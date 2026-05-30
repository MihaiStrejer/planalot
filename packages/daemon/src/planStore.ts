import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type {
  AddPlanFeedbackRequest,
  CreatePlanRequest,
  HarnessRef,
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
import { validateWorkspaceFileName } from "./security.js";

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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
    mainFile: "index.md",
    origin: body.origin,
    harnesses: {
      ...(body.harness ? { lastActive: body.harness } : {}),
    },
    files: [
      {
        path: "index.md",
        type: "markdown",
        title: "Main Plan",
        purpose: "Canonical plan body",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };

  await writeFile(planFilePath(id, "index.md"), indexText, { mode: 0o600 });
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
  return JSON.parse(await readFile(planManifestPath(id), "utf8")) as PlanManifest;
}

export async function writeManifest(manifest: PlanManifest): Promise<void> {
  await mkdir(planDir(manifest.id), { recursive: true, mode: 0o700 });
  await writeFile(planManifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export async function readFeedback(id: string): Promise<PlanFeedbackStore> {
  try {
    const store = JSON.parse(await readFile(planFeedbackPath(id), "utf8")) as PlanFeedbackStore;
    store.items ??= [];
    return store;
  } catch {
    return { items: [] };
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
  const now = new Date().toISOString();
  let entry = manifest.files.find((candidate) => candidate.path === clean);
  if (!entry) {
    entry = {
      path: clean,
      type: fileType(clean),
      title: body.title?.trim() || titleFromFileName(clean),
      purpose: body.purpose?.trim() || "Planning artifact",
      createdAt: now,
      updatedAt: now,
    };
    manifest.files.push(entry);
  } else {
    if (body.title !== undefined) entry.title = body.title.trim() || entry.title;
    if (body.purpose !== undefined) entry.purpose = body.purpose.trim() || entry.purpose;
    entry.updatedAt = now;
  }

  await writeFile(planFilePath(id, clean), body.content, { mode: 0o600 });
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
  if (clean === "index.md") throw new Error("index.md cannot be deleted");
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
  if (body.filePath !== undefined) validateWorkspaceFileName(body.filePath);
  const store = await readFeedback(id);
  const now = new Date().toISOString();
  const item: PlanFeedbackItem = {
    id: `fb_${randomUUID()}`,
    kind: body.kind,
    status: "open",
    text: body.text,
    ...(body.filePath ? { filePath: body.filePath } : {}),
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
  return store.items.some((item) => item.status === "open");
}

export function workspacePath(id: string): string {
  return planDir(id);
}

function touchManifest(manifest: PlanManifest, now = new Date().toISOString()): void {
  manifest.updatedAt = now;
  manifest.expiresAt = new Date(Date.parse(now) + EXPIRY_MS).toISOString();
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
