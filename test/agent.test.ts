import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaimAgent } from "../src/agent.ts";
import { reply, scriptedClient } from "../src/fakeClient.ts";
import { lookupCalls } from "../src/policy.ts";
import type { TraceEvent } from "../src/trace.ts";
import { lookup, submit, validClaim } from "./helpers.ts";

const opts = { model: "test-model", claimId: 1 };

test("loop cap: model that keeps calling the tool is stopped and marked needs_human", async () => {
  // 10 scripted lookups available, but the agent must stop after 5 model calls.
  const client = scriptedClient(Array.from({ length: 10 }, (_, i) => lookup(`tu_${i}`, `POL-${1000 + i}`)));
  const r = await runClaimAgent(client, "claim", { ...opts, maxTurns: 5 });
  assert.equal(r.status, "needs_human");
  assert.equal(client.calls.length, 5);
});

test("identical lookups are memoized: one real API hit, cached note returned", async () => {
  const before = lookupCalls.count;
  const client = scriptedClient([lookup("a"), lookup("b"), submit(validClaim)]);
  const r = await runClaimAgent(client, "claim", opts);
  assert.equal(r.status, "done");
  assert.equal(lookupCalls.count - before, 1);
  assert.equal(r.status === "done" && r.cacheHits, 1);
  const results = (client.calls[2]!.messages.at(-1)!.content as any[]);
  assert.match(results[0].content, /cached/);
});

test("tool_result ids match tool_use ids; unknown policy returns is_error", async () => {
  const client = scriptedClient([lookup("tu_x", "POL-00000"), submit({ ...validClaim, coverage_confirmed: false })]);
  await runClaimAgent(client, "claim", opts);
  const res = client.calls[1]!.messages.at(-1)!.content as any[];
  assert.equal(res[0].tool_use_id, "tu_x");
  assert.equal(res[0].is_error, true);
});

test("submit_claim is forced via tool_choice and prompt caching is set up", async () => {
  const client = scriptedClient([reply([], "end_turn"), submit(validClaim)]);
  await runClaimAgent(client, "claim", opts);
  assert.deepEqual(client.calls[1]!.tool_choice, { type: "tool", name: "submit_claim" });
  const p = client.calls[0]!;
  assert.ok((p.system as any[]).at(-1).cache_control);
  assert.ok((p.tools as any[]).at(-1).cache_control);
});

test("malformed output: validation errors sent back, repair succeeds", async () => {
  const client = scriptedClient([submit({ ...validClaim, amount_claimed: "about 1,800" }), submit(validClaim, "tu_fix")]);
  const events: TraceEvent[] = [];
  const r = await runClaimAgent(client, "claim", { ...opts, tracer: (e) => events.push(e) });
  assert.equal(r.status, "done");
  const fb = client.calls[1]!.messages.at(-1)!.content as any[];
  assert.equal(fb[0].is_error, true);
  assert.match(fb[0].content, /amount_claimed/);
  assert.deepEqual(events.map((e) => e.phase), ["tools", "repair"]);
});

test("repair also invalid: needs_human, never a bad row", async () => {
  const bad = { ...validClaim, incident_date: "last Tuesday" };
  const client = scriptedClient([submit(bad), submit(bad, "tu2")]);
  const r = await runClaimAgent(client, "claim", opts);
  assert.equal(r.status, "needs_human");
  assert.match((r as any).reason, /incident_date/);
  assert.equal(client.calls.length, 2); // exactly one repair attempt
});

test("trace: one line per model call with token and cache fields", async () => {
  const events: TraceEvent[] = [];
  await runClaimAgent(scriptedClient([lookup("a"), submit(validClaim)]), "c", { ...opts, retryCount: 2, tracer: (e) => events.push(e) });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.stop_reason, "tool_use");
  assert.equal(events[0]!.retry_count, 2);
  assert.equal(events[0]!.cache_read_tokens, 1000);
  assert.ok(events[0]!.latency_ms >= 0 && events[1]!.turn === 2);
});
