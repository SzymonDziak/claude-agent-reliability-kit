import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./agent.ts";

type Params = Anthropic.MessageCreateParamsNonStreaming;
export type Step = Anthropic.Message | Error | ((p: Params) => Anthropic.Message | Error);

/** Build an API-like error (what the SDK throws on 429/529) for tests and the demo. */
export function apiError(status: number, retryAfterSec?: number): Error {
  const e = new Error(`${status} simulated API error`) as Error & { status: number; headers: Record<string, string> };
  e.status = status;
  e.headers = retryAfterSec === undefined ? {} : { "retry-after": String(retryAfterSec) };
  return e;
}

export const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

export function reply(content: Anthropic.ContentBlock[], stop: "tool_use" | "end_turn" = "tool_use"): Anthropic.Message {
  return {
    id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/** Plays back scripted steps in order; records every request for assertions. */
export function scriptedClient(steps: Step[]): ModelClient & { calls: Params[] } {
  const calls: Params[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(p) {
        // Snapshot: the agent mutates its messages array after the call.
        calls.push(structuredClone(p));
        const step = steps[i++];
        if (!step) throw new Error("scriptedClient: ran out of steps");
        const out = typeof step === "function" ? step(p) : step;
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

/**
 * Rule-based stand-in for the model, used by `npm run demo`. Reads labelled fields from the claim text.
 * With `chaos`, it misbehaves on purpose to show the reliability machinery working:
 *  - claims containing "Hailstorm": first call fails with 429 (retry-after 1s)
 *  - claims containing "Brake": first submission is malformed JSON-shape (repair kicks in)
 */
export function demoClient(chaos = true): ModelClient {
  const seen = new Map<string, number>();
  const field = (t: string, label: string) => new RegExp(`^${label}:\\s*(.+)$`, "mi").exec(t)?.[1]?.trim();
  return {
    messages: {
      async create(p) {
        const first = p.messages[0]!.content as string;
        const n = (seen.get(first) ?? 0) + 1;
        seen.set(first, n);
        if (chaos && first.includes("Hailstorm") && n === 1) throw apiError(429, 1);
        const policy = field(first, "Policy");
        const toolResults = p.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
        const lookedUp = toolResults.find((b) => !b.is_error && !String(JSON.stringify(b.content)).includes("Validation"));
        const lookupFailed = toolResults.some((b) => b.is_error && String(JSON.stringify(b.content)).includes("not found"));
        if (policy && p.tool_choice?.type === "auto" && toolResults.length === 0) {
          return reply([toolUse("tu_lookup", "lookup_policy", { policy_number: policy })]);
        }
        const repairing = toolResults.some((b) => b.is_error && JSON.stringify(b.content).includes("Validation failed"));
        const claim = {
          policy_number: policy ?? "POL-0000",
          claimant_name: field(first, "Name") ?? "Unknown",
          incident_date: field(first, "Date") ?? "1970-01-01",
          claim_type: field(first, "Type") ?? "other",
          amount_claimed: Number((field(first, "Amount") ?? "0").replace(/[^\d.]/g, "")),
          currency: "USD",
          coverage_confirmed: Boolean(lookedUp) && !lookupFailed && !String(JSON.stringify(lookedUp?.content)).includes("lapsed"),
          summary: field(first, "Summary") ?? "",
        };
        if (chaos && first.includes("Brake") && !repairing) (claim as Record<string, unknown>).amount_claimed = "about 1,800 dollars"; // malformed
        return reply([toolUse("tu_submit", "submit_claim", claim)]);
      },
    },
  };
}
