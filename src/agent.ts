import type Anthropic from "@anthropic-ai/sdk";
import { lookupPolicy } from "./policy.ts";
import { ClaimSchema, formatZodIssues, type Claim } from "./schema.ts";
import { SYSTEM, TOOLS } from "./tools.ts";
import { noopTracer, type Tracer } from "./trace.ts";

/** The only part of the SDK we depend on, so tests can pass a scripted fake. */
export interface ModelClient {
  messages: { create(p: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface AgentOptions {
  model: string;
  claimId: number | string;
  maxTurns?: number; // hard cap on tool-use turns (default 5)
  tracer?: Tracer;
  retryCount?: number; // queue-level retries so far, surfaced in the trace
}

export type AgentResult =
  | { status: "done"; data: Claim; turns: number; lookups: number; cacheHits: number }
  | { status: "needs_human"; reason: string; turns: number; lookups: number; cacheHits: number };

type Msg = Anthropic.MessageParam;
type ToolUse = Anthropic.ToolUseBlock;
const MAX_TOOL_RESULT_CHARS = 800;

export async function runClaimAgent(client: ModelClient, claimText: string, opts: AgentOptions): Promise<AgentResult> {
  const { model, claimId, maxTurns = 5, tracer = noopTracer, retryCount = 0 } = opts;
  const messages: Msg[] = [{ role: "user", content: `<claim>\n${claimText}\n</claim>` }];
  const memo = new Map<string, { content: string; is_error: boolean }>(); // per-claim memoization
  let turn = 0, lookups = 0, cacheHits = 0;
  const stats = () => ({ turns: turn, lookups, cacheHits });
  const human = (reason: string): AgentResult => ({ status: "needs_human", reason, ...stats() });

  async function call(phase: "tools" | "submit" | "repair", forceSubmit: boolean): Promise<Anthropic.Message> {
    turn++;
    const t0 = Date.now();
    const base = { ts: new Date().toISOString(), claim_id: claimId, turn, phase, retry_count: retryCount };
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        tool_choice: forceSubmit ? { type: "tool", name: "submit_claim" } : { type: "auto" },
        messages,
      });
      const u = msg.usage;
      tracer({
        ...base, stop_reason: msg.stop_reason, input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens ?? 0, cache_write_tokens: u.cache_creation_input_tokens ?? 0,
        latency_ms: Date.now() - t0,
      });
      return msg;
    } catch (err) {
      tracer({
        ...base, stop_reason: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        latency_ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err),
      });
      throw err; // the queue worker decides whether this is retryable
    }
  }

  const usesOf = (m: Anthropic.Message) => m.content.filter((b): b is ToolUse => b.type === "tool_use");

  /** Runs lookup_policy with memoization. Errors come back as is_error results so the model can adapt. */
  function runLookup(use: ToolUse): Anthropic.ToolResultBlockParam {
    const raw = (use.input as { policy_number?: unknown }).policy_number;
    const key = `lookup_policy:${String(raw).trim().toUpperCase()}`;
    const hit = memo.get(key);
    if (hit) {
      cacheHits++;
      return { type: "tool_result", tool_use_id: use.id, is_error: hit.is_error, content: `${hit.content}\n(cached: you already looked this up, do not call it again)` };
    }
    let out: { content: string; is_error: boolean };
    try {
      lookups++;
      const p = lookupPolicy(String(raw).trim().toUpperCase());
      // Trim: only fields the model needs, hard length cap.
      out = { content: JSON.stringify({ status: p.status, covers: p.covers, deductible: p.deductible, limit: p.limit }).slice(0, MAX_TOOL_RESULT_CHARS), is_error: false };
    } catch (e) {
      out = { content: (e instanceof Error ? e.message : String(e)).slice(0, MAX_TOOL_RESULT_CHARS), is_error: true };
    }
    memo.set(key, out);
    return { type: "tool_result", tool_use_id: use.id, ...out };
  }

  // ---- Phase 1: bounded tool loop ----
  let submitted: ToolUse | undefined;
  let lastUses: ToolUse[] = [];
  let finishedTools = false;
  for (let i = 0; i < maxTurns && !finishedTools; i++) {
    const msg = await call("tools", false);
    messages.push({ role: "assistant", content: msg.content });
    lastUses = usesOf(msg);
    submitted = lastUses.find((u) => u.name === "submit_claim");
    if (submitted || lastUses.length === 0) { finishedTools = true; break; }
    // Every tool_use gets exactly one tool_result with the matching id.
    const results = lastUses.map((u) =>
      u.name === "lookup_policy" ? runLookup(u)
        : ({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `Unknown tool ${u.name}` } as const));
    messages.push({ role: "user", content: results });
    if (i === maxTurns - 1) return human(`tool turn cap (${maxTurns}) reached without a submission`);
  }

  // ---- Phase 2: forced structured output, validate, one repair ----
  if (!submitted) {
    messages.push({ role: "user", content: "Now call submit_claim with the final structured result." });
    const msg = await call("submit", true);
    messages.push({ role: "assistant", content: msg.content });
    lastUses = usesOf(msg);
    submitted = lastUses.find((u) => u.name === "submit_claim");
  }
  for (let repairs = 0; ; repairs++) {
    if (!submitted) return human("model did not call submit_claim");
    const parsed = ClaimSchema.safeParse(submitted.input);
    if (parsed.success) return { status: "done", data: parsed.data, ...stats() };
    if (repairs >= 1) return human(`validation failed after repair:\n${formatZodIssues(parsed.error)}`);
    const bad = submitted;
    messages.push({
      role: "user",
      content: lastUses.map((u): Anthropic.ToolResultBlockParam => ({
        type: "tool_result", tool_use_id: u.id, is_error: true,
        content: u.id === bad.id ? `Validation failed. Fix these and call submit_claim again:\n${formatZodIssues(parsed.error)}` : "Skipped; submit_claim first.",
      })),
    });
    const msg = await call("repair", true);
    messages.push({ role: "assistant", content: msg.content });
    lastUses = usesOf(msg);
    submitted = lastUses.find((u) => u.name === "submit_claim");
  }
}
