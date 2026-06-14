// HTTP clients that stand in for the two ends of the planalot loop in tests:
//   - userClient   → the browser/user side (create plans, send feedback rounds,
//                    build/accept, answer questions, read state).
//   - harnessClient → the poll-harness lifecycle (attach / heartbeat / detach)
//                    plus the writes a harness performs, so tests can drive a
//                    raw harness without spawning the CLI.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHandle } from "./daemon.ts";

export interface HttpResult<T = any> {
  status: number;
  json: T;
}

function makeHttp(d: DaemonHandle) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${d.token}` };
  const send = async (method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<HttpResult> => {
    const init: RequestInit = { method, headers: { ...headers, ...extra } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(d.baseUrl + path, init);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, body?: unknown, extra?: Record<string, string>) => send("POST", path, body, extra),
    put: (path: string, body?: unknown, extra?: Record<string, string>) => send("PUT", path, body, extra),
  };
}

export function userClient(d: DaemonHandle) {
  const http = makeHttp(d);
  const enc = encodeURIComponent;
  return {
    /** Plain text-import plan → a "manual" session (no harness runtime bound). */
    async createManualPlan(name = "Test Plan", text = "# Plan\n\nrequirements\n"): Promise<string> {
      const { json } = await http.post("/plans", { name, origin: { kind: "text-import" }, indexText: text, runtime: "manual" });
      return json.planId as string;
    },
    /**
     * Open a plan as a harness-backed session (default claude-code) via /sessions,
     * which persists a session whose runtime is NOT "manual" — needed to exercise
     * the delivery-failed path when no harness is connected.
     */
    async createHarnessPlan(opts: { runtime?: string; text?: string } = {}): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), "pl-plan-"));
      const planFile = "PLAN.md";
      const planText = opts.text ?? "# Plan\n\nrequirements\n";
      writeFileSync(join(dir, planFile), planText, "utf8");
      const { json } = await http.post("/sessions", {
        runtime: opts.runtime ?? "claude-code",
        cwd: dir,
        planFile,
        planText,
        transport: { kind: opts.runtime ?? "claude-code" },
      });
      return json.sessionId as string;
    },
    /** Send a review round (POST /sessions/:id/feedback) — leases the plan to the target harness. */
    sendFeedback: (planId: string, opts: { message?: string; targetHarnessId?: string } = {}): Promise<HttpResult> =>
      http.post(`/sessions/${enc(planId)}/feedback`, {
        kind: "chat",
        message: opts.message ?? "please review",
        ...(opts.targetHarnessId ? { targetHarnessId: opts.targetHarnessId } : {}),
      }),
    build: (planId: string): Promise<HttpResult> => http.post(`/sessions/${enc(planId)}/build`),
    accept: (planId: string): Promise<HttpResult> => http.post(`/sessions/${enc(planId)}/accept`),
    implement: (planId: string, body: Record<string, unknown> = {}): Promise<HttpResult> =>
      http.post(`/plans/${enc(planId)}/implement`, body),
    answerQuestion: (planId: string, requestId: string, answers: unknown[]): Promise<HttpResult> =>
      http.post(`/sessions/${enc(planId)}/feedback-answered`, { requestId, answers }),
    getPlan: (planId: string): Promise<HttpResult> => http.get(`/plans/${enc(planId)}`),
    /** publicSessionView — includes editLease + harness roster (GET /plans/:id omits the lease). */
    getSession: (planId: string): Promise<HttpResult> => http.get(`/sessions/${enc(planId)}`),
    getFeedback: (planId: string): Promise<HttpResult> => http.get(`/plans/${enc(planId)}/feedback`),
    readFile: (planId: string, path: string): Promise<HttpResult> =>
      http.get(`/plans/${enc(planId)}/files/${enc(path)}`),
  };
}

export interface AttachResult {
  harnessId: string;
  label: string;
  role: string;
  roster: Array<{ harnessId: string; status: string; isDriver: boolean; label: string }>;
  cursor: number;
  editLease?: { holderHarnessIds: string[]; feedbackRequestId?: string };
}

export function harnessClient(d: DaemonHandle, planId: string) {
  const http = makeHttp(d);
  const enc = encodeURIComponent;
  return {
    async attach(opts: { harnessId?: string; harnessType?: string; label?: string; drive?: boolean } = {}): Promise<AttachResult> {
      const { json } = await http.post(`/plans/${enc(planId)}/harness/attach`, {
        harnessType: opts.harnessType ?? "claude-code",
        ...(opts.harnessId ? { harnessId: opts.harnessId } : {}),
        ...(opts.label ? { label: opts.label } : {}),
        drive: opts.drive ?? false,
      });
      return json as AttachResult;
    },
    heartbeat: (harnessId: string, opts: { cursor: number; waitMs?: number }): Promise<HttpResult> =>
      http.post(`/plans/${enc(planId)}/harness/${enc(harnessId)}/heartbeat`, { cursor: opts.cursor, waitMs: opts.waitMs ?? 0 }),
    detach: (harnessId: string): Promise<HttpResult> =>
      http.post(`/plans/${enc(planId)}/harness/${enc(harnessId)}/detach`),
    /** Attempt a plan-file write as this harness (PUT) — used to assert the 409 edit-lease guard. */
    write: (harnessId: string, path: string, content: string): Promise<HttpResult> =>
      http.put(`/plans/${enc(planId)}/files/${enc(path)}`, { content }, { "x-planalot-harness-id": harnessId }),
    feedbackResult: (harnessId: string, result: unknown): Promise<HttpResult> =>
      http.post(`/sessions/${enc(planId)}/feedback-result`, { result }, { "x-planalot-harness-id": harnessId }),
  };
}

/** Poll `predicate` until it returns truthy or the timeout elapses. Drives on state, not sleeps. */
export async function waitFor<T>(
  predicate: () => Promise<T | undefined | false>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 4000;
  const interval = opts.interval ?? 25;
  const deadline = Date.now() + timeout;
  let last: T | undefined | false;
  for (;;) {
    last = await predicate();
    if (last) return last as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ""}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
