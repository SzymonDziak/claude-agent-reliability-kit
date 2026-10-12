import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite"; // built in: no native build step

export type ClaimState = "pending" | "processing" | "done" | "needs_human" | "failed";

export interface ClaimRow {
  id: number;
  idem_key: string;
  payload: string;
  state: ClaimState;
  attempts: number;
  next_attempt_at: number;
  result: string | null;
  last_error: string | null;
}

/** Idempotency key = hash of the whitespace-normalized submission, so a re-sent form is the same claim. */
export const idempotencyKey = (payload: string) =>
  createHash("sha256").update(payload.trim().replace(/\s+/g, " ")).digest("hex");

export class ClaimQueue {
  private db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idem_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    // Crash recovery: anything left 'processing' by a dead worker goes back to pending.
    this.db.exec(`UPDATE claims SET state='pending' WHERE state='processing'`);
  }

  /** Insert-or-ignore on the idempotency key. Re-enqueueing the same submission returns the existing row. */
  enqueue(payload: string, now = Date.now()): { id: number; created: boolean } {
    const key = idempotencyKey(payload);
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO claims (idem_key, payload, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(key, payload, now, now, now);
    const row = this.db.prepare(`SELECT id FROM claims WHERE idem_key = ?`).get(key) as { id: number };
    return { id: row.id, created: Number(r.changes) === 1 };
  }

  /** Atomically take the next due pending claim. */
  claimNext(now = Date.now()): ClaimRow | undefined {
    const row = this.db.prepare(
      `SELECT * FROM claims WHERE state='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1`,
    ).get(now) as ClaimRow | undefined;
    if (!row) return undefined;
    this.db.prepare(`UPDATE claims SET state='processing', attempts=attempts+1, updated_at=? WHERE id=?`).run(now, row.id);
    return { ...row, state: "processing", attempts: row.attempts + 1 };
  }

  /** Earliest time a pending claim becomes due (to know how long to sleep). */
  nextDueAt(): number | undefined {
    const r = this.db.prepare(`SELECT MIN(next_attempt_at) AS t FROM claims WHERE state='pending'`).get() as { t: number | null };
    return r.t ?? undefined;
  }

  finish(id: number, state: "done" | "needs_human" | "failed", fields: { result?: unknown; error?: string } = {}, now = Date.now()) {
    this.db.prepare(`UPDATE claims SET state=?, result=COALESCE(?, result), last_error=?, updated_at=? WHERE id=?`)
      .run(state, fields.result === undefined ? null : JSON.stringify(fields.result), fields.error ?? null, now, id);
  }

  retryAt(id: number, at: number, error: string, now = Date.now()) {
    this.db.prepare(`UPDATE claims SET state='pending', next_attempt_at=?, last_error=?, updated_at=? WHERE id=?`).run(at, error, now, id);
  }

  /** Store the validated result while delivery is still outstanding, so a retry never re-calls the model. */
  saveResult(id: number, result: unknown) {
    this.db.prepare(`UPDATE claims SET result=? WHERE id=?`).run(JSON.stringify(result), id);
  }

  get(id: number): ClaimRow | undefined {
    return this.db.prepare(`SELECT * FROM claims WHERE id=?`).get(id) as ClaimRow | undefined;
  }

  all(): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claims ORDER BY id`).all() as unknown as ClaimRow[];
  }
}
