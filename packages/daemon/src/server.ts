import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  AgentMessageRequest,
  AddPlanFeedbackRequest,
  ConversationMessage,
  CreatePlanRequest,
  CreateSessionRequest,
  FeedbackAnsweredRequest,
  FeedbackBatch,
  FeedbackQuestion,
  FeedbackQuestionRequest,
  FeedbackRequestedRequest,
  FeedbackRequest,
  HarnessRef,
  HarnessPresence,
  ImplementPlanRequest,
  PlanFeedbackStore,
  PlanFileEntry,
  PlanManifest,
  PlanSession,
  PlanStatus,
  PlanUpdatedRequest,
  PlanVersion,
  RuntimeKind,
  ServerEvent,
  UpdatePlanFeedbackRequest,
  UpdatePlanFileMetadataRequest,
  UpdatePlanMetadataRequest,
  UpsertPlanFileRequest,
} from "@planalot/shared";
import { loadDaemonConfig, type DaemonConfig } from "./config.js";
import { computeLineModifications } from "./diff.js";
import { dataDir, ensureDataDirs, planFilePath, sessionPath, writeDaemonMetadata, APP_VERSION } from "./fsPaths.js";
import { methodNotAllowed, readJsonBody, requestUrl, sendJson, sendText } from "./http.js";
import { contentHash, makeToken, timingSafeTokenEqual, validatePlanPath } from "./security.js";
import {
  addPlanFeedback,
  createPlanWorkspace,
  deletePlanFile,
  hasOpenFeedback,
  listPlanFiles,
  listPlans,
  readAllPlanFiles,
  readFeedback,
  readManifest,
  readPlanFile,
  readPlanView,
  reopenPlan,
  setMainHarness,
  setPlanHarnessActive,
  updatePlanFeedback,
  updatePlanFileMetadata,
  updatePlanMetadata,
  upsertPlanFile,
  workspacePath,
  writeManifest,
} from "./planStore.js";

interface HarnessConn {
  harnessId: string;
  harnessType: RuntimeKind;
  label: string;
  connectedAt: number;
  lastActiveAt?: number;
  res: ServerResponse;
}

interface SessionRuntime {
  session: PlanSession;
  planId: string;
  clients: Set<ServerResponse>;
  /** Connected harness instances, keyed by unique-per-instance harnessId. */
  harnesses: Map<string, HarnessConn>;
  watcher?: FSWatcher;
  watchTimer?: NodeJS.Timeout;
  harnessTimer?: NodeJS.Timeout;
}

interface StartDaemonOptions {
  port?: number;
  token?: string;
}

const HOST = "127.0.0.1";

export async function startDaemon(options: StartDaemonOptions = {}): Promise<{ port: number; token: string; close: () => Promise<void> }> {
  await ensureDataDirs();
  const config = loadDaemonConfig();
  const token = options.token ?? makeToken();
  const sessions = new Map<string, SessionRuntime>();

  // Keepalive: SSE consumed via fetch streaming (the harness adapters) is
  // terminated by undici's ~5min body timeout when idle. Periodic comment
  // pings keep long-lived connections (and the harness registry) alive.
  const heartbeat = setInterval(() => {
    for (const runtime of sessions.values()) {
      for (const client of runtime.clients) {
        try { client.write(": ping\n\n"); } catch { /* client gone; close handler cleans up */ }
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  const authorize = (url: URL): boolean => timingSafeTokenEqual(url.searchParams.get("token"), token);
  const authorizeHeader = (req: { headers: Record<string, string | string[] | undefined> }): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    return timingSafeTokenEqual(header.replace(/^Bearer\s+/i, ""), token);
  };

  const writeEvent = (client: ServerResponse, event: ServerEvent): void => {
    client.write(`event: ${event.type}\n`);
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const emit = (runtime: SessionRuntime, event: ServerEvent): void => {
    for (const client of runtime.clients) writeEvent(client, event);
  };

  const presenceList = (runtime: SessionRuntime): HarnessPresence[] =>
    Array.from(runtime.harnesses.values()).map(({ res: _res, ...rest }) => rest);

  /**
   * Resolve which connected harness feedback should route to:
   * user-chosen (if connected) → last-active (if connected) → most-recently-active
   * among connected → most-recently-connected → none.
   */
  const resolveTargetId = (runtime: SessionRuntime, chosen?: string): string | undefined => {
    const conns = runtime.harnesses;
    if (chosen && conns.has(chosen)) return chosen;
    const last = runtime.session.lastActiveHarnessId;
    if (last && conns.has(last)) return last;
    const arr = Array.from(conns.values());
    if (arr.length === 0) return undefined;
    const active = arr.filter((c) => c.lastActiveAt !== undefined).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    if (active.length) return active[0]!.harnessId;
    return arr.sort((a, b) => b.connectedAt - a.connectedAt)[0]!.harnessId;
  };

  const presenceEvent = (runtime: SessionRuntime): ServerEvent => {
    const targetHarnessId = resolveTargetId(runtime);
    return {
      type: "harness.presence",
      sessionId: runtime.session.id,
      harnesses: presenceList(runtime),
      ...(targetHarnessId ? { targetHarnessId } : {}),
    };
  };

  const broadcastPresence = (runtime: SessionRuntime): void => emit(runtime, presenceEvent(runtime));

  const publicSessionView = (runtime: SessionRuntime): PlanSession => {
    const targetHarnessId = resolveTargetId(runtime);
    return {
      ...runtime.session,
      messages: [],
      harnesses: presenceList(runtime),
      ...(targetHarnessId ? { targetHarnessId } : {}),
    };
  };

  const persist = async (session: PlanSession): Promise<void> => {
    await mkdir(dirname(sessionPath(session.id)), { recursive: true, mode: 0o700 });
    await writeFile(sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  };

  const sessionFromPlan = async (manifest: PlanManifest): Promise<PlanSession> => {
    const text = await readFile(planFilePath(manifest.id, manifest.mainFile), "utf8");
    const hash = contentHash(text);
    const createdAt = Date.parse(manifest.createdAt);
    const updatedAt = Date.parse(manifest.updatedAt);
    return {
      id: manifest.id,
      runtime: "manual",
      cwd: workspacePath(manifest.id),
      planFile: manifest.name,
      absolutePlanPath: planFilePath(manifest.id, manifest.mainFile),
      currentPlanHash: hash,
      currentPlanText: text,
      versions: [createInitialVersion(text, hash, createdAt)],
      feedbackBatches: [],
      feedbackRequests: [],
      messages: [],
      status: manifest.status === "planning" ? "active" : "closed",
      createdAt,
      updatedAt,
    };
  };

  const harnessRefFromConn = (conn: HarnessConn): HarnessRef => ({
    id: conn.harnessId,
    type: conn.harnessType,
    label: conn.label,
    connectedAt: new Date(conn.connectedAt).toISOString(),
    ...(conn.lastActiveAt !== undefined ? { lastActiveAt: new Date(conn.lastActiveAt).toISOString() } : {}),
  });

  const resolveHarnessRef = (runtime: SessionRuntime, harnessId?: string): HarnessRef | undefined => {
    const resolved = resolveTargetId(runtime, harnessId);
    const conn = resolved ? runtime.harnesses.get(resolved) : undefined;
    return conn ? harnessRefFromConn(conn) : undefined;
  };

  const normalizeSession = (session: PlanSession): PlanSession => {
    session.versions ??= [createInitialVersion(session.currentPlanText, session.currentPlanHash, Date.now())];
    session.feedbackBatches ??= [];
    session.feedbackRequests ??= [];
    return session;
  };

  const loadSession = async (id: string): Promise<SessionRuntime | null> => {
    const existing = sessions.get(id);
    if (existing) return existing;
    try {
      const session = normalizeSession(JSON.parse(await readFile(sessionPath(id), "utf8")) as PlanSession);
      const runtime: SessionRuntime = { session, planId: session.id, clients: new Set(), harnesses: new Map() };
      await attachWatcher(runtime);
      sessions.set(id, runtime);
      return runtime;
    } catch {
      try {
        const manifest = await readManifest(id);
        const session = normalizeSession(await sessionFromPlan(manifest));
        const runtime: SessionRuntime = { session, planId: manifest.id, clients: new Set(), harnesses: new Map() };
        await attachWatcher(runtime);
        sessions.set(id, runtime);
        return runtime;
      } catch {
        return null;
      }
    }
  };

  const attachWatcher = async (runtime: SessionRuntime): Promise<void> => {
    await runtime.watcher?.close();
    if (!existsSync(runtime.session.absolutePlanPath)) return;

    runtime.watcher = chokidar.watch(runtime.session.absolutePlanPath, {
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100,
      },
    });
    runtime.watcher.on("change", () => {
      clearTimeout(runtime.watchTimer);
      runtime.watchTimer = setTimeout(() => {
        void refreshPlan(runtime, "watcher").catch((error) => {
          emit(runtime, { type: "feedback.failed", sessionId: runtime.session.id, error: String(error) });
        });
      }, config.watchDebounceMs);
    });
  };

  const refreshPlan = async (runtime: SessionRuntime, source: "watcher" | "harness"): Promise<PlanVersion | null> => {
    const text = await readFile(runtime.session.absolutePlanPath, "utf8");
    const hash = contentHash(text);
    if (hash === runtime.session.currentPlanHash) {
      emit(runtime, { type: "plan.unchanged", sessionId: runtime.session.id, hash });
      return null;
    }

    const version = createVersion(runtime.session, text, hash, source, config);
    runtime.session.previousPlanText = runtime.session.currentPlanText;
    runtime.session.currentPlanText = text;
    runtime.session.currentPlanHash = hash;
    runtime.session.versions.push(version);
    runtime.session.status = "plan-updated";
    runtime.session.updatedAt = Date.now();
    await persist(runtime.session);
    emit(runtime, { type: "plan.changed", sessionId: runtime.session.id, planText: text, hash, version });
    emit(runtime, { type: "plan.updated", sessionId: runtime.session.id, planText: text, hash, version } as ServerEvent);
    emit(runtime, { type: "session.status", sessionId: runtime.session.id, status: "plan-updated" });
    return version;
  };

  const scheduleHarnessRefresh = (runtime: SessionRuntime): void => {
    clearTimeout(runtime.harnessTimer);
    runtime.harnessTimer = setTimeout(() => {
      void refreshPlan(runtime, "harness").catch((error) => {
        emit(runtime, { type: "feedback.failed", sessionId: runtime.session.id, error: String(error) });
      });
    }, config.harnessEventDebounceMs);
  };

  const createSession = async (body: CreateSessionRequest, origin: string): Promise<{ session: PlanSession; url: string }> => {
    if (!isRuntime(body.runtime)) throw new Error("runtime must be pi, claude-code, or manual");
    if (typeof body.cwd !== "string" || typeof body.planFile !== "string") throw new Error("cwd and planFile are required");

    const cwd = body.cwd;
    const absolutePlanPath = validatePlanPath(cwd, body.planFile);
    if (!existsSync(absolutePlanPath)) {
      throw new Error("planFile must already exist; Planalot only opens and watches existing markdown files");
    }
    const planText = body.planText ?? await readFile(absolutePlanPath, "utf8");
    const manifest = await createPlanWorkspace({
      name: body.planFile,
      origin: { kind: "file-import", sourcePath: absolutePlanPath },
      indexText: planText,
      runtime: body.runtime,
    });
    const session = await sessionFromPlan(manifest);
    session.runtime = body.runtime;
    session.messages = [
      {
        id: randomUUID(),
        role: "system",
        kind: "delivery-status",
        text: `Plan workspace ${manifest.id} opened from ${body.planFile}. Planalot now owns the source of truth.`,
        createdAt: Date.now(),
      },
    ];
    const runtime: SessionRuntime = { session, planId: manifest.id, clients: new Set(), harnesses: new Map() };
    await attachWatcher(runtime);
    sessions.set(manifest.id, runtime);
    await persist(session);
    return { session, url: `${origin}/s/${manifest.id}?token=${encodeURIComponent(token)}` };
  };

  const webHtml = async (): Promise<string> => {
    const explicit = process.env.PLANALOT_WEB_DIST;
    const candidates = [
      explicit ? join(explicit, "index.html") : "",
      join(dirname(fileURLToPath(import.meta.url)), "web", "index.html"),
      join(process.cwd(), "apps", "web", "dist", "index.html"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        return await readFile(candidate, "utf8");
      } catch {
        // Try next candidate.
      }
    }

    return "<!doctype html><html><body><h1>planalot</h1><p>Build the web app with <code>pnpm --filter @planalot/web build</code>.</p></body></html>";
  };

  const notifyFileChanged = async (planId: string, filePath: string): Promise<void> => {
    const runtime = sessions.get(planId);
    if (!runtime) return;
    if (filePath === "index.md") {
      const text = await readFile(runtime.session.absolutePlanPath, "utf8");
      const hash = contentHash(text);
      if (hash !== runtime.session.currentPlanHash) {
        const version = createVersion(runtime.session, text, hash, "harness", config);
        runtime.session.previousPlanText = runtime.session.currentPlanText;
        runtime.session.currentPlanText = text;
        runtime.session.currentPlanHash = hash;
        runtime.session.versions.push(version);
        runtime.session.updatedAt = Date.now();
        await persist(runtime.session);
        emit(runtime, { type: "plan.changed", sessionId: planId, planText: text, hash, version });
      }
    }
    emit(runtime, { type: "file.changed", sessionId: planId, filePath });
  };

  const parseStatusList = (value: string | null): PlanStatus[] | undefined => {
    if (!value) return undefined;
    const statuses = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (statuses.every(isPlanStatus)) return statuses;
    throw new Error("invalid plan status filter");
  };

  const server = createServer(async (req, res) => {
    try {
      const url = requestUrl(req);
      const origin = `http://${HOST}:${actualPort()}`;

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
        });
        res.end();
        return;
      }

      if (url.pathname === "/health") {
        if (req.method !== "GET") return methodNotAllowed(res);
        sendJson(res, { ok: true, name: "planalot", version: APP_VERSION, pid: process.pid, port: actualPort(), config });
        return;
      }

      if (url.pathname === "/plans") {
        if (req.method === "GET") {
          if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const query = url.searchParams.get("q") ?? undefined;
          const statuses = parseStatusList(url.searchParams.get("statuses") ?? url.searchParams.get("status"));
          const plans = await listPlans({
            ...(query ? { query } : {}),
            ...(statuses ? { statuses } : {}),
            includeExpired: url.searchParams.get("includeExpired") === "true",
            limit: Number(url.searchParams.get("limit") || 50),
          });
          sendJson(res, { plans });
          return;
        }
        if (req.method === "POST") {
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const body = await readJsonBody<CreatePlanRequest>(req);
          const manifest = await createPlanWorkspace(body);
          sendJson(res, { planId: manifest.id, url: `${origin}/s/${manifest.id}?token=${encodeURIComponent(token)}`, manifest });
          return;
        }
        return methodNotAllowed(res);
      }

      const planFileMatch = url.pathname.match(/^\/plans\/([^/]+)\/files(?:\/([^/]+))?$/);
      if (planFileMatch) {
        const id = planFileMatch[1] ?? "";
        const filePath = planFileMatch[2];
        if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);

        if (filePath === undefined) {
          if (req.method === "GET") {
            sendJson(res, { files: await listPlanFiles(id) });
            return;
          }
          if (req.method === "POST") {
            if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
            const body = await readJsonBody<UpsertPlanFileRequest>(req);
            const entry = await upsertPlanFile(id, body);
            await notifyFileChanged(id, entry.path);
            sendJson(res, { entry }, 201);
            return;
          }
          return methodNotAllowed(res);
        }

        if (req.method === "GET") {
          const result = await readPlanFile(id, filePath);
          sendJson(res, result);
          return;
        }
        if (req.method === "PUT") {
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const body = await readJsonBody<{ content: string }>(req);
          const current = await readPlanFile(id, filePath).catch(() => undefined);
          const entry = await upsertPlanFile(id, {
            path: filePath,
            ...(current?.entry.title ? { title: current.entry.title } : {}),
            ...(current?.entry.purpose ? { purpose: current.entry.purpose } : {}),
            content: body.content,
          });
          await notifyFileChanged(id, entry.path);
          sendJson(res, { entry });
          return;
        }
        if (req.method === "PATCH") {
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const body = await readJsonBody<UpdatePlanFileMetadataRequest>(req);
          sendJson(res, { entry: await updatePlanFileMetadata(id, filePath, body) });
          return;
        }
        if (req.method === "DELETE") {
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          sendJson(res, { manifest: await deletePlanFile(id, filePath) });
          return;
        }
        return methodNotAllowed(res);
      }

      const planFeedbackMatch = url.pathname.match(/^\/plans\/([^/]+)\/feedback(?:\/([^/]+))?$/);
      if (planFeedbackMatch) {
        const id = planFeedbackMatch[1] ?? "";
        const feedbackId = planFeedbackMatch[2];
        if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);

        if (feedbackId === undefined) {
          if (req.method === "GET") {
            sendJson(res, await readFeedback(id));
            return;
          }
          if (req.method === "POST") {
            if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
            const body = await readJsonBody<AddPlanFeedbackRequest>(req);
            const runtime = await loadSession(id);
            const feedback = await addPlanFeedback(id, body, runtime ? resolveHarnessRef(runtime, body.targetHarnessId) : undefined);
            if (runtime) emit(runtime, { type: "feedback.added", sessionId: id, feedback });
            sendJson(res, { feedback }, 201);
            return;
          }
          return methodNotAllowed(res);
        }

        if (req.method === "PATCH") {
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const body = await readJsonBody<UpdatePlanFeedbackRequest>(req);
          const feedback = await updatePlanFeedback(id, feedbackId, body);
          const runtime = await loadSession(id);
          if (runtime) emit(runtime, { type: "feedback.updated", sessionId: id, feedback });
          sendJson(res, { feedback });
          return;
        }
        return methodNotAllowed(res);
      }

      const planHarnessMatch = url.pathname.match(/^\/plans\/([^/]+)\/harnesses(?:\/([^/]+)\/active|\/main)$/);
      if (planHarnessMatch) {
        const id = planHarnessMatch[1] ?? "";
        const activeHarnessId = planHarnessMatch[2];
        if (req.method !== "POST" && req.method !== "PATCH") return methodNotAllowed(res);
        if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
        const runtime = await loadSession(id);
        if (!runtime) return sendJson(res, { error: "Plan not found" }, 404);

        if (activeHarnessId !== undefined) {
          const conn = runtime.harnesses.get(activeHarnessId);
          if (!conn) return sendJson(res, { error: "Harness not connected" }, 404);
          conn.lastActiveAt = Date.now();
          runtime.session.lastActiveHarnessId = activeHarnessId;
          const manifest = await setPlanHarnessActive(id, harnessRefFromConn(conn));
          broadcastPresence(runtime);
          sendJson(res, { manifest });
          return;
        }

        const body = await readJsonBody<{ harnessId?: string }>(req);
        const target = body.harnessId ? runtime.harnesses.get(body.harnessId) : undefined;
        if (!target) return sendJson(res, { error: "Harness not connected" }, 404);
        const manifest = await setMainHarness(id, harnessRefFromConn(target));
        sendJson(res, { manifest });
        return;
      }

      const planActionMatch = url.pathname.match(/^\/plans\/([^/]+)(?:\/(events|reopen|cancel|complete|implement|agent-message))?$/);
      if (planActionMatch) {
        const id = planActionMatch[1] ?? "";
        const action = planActionMatch[2];

        if (action === undefined) {
          if (req.method !== "GET" && req.method !== "PATCH") return methodNotAllowed(res);
          if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          if (req.method === "PATCH") {
            if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
            const body = await readJsonBody<UpdatePlanMetadataRequest>(req);
            sendJson(res, { manifest: await updatePlanMetadata(id, body) });
            return;
          }
          const view = await readPlanView(id);
          const runtime = await loadSession(id);
          sendJson(res, {
            ...view,
            ...(runtime ? { harnesses: presenceList(runtime), targetHarnessId: resolveTargetId(runtime) } : {}),
          });
          return;
        }

        if (action === "events") {
          const runtime = await loadSession(id);
          if (!runtime) return sendJson(res, { error: "Plan not found" }, 404);
          if (req.method !== "GET") return methodNotAllowed(res);
          if (!authorize(url)) return sendJson(res, { error: "Unauthorized" }, 401);
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write("retry: 1000\n\n");
          runtime.clients.add(res);
          let harnessId: string | undefined;
          if (url.searchParams.get("role") === "harness") {
            harnessId = url.searchParams.get("harnessId") || randomUUID();
            const declaredType = url.searchParams.get("harnessType");
            const harnessType = isRuntime(declaredType) ? declaredType : runtime.session.runtime;
            const label = url.searchParams.get("label") || harnessType;
            const connectedAt = Date.now();
            runtime.harnesses.set(harnessId, { harnessId, harnessType, label, connectedAt, res });
            await setPlanHarnessActive(id, { id: harnessId, type: harnessType, label, connectedAt: new Date(connectedAt).toISOString() });
            broadcastPresence(runtime);
          } else {
            writeEvent(res, presenceEvent(runtime));
          }
          req.once("close", () => {
            runtime.clients.delete(res);
            if (harnessId && runtime.harnesses.get(harnessId)?.res === res) {
              runtime.harnesses.delete(harnessId);
              broadcastPresence(runtime);
            }
          });
          return;
        }

        if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);

        if (action === "reopen" || action === "cancel" || action === "complete") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const manifest =
            action === "reopen"
              ? await reopenPlan(id)
              : await updatePlanMetadata(id, { status: action === "cancel" ? "canceled" : "done" });
          sendJson(res, { manifest });
          return;
        }

        if (action === "implement") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<ImplementPlanRequest>(req);
          const feedback = await readFeedback(id);
          if (hasOpenFeedback(feedback) && body.allowOpenFeedback !== true) {
            return sendJson(res, { error: "Plan has open feedback. Resolve it or set allowOpenFeedback." }, 409);
          }
          const runtime = await loadSession(id);
          const target = runtime ? resolveTargetId(runtime, body.targetHarnessId) : undefined;
          const manifest = await updatePlanMetadata(id, { status: "implementing" });
          const files = await readAllPlanFiles(id);
          const instruction = buildImplementationInstruction(manifest, workspacePath(id), files.map((file) => file.entry), feedback, body.instruction);
          const message: ConversationMessage = {
            id: randomUUID(),
            role: "user",
            kind: "delivery-status",
            text: instruction,
            createdAt: Date.now(),
          };
          if (runtime) {
            runtime.session.messages.push(message);
            runtime.session.updatedAt = Date.now();
            emit(runtime, { type: "implementation.requested", sessionId: id, message, ...(target ? { targetHarnessId: target } : {}) });
            emit(runtime, { type: "plan.build", sessionId: id, message, ...(target ? { targetHarnessId: target } : {}) });
          }
          sendJson(res, { ok: true, manifest, message, targetHarnessId: target });
          return;
        }

        if (action === "agent-message") {
          const runtime = await loadSession(id);
          if (!runtime) return sendJson(res, { error: "Plan not found" }, 404);
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<AgentMessageRequest>(req);
          if (typeof body.message !== "string") throw new Error("agent message must be a string");
          const message: ConversationMessage = { id: randomUUID(), role: "agent", kind: "chat", text: body.message, createdAt: Date.now() };
          runtime.session.messages.push(message);
          emit(runtime, { type: "agent.message", sessionId: id, message });
          sendJson(res, { ok: true, message });
          return;
        }
      }

      if (url.pathname === "/sessions") {
        if (req.method !== "POST") return methodNotAllowed(res);
        if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
        const body = await readJsonBody<CreateSessionRequest>(req);
        const result = await createSession(body, origin);
        sendJson(res, { sessionId: result.session.id, url: result.url });
        return;
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(events|feedback|agent-message|feedback-requested|feedback-answered|plan-updated|accept|build))?$/);
      if (sessionMatch) {
        const id = sessionMatch[1] ?? "";
        const action = sessionMatch[2];
        const runtime = await loadSession(id);
        if (!runtime) return sendJson(res, { error: "Session not found" }, 404);

        if (action === undefined) {
          if (req.method !== "GET") return methodNotAllowed(res);
          if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          sendJson(res, publicSessionView(runtime));
          return;
        }

        if (action === "events") {
          if (req.method !== "GET") return methodNotAllowed(res);
          if (!authorize(url)) return sendJson(res, { error: "Unauthorized" }, 401);
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write("retry: 1000\n\n");
          runtime.clients.add(res);

          let harnessId: string | undefined;
          if (url.searchParams.get("role") === "harness") {
            harnessId = url.searchParams.get("harnessId") || randomUUID();
            const declaredType = url.searchParams.get("harnessType");
            const harnessType = isRuntime(declaredType) ? declaredType : runtime.session.runtime;
            const label = url.searchParams.get("label") || harnessType;
            const connectedAt = Date.now();
            runtime.harnesses.set(harnessId, { harnessId, harnessType, label, connectedAt, res });
            await setPlanHarnessActive(runtime.planId, { id: harnessId, type: harnessType, label, connectedAt: new Date(connectedAt).toISOString() });
            broadcastPresence(runtime);
          } else {
            // Browser/unidentified client: send a presence snapshot so the selector renders immediately.
            writeEvent(res, presenceEvent(runtime));
          }

          req.once("close", () => {
            runtime.clients.delete(res);
            if (harnessId && runtime.harnesses.get(harnessId)?.res === res) {
              runtime.harnesses.delete(harnessId);
              broadcastPresence(runtime);
            }
          });
          return;
        }

        if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);

        if (action === "feedback") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<FeedbackRequest>(req);
          if (body.kind !== "chat" && body.kind !== "annotated-feedback") throw new Error("feedback kind must be chat or annotated-feedback");
          if (typeof body.message !== "string") throw new Error("feedback message must be a string");
          const annotations = Array.isArray(body.annotations) && body.annotations.length ? body.annotations : undefined;
          const chosen = typeof body.targetHarnessId === "string" ? body.targetHarnessId : undefined;
          const targetId = resolveTargetId(runtime, chosen);
          const message: ConversationMessage = {
            id: randomUUID(),
            role: "user",
            kind: body.kind,
            text: body.message,
            ...(annotations === undefined ? {} : { annotations }),
            createdAt: Date.now(),
          };
          const batch = createFeedbackBatch(runtime.session, message);
          runtime.session.messages.push(message);
          runtime.session.feedbackBatches.push(batch);
          const feedback = await addPlanFeedback(runtime.planId, {
            kind: body.kind,
            text: body.message,
            ...(annotations === undefined ? {} : { annotations }),
            ...(chosen ? { targetHarnessId: chosen } : {}),
          }, resolveHarnessRef(runtime, chosen));
          emit(runtime, { type: "feedback.added", sessionId: id, feedback });

          if (targetId) {
            // A connected harness owns this send — deliver only to it (tagged).
            runtime.session.status = "agent-processing";
            runtime.session.updatedAt = Date.now();
            await persist(runtime.session);
            emit(runtime, { type: "feedback.sent", sessionId: id, message, batch, targetHarnessId: targetId });
            emit(runtime, { type: "feedback.submitted", sessionId: id, batch });
            emit(runtime, { type: "session.status", sessionId: id, status: runtime.session.status });
            sendJson(res, { ok: true, message, batch, delivered: true, targetHarnessId: targetId });
            return;
          }

          if (runtime.session.runtime === "manual") {
            // Manual/copyable session — recorded for the user; no harness to route to.
            runtime.session.status = "active";
            runtime.session.updatedAt = Date.now();
            await persist(runtime.session);
            emit(runtime, { type: "feedback.sent", sessionId: id, message, batch });
            emit(runtime, { type: "feedback.submitted", sessionId: id, batch });
            emit(runtime, { type: "session.status", sessionId: id, status: runtime.session.status });
            sendJson(res, { ok: true, message, batch, delivered: true });
            return;
          }

          // Harness-backed session but no harness connected → delivery failed (no queue/replay).
          // The browser surfaces this so the user can retry or pick another harness.
          runtime.session.status = "delivery-failed";
          runtime.session.updatedAt = Date.now();
          await persist(runtime.session);
          emit(runtime, {
            type: "feedback.failed",
            sessionId: id,
            error: "No connected harness to deliver feedback to. Retry once a harness reconnects, or pick another.",
            messageId: message.id,
          });
          emit(runtime, { type: "session.status", sessionId: id, status: runtime.session.status });
          sendJson(res, { ok: true, message, batch, delivered: false });
          return;
        }

        if (action === "feedback-requested") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<FeedbackRequestedRequest>(req);
          validateFeedbackQuestions(body.questions);
          const request: FeedbackQuestionRequest = {
            id: randomUUID(),
            ...(body.feedbackBatchId ? { feedbackBatchId: body.feedbackBatchId } : {}),
            planVersionId: latestVersion(runtime.session).id,
            questions: body.questions,
            status: "requested",
            createdAt: Date.now(),
          };
          runtime.session.feedbackRequests.push(request);
          if (request.feedbackBatchId) {
            const batch = runtime.session.feedbackBatches.find((candidate) => candidate.id === request.feedbackBatchId);
            if (batch) {
              batch.status = "clarifying";
              batch.updatedAt = Date.now();
            }
          }
          runtime.session.updatedAt = Date.now();
          await persist(runtime.session);
          emit(runtime, { type: "feedback.requested", sessionId: id, request });
          sendJson(res, { ok: true, request });
          return;
        }

        if (action === "feedback-answered") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<FeedbackAnsweredRequest>(req);
          const request = runtime.session.feedbackRequests.find((candidate) => candidate.id === body.requestId);
          if (!request) throw new Error("feedback request not found");
          request.status = "answered";
          request.answeredAt = Date.now();
          if (request.feedbackBatchId) {
            const batch = runtime.session.feedbackBatches.find((candidate) => candidate.id === request.feedbackBatchId);
            if (batch) {
              batch.status = "answered";
              batch.updatedAt = Date.now();
            }
          }
          runtime.session.updatedAt = Date.now();
          await persist(runtime.session);
          const answeredTarget = resolveTargetId(runtime);
          emit(runtime, { type: "feedback.answered", sessionId: id, request, answers: body.answers, ...(answeredTarget ? { targetHarnessId: answeredTarget } : {}) });
          sendJson(res, { ok: true, request, answers: body.answers });
          return;
        }

        if (action === "plan-updated") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<PlanUpdatedRequest>(req).catch(() => ({} as PlanUpdatedRequest));
          if (typeof body?.harnessId === "string" && body.harnessId) {
            runtime.session.lastActiveHarnessId = body.harnessId;
            const conn = runtime.harnesses.get(body.harnessId);
            if (conn) {
              conn.lastActiveAt = Date.now();
              await setPlanHarnessActive(runtime.planId, harnessRefFromConn(conn));
            }
            broadcastPresence(runtime);
          }
          scheduleHarnessRefresh(runtime);
          sendJson(res, { ok: true });
          return;
        }

        if (action === "accept" || action === "build") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const isBuild = action === "build";
          const message: ConversationMessage = {
            id: randomUUID(),
            role: "user",
            kind: "delivery-status",
            text: isBuild
              ? "Plan accepted. Move to implementation phase."
              : "Plan accepted. Await explicit user instruction before implementation.",
            createdAt: Date.now(),
          };
          runtime.session.messages.push(message);
          runtime.session.updatedAt = Date.now();
          await persist(runtime.session);
          const acceptTarget = resolveTargetId(runtime);
          emit(runtime, { type: isBuild ? "plan.build" : "plan.accepted", sessionId: id, message, ...(acceptTarget ? { targetHarnessId: acceptTarget } : {}) } as ServerEvent);
          sendJson(res, { ok: true, message });
          return;
        }

        if (action === "agent-message") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const body = await readJsonBody<AgentMessageRequest>(req);
          if (typeof body.message !== "string") throw new Error("agent message must be a string");
          const message: ConversationMessage = {
            id: randomUUID(),
            role: "agent",
            kind: "chat",
            text: body.message,
            createdAt: Date.now(),
          };
          runtime.session.messages.push(message);
          runtime.session.status = "reply-received";
          runtime.session.updatedAt = Date.now();
          await persist(runtime.session);
          emit(runtime, { type: "agent.message", sessionId: id, message });
          emit(runtime, { type: "session.status", sessionId: id, status: "reply-received" });
          sendJson(res, { ok: true, message });
          return;
        }
      }

      if (url.pathname === "/" || url.pathname.startsWith("/s/")) {
        if (req.method !== "GET") return methodNotAllowed(res);
        sendText(res, await webHtml(), 200, "text/html; charset=utf-8");
        return;
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  let boundPort = 0;
  const actualPort = () => boundPort;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, () => {
      server.off("error", reject);
      boundPort = (server.address() as { port: number }).port;
      resolve();
    });
  });

  await writeDaemonMetadata({ pid: process.pid, port: boundPort, token, startedAt: Date.now(), version: APP_VERSION });
  console.error(`[planalot] daemon listening on http://${HOST}:${boundPort}`);

  return {
    port: boundPort,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(heartbeat);
        for (const runtime of sessions.values()) {
          clearTimeout(runtime.watchTimer);
          clearTimeout(runtime.harnessTimer);
          void runtime.watcher?.close();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function createInitialVersion(text: string, hash: string, createdAt: number): PlanVersion {
  return { id: randomUUID(), version: 0, hash, text, source: "initial", modifications: [], createdAt };
}

function createVersion(session: PlanSession, text: string, hash: string, source: "watcher" | "harness", config: DaemonConfig): PlanVersion {
  return {
    id: randomUUID(),
    version: session.versions.length,
    hash,
    text,
    source,
    modifications: computeLineModifications(session.currentPlanText, text, config.maxTrailModifications),
    createdAt: Date.now(),
  };
}

function latestVersion(session: PlanSession): PlanVersion {
  return session.versions.at(-1) ?? createInitialVersion(session.currentPlanText, session.currentPlanHash, Date.now());
}

function createFeedbackBatch(session: PlanSession, message: ConversationMessage): FeedbackBatch {
  const now = Date.now();
  return {
    id: randomUUID(),
    messageId: message.id,
    status: "submitted",
    planVersionId: latestVersion(session).id,
    message,
    createdAt: now,
    updatedAt: now,
  };
}

function validateFeedbackQuestions(questions: FeedbackQuestion[]): void {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error("questions must be a non-empty array");
  for (const question of questions) {
    if (typeof question.id !== "string" || typeof question.prompt !== "string") throw new Error("question id and prompt are required");
    if (question.kind !== "text" && question.kind !== "single-select" && question.kind !== "multi-select") throw new Error("invalid question kind");
    if (question.kind !== "text") {
      if (!Array.isArray(question.suggestions) || question.suggestions.length === 0) throw new Error("select questions require suggestions");
      for (const suggestion of question.suggestions) {
        if (typeof suggestion.id !== "string" || typeof suggestion.label !== "string" || typeof suggestion.description !== "string" || !suggestion.description.trim()) {
          throw new Error("every suggestion requires id, label, and detailed description");
        }
      }
    }
  }
}

function isRuntime(value: unknown): value is RuntimeKind {
  return value === "codex" || value === "pi" || value === "claude-code" || value === "manual";
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "planning" || value === "implementing" || value === "done" || value === "canceled" || value === "expired";
}

function buildImplementationInstruction(
  manifest: PlanManifest,
  workspacePathValue: string,
  files: PlanFileEntry[],
  feedback: PlanFeedbackStore,
  userInstruction?: string,
): string {
  const open = feedback.items.filter((item) => item.status === "open");
  const resolved = feedback.items.filter((item) => item.status !== "open");
  const fileLines = files.map((file) => `- ${file.path}: ${file.purpose}`).join("\n");
  const feedbackSummary = [
    `Open feedback: ${open.length}`,
    `Resolved/dismissed feedback: ${resolved.length}`,
  ].join("\n");
  return [
    userInstruction?.trim() || "Implement the accepted Planalot plan.",
    "",
    `Plan: ${manifest.name} (${manifest.id})`,
    `Workspace: ${workspacePathValue}`,
    "",
    "Read these Planalot files from disk before implementing:",
    fileLines || "- index.md: Canonical plan body",
    "",
    "Feedback summary:",
    feedbackSummary,
    "",
    "Treat Planalot as the planning source of truth. Use your normal implementation workflow after reading the files.",
  ].join("\n");
}

export function daemonLogPath(): string {
  return join(dataDir(), "daemon.log");
}
