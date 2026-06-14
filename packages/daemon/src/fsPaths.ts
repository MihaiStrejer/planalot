import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonMetadata {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export const APP_NAME = "planalot";
export const APP_VERSION = "0.1.0";

export function dataDir(): string {
  // PLANALOT_DATA_DIR isolates planalot's data root WITHOUT moving HOME — so an
  // isolated test daemon (and the `planalot` commands a harness spawns) can use a
  // throwaway dir while the harness keeps reading its real auth from the real HOME.
  return process.env.PLANALOT_DATA_DIR || join(homedir(), ".planalot");
}

export function daemonMetadataPath(): string {
  return join(dataDir(), "daemon.json");
}

export function sessionsDir(): string {
  return join(dataDir(), "sessions");
}

export function sessionPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

export function plansDir(): string {
  return join(dataDir(), "plans");
}

export function planDir(planId: string): string {
  return join(plansDir(), planId);
}

export function planManifestPath(planId: string): string {
  return join(planDir(planId), "manifest.json");
}

export function planFeedbackPath(planId: string): string {
  return join(planDir(planId), "feedback.json");
}

export function planFilePath(planId: string, filePath: string): string {
  return join(planDir(planId), filePath);
}

/** Directory holding a plan's research sessions (one JSON file per session). */
export function researchDir(planId: string): string {
  return join(planDir(planId), "research");
}

export function researchPath(planId: string, researchId: string): string {
  return join(researchDir(planId), `${researchId}.json`);
}

export function harnessStateDir(): string {
  return join(dataDir(), "harness");
}

/**
 * Where a long-running `attach` records its harnessId so that subsequent
 * short-lived CLI calls (write / add-file / feedback-result) can claim the
 * same identity for edit-lease checks.
 */
export function harnessStatePath(planId: string): string {
  return join(harnessStateDir(), `${planId}.json`);
}

/**
 * Per-working-directory harness name, so a given harness instance (one project
 * cwd) keeps the same friendly name across plans and reconnects.
 */
export function harnessNamePath(cwd: string): string {
  const key = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(harnessStateDir(), "names", `${key}.json`);
}

export async function ensureDataDirs(): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  await mkdir(plansDir(), { recursive: true, mode: 0o700 });
}

export async function readDaemonMetadata(): Promise<DaemonMetadata | null> {
  try {
    return JSON.parse(await readFile(daemonMetadataPath(), "utf8")) as DaemonMetadata;
  } catch {
    return null;
  }
}

export async function writeDaemonMetadata(metadata: DaemonMetadata): Promise<void> {
  await ensureDataDirs();
  const file = daemonMetadataPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}
