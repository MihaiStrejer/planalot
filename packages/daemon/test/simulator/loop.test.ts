// Tier B — the full planalot loop, end to end, run for EACH harness transport
// (cc poll+exit-on-feedback, codex long-lived poll, pi SSE push). Deterministic
// (scripted brain, no LLM). Each transport must prove the same contract: a
// review round wakes the harness, its feedback-result is applied, and the lease
// releases — across multiple rounds and on a Build action.

import test from "node:test";
import assert from "node:assert/strict";
import { harnessClient, userClient, waitFor } from "../fixtures/client.ts";
import { withDaemon } from "../fixtures/daemon.ts";
import { type Brain, type HarnessKind, makeLoopHarness } from "./fakeHarness.ts";

const KINDS: HarnessKind[] = ["cc", "codex", "pi"];

/** Brain that resolves every review round by writing a design file and closing it. */
const resolvingBrain: Brain = async (wake, ctx) => {
  if (wake.type !== "feedback.sent") return;
  const store = (await userClient(ctx.daemon).getFeedback(ctx.planId)).json;
  const session = (store.sessions ?? []).find((s: { status: string }) => s.status === "open");
  if (!session) return;
  await harnessClient(ctx.daemon, ctx.planId).feedbackResult(ctx.harnessId, {
    schemaVersion: 1,
    feedbackSessionId: session.id,
    fileChanges: [{ path: "design/sim.md", operation: "created", content: "# from sim\n", feedbackItemIds: session.feedbackItemIds }],
    responses: [{ id: `r-${session.id}`, kind: "insight", feedbackItemIds: session.feedbackItemIds, text: "resolved by simulator", expectsUserFollowUp: false }],
  });
};

const noopBrain: Brain = () => undefined;

const closedCount = async (u: ReturnType<typeof userClient>, planId: string): Promise<number> =>
  ((await u.getFeedback(planId)).json.sessions ?? []).filter((s: { status: string }) => s.status === "closed").length;

for (const kind of KINDS) {
  test(`loop [${kind}]: feedback round → wake → result applied → lease released`, async () => {
    await withDaemon(async (d) => {
      const u = userClient(d);
      const planId = await u.createManualPlan();
      const h = makeLoopHarness(kind, d, planId);
      try {
        await h.start(resolvingBrain);

        const sent = await u.sendFeedback(planId, { targetHarnessId: h.harnessId });
        assert.equal(sent.json.delivered, true);

        await waitFor(async () => ((await closedCount(u, planId)) >= 1 ? true : undefined), { timeout: 12000, label: `${kind} round closed` });

        const file = await u.readFile(planId, "design/sim.md");
        assert.equal(file.status, 200);
        assert.ok(String(file.json.content).includes("from sim"), `${kind}: simulator's file change applied`);
        assert.ok(h.wakes.some((w) => w.type === "feedback.sent"), `${kind}: harness woke on feedback`);
        assert.equal((await u.getSession(planId)).json.editLease, undefined, `${kind}: lease released`);
      } finally {
        await h.stop();
      }
    });
  });

  test(`loop [${kind}]: two sequential rounds`, async () => {
    await withDaemon(async (d) => {
      const u = userClient(d);
      const planId = await u.createManualPlan();
      const h = makeLoopHarness(kind, d, planId);
      try {
        await h.start(resolvingBrain);

        await u.sendFeedback(planId, { targetHarnessId: h.harnessId });
        await waitFor(async () => ((await closedCount(u, planId)) >= 1 ? true : undefined), { timeout: 12000, label: `${kind} round 1` });

        await u.sendFeedback(planId, { targetHarnessId: h.harnessId });
        await waitFor(async () => ((await closedCount(u, planId)) >= 2 ? true : undefined), { timeout: 12000, label: `${kind} round 2` });

        assert.equal(h.wakes.filter((w) => w.type === "feedback.sent").length, 2, `${kind}: woke for both rounds`);
      } finally {
        await h.stop();
      }
    });
  });

  test(`loop [${kind}]: a Build action wakes the harness`, async () => {
    await withDaemon(async (d) => {
      const u = userClient(d);
      const planId = await u.createManualPlan();
      const h = makeLoopHarness(kind, d, planId);
      try {
        await h.start(noopBrain);
        await u.build(planId);
        await waitFor(() => (h.wakes.some((w) => w.type === "plan.build") ? true : undefined), { timeout: 12000, label: `${kind} build wake` });
      } finally {
        await h.stop();
      }
    });
  });
}
