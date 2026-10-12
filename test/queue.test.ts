import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiError, scriptedClient } from "../src/fakeClient.ts";
import { ClaimQueue } from "../src/queue.ts";
import { backoffMs } from "../src/retry.ts";
import { Worker } from "../src/worker.ts";
import { fakeClock, submit, validClaim } from "./helpers.ts";

const mk = (steps: any[], extra: object = {}) => {
  const clock = fakeClock();
  const queue = new ClaimQueue();
  const client = scriptedClient(steps);
  const worker = new Worker({ client, queue, model: "m", now: clock.now, sleep: clock.sleep, backoff: { baseMs: 1000, rng: () => 1 }, ...extra });
  return { clock, queue, client, worker };
};

test("429 then success: retried after backoff honoring retry-after, claim ends done", async () => {
  const { clock, queue, worker } = mk([apiError(429, 7), submit(validClaim)]);
  const { id } = queue.enqueue("claim text", clock.now());
  await worker.drain();
  assert.equal(queue.get(id)!.state, "done");
  assert.equal(queue.get(id)!.attempts, 2);
  assert.equal(clock.sleeps[0], 7000); // retry-after (7s) beats computed backoff (1s)
});

test("529 exhaustion: claim is parked as failed with the error, not dropped", async () => {
  const { clock, queue, worker } = mk(Array.from({ length: 10 }, () => apiError(529)), { maxAttempts: 3 });
  const { id } = queue.enqueue("claim text", clock.now());
  await worker.drain();
  const row = queue.get(id)!;
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 3);
  assert.match(row.last_error!, /529/);
  assert.equal(row.payload, "claim text"); // still there, replayable
  assert.equal(clock.sleeps.length, 2);
});

test("non-retryable 400 fails immediately", async () => {
  const { clock, queue, worker } = mk([apiError(400)]);
  const { id } = queue.enqueue("x", clock.now());
  await worker.drain();
  assert.equal(queue.get(id)!.state, "failed");
  assert.equal(queue.get(id)!.attempts, 1);
});

test("idempotent re-enqueue: same submission (whitespace aside) is one row, processed once", async () => {
  const { clock, queue, client, worker } = mk([submit(validClaim)]);
  const a = queue.enqueue("Policy  POL-48213\nrear-end", clock.now());
  const b = queue.enqueue("  Policy POL-48213 rear-end ", clock.now());
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  await worker.drain();
  assert.equal(queue.all().length, 1);
  assert.equal(client.calls.length, 1);
});

test("needs_human is a terminal queue state and is not delivered", async () => {
  const bad = submit({ ...validClaim, currency: "dollars" });
  const posts: unknown[] = [];
  const { clock, queue, worker } = mk([bad, submit({ ...validClaim, currency: "dollars" })], {
    webhookUrl: "https://n8n.example/hook", fetchImpl: async (...a: unknown[]) => { posts.push(a); return { ok: true, status: 200 }; },
  });
  const { id } = queue.enqueue("c", clock.now());
  await worker.drain();
  assert.equal(queue.get(id)!.state, "needs_human");
  assert.equal(posts.length, 0);
});

test("deliver: POSTs validated row with idempotency-key; webhook 503 retries without re-calling the model", async () => {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  let n = 0;
  const fetchImpl = async (url: string, init: any) => { posts.push({ url, ...init }); return { ok: ++n > 1, status: n > 1 ? 200 : 503 }; };
  const { clock, queue, client, worker } = mk([submit(validClaim)], { webhookUrl: "https://n8n.example/hook", fetchImpl });
  const { id } = queue.enqueue("c", clock.now());
  await worker.drain();
  const row = queue.get(id)!;
  assert.equal(row.state, "done");
  assert.equal(client.calls.length, 1); // model called once despite two delivery attempts
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers["idempotency-key"], row.idem_key);
  assert.equal(JSON.parse(posts[1]!.body).policy_number, "POL-48213");
});

test("restart recovery: a claim stuck in 'processing' goes back to pending", () => {
  const path = join(mkdtempSync(join(tmpdir(), "q-")), "q.db");
  const q1 = new ClaimQueue(path);
  const { id } = q1.enqueue("c", 0);
  q1.claimNext(0); // worker "crashes" here, holding the claim
  assert.equal(q1.get(id)!.state, "processing");
  assert.equal(new ClaimQueue(path).get(id)!.state, "pending");
});

test("backoff grows exponentially, is capped, and respects retry-after", () => {
  const o = { baseMs: 1000, capMs: 8000, rng: () => 1 };
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => backoffMs(a, new Error("x"), o)), [1000, 2000, 4000, 8000, 8000]);
  assert.equal(backoffMs(1, apiError(429, 30), o), 30000);
  assert.equal(backoffMs(1, new Error("x"), { ...o, rng: () => 0 }), 500); // jitter floor is half
});
