import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DaemonConfig {
  watchDebounceMs: number;
  harnessEventDebounceMs: number;
  maxTrailModifications: number;
  /** Recommended client heartbeat cadence; harnesses poll at or under this. */
  heartbeatIntervalMs: number;
  /** A harness with no heartbeat for longer than this is marked "down". */
  harnessDownMs: number;
  /** A harness with no heartbeat for longer than this is evicted entirely. */
  harnessEvictMs: number;
  /** Max long-poll budget the daemon will hold a heartbeat open for. */
  longPollMs: number;
}

export function loadDaemonConfig(cwd = process.cwd()): DaemonConfig {
  loadDotEnv(join(cwd, ".env"));
  loadDotEnv(join(cwd, ".env.local"));

  return {
    watchDebounceMs: readNumber("PLANALOT_WATCH_DEBOUNCE_MS", 10_000),
    harnessEventDebounceMs: readNumber("PLANALOT_HARNESS_EVENT_DEBOUNCE_MS", 0),
    maxTrailModifications: readNumber("PLANALOT_MAX_TRAIL_MODIFICATIONS", 3),
    heartbeatIntervalMs: readNumber("PLANALOT_HEARTBEAT_INTERVAL_MS", 30_000),
    harnessDownMs: readNumber("PLANALOT_HARNESS_DOWN_MS", 45_000),
    harnessEvictMs: readNumber("PLANALOT_HARNESS_EVICT_MS", 120_000),
    longPollMs: readNumber("PLANALOT_LONG_POLL_MS", 25_000),
  };
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
