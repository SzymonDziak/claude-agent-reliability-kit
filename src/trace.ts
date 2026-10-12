import { appendFileSync } from "node:fs";

/** One JSON line per model call. Sink defaults to stdout; pass a file path for a log file. */
export interface TraceEvent {
  ts: string;
  claim_id: number | string;
  turn: number;
  phase: "tools" | "submit" | "repair";
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  retry_count: number;
  error?: string;
}

export type Tracer = (e: TraceEvent) => void;

export const stdoutTracer: Tracer = (e) => process.stdout.write(JSON.stringify(e) + "\n");
export const fileTracer = (path: string): Tracer => (e) => appendFileSync(path, JSON.stringify(e) + "\n");
export const noopTracer: Tracer = () => {};
