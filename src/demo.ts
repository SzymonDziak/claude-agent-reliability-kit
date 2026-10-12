import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveClient, modelFromEnv } from "./client.ts";
import { demoClient } from "./fakeClient.ts";
import { ClaimQueue } from "./queue.ts";
import { stdoutTracer } from "./trace.ts";
import { Worker } from "./worker.ts";

const live = process.argv.includes("--live");
const client = live ? liveClient() : demoClient();
console.log(live ? `LIVE mode, model ${modelFromEnv()}` : "FAKE mode: scripted model, no network, no API key needed (use --live for the real API)");

const queue = new ClaimQueue(); // in-memory for the demo; pass a file path for a durable queue
const dir = join(import.meta.dirname, "..", "samples");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()) {
  const { id, created } = queue.enqueue(readFileSync(join(dir, f), "utf8"));
  console.log(`enqueued ${f} -> claim ${id}${created ? "" : " (duplicate ignored)"}`);
}
// Re-submitting the same form is a no-op:
console.log("re-enqueue first sample ->", queue.enqueue(readFileSync(join(dir, "01-auto-collision.txt"), "utf8")));

const worker = new Worker({
  client, queue, model: modelFromEnv(), tracer: stdoutTracer, log: (m) => console.log("worker:", m),
  webhookUrl: process.env.WEBHOOK_URL,
  backoff: live ? undefined : { baseMs: 200 },
});
await worker.drain();

console.log("\nFinal queue state:");
for (const r of queue.all()) console.log(r.id, r.state.padEnd(11), `attempts=${r.attempts}`, r.state === "done" ? r.result : r.last_error?.split("\n")[0] ?? "");
