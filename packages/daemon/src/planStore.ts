import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type {
  AddPlanFeedbackRequest,
  CreatePlanRequest,
  FeedbackResult,
  HarnessRef,
  PlanLayer,
  PlanFeedbackItem,
  PlanFeedbackStore,
  PlanFileEntry,
  PlanManifest,
  PlanStatus,
  PlanSummary,
  PlanWorkspaceView,
  UpdatePlanFeedbackRequest,
  UpdatePlanFileMetadataRequest,
  UpdatePlanMetadataRequest,
  UpsertPlanFileRequest,
} from "@planalot/shared";
import {
  planDir,
  planFeedbackPath,
  planFilePath,
  planManifestPath,
  plansDir,
} from "./fsPaths.js";
import { isPlanLayer, layerFromWorkspaceFileName, validateWorkspaceFileName } from "./security.js";

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAIN_PLAN_FILE = "requirements/index.md";
const PLAN_LAYERS: readonly PlanLayer[] = ["requirements", "design", "tasks"];

export function effectivePlanStatus(manifest: PlanManifest, now = Date.now()): PlanStatus {
  if (manifest.status !== "planning") return manifest.status;
  return Date.parse(manifest.updatedAt) + EXPIRY_MS < now ? "expired" : manifest.status;
}

export async function createPlanWorkspace(body: CreatePlanRequest): Promise<PlanManifest> {
  const id = await createShortPlanId();
  const now = new Date().toISOString();
  const workspace = planDir(id);
  await mkdir(workspace, { recursive: true, mode: 0o700 });

  const indexText = await initialIndexText(body);
  const name = body.name?.trim() || inferPlanName(indexText) || "Untitled Plan";
  const manifest: PlanManifest = {
    id,
    name,
    status: "planning",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + EXPIRY_MS).toISOString(),
    mainFile: MAIN_PLAN_FILE,
    origin: body.origin,
    harnesses: {
      ...(body.harness ? { lastActive: body.harness } : {}),
    },
    files: [
      {
        path: MAIN_PLAN_FILE,
        layer: "requirements",
        type: "markdown",
        title: "Main Plan",
        purpose: "Canonical requirements and planning entrypoint",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };

  await writePlanFile(id, MAIN_PLAN_FILE, indexText);
  await writeFeedback(id, { items: [] });
  await writeManifest(manifest);
  return manifest;
}

export async function listPlans(options: {
  query?: string;
  statuses?: PlanStatus[];
  includeExpired?: boolean;
  limit?: number;
}): Promise<PlanSummary[]> {
  await mkdir(plansDir(), { recursive: true, mode: 0o700 });
  const ids = await readdir(plansDir()).catch(() => []);
  const summaries: PlanSummary[] = [];
  const query = options.query?.trim().toLowerCase();
  const statuses = options.statuses?.length ? new Set(options.statuses) : new Set<PlanStatus>(["planning"]);

  for (const id of ids) {
    const manifest = await readManifest(id).catch(() => null);
    if (!manifest) continue;
    const feedback = await readFeedback(id).catch(() => ({ items: [] }));
    const effectiveStatus = effectivePlanStatus(manifest);
    if (!options.includeExpired && effectiveStatus === "expired") continue;
    if (!statuses.has(effectiveStatus)) continue;
    if (query && !matchesPlanQuery(manifest, query)) continue;
    summaries.push(toSummary(manifest, feedback, effectiveStatus));
  }

  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return summaries.slice(0, options.limit ?? 50);
}

export async function readPlanView(id: string): Promise<PlanWorkspaceView> {
  const manifest = await readManifest(id);
  const feedback = await readFeedback(id);
  return {
    manifest,
    effectiveStatus: effectivePlanStatus(manifest),
    workspacePath: planDir(id),
    feedback,
  };
}

export async function readManifest(id: string): Promise<PlanManifest> {
  const manifest = JSON.parse(await readFile(planManifestPath(id), "utf8")) as PlanManifest;
  return await normalizeManifest(id, manifest);
}

export async function writeManifest(manifest: PlanManifest): Promise<void> {
  await mkdir(planDir(manifest.id), { recursive: true, mode: 0o700 });
  await writeFile(planManifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export async function readFeedback(id: string): Promise<PlanFeedbackStore> {
  try {
    const store = JSON.parse(await readFile(planFeedbackPath(id), "utf8")) as PlanFeedbackStore;
    store.items ??= [];
    store.sessions ??= [];
    store.responses ??= [];
    return store;
  } catch {
    return { items: [], sessions: [], responses: [] };
  }
}

export async function writeFeedback(id: string, store: PlanFeedbackStore): Promise<void> {
  await mkdir(planDir(id), { recursive: true, mode: 0o700 });
  await writeFile(planFeedbackPath(id), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export async function updatePlanMetadata(id: string, patch: UpdatePlanMetadataRequest): Promise<PlanManifest> {
  const manifest = await readManifest(id);
  if (patch.name !== undefined) manifest.name = patch.name.trim() || manifest.name;
  if (patch.status !== undefined) manifest.status = patch.status;
  touchManifest(manifest);
  await writeManifest(manifest);
  return manifest;
}

export async function reopenPlan(id: string): Promise<PlanManifest> {
  return updatePlanMetadata(id, { status: "planning" });
}

export async function listPlanFiles(id: string): Promise<PlanFileEntry[]> {
  const manifest = await readManifest(id);
  return manifest.files;
}

export async function readPlanFile(id: string, filePath: string): Promise<{ entry: PlanFileEntry; content: string }> {
  const clean = validateWorkspaceFileName(filePath);
  const manifest = await readManifest(id);
  const entry = findFileEntry(manifest, clean);
  return { entry, content: await readFile(planFilePath(id, clean), "utf8") };
}

export async function readAllPlanFiles(id: string): Promise<Array<{ entry: PlanFileEntry; content: string }>> {
  const manifest = await readManifest(id);
  const files = [];
  for (const entry of manifest.files) {
    files.push({ entry, content: await readFile(planFilePath(id, entry.path), "utf8") });
  }
  return files;
}

export async function upsertPlanFile(id: string, body: UpsertPlanFileRequest): Promise<PlanFileEntry> {
  const clean = validateWorkspaceFileName(body.path);
  const manifest = await readManifest(id);
  const layer = layerFromWorkspaceFileName(clean);
  const now = new Date().toISOString();
  let entry = manifest.files.find((candidate) => candidate.path === clean);
  if (!entry) {
    entry = {
      path: clean,
      layer,
      type: fileType(clean),
      title: body.title?.trim() || titleFromFileName(clean),
      purpose: body.purpose?.trim() || "Planning artifact",
      createdAt: now,
      updatedAt: now,
    };
    manifest.files.push(entry);
  } else {
    entry.layer = layer;
    if (body.title !== undefined) entry.title = body.title.trim() || entry.title;
    if (body.purpose !== undefined) entry.purpose = body.purpose.trim() || entry.purpose;
    entry.updatedAt = now;
  }

  await writePlanFile(id, clean, body.content);
  touchManifest(manifest, now);
  await writeManifest(manifest);
  return entry;
}

export async function updatePlanFileMetadata(id: string, filePath: string, patch: UpdatePlanFileMetadataRequest): Promise<PlanFileEntry> {
  const clean = validateWorkspaceFileName(filePath);
  const manifest = await readManifest(id);
  const entry = findFileEntry(manifest, clean);
  if (patch.title !== undefined) entry.title = patch.title.trim() || entry.title;
  if (patch.purpose !== undefined) entry.purpose = patch.purpose.trim() || entry.purpose;
  entry.updatedAt = new Date().toISOString();
  touchManifest(manifest, entry.updatedAt);
  await writeManifest(manifest);
  return entry;
}

export async function deletePlanFile(id: string, filePath: string): Promise<PlanManifest> {
  const clean = validateWorkspaceFileName(filePath);
  if (clean === MAIN_PLAN_FILE) throw new Error(`${MAIN_PLAN_FILE} cannot be deleted`);
  const manifest = await readManifest(id);
  const before = manifest.files.length;
  manifest.files = manifest.files.filter((entry) => entry.path !== clean);
  if (manifest.files.length === before) throw new Error("plan file not found");
  await rm(planFilePath(id, clean), { force: true });
  touchManifest(manifest);
  await writeManifest(manifest);
  return manifest;
}

export async function addPlanFeedback(id: string, body: AddPlanFeedbackRequest, targetHarness?: HarnessRef): Promise<PlanFeedbackItem> {
  if (!body.text.trim()) throw new Error("feedback text is required");
  const cleanFilePath = body.filePath !== undefined ? validateWorkspaceFileName(body.filePath) : undefined;
  const layer = body.layer ?? (cleanFilePath ? layerFromWorkspaceFileName(cleanFilePath) : undefined);
  if (layer !== undefined && !isPlanLayer(layer)) throw new Error("feedback layer must be requirements, design, or tasks");
  const store = await readFeedback(id);
  const now = new Date().toISOString();
  const item: PlanFeedbackItem = {
    id: `fb_${randomUUID()}`,
    kind: body.kind,
    status: "open",
    text: body.text,
    ...(layer ? { layer } : {}),
    ...(cleanFilePath ? { filePath: cleanFilePath } : {}),
    ...(body.annotations?.length ? { annotations: body.annotations } : {}),
    ...(targetHarness ? { targetHarness } : {}),
    createdAt: now,
    updatedAt: now,
  };
  store.items.push(item);
  await writeFeedback(id, store);
  const manifest = await readManifest(id);
  touchManifest(manifest, now);
  await writeManifest(manifest);
  return item;
}

export async function updatePlanFeedback(id: string, feedbackId: string, patch: UpdatePlanFeedbackRequest): Promise<PlanFeedbackItem> {
  const store = await readFeedback(id);
  const item = store.items.find((candidate) => candidate.id === feedbackId);
  if (!item) throw new Error("feedback item not found");
  const now = new Date().toISOString();
  if (patch.status !== undefined) {
    item.status = patch.status;
    if (patch.status === "resolved" || patch.status === "dismissed") item.resolvedAt = now;
  }
  if (patch.resolution !== undefined) item.resolution = patch.resolution;
  item.updatedAt = now;
  await writeFeedback(id, store);
  const manifest = await readManifest(id);
  touchManifest(manifest, now);
  await writeManifest(manifest);
  return item;
}

export async function setPlanHarnessActive(id: string, harness: HarnessRef): Promise<PlanManifest> {
  const manifest = await readManifest(id);
  manifest.harnesses.lastActive = harness;
  touchManifest(manifest);
  await writeManifest(manifest);
  return manifest;
}

export async function setMainHarness(id: string, harness: HarnessRef): Promise<PlanManifest> {
  const manifest = await readManifest(id);
  manifest.harnesses.main = harness;
  touchManifest(manifest);
  await writeManifest(manifest);
  return manifest;
}

export function hasOpenFeedback(store: PlanFeedbackStore): boolean {
  return store.items.some((item) => item.status === "open" || item.status === "needs-clarification" || item.status === "result-invalid");
}

export function workspacePath(id: string): string {
  return planDir(id);
}

function touchManifest(manifest: PlanManifest, now = new Date().toISOString()): void {
  manifest.updatedAt = now;
  manifest.expiresAt = new Date(Date.parse(now) + EXPIRY_MS).toISOString();
}

export function layerForPath(path: string): PlanLayer {
  return layerFromWorkspaceFileName(path);
}

export function planLayers(): readonly PlanLayer[] {
  return PLAN_LAYERS;
}

export function validateFeedbackResultShape(result: unknown, feedbackSessionId: string, validFeedbackIds: Set<string>): FeedbackResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("feedback result must be an object");
  const candidate = result as FeedbackResult;
  if (candidate.schemaVersion !== 1) throw new Error("feedback result schemaVersion must be 1");
  if (candidate.feedbackSessionId !== feedbackSessionId) throw new Error("feedback result session id does not match");
  if (candidate.fileChanges !== undefined) {
    if (!Array.isArray(candidate.fileChanges)) throw new Error("feedback result fileChanges must be an array");
    for (const change of candidate.fileChanges) {
      validateWorkspaceFileName(change.path);
      if (change.operation !== "created" && change.operation !== "updated" && change.operation !== "deleted") {
        throw new Error("feedback result fileChanges operation is invalid");
      }
      if (change.content !== undefined && typeof change.content !== "string") throw new Error("feedback result file change content must be a string");
      if (change.alreadyApplied !== undefined && typeof change.alreadyApplied !== "boolean") throw new Error("feedback result alreadyApplied must be boolean");
      if ((change.operation === "created" || change.operation === "updated") && change.content === undefined && change.alreadyApplied !== true) {
        throw new Error("created/updated fileChanges require content or alreadyApplied true");
      }
      if (change.operation === "deleted" && change.content !== undefined) throw new Error("deleted fileChanges must not include content");
      validateFeedbackIds(change.feedbackItemIds, validFeedbackIds);
    }
  }
  if (candidate.responses !== undefined) {
    if (!Array.isArray(candidate.responses)) throw new Error("feedback result responses must be an array");
    for (const response of candidate.responses) {
      if (typeof response.id !== "string" || !response.id.trim()) throw new Error("feedback response id is required");
      if (response.kind !== "clarification" && response.kind !== "question" && response.kind !== "insight") {
        throw new Error("feedback response kind is invalid");
      }
      if (response.layer !== undefined && !isPlanLayer(response.layer)) throw new Error("feedback response layer is invalid");
      if (typeof response.text !== "string" || !response.text.trim()) throw new Error("feedback response text is required");
      if (typeof response.expectsUserFollowUp !== "boolean") throw new Error("feedback response expectsUserFollowUp must be boolean");
      validateFeedbackIds(response.feedbackItemIds, validFeedbackIds);
      if (response.suggestedAnswers !== undefined) {
        if (!Array.isArray(response.suggestedAnswers)) throw new Error("feedback response suggestedAnswers must be an array");
        for (const answer of response.suggestedAnswers) {
          if (typeof answer.id !== "string" || !answer.id.trim()) throw new Error("suggested answer id is required");
          if (typeof answer.label !== "string" || !answer.label.trim()) throw new Error("suggested answer label is required");
          if (answer.description !== undefined && typeof answer.description !== "string") throw new Error("suggested answer description must be a string");
        }
      }
    }
  }
  return candidate;
}

function validateFeedbackIds(ids: string[] | undefined, validFeedbackIds: Set<string>): void {
  if (ids === undefined) return;
  if (!Array.isArray(ids)) throw new Error("feedbackItemIds must be an array");
  for (const id of ids) {
    if (typeof id !== "string" || !validFeedbackIds.has(id)) throw new Error(`unknown feedback item id: ${id}`);
  }
}

async function initialIndexText(body: CreatePlanRequest): Promise<string> {
  if (body.origin.kind === "blank") return body.indexText ?? "# Plan\n";
  if (body.origin.kind === "text-import") return body.indexText ?? "# Plan\n";
  const source = resolve(body.origin.sourcePath);
  return await readFile(source, "utf8");
}

async function createShortPlanId(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const id = randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 7);
    if (id.length >= 5 && !existsSync(planDir(id))) return id;
  }
  throw new Error("failed to allocate plan id");
}

function inferPlanName(text: string): string | undefined {
  const heading = text.split(/\r?\n/).find((line) => line.trim().startsWith("# "));
  return heading?.replace(/^#\s+/, "").trim() || undefined;
}

function findFileEntry(manifest: PlanManifest, clean: string): PlanFileEntry {
  const entry = manifest.files.find((candidate) => candidate.path === clean);
  if (!entry) throw new Error("plan file not found");
  return entry;
}

async function normalizeManifest(id: string, manifest: PlanManifest): Promise<PlanManifest> {
  let changed = false;
  const seen = new Set<string>();
  const files: PlanFileEntry[] = [];
  for (const entry of manifest.files ?? []) {
    const currentPath = entry.path;
    const nextPath = isLayeredPath(currentPath) ? validateWorkspaceFileName(currentPath) : layeredPathForLegacyFile(currentPath);
    const layer = layerFromWorkspaceFileName(nextPath);
    if (currentPath !== nextPath) {
      await moveLegacyPlanFile(id, currentPath, nextPath);
      changed = true;
    }
    if (entry.layer !== layer) changed = true;
    if (seen.has(nextPath)) {
      changed = true;
      continue;
    }
    seen.add(nextPath);
    files.push({ ...entry, path: nextPath, layer });
  }

  if (files.length === 0) {
    const now = new Date().toISOString();
    files.push({
      path: MAIN_PLAN_FILE,
      layer: "requirements",
      type: "markdown",
      title: "Main Plan",
      purpose: "Canonical requirements and planning entrypoint",
      createdAt: manifest.createdAt ?? now,
      updatedAt: manifest.updatedAt ?? now,
    });
    changed = true;
  }

  const nextMainFile = isLayeredPath(manifest.mainFile) ? validateWorkspaceFileName(manifest.mainFile) : MAIN_PLAN_FILE;
  if (manifest.mainFile !== nextMainFile) changed = true;
  manifest.mainFile = nextMainFile;
  manifest.files = files.sort((a, b) => PLAN_LAYERS.indexOf(a.layer) - PLAN_LAYERS.indexOf(b.layer) || a.path.localeCompare(b.path));

  if (changed) await writeManifest(manifest);
  return manifest;
}

function isLayeredPath(path: string): boolean {
  try {
    validateWorkspaceFileName(path);
    return true;
  } catch {
    return false;
  }
}

function layeredPathForLegacyFile(path: string): string {
  const clean = basename(path);
  if (clean !== path || clean.startsWith(".") || clean.includes("..")) throw new Error(`invalid legacy plan file path: ${path}`);
  const ext = extname(clean).toLowerCase();
  if (ext !== ".md" && ext !== ".html") throw new Error(`invalid legacy plan file extension: ${path}`);
  return `${inferLegacyLayer(clean)}/${clean}`;
}

function inferLegacyLayer(fileName: string): PlanLayer {
  const lower = fileName.toLowerCase();
  if (lower === "index.md" || lower.startsWith("requirements") || lower.startsWith("requirement") || lower.startsWith("spec")) return "requirements";
  if (lower.startsWith("task") || lower.startsWith("todo") || lower.startsWith("implementation")) return "tasks";
  return "design";
}

async function moveLegacyPlanFile(id: string, oldPath: string, nextPath: string): Promise<void> {
  const source = planFilePath(id, oldPath);
  const target = planFilePath(id, nextPath);
  if (!existsSync(source)) return;
  if (existsSync(target)) return;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rename(source, target);
}

async function writePlanFile(id: string, path: string, content: string): Promise<void> {
  const target = planFilePath(id, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
}

function fileType(path: string): "markdown" | "html" {
  return extname(path).toLowerCase() === ".html" ? "html" : "markdown";
}

function titleFromFileName(path: string): string {
  const name = basename(path, extname(path)).replace(/[-_]+/g, " ");
  return name.replace(/\b\w/g, (char) => char.toUpperCase());
}

function matchesPlanQuery(manifest: PlanManifest, query: string): boolean {
  const haystack = [
    manifest.id,
    manifest.name,
    ...manifest.files.flatMap((file) => [file.path, file.title, file.purpose]),
  ].join("\n").toLowerCase();
  return haystack.includes(query);
}

function toSummary(manifest: PlanManifest, feedback: PlanFeedbackStore, effectiveStatus: PlanStatus): PlanSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    status: manifest.status,
    effectiveStatus,
    updatedAt: manifest.updatedAt,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    mainFile: manifest.mainFile,
    workspacePath: planDir(manifest.id),
    files: manifest.files,
    openFeedbackCount: feedback.items.filter((item) => item.status === "open").length,
  };
}
