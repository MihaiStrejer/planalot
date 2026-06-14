// Deterministic harness drivers for the loop tests — one per real transport,
// behind a common LoopHarness interface so the same scenarios run for all three:
//
//   cc    — POLL + --exit-on-feedback: spawns the REAL attach CLI, treats its
//           EXIT as the wake, then relaunches. (Models "CC re-invokes on exit".)
//   codex — POLL, long-lived: spawns the REAL attach CLI WITHOUT
//           --exit-on-feedback; reacts to streamed event lines inline, no exit.
//   pi    — SSE push: opens the /events?role=harness stream and reacts to pushed
//           events in-process (no CLI), exactly like the pi extension.
//
// Everything below the transport is real (daemon, queue, lease, feedback-result);
// only the LLM's judgment is replaced by a scripted `brain`.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const CLI_ENTRY = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const DAEMON_PKG_DIR = fileURLToPath(new URL("../../", import.meta.url));

export type HarnessKind = "cc" | "codex" | "pi";

export interface WakeEvent {
  type: string;
  [key: string]: unknown;
}

export interface BrainContext {
  daemon: DaemonHandle;
  planId: string;
  harnessId: string;
}

export type Brain = (wake: WakeEvent, ctx: BrainContext) => Promise<void> | void;

export interface LoopHarness {
  readonly kind: HarnessKind;
  readonly harnessId: string;
  readonly wakes: WakeEvent[];
  /** Connect/attach and begin reacting; resolves once registered with the daemon. */
  start(brain: Brain): Promise<void>;
  /** Stop reacting and deregister. */
  stop(): Promise<void>;
}

const ACTIONABLE = new Set(["feedback.sent", "feedback.answered", "plan.build", "plan.accepted", "implementation.requested"]);

/** An event is a wake for us iff it is actionable and (untargeted or targeted at us). */
function isWakeForMe(evt: WakeEvent, harnessId: string): boolean {
  if (!ACTIONABLE.has(evt.type)) return false;
  const target = (evt as { targetHarnessId?: string }).targetHarnessId;
  return !target || target === harnessId;
}

/** Dedup key so a re-delivered event (e.g. on resume) isn't actioned twice. */
function wakeKey(evt: WakeEvent): string {
  const msg = (evt as { message?: { id?: string }; request?: { id?: string } });
  return `${evt.type}:${msg.message?.id ?? msg.request?.id ?? JSON.stringify(evt).length}`;
}

function spawnAttach(planId: string, harnessId: string, harnessType: string, drive: boolean, exitOnFeedback: boolean): ChildProcessWithoutNullStreams {
  const args = [
    "--import", "tsx", CLI_ENTRY, "attach", planId,
    "--type", harnessType, "--harness-id", harnessId,
    ...(drive ? ["--drive"] : []),
    ...(exitOnFeedback ? ["--exit-on-feedback"] : []),
  ];
  return spawn(process.execPath, args, { cwd: DAEMON_PKG_DIR, env: { ...process.env } });
}

async function detach(daemon: DaemonHandle, planId: string, harnessId: string): Promise<void> {
  await fetch(
    `${daemon.baseUrl}/plans/${encodeURIComponent(planId)}/harness/${encodeURIComponent(harnessId)}/detach`,
    { method: "POST", headers: { authorization: `Bearer ${daemon.token}` } },
  ).catch(() => undefined);
}

// ── cc — POLL + exit-on-feedback (exit = wake, then relaunch) ─────────────────

export class CcHarness implements LoopHarness {
  readonly kind = "cc" as const;
  readonly harnessId: string;
  readonly wakes: WakeEvent[] = [];
  private readonly daemon: DaemonHandle;
  private readonly planId: string;
  private stopping = false;
  private terminal = false;
  private child?: ChildProcessWithoutNullStreams;
  private loopPromise?: Promise<void>;
  private attachedResolve?: () => void;

  constructor(opts: { daemon: DaemonHandle; planId: string; harnessId: string }) {
    this.daemon = opts.daemon;
    this.planId = opts.planId;
    this.harnessId = opts.harnessId;
  }

  start(brain: Brain): Promise<void> {
    const attached = new Promise<void>((resolve) => { this.attachedResolve = resolve; });
    this.loopPromise = this.loop(brain);
    return attached;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.child?.kill();
    await this.loopPromise?.catch(() => undefined);
    await detach(this.daemon, this.planId, this.harnessId);
  }

  private async loop(brain: Brain): Promise<void> {
    while (!this.stopping) {
      const wake = await this.armAndAwaitWake();
      if (this.stopping) break;
      if (wake) {
        this.wakes.push(wake);
        await brain(wake, { daemon: this.daemon, planId: this.planId, harnessId: this.harnessId });
        continue; // relaunch
      }
      if (this.terminal) break;
    }
  }

  private armAndAwaitWake(): Promise<WakeEvent | null> {
    const child = spawnAttach(this.planId, this.harnessId, "claude-code", true, true);
    this.child = child;
    return new Promise<WakeEvent | null>((resolve) => {
      let wake: WakeEvent | null = null;
      let buffer = "";
      const onLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: WakeEvent;
        try { evt = JSON.parse(trimmed) as WakeEvent; } catch { return; }
        if (evt.type === "attached" || evt.type === "reattached") { this.attachedResolve?.(); this.attachedResolve = undefined; return; }
        if (evt.type === "detached") { this.terminal = true; return; }
        if (evt.type === "attach-error") return;
        wake = evt;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) { onLine(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
      });
      child.on("exit", () => { if (buffer.trim()) onLine(buffer); resolve(wake); });
      child.on("error", () => resolve(null));
    });
  }
}

// ── codex — POLL, long-lived (stream lines, react inline) ─────────────────────

export class CodexHarness implements LoopHarness {
  readonly kind = "codex" as const;
  readonly harnessId: string;
  readonly wakes: WakeEvent[] = [];
  private readonly daemon: DaemonHandle;
  private readonly planId: string;
  private stopping = false;
  private child?: ChildProcessWithoutNullStreams;
  private chain: Promise<void> = Promise.resolve();
  private readonly seen = new Set<string>();

  constructor(opts: { daemon: DaemonHandle; planId: string; harnessId: string }) {
    this.daemon = opts.daemon;
    this.planId = opts.planId;
    this.harnessId = opts.harnessId;
  }

  start(brain: Brain): Promise<void> {
    const child = spawnAttach(this.planId, this.harnessId, "codex", true, false);
    this.child = child;
    return new Promise<void>((resolveStart) => {
      let buffer = "";
      const ctx = { daemon: this.daemon, planId: this.planId, harnessId: this.harnessId };
      const onLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: WakeEvent;
        try { evt = JSON.parse(trimmed) as WakeEvent; } catch { return; }
        if (evt.type === "attached" || evt.type === "reattached") { resolveStart(); return; }
        if (!isWakeForMe(evt, this.harnessId)) return;
        const key = wakeKey(evt);
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.wakes.push(evt);
        this.chain = this.chain.then(() => brain(evt, ctx)).catch(() => undefined);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) { onLine(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.child?.kill();
    await this.chain.catch(() => undefined);
    await detach(this.daemon, this.planId, this.harnessId);
  }
}

// ── pi — SSE push (no CLI; react to the held stream in-process) ───────────────

export class PiHarness implements LoopHarness {
  readonly kind = "pi" as const;
  readonly harnessId: string;
  readonly wakes: WakeEvent[] = [];
  private readonly daemon: DaemonHandle;
  private readonly planId: string;
  private readonly abort = new AbortController();
  private chain: Promise<void> = Promise.resolve();
  private readLoop?: Promise<void>;
  private readonly seen = new Set<string>();

  constructor(opts: { daemon: DaemonHandle; planId: string; harnessId: string }) {
    this.daemon = opts.daemon;
    this.planId = opts.planId;
    this.harnessId = opts.harnessId;
  }

  async start(brain: Brain): Promise<void> {
    const params = new URLSearchParams({
      token: this.daemon.token,
      role: "harness",
      harnessId: this.harnessId,
      harnessType: "pi",
      label: "pi",
    });
    const res = await fetch(
      `${this.daemon.baseUrl}/sessions/${encodeURIComponent(this.planId)}/events?${params.toString()}`,
      { signal: this.abort.signal },
    );
    if (!res.ok || !res.body) throw new Error(`pi SSE connect failed: ${res.status}`);
    // Response headers received ⇒ the daemon has registered us as a harness.
    this.readLoop = this.read(res.body, brain);
  }

  private async read(body: ReadableStream<Uint8Array>, brain: Brain): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const ctx = { daemon: this.daemon, planId: this.planId, harnessId: this.harnessId };
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let evt: WakeEvent;
          try { evt = JSON.parse(dataLine.slice(6)) as WakeEvent; } catch { continue; }
          if (!isWakeForMe(evt, this.harnessId)) continue;
          const key = wakeKey(evt);
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          this.wakes.push(evt);
          this.chain = this.chain.then(() => brain(evt, ctx)).catch(() => undefined);
        }
      }
    } catch {
      // aborted on stop()
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.readLoop?.catch(() => undefined);
    await this.chain.catch(() => undefined);
    // Aborting the stream closes the request; the daemon removes the SSE harness.
  }
}

export function makeLoopHarness(kind: HarnessKind, daemon: DaemonHandle, planId: string): LoopHarness {
  const harnessId = `fake-${kind}-${planId}`;
  const opts = { daemon, planId, harnessId };
  if (kind === "cc") return new CcHarness(opts);
  if (kind === "codex") return new CodexHarness(opts);
  return new PiHarness(opts);
}
