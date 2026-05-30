// Holds a harness SSE connection open so the browser HarnessBar shows it.
const PORT = 61761;
const SID = "80b48854-36f0-48f3-8c4b-a7bff65c8684";
const TOKEN = "qDBzvzjz6i4A3WLkzJr1o7bDdm0yTGg2tDqFnpfDYYw";
const params = new URLSearchParams({ token: TOKEN, role: "harness", harnessId: "pi-demo-1", harnessType: "pi", label: "planalot (demo)" });
const res = await fetch(`http://127.0.0.1:${PORT}/sessions/${SID}/events?${params}`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) !== -1) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (line) { const e = JSON.parse(line.slice(6)); if (e.type === "feedback.sent") console.log("KEEPER received feedback:", JSON.stringify(e.message.text).slice(0, 80), "target:", e.targetHarnessId); }
  }
}
console.log("keeper exit");
