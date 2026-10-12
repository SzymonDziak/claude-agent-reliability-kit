import { runClaimAgent, type ModelClient } from "./agent.ts";
import { deliver, type Fetch } from "./deliver.ts";
import { backoffMs, isRetryable, type BackoffOptions } from "./retry.ts";
import type { ClaimQueue, ClaimRow } from "./queue.ts";
import type { Claim } from "./schema.ts";
import type { Tracer } from "./trace.ts";

export interface WorkerOptions {
  client: ModelClient;
  queue: ClaimQueue;
  model: string;
  tracer?: Tracer;
  webhookUrl?: string;
  fetchImpl?: Fetch;
  maxAttempts?: number; // after this many tries a claim is parked as 'failed' (still in the table, replayable)
  backoff?: BackoffOptions;
  now?: () => number; // injectable clock + sleep make retry tests instant and deterministic
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export class Worker {
  private o: Required<Pick<WorkerOptions, "maxAttempts" | "now" | "sleep" | "log">> & WorkerOptions;
  constructor(opts: WorkerOptions) {
    this.o = { maxAttempts: 6, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: () => {}, ...opts };
  }

  /** Process every claim until nothing is pending. Sleeps until the next retry is due; never drops a claim. */
  async drain() {
    for (;;) {
      const row = this.o.queue.claimNext(this.o.now());
      if (row) { await this.process(row); continue; }
      const next = this.o.queue.nextDueAt();
      if (next === undefined) return;
      await this.o.sleep(Math.max(0, next - this.o.now()));
    }
  }

  private async process(row: ClaimRow) {
    const { queue, now, log } = this.o;
    try {
      // Resume after a delivery failure without paying for the model call again.
      let claim: Claim | undefined = row.result ? (JSON.parse(row.result) as Claim) : undefined;
      if (!claim) {
        const r = await runClaimAgent(this.o.client, row.payload, {
          model: this.o.model, claimId: row.id, tracer: this.o.tracer, retryCount: row.attempts - 1,
        });
        if (r.status === "needs_human") {
          queue.finish(row.id, "needs_human", { error: r.reason }, now());
          log(`claim ${row.id}: needs_human (${r.reason.split("\n")[0]})`);
          return;
        }
        claim = r.data;
        queue.saveResult(row.id, claim);
      }
      if (this.o.webhookUrl) await deliver(this.o.webhookUrl, row.idem_key, claim, this.o.fetchImpl);
      queue.finish(row.id, "done", { result: claim }, now());
      log(`claim ${row.id}: done`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRetryable(err) && row.attempts < this.o.maxAttempts) {
        const delay = backoffMs(row.attempts, err, this.o.backoff);
        queue.retryAt(row.id, now() + delay, msg, now());
        log(`claim ${row.id}: retry #${row.attempts} in ${Math.round(delay)}ms (${msg})`);
      } else {
        queue.finish(row.id, "failed", { error: msg }, now());
        log(`claim ${row.id}: failed (${msg})`);
      }
    }
  }
}
