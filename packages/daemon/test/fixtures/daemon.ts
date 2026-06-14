// In-process daemon fixture for deterministic tests.
//
// Boots the REAL daemon (startDaemon) on an ephemeral port with a throwaway
// PLANALOT_DATA_DIR, so each test gets a hermetic ~/.planalot without touching
// the user's real data or moving HOME. Timing knobs (presence TTL, long-poll
// budget) are overridable via env so lifecycle tests stay fast.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/server.ts";

export interface DaemonHandle {
  baseUrl: string;
  port: number;
  token: string;
  dataDir: string;
}

export interface DaemonOptions {
  /** Env overrides applied around startDaemon (e.g. PLANALOT_HARNESS_DOWN_MS). */
  env?: Record<string, string>;
}

export async function withDaemon<T>(
  fn: (d: DaemonHandle) => Promise<T>,
  options: DaemonOptions = {},
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), "pl-daemon-"));
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string): void => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };
  setEnv("PLANALOT_DATA_DIR", dataDir);
  for (const [key, value] of Object.entries(options.env ?? {})) setEnv(key, value);

  const daemon = await startDaemon({ port: 0 });
  const handle: DaemonHandle = {
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    port: daemon.port,
    token: daemon.token,
    dataDir,
  };
  try {
    return await fn(handle);
  } finally {
    await daemon.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
