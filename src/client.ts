import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./agent.ts";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const modelFromEnv = () => process.env.CLAUDE_MODEL || DEFAULT_MODEL;

/** Real client. maxRetries is 0 on purpose: retries belong to the durable queue, so a retry is never invisible or lost on process exit. */
export function liveClient(): ModelClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");
  return new Anthropic({ apiKey, maxRetries: 0, timeout: 60_000 }) as unknown as ModelClient;
}
