// Tier A3 — harness lifecycle against an in-process daemon: a harness attaching,
// a second one joining, targeting/driver election, the long-poll wake + gap
// replay, the exclusive edit lease (+ 409 guard), and all-harnesses-gone
// (explicit detach, lease abandonment, presence TTL eviction, delivery-failed).

import test from "node:test";
import assert from "node:assert/strict";
import { harnessClient, userClient, waitFor } from "./fixtures/client.ts";
import { withDaemon } from "./fixtures/daemon.ts";

function closeRoundResult(feedbackSessionId: string, itemId: string) {
  return {
    schemaVersion: 1,
    feedbackSessionId,
    fileChanges: [],
    responses: [{ id: "r1", kind: "insight", feedbackItemIds: [itemId], text: "resolved", expectsUserFollowUp: false }],
  };
}

test("attach: a new harness joins the roster and a --drive attach becomes driver", async () => {
  await withDaemon(async (d) => {
    const planId = await userClient(d).createManualPlan();
    const h = harnessClient(d, planId);
    const a = await h.attach({ label: "alpha", drive: true });
    assert.ok(a.harnessId);
    assert.equal(a.role, "driver");
    const me = a.roster.find((r) => r.harnessId === a.harnessId);
    assert.equal(me?.status, "live");
    assert.equal(me?.isDriver, true);
  });
});

test("second attach: does not steal a live driver; roster holds both", async () => {
  await withDaemon(async (d) => {
    const planId = await userClient(d).createManualPlan();
    const h = harnessClient(d, planId);
    const a = await h.attach({ harnessId: "a", label: "a", drive: true });
    const b = await h.attach({ harnessId: "b", label: "b", drive: true });
    assert.equal(a.role, "driver");
    assert.equal(b.role, "peer", "a live driver is not displaced by a second --drive");
    assert.equal(b.roster.length, 2);
    assert.equal(b.roster.find((r) => r.harnessId === "a")?.isDriver, true);
    assert.equal(b.roster.find((r) => r.harnessId === "b")?.isDriver, false);
  });
});

test("heartbeat long-poll wakes the instant a targeted feedback event arrives", async () => {
  await withDaemon(async (d) => {
    const u = userClient(d);
    const planId = await u.createManualPlan();
    const h = harnessClient(d, planId);
    const a = await h.attach({ harnessId: "a", label: "a", drive: true });

    // Drain the presence event the attach itself broadcast, advancing the cursor,
    // so the blocking heartbeat actually has to wait for the feedback.
    const drained = await h.heartbeat(a.harnessId, { cursor: a.cursor, waitMs: 0 });
    const hb = h.heartbeat(a.harnessId, { cursor: drained.json.cursor, waitMs: 3000 });
    await new Promise((r) => setTimeout(r, 40)); // let the long-poll arm its waiter
    const sent = await u.sendFeedback(planId, { targetHarnessId: a.harnessId });
    assert.equal(sent.json.delivered, true);

    const result = await hb;
    const types = result.json.events.map((e: { type: string }) => e.type);
    assert.ok(types.includes("feedback.sent"), `expected feedback.sent, got ${types.join(",")}`);
  });
});

test("gap replay: a re-attach rewinds the cursor so events queued in the gap replay", async () => {
  await withDaemon(async (d) => {
    const u = userClient(d);
    const planId = await u.createManualPlan();
    const h = harnessClient(d, planId);
    const a = await h.attach({ harnessId: "gap", label: "g", drive: true });

    // Feedback arrives while no heartbeat is in flight → it sits in the queue.
    await u.sendFeedback(planId, { targetHarnessId: a.harnessId });

    // Relaunch (same harnessId) — resumeCursor rewinds to just before the queued event.
    const re = await h.attach({ harnessId: "gap", label: "g", drive: true });
    const hb = await h.heartbeat(a.harnessId, { cursor: re.cursor, waitMs: 0 });
    const types = hb.json.events.map((e: { type: string }) => e.type);
    assert.ok(types.includes("feedback.sent"), `gap event must replay, got ${types.join(",")}`);
  });
});

test("edit lease: round leases to target; foreign write → 409; result closes + releases", async () => {
  await withDaemon(async (d) => {
    const u = userClient(d);
    const planId = await u.createManualPlan();
    const h = harnessClient(d, planId);
    const owner = await h.attach({ harnessId: "owner", label: "owner", drive: true });
    await h.attach({ harnessId: "intruder", label: "intruder" });

    const sent = await u.sendFeedback(planId, { targetHarnessId: owner.harnessId });
    assert.equal(sent.json.delivered, true);
    assert.equal(sent.json.targetHarnessId, "owner");
    const itemId = sent.json.feedbackSession.feedbackItemIds[0];
    const fsId = sent.json.feedbackSession.id;

    const leased = await u.getSession(planId);
    assert.deepEqual(leased.json.editLease?.holderHarnessIds, ["owner"]);

    const foreign = await h.write("intruder", "requirements/index.md", "hijacked");
    assert.equal(foreign.status, 409, "non-holder write must be rejected");

    const closed = await h.feedbackResult("owner", closeRoundResult(fsId, itemId));
    assert.equal(closed.json.feedbackSession.status, "closed");

    const after = await u.getSession(planId);
    assert.equal(after.json.editLease, undefined, "lease released on round close");
  });
});

test("all disconnect: detaching the lease holder abandons the lease and empties the roster", async () => {
  await withDaemon(async (d) => {
    const u = userClient(d);
    const planId = await u.createManualPlan();
    const h = harnessClient(d, planId);
    const a = await h.attach({ harnessId: "a", label: "a", drive: true });
    await h.attach({ harnessId: "b", label: "b" });

    await u.sendFeedback(planId, { targetHarnessId: a.harnessId });
    assert.ok((await u.getSession(planId)).json.editLease, "lease held before detach");

    await h.detach("a");
    assert.equal((await u.getSession(planId)).json.editLease, undefined, "lease abandoned when holder detaches");

    await h.detach("b");
    assert.equal((await u.getSession(planId)).json.harnesses.length, 0, "roster empty after all detach");
  });
});

test("presence TTL: an unresponsive harness is evicted by the prune sweep", async () => {
  await withDaemon(
    async (d) => {
      const u = userClient(d);
      const planId = await u.createManualPlan();
      const h = harnessClient(d, planId);
      await h.attach({ harnessId: "stale", label: "stale", drive: true });
      // No heartbeats. Prune cadence is floored at ~5s, so allow up to 9s.
      await waitFor(
        async () => ((await u.getSession(planId)).json.harnesses.length === 0 ? true : undefined),
        { timeout: 9000, interval: 200, label: "TTL eviction" },
      );
    },
    { env: { PLANALOT_HARNESS_DOWN_MS: "50", PLANALOT_HARNESS_EVICT_MS: "100" } },
  );
});

test("delivery-failed: feedback to a harness-backed session with nobody home", async () => {
  await withDaemon(async (d) => {
    const u = userClient(d);
    const planId = await u.createHarnessPlan({ runtime: "claude-code" });
    const sent = await u.sendFeedback(planId); // no target, no live harness
    assert.equal(sent.json.delivered, false);
    assert.equal((await u.getSession(planId)).json.status, "delivery-failed");
  });
});
