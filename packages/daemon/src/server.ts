import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  AgentMessageRequest,
  AddInquiriesRequest,
  AddPlanFeedbackRequest,
  ConversationMessage,
  CreatePlanRequest,
  CreateResearchRequest,
  CreateSessionRequest,
  FeedbackAnsweredRequest,
  FeedbackBatch,
  FeedbackQuestion,
  FeedbackQuestionRequest,
  FeedbackResult,
  FeedbackResultRequest,
  FeedbackRequestedRequest,
  FeedbackRequest,
  HarnessAttachRequest,
  HarnessHeartbeatRequest,
  HarnessPresence,
  HarnessRef,
  HarnessRole,
  HarnessStatus,
  HarnessTransport,
  ImplementPlanRequest,
  PlanEditLease,
  PlanFeedbackStore,
  PlanFileEntry,
  PlanFeedbackItem,
  PlanManifest,
  PlanSession,
  PlanStatus,
  PlanUpdatedRequest,
  PlanVersion,
  ResearchSession,
  RuntimeKind,
  ServerEvent,
  UpdateInquiryRequest,
  UpdatePlanFeedbackRequest,
  UpdatePlanFileMetadataRequest,
  UpdatePlanMetadataRequest,
  UpdateResearchRequest,
  UpdateResearchScopeRequest,
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
  layerForPath,
  listPlanFiles,
  listPlans,
  planLayers,
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
  validateFeedbackResultShape,
  workspacePath,
  writeFeedback,
  writeManifest,
} from "./planStore.js";
import {
  addInquiries,
  createResearch,
  listResearch,
  readResearch,
  updateInquiry,
  updateResearchMeta,
  updateResearchScope,
} from "./researchStore.js";

interface QueuedEvent {
  seq: number;
  event: ServerEvent;
}

interface HarnessConn {
  harnessId: string;
  harnessType: RuntimeKind;
  label: string;
  connectedAt: number;
  lastActiveAt?: number;
  lastSeenAt: number;
  status: HarnessStatus;
  transport: HarnessTransport;
  /** Held SSE stream for push delivery (Pi); undefined for poll harnesses. */
  res?: ServerResponse;
  /** Pending targeted events awaiting pull by a poll harness. */
  queue: QueuedEvent[];
  /** Resolver that wakes an in-flight long-poll heartbeat when an event arrives. */
  waiter?: (() => void) | undefined;
}

interface SessionRuntime {
  session: PlanSession;
  planId: string;
  clients: Set<ServerResponse>;
  /** Attached harness instances, keyed by unique-per-instance harnessId. */
  harnesses: Map<string, HarnessConn>;
  /** Monotonic per-session event sequence powering poll cursors. */
  eventSeq: number;
  /** harnessId designated to drive (mirror of manifest.harnesses.main). */
  driverHarnessId?: string | undefined;
  /** Active exclusive edit lease while a feedback round is in flight. */
  editLease?: PlanEditLease | undefined;
  watcher?: FSWatcher;
  watchTimer?: NodeJS.Timeout;
  harnessTimer?: NodeJS.Timeout;
}

const newRuntime = (session: PlanSession, planId: string): SessionRuntime => ({
  session,
  planId,
  clients: new Set(),
  harnesses: new Map(),
  eventSeq: 0,
});

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
  // pings keep long-lived connections alive, and an open SSE stream counts as
  // an implicit heartbeat (refreshes the harness's lastSeenAt).
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const runtime of sessions.values()) {
      for (const client of runtime.clients) {
        try { client.write(": ping\n\n"); } catch { /* client gone; close handler cleans up */ }
      }
      for (const conn of runtime.harnesses.values()) {
        if (conn.res !== undefined) conn.lastSeenAt = now;
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  // Presence TTL: flip stale harnesses to "down", then evict; broadcast changes
  // so the browser reflects connection health. Poll harnesses refresh lastSeenAt
  // on each heartbeat; SSE harnesses refresh via the keepalive loop above.
  const prune = setInterval(() => {
    const now = Date.now();
    for (const runtime of sessions.values()) {
      let changed = false;
      for (const conn of [...runtime.harnesses.values()]) {
        const age = now - conn.lastSeenAt;
        if (conn.status === "live" && age > config.harnessDownMs) {
          // Going unresponsive abandons any edit lease it holds so the plan
          // unlocks immediately (the open round can be retargeted) rather than
          // staying locked by a dead harness until eviction.
          conn.status = "down";
          releaseLeaseIfHeldBy(runtime, conn.harnessId);
          changed = true;
        }
        if (age > config.harnessEvictMs) {
          runtime.harnesses.delete(conn.harnessId);
          conn.waiter?.();
          releaseLeaseIfHeldBy(runtime, conn.harnessId);
          changed = true;
        }
      }
      if (changed) broadcastPresence(runtime);
    }
  }, Math.max(5_000, Math.floor(config.harnessDownMs / 3)));
  prune.unref?.();

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
    const seq = ++runtime.eventSeq;
    // Push to all held streams (browser + SSE harnesses).
    for (const client of runtime.clients) writeEvent(client, event);
    // Targeted events also queue for the addressed poll harness (no held stream),
    // and wake any in-flight long-poll heartbeat it has open.
    const target = (event as { targetHarnessId?: string }).targetHarnessId;
    if (target) {
      const conn = runtime.harnesses.get(target);
      if (conn && conn.res === undefined) {
        conn.queue.push({ seq, event });
        if (conn.queue.length > 256) conn.queue.splice(0, conn.queue.length - 256);
        conn.waiter?.();
      }
    }
  };

  const presenceList = (runtime: SessionRuntime): HarnessPresence[] =>
    Array.from(runtime.harnesses.values()).map((c) => ({
      harnessId: c.harnessId,
      harnessType: c.harnessType,
      label: c.label,
      connectedAt: c.connectedAt,
      ...(c.lastActiveAt !== undefined ? { lastActiveAt: c.lastActiveAt } : {}),
      lastSeenAt: c.lastSeenAt,
      status: c.status,
      transport: c.transport,
      isDriver: c.harnessId === runtime.driverHarnessId,
    }));

  /**
   * Resolve which live harness feedback should route to:
   * user-chosen → driver → last-active → most-recently-active → most-recently-
   * attached → none. Only "live" harnesses are eligible.
   */
  const resolveTargetId = (runtime: SessionRuntime, chosen?: string): string | undefined => {
    const conns = runtime.harnesses;
    const live = (id?: string): boolean => id !== undefined && conns.get(id)?.status === "live";
    if (chosen && live(chosen)) return chosen;
    if (live(runtime.driverHarnessId)) return runtime.driverHarnessId;
    const last = runtime.session.lastActiveHarnessId;
    if (live(last)) return last;
    const arr = Array.from(conns.values()).filter((c) => c.status === "live");
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
      ...(runtime.editLease ? { editLease: runtime.editLease } : {}),
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
      ...(runtime.editLease ? { editLease: runtime.editLease } : {}),
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

  const harnessIdHeader = (req: { headers: Record<string, string | string[] | undefined> }): string | undefined => {
    const value = req.headers["x-planalot-harness-id"];
    return typeof value === "string" && value ? value : undefined;
  };

  /**
   * Enforce the single-writer invariant. Returns a 409 body when `harnessId`
   * may not mutate the plan: while a feedback round holds the edit lease, only
   * the addressed harness(es) may write; outside a round, only a live driver
   * may write (if one is designated). Returns null when the write is allowed.
   */
  const editLeaseViolation = (
    runtime: SessionRuntime | undefined,
    harnessId: string | undefined,
  ): { error: string; holder: string[]; feedbackRequestId?: string } | null => {
    if (!runtime) return null;
    const lease = runtime.editLease;
    if (lease) {
      if (harnessId && lease.holderHarnessIds.includes(harnessId)) return null;
      return {
        error: "Plan is locked to the addressed harness for the active feedback round.",
        holder: lease.holderHarnessIds,
        feedbackRequestId: lease.feedbackRequestId,
      };
    }
    const driverId = runtime.driverHarnessId;
    if (driverId) {
      const driver = runtime.harnesses.get(driverId);
      if (driver && driver.status === "live" && harnessId !== driverId) {
        return { error: "Plan edits are restricted to the driver harness.", holder: [driverId] };
      }
    }
    return null;
  };

  const releaseLeaseIfHeldBy = (runtime: SessionRuntime, harnessId: string): void => {
    const lease = runtime.editLease;
    if (!lease) return;
    const holders = lease.holderHarnessIds.filter((id) => id !== harnessId);
    runtime.editLease = holders.length === 0 ? undefined : { ...lease, holderHarnessIds: holders };
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
      let driverId: string | undefined;
      try {
        const manifest = await readManifest(id);
        session.cwd = workspacePath(manifest.id);
        session.absolutePlanPath = planFilePath(manifest.id, manifest.mainFile);
        session.planFile = manifest.name;
        driverId = manifest.harnesses.main?.id;
      } catch {
        // Keep the persisted session shape if no plan manifest is available.
      }
      const runtime = newRuntime(session, session.id);
      runtime.driverHarnessId = driverId;
      await attachWatcher(runtime);
      sessions.set(id, runtime);
      return runtime;
    } catch {
      try {
        const manifest = await readManifest(id);
        const session = normalizeSession(await sessionFromPlan(manifest));
        const runtime = newRuntime(session, manifest.id);
        runtime.driverHarnessId = manifest.harnesses.main?.id;
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
    const runtime = newRuntime(session, manifest.id);
    runtime.driverHarnessId = manifest.harnesses.main?.id;
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
    const manifest = await readManifest(planId);
    if (filePath === manifest.mainFile) {
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

  const createFeedbackItems = async (
    planId: string,
    body: FeedbackRequest,
    targetHarness?: HarnessRef,
  ): Promise<PlanFeedbackItem[]> => {
    const base = {
      kind: body.kind,
      ...(body.filePath ? { filePath: body.filePath } : {}),
      ...(body.layer ? { layer: body.layer } : {}),
      ...(body.targetHarnessId ? { targetHarnessId: body.targetHarnessId } : {}),
    } satisfies Omit<AddPlanFeedbackRequest, "text">;
    const annotations = Array.isArray(body.annotations) && body.annotations.length ? body.annotations : undefined;
    if (!annotations) {
      return [await addPlanFeedback(planId, { ...base, text: body.message }, targetHarness)];
    }

    const items: PlanFeedbackItem[] = [];
    for (const annotation of annotations) {
      const text = [
        annotation.comment?.trim() || annotation.label?.trim() || "Annotated feedback",
        body.message.trim() ? `\nSession note:\n${body.message.trim()}` : "",
      ].filter(Boolean).join("\n");
      items.push(await addPlanFeedback(planId, { ...base, text, annotations: [annotation] }, targetHarness));
    }
    if (body.message.trim() && items.length === 0) {
      items.push(await addPlanFeedback(planId, { ...base, text: body.message }, targetHarness));
    }
    return items;
  };

  const createFeedbackSession = async (
    planId: string,
    items: PlanFeedbackItem[],
    feedbackSessionId: string,
    requestMarkdown: string,
  ): Promise<NonNullable<PlanFeedbackStore["sessions"]>[number]> => {
    const store = await readFeedback(planId);
    store.sessions ??= [];
    const now = new Date().toISOString();
    const session = {
      id: feedbackSessionId,
      feedbackItemIds: items.map((item) => item.id),
      status: "open" as const,
      createdAt: now,
      updatedAt: now,
      requestMarkdown,
    };
    store.sessions.push(session);
    for (const item of store.items) {
      if (!session.feedbackItemIds.includes(item.id)) continue;
      item.feedbackSessionIds ??= [];
      if (!item.feedbackSessionIds.includes(session.id)) item.feedbackSessionIds.push(session.id);
      item.updatedAt = now;
    }
    await writeFeedback(planId, store);
    return session;
  };

  const applyFeedbackResult = async (runtime: SessionRuntime, rawResult: FeedbackResult): Promise<unknown> => {
    const store = await readFeedback(runtime.planId);
    store.sessions ??= [];
    store.responses ??= [];
    const feedbackSessionId = typeof rawResult?.feedbackSessionId === "string" ? rawResult.feedbackSessionId : "";
    const session = store.sessions.find((candidate) => candidate.id === feedbackSessionId);
    if (!session) throw new Error("feedback session not found");
    const validIds = new Set(session.feedbackItemIds);
    const now = new Date().toISOString();

    let result: FeedbackResult;
    try {
      result = validateFeedbackResultShape(rawResult, session.id, validIds);
    } catch (error) {
      session.status = "result-invalid";
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = now;
      for (const item of store.items) {
        if (validIds.has(item.id)) {
          item.status = "result-invalid";
          item.updatedAt = now;
        }
      }
      await writeFeedback(runtime.planId, store);
      return { ok: false, error: session.error, feedbackSession: session };
    }

    const changedIds = new Set<string>();
    for (const change of result.fileChanges ?? []) {
      for (const id of change.feedbackItemIds ?? []) changedIds.add(id);
      if (change.operation === "deleted") {
        await deletePlanFile(runtime.planId, change.path);
        await notifyFileChanged(runtime.planId, change.path);
        continue;
      }
      if (change.content !== undefined) {
        await upsertPlanFile(runtime.planId, { path: change.path, content: change.content });
        await notifyFileChanged(runtime.planId, change.path);
      } else if (change.alreadyApplied === true) {
        await notifyFileChanged(runtime.planId, change.path);
      }
    }

    const followUpIds = new Set<string>();
    const addressedByResponseIds = new Set<string>();
    const followUpRequests: FeedbackQuestionRequest[] = [];
    for (const response of result.responses ?? []) {
      store.responses.push(response);
      if (response.expectsUserFollowUp && response.kind === "question") {
        const request: FeedbackQuestionRequest = {
          id: response.id,
          planVersionId: latestVersion(runtime.session).id,
          questions: [
            {
              id: response.id,
              kind: response.suggestedAnswers?.length ? "single-select" : "text",
              prompt: response.text,
              required: true,
              ...(response.suggestedAnswers?.length
                ? {
                    suggestions: response.suggestedAnswers.map((answer) => ({
                      id: answer.id,
                      label: answer.label,
                      description: answer.description ?? answer.label,
                    })),
                  }
                : {}),
            },
          ],
          status: "requested",
          createdAt: Date.now(),
        };
        if (!runtime.session.feedbackRequests.some((candidate) => candidate.id === request.id)) {
          runtime.session.feedbackRequests.push(request);
          followUpRequests.push(request);
        }
      }
      for (const id of response.feedbackItemIds ?? []) {
        addressedByResponseIds.add(id);
        if (response.expectsUserFollowUp) followUpIds.add(id);
        const item = store.items.find((candidate) => candidate.id === id);
        if (item) {
          item.responseIds ??= [];
          if (!item.responseIds.includes(response.id)) item.responseIds.push(response.id);
        }
      }
    }

    const sessionHasUnscopedFollowUp = (result.responses ?? []).some((response) => response.expectsUserFollowUp && !response.feedbackItemIds?.length);
    for (const item of store.items) {
      if (!validIds.has(item.id)) continue;
      if (followUpIds.has(item.id)) {
        item.status = "needs-clarification";
      } else if (changedIds.has(item.id) || addressedByResponseIds.has(item.id)) {
        item.status = "resolved";
        item.resolvedAt = now;
      }
      item.updatedAt = now;
    }

    const unresolved = store.items.some((item) =>
      validIds.has(item.id) && (item.status === "open" || item.status === "needs-clarification" || item.status === "result-invalid")
    );
    session.status = unresolved || sessionHasUnscopedFollowUp ? "open" : "closed";
    session.result = result;
    delete session.error;
    session.updatedAt = now;
    await writeFeedback(runtime.planId, store);
    // Round closed → release the exclusive edit lease bound to it.
    if (session.status === "closed" && runtime.editLease?.feedbackRequestId === session.id) {
      runtime.editLease = undefined;
      broadcastPresence(runtime);
    }
    if (followUpRequests.length > 0) {
      runtime.session.updatedAt = Date.now();
      await persist(runtime.session);
      for (const request of followUpRequests) emit(runtime, { type: "feedback.requested", sessionId: runtime.session.id, request });
    }

    for (const item of store.items) {
      if (validIds.has(item.id)) emit(runtime, { type: "feedback.updated", sessionId: runtime.session.id, feedback: item });
    }
    return { ok: true, feedbackSession: session };
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

      const planFileMatch = url.pathname.match(/^\/plans\/([^/]+)\/files(?:\/(.+))?$/);
      if (planFileMatch) {
        const id = planFileMatch[1] ?? "";
        const filePath = planFileMatch[2] ? decodeURIComponent(planFileMatch[2]) : undefined;
        if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);

        if (filePath === undefined) {
          if (req.method === "GET") {
            sendJson(res, { files: await listPlanFiles(id) });
            return;
          }
          if (req.method === "POST") {
            if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
            const violation = editLeaseViolation(sessions.get(id), harnessIdHeader(req));
            if (violation) return sendJson(res, violation, 409);
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
          const violation = editLeaseViolation(sessions.get(id), harnessIdHeader(req));
          if (violation) return sendJson(res, violation, 409);
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
          const violation = editLeaseViolation(sessions.get(id), harnessIdHeader(req));
          if (violation) return sendJson(res, violation, 409);
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

      // Research sessions: plan-scoped, lease-EXEMPT investigations. Token auth
      // only — these routes never call editLeaseViolation, so many subagents can
      // resolve inquiries in parallel while the plan's own edit lease is held.
      const planResearchMatch = url.pathname.match(/^\/plans\/([^/]+)\/research(?:\/([^/]+)(?:\/(scope|inquiries)(?:\/([^/]+))?)?)?$/);
      if (planResearchMatch) {
        const id = planResearchMatch[1] ?? "";
        const rid = planResearchMatch[2];
        const sub = planResearchMatch[3];
        const iid = planResearchMatch[4];
        if (!authorize(url) && !authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);

        const emitResearchUpdated = async (research: ResearchSession): Promise<void> => {
          const runtime = await loadSession(id);
          if (runtime) emit(runtime, { type: "research.updated", sessionId: id, research });
        };

        // /plans/:id/research
        if (rid === undefined) {
          if (req.method === "GET") {
            sendJson(res, { research: await listResearch(id) });
            return;
          }
          if (req.method === "POST") {
            if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
            const body = await readJsonBody<CreateResearchRequest>(req);
            const research = await createResearch(id, body);
            await emitResearchUpdated(research);
            sendJson(res, { research }, 201);
            return;
          }
          return methodNotAllowed(res);
        }

        // /plans/:id/research/:rid
        if (sub === undefined) {
          if (req.method === "GET") {
            sendJson(res, { research: await readResearch(id, rid) });
            return;
          }
          if (req.method === "PATCH") {
            if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
            const body = await readJsonBody<UpdateResearchRequest>(req);
            const research = await updateResearchMeta(id, rid, body);
            await emitResearchUpdated(research);
            sendJson(res, { research });
            return;
          }
          return methodNotAllowed(res);
        }

        // /plans/:id/research/:rid/scope
        if (sub === "scope") {
          if (req.method !== "PUT") return methodNotAllowed(res);
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const body = await readJsonBody<UpdateResearchScopeRequest>(req);
          if (typeof body.scope !== "string") throw new Error("scope must be a string");
          const research = await updateResearchScope(id, rid, body.scope);
          await emitResearchUpdated(research);
          sendJson(res, { research });
          return;
        }

        // /plans/:id/research/:rid/inquiries[/:iid]
        if (iid === undefined) {
          if (req.method !== "POST") return methodNotAllowed(res);
          if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
          const body = await readJsonBody<AddInquiriesRequest>(req);
          const research = await addInquiries(id, rid, body);
          await emitResearchUpdated(research);
          sendJson(res, { research }, 201);
          return;
        }
        if (req.method !== "PATCH") return methodNotAllowed(res);
        if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
        const inquiryBody = await readJsonBody<UpdateInquiryRequest>(req);
        const { research, inquiry } = await updateInquiry(id, rid, iid, inquiryBody);
        const runtime = await loadSession(id);
        if (runtime) emit(runtime, { type: "research.inquiry.updated", sessionId: id, researchId: research.id, inquiry });
        sendJson(res, { research, inquiry });
        return;
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
        runtime.driverHarnessId = target.harnessId;
        broadcastPresence(runtime);
        sendJson(res, { manifest });
        return;
      }

      // Explicit attach / heartbeat / detach lifecycle for poll-based harnesses
      // (Claude Code, Codex). Presence is governed by this lifecycle + a TTL,
      // decoupled from any held stream. SSE harnesses (Pi) keep using /events.
      const harnessLifecycleMatch = url.pathname.match(/^\/plans\/([^/]+)\/harness\/(?:([^/]+)\/)?(attach|heartbeat|detach)$/);
      if (harnessLifecycleMatch) {
        const id = harnessLifecycleMatch[1] ?? "";
        const hid = harnessLifecycleMatch[2];
        const action = harnessLifecycleMatch[3];
        if (req.method !== "POST") return methodNotAllowed(res);
        if (!authorizeHeader(req)) return sendJson(res, { error: "Unauthorized" }, 401);
        const runtime = await loadSession(id);
        if (!runtime) return sendJson(res, { error: "Plan not found" }, 404);

        if (action === "attach") {
          const body = await readJsonBody<HarnessAttachRequest>(req).catch(() => ({} as HarnessAttachRequest));
          const harnessId = (typeof body.harnessId === "string" && body.harnessId) || randomUUID();
          const harnessType = isRuntime(body.harnessType) ? body.harnessType : runtime.session.runtime;
          const now = Date.now();
          const existing = runtime.harnesses.get(harnessId);
          // Name: explicit (provided) wins; else keep an existing name across
          // reconnects; else assign a friendly name unique among live harnesses.
          const providedLabel = typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;
          const label = providedLabel ?? existing?.label ?? (() => {
            const taken = new Set(Array.from(runtime.harnesses.values()).map((c) => c.label));
            for (let i = 0; i < 25; i += 1) {
              const candidate = generateHarnessName();
              if (!taken.has(candidate)) return candidate;
            }
            return `${generateHarnessName()}-${Math.floor(Math.random() * 1000)}`;
          })();
          const conn: HarnessConn = existing ?? {
            harnessId, harnessType, label,
            connectedAt: now, lastSeenAt: now, status: "live", transport: "poll", queue: [],
          };
          conn.harnessType = harnessType;
          conn.label = label;
          conn.lastSeenAt = now;
          conn.status = "live";
          if (conn.res === undefined) conn.transport = "poll";
          runtime.harnesses.set(harnessId, conn);

          // Resume cursor: a reattaching poll harness may have targeted events
          // queued during a window with no heartbeat in flight (e.g. an
          // --exit-on-feedback waiter between its exit and relaunch). Rewind to
          // just before the oldest undelivered event so the next heartbeat
          // replays them instead of skipping to the latest seq. Heartbeats prune
          // delivered events from the queue, so this never replays handled ones.
          // Fresh harnesses (empty queue) start at the current head.
          const resumeCursor = conn.queue.length > 0 ? conn.queue[0]!.seq - 1 : runtime.eventSeq;

          // Honor a drive request only when no live driver is already designated.
          const currentDriver = runtime.driverHarnessId ? runtime.harnesses.get(runtime.driverHarnessId) : undefined;
          if (body.drive === true && (!runtime.driverHarnessId || currentDriver?.status !== "live")) {
            runtime.driverHarnessId = harnessId;
            await setMainHarness(id, harnessRefFromConn(conn));
          }
          await setPlanHarnessActive(id, harnessRefFromConn(conn));
          broadcastPresence(runtime);
          const role: HarnessRole = runtime.driverHarnessId === harnessId ? "driver" : "peer";
          sendJson(res, {
            harnessId,
            label,
            role,
            roster: presenceList(runtime),
            cursor: resumeCursor,
            ...(runtime.editLease ? { editLease: runtime.editLease } : {}),
          });
          return;
        }

        if (!hid) return sendJson(res, { error: "harness id is required" }, 400);
        const conn = runtime.harnesses.get(hid);

        if (action === "detach") {
          if (conn) {
            runtime.harnesses.delete(hid);
            conn.waiter?.();
            releaseLeaseIfHeldBy(runtime, hid);
            broadcastPresence(runtime);
          }
          sendJson(res, { ok: true });
          return;
        }

        // action === "heartbeat": refresh liveness and long-poll for events.
        if (!conn) return sendJson(res, { error: "Harness not attached", reattach: true }, 404);
        const body = await readJsonBody<HarnessHeartbeatRequest>(req).catch(() => ({} as HarnessHeartbeatRequest));
        conn.lastSeenAt = Date.now();
        conn.status = "live";
        const cursor = typeof body.cursor === "number" ? body.cursor : 0;
        const waitMs = Math.max(0, Math.min(Number(body.waitMs) || 0, config.longPollMs));
        const drain = (): QueuedEvent[] => conn.queue.filter((q) => q.seq > cursor);

        let pending = drain();
        if (pending.length === 0 && waitMs > 0) {
          pending = await new Promise<QueuedEvent[]>((resolve) => {
            let settled = false;
            const finish = (items: QueuedEvent[]): void => {
              if (settled) return;
              settled = true;
              conn.waiter = undefined;
              clearTimeout(timer);
              resolve(items);
            };
            const timer = setTimeout(() => finish([]), waitMs);
            timer.unref?.();
            conn.waiter = () => finish(drain());
            req.once("close", () => finish([]));
          });
          conn.lastSeenAt = Date.now();
        }

        const maxSeq = pending.length ? pending[pending.length - 1]!.seq : cursor;
        conn.queue = conn.queue.filter((q) => q.seq > maxSeq);
        const role: HarnessRole = runtime.driverHarnessId === hid ? "driver" : "peer";
        sendJson(res, {
          harnessId: hid,
          role,
          roster: presenceList(runtime),
          events: pending.map((q) => q.event),
          cursor: maxSeq,
          ...(runtime.editLease ? { editLease: runtime.editLease } : {}),
        });
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
            runtime.harnesses.set(harnessId, {
              harnessId,
              harnessType,
              label,
              connectedAt,
              lastSeenAt: connectedAt,
              status: "live",
              transport: "sse",
              res,
              queue: [],
            });
            await setPlanHarnessActive(id, { id: harnessId, type: harnessType, label, connectedAt: new Date(connectedAt).toISOString() });
            broadcastPresence(runtime);
          } else {
            writeEvent(res, presenceEvent(runtime));
          }
          req.once("close", () => {
            runtime.clients.delete(res);
            if (harnessId && runtime.harnesses.get(harnessId)?.res === res) {
              runtime.harnesses.delete(harnessId);
              releaseLeaseIfHeldBy(runtime, harnessId);
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

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(events|feedback|feedback-result|agent-message|feedback-requested|feedback-answered|plan-updated|accept|build))?$/);
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
            runtime.harnesses.set(harnessId, {
              harnessId,
              harnessType,
              label,
              connectedAt,
              lastSeenAt: connectedAt,
              status: "live",
              transport: "sse",
              res,
              queue: [],
            });
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
              releaseLeaseIfHeldBy(runtime, harnessId);
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
          const manifest = await readManifest(runtime.planId);
          const feedbackItems = await createFeedbackItems(runtime.planId, body, resolveHarnessRef(runtime, chosen));
          for (const feedback of feedbackItems) emit(runtime, { type: "feedback.added", sessionId: id, feedback });
          const feedbackSessionId = `fs_${randomUUID()}`;
          const requestMarkdown = buildFeedbackRequestMarkdown(manifest, feedbackItems, feedbackSessionId);
          const feedbackSession = await createFeedbackSession(runtime.planId, feedbackItems, feedbackSessionId, requestMarkdown);
          const message: ConversationMessage = {
            id: randomUUID(),
            role: "user",
            kind: body.kind,
            text: requestMarkdown,
            ...(annotations === undefined ? {} : { annotations }),
            createdAt: Date.now(),
          };
          const batch = createFeedbackBatch(runtime.session, message);
          runtime.session.messages.push(message);
          runtime.session.feedbackBatches.push(batch);

          if (targetId) {
            // A connected harness owns this send — deliver only to it (tagged),
            // and lease the plan's edit rights exclusively to it for this round.
            runtime.editLease = { holderHarnessIds: [targetId], feedbackRequestId: feedbackSessionId, grantedAt: Date.now() };
            runtime.session.status = "agent-processing";
            runtime.session.updatedAt = Date.now();
            await persist(runtime.session);
            emit(runtime, { type: "feedback.sent", sessionId: id, message, batch, targetHarnessId: targetId });
            emit(runtime, { type: "feedback.submitted", sessionId: id, batch });
            emit(runtime, { type: "session.status", sessionId: id, status: runtime.session.status });
            broadcastPresence(runtime);
            sendJson(res, { ok: true, message, batch, feedbackSession, delivered: true, targetHarnessId: targetId });
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
            sendJson(res, { ok: true, message, batch, feedbackSession, delivered: true });
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
          sendJson(res, { ok: true, message, batch, feedbackSession, delivered: false });
          return;
        }

        if (action === "feedback-result") {
          if (req.method !== "POST") return methodNotAllowed(res);
          const violation = editLeaseViolation(runtime, harnessIdHeader(req));
          if (violation) return sendJson(res, violation, 409);
          const body = await readJsonBody<FeedbackResultRequest>(req);
          const applied = await applyFeedbackResult(runtime, body.result);
          sendJson(res, applied);
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
        clearInterval(prune);
        for (const runtime of sessions.values()) {
          clearTimeout(runtime.watchTimer);
          clearTimeout(runtime.harnessTimer);
          for (const conn of runtime.harnesses.values()) conn.waiter?.();
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

function buildFeedbackRequestMarkdown(manifest: PlanManifest, items: PlanFeedbackItem[], feedbackSessionId: string): string {
  const filesByLayer = new Map(planLayers().map((layer) => [layer, manifest.files.filter((file) => file.layer === layer)]));
  const itemsByLayer = new Map(planLayers().map((layer) => [layer, items.filter((item) => (item.layer ?? (item.filePath ? layerForPath(item.filePath) : "requirements")) === layer)]));
  return [
    "# Planalot Feedback Request",
    "",
    "Protocol: `planalot.feedback_request.v1`",
    "Expected result: `planalot.feedback_result.v1`",
    "",
    `Plan: ${manifest.name}`,
    `Plan ID: ${manifest.id}`,
    `Feedback Session ID: ${feedbackSessionId}`,
    "",
    "## Harness Context",
    "",
    "You are connected to Planalot as an LLM harness. If your runtime supports a Planalot skill, plugin, or local harness instructions, load or consult them before acting.",
    "",
    "This request is self-contained for the current feedback session. If prior context was compacted or lost, treat this request plus the Planalot files as the source of truth.",
    "",
    "Planalot owns the plan workspace. Use Planalot file access/write mechanisms when you need more context or need to update files.",
    "",
    "Return only valid JSON matching `planalot.feedback_result.v1`.",
    "",
    "## Layer Model",
    "",
    "Resolve top-down: `requirements/` -> `design/` -> `tasks/`.",
    "",
    "`requirements/`: goals, business rules, constraints, acceptance criteria, non-goals, open questions.",
    "`design/`: architecture, UX flows, data model, APIs, tradeoffs, risks, rejected alternatives.",
    "`tasks/`: implementation slices, dependencies, file ownership, verification commands, rollout notes.",
    "",
    "If requirements change, reconcile design/tasks. If design changes, reconcile tasks. Do not silently change requirements because of downstream feedback.",
    "",
    "## Available Files",
    "",
    ...planLayers().flatMap((layer) => [
      `### ${layerTitle(layer)}`,
      "",
      ...(filesByLayer.get(layer)?.length
        ? filesByLayer.get(layer)!.map((file) => `- \`${file.path}\``)
        : ["- No files"]),
      "",
    ]),
    "You may retrieve full files or nearby context from Planalot if the selected text below is insufficient.",
    "",
    "## Feedback Items",
    "",
    ...planLayers().flatMap((layer) => {
      const layerItems = itemsByLayer.get(layer) ?? [];
      return [
        `### ${layerTitle(layer)} Feedback`,
        "",
        ...(layerItems.length ? layerItems.flatMap(formatFeedbackItem) : ["No feedback in this layer.", ""]),
      ];
    }),
    "## Required Result Format",
    "",
    "Return only valid JSON matching this shape:",
    "",
    "```json",
    JSON.stringify({
      schemaVersion: 1,
      feedbackSessionId,
      fileChanges: [
        {
          path: "requirements/index.md",
          operation: "updated",
          feedbackItemIds: ["fb_example"],
          content: "optional full file content when Planalot should apply the change",
          alreadyApplied: false,
        },
      ],
      responses: [
        {
          id: "r_example",
          kind: "question",
          feedbackItemIds: ["fb_example"],
          layer: "requirements",
          text: "Question, clarification, or insight text.",
          expectsUserFollowUp: true,
          suggestedAnswers: [
            { id: "answer_a", label: "Suggested answer", description: "Optional detail." },
          ],
        },
      ],
    }, null, 2),
    "```",
    "",
    "Rules:",
    "",
    "- Use `fileChanges` for plan file edits.",
    "- Use `responses` for clarification text, questions, or synthesized insight.",
    "- A response may reference one, many, or no feedback items.",
    "- Set `expectsUserFollowUp: true` only when Planalot should keep the session open waiting for the user.",
    "- If you ask a question, include suggested answers when useful.",
    "- Return JSON only. No markdown outside the JSON object.",
  ].join("\n");
}

function formatFeedbackItem(item: PlanFeedbackItem): string[] {
  const selectedText = item.annotations?.map((annotation) => annotation.originalText).filter(Boolean).join("\n\n");
  return [
    `#### \`${item.id}\``,
    "",
    `File: ${item.filePath ? `\`${item.filePath}\`` : "not provided"}`,
    "Lines: not provided",
    "",
    "User comment:",
    "",
    blockquote(item.text),
    "",
    selectedText ? "Selected text:" : "Selected text: not provided",
    selectedText ? "" : "",
    ...(selectedText ? ["```md", selectedText, "```", ""] : []),
  ];
}

function blockquote(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function layerTitle(layer: string): string {
  return layer.slice(0, 1).toUpperCase() + layer.slice(1);
}

const NAME_ADJECTIVES = [
  "amber", "brisk", "clever", "dapper", "eager", "fleet", "golden", "hardy",
  "ivory", "jolly", "keen", "lucid", "merry", "nimble", "opal", "prime",
  "quiet", "rapid", "sage", "tidy", "umber", "vivid", "warm", "zesty",
];
const NAME_ANIMALS = [
  "otter", "falcon", "lynx", "heron", "marten", "ibex", "raven", "panda",
  "tapir", "egret", "bison", "gecko", "koala", "lemur", "civet", "shrew",
  "finch", "moose", "quail", "stoat", "viper", "wren", "yak", "zebu",
];

function generateHarnessName(): string {
  const adjective = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)] ?? "amber";
  const animal = NAME_ANIMALS[Math.floor(Math.random() * NAME_ANIMALS.length)] ?? "otter";
  return `${adjective}-${animal}`;
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
    fileLines || "- requirements/index.md: Canonical requirements and planning entrypoint",
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
