// Routing test: simulates harness SSE connections and asserts targeted delivery.
const PORT = 61761;
const SID = "80b48854-36f0-48f3-8c4b-a7bff65c8684";
const TOKEN = "qDBzvzjz6i4A3WLkzJr1o7bDdm0yTGg2tDqFnpfDYYw";
const base = `http://127.0.0.1:${PORT}/sessions/${SID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  PASS", msg); } else { fail++; console.log("  FAIL", msg); } };

function openStream(role, harnessId) {
  const params = new URLSearchParams({ token: TOKEN });
  if (role === "harness") { params.set("role", "harness"); params.set("harnessId", harnessId); params.set("harnessType", "pi"); params.set("label", harnessId); }
  const abort = new AbortController();
  const events = [];
  (async () => {
    const res = await fetch(`${base}/events?${params}`, { signal: abort.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        }
      }
    } catch {}
  })();
  // A real harness self-filters: it only acts on feedback.sent targeted to it
  // (or untargeted). Mimic the Pi adapter's handleSseChunk filter here.
  return {
    events,
    close: () => abort.abort(),
    feedbackTexts: () => events
      .filter((e) => e.type === "feedback.sent" && (!e.targetHarnessId || e.targetHarnessId === harnessId))
      .map((e) => e.message.text),
  };
}

async function postFeedback(message, targetHarnessId) {
  const res = await fetch(`${base}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ kind: "chat", message, ...(targetHarnessId ? { targetHarnessId } : {}) }),
  });
  return res.json();
}
async function planUpdated(harnessId) {
  await fetch(`${base}/plan-updated`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ harnessId }) });
}

(async () => {
  const browser = openStream("browser");
  await sleep(200);

  // 1. Attach harness A
  const A = openStream("harness", "A");
  await sleep(300);
  ok(browser.events.some((e) => e.type === "harness.presence" && e.harnesses.some((h) => h.harnessId === "A")), "browser sees harness A via harness.presence");

  // 2. A is last-active; feedback routes to A
  await planUpdated("A");
  await sleep(150);
  const r1 = await postFeedback("m1");
  await sleep(200);
  ok(r1.delivered === true && r1.targetHarnessId === "A", "m1 delivered to A (response)");
  ok(A.feedbackTexts().includes("m1"), "harness A received m1");

  // 3. Attach B; feedback still goes to A (last-active), NOT B
  const B = openStream("harness", "B");
  await sleep(300);
  const r2 = await postFeedback("m2");
  await sleep(200);
  ok(r2.targetHarnessId === "A", "m2 still targets A (last-active)");
  ok(A.feedbackTexts().includes("m2"), "harness A received m2");
  ok(!B.feedbackTexts().includes("m2"), "harness B did NOT receive m2 (no double-delivery)");

  // 4. Close A; fallback to connected B
  A.close();
  await sleep(300);
  const r3 = await postFeedback("m3");
  await sleep(200);
  ok(r3.delivered === true && r3.targetHarnessId === "B", "m3 falls back to connected B");
  ok(B.feedbackTexts().includes("m3"), "harness B received m3");

  // 5. Close B; no harness → delivery fails
  B.close();
  await sleep(300);
  const r4 = await postFeedback("m4");
  await sleep(200);
  ok(r4.delivered === false, "m4 delivery failed (no harness connected)");
  ok(browser.events.some((e) => e.type === "feedback.failed"), "browser saw feedback.failed");

  // 6. User override: reattach A and B, target B explicitly
  const A2 = openStream("harness", "A");
  const B2 = openStream("harness", "B");
  await sleep(300);
  const r5 = await postFeedback("m5", "B");
  await sleep(200);
  ok(r5.targetHarnessId === "B", "m5 honors user override (B)");
  ok(B2.feedbackTexts().includes("m5"), "harness B received m5 (override)");
  ok(!A2.feedbackTexts().includes("m5"), "harness A did NOT receive m5 (override)");

  browser.close(); A2.close(); B2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
