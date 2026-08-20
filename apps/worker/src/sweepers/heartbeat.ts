import { classifySweeperHeartbeat, fixedClock, type SweeperHealth } from "@lpr/domain";
import type { Pool } from "@lpr/db";
import type { SweepLogger } from "./sweeper.js";

/**
 * `sweep.heartbeat` — the fourth sweeper (ADR-005, STRUCTURE.md §8.4).
 *
 * It reconciles nothing. It records that the other three ran, which is the only
 * way "the sweep loop stopped" ever becomes visible: a loop that has died looks
 * identical to a loop with nothing to do.
 *
 * It is modelled as a collaborator of the runner rather than as a peer
 * `Sweeper`, because it is a different kind of thing. The other three answer a
 * question about participants; this one answers a question about the runner, and
 * it needs the cycle's result — including which sweepers failed — to do so. A
 * `Sweeper` cannot be handed that without giving every sweeper access to the
 * outcomes of its siblings, which none of them should have. It keeps the name
 * `sweep.heartbeat` in logs and in the table so operations sees the four the
 * ADR describes.
 */

/** Recorded after every cycle, clean or not. */
export interface CycleObservation {
  /** Sweepers that threw or reported failed rows, for `last_error`. */
  readonly failures: readonly string[];
}

export interface HeartbeatReport {
  /** The row as it now stands, straight from the database clock. */
  readonly sweptAt: Date;
  readonly consecutiveFailures: number;
  /**
   * How the PREVIOUS cycle's heartbeat looks from this one — the gap that
   * reveals a worker which was alive but not sweeping. `null` on the first
   * cycle after a restart, where there is nothing to compare against.
   */
  readonly previous: SweeperHealth | null;
}

export interface HeartbeatWriterOptions {
  readonly pool: Pool;
  readonly workerId: string;
  readonly sweepIntervalSeconds: number;
  readonly logger: SweepLogger;
  /** Overridable so a test does not have to wait five real minutes. */
  readonly staleAfterMs?: number;
  /** Called when this worker detects it stopped sweeping. Wire to Sentry. */
  readonly onStale?: (health: SweeperHealth) => void;
}

export const HEARTBEAT_SWEEPER_NAME = "sweep.heartbeat";

/**
 * What the runner needs from the heartbeat.
 *
 * The runner depends on this rather than on `HeartbeatWriter` so that testing
 * the loop does not require a database. The loop's behaviour — that a failing
 * cycle still records, that a heartbeat failure does not stop the sweeping —
 * is the part most worth pinning down, and it should not be reachable only
 * through PostgreSQL.
 */
export interface HeartbeatRecorder {
  readonly name: string;
  record(observation: CycleObservation): Promise<HeartbeatReport>;
}

/**
 * `last_error` is a diagnostic column, not a log sink. Truncated so a sweeper
 * that fails with a multi-kilobyte driver error cannot turn every heartbeat
 * write into a large one.
 */
const MAX_LAST_ERROR_LENGTH = 500;

export class HeartbeatWriter implements HeartbeatRecorder {
  readonly name = HEARTBEAT_SWEEPER_NAME;
  readonly #options: HeartbeatWriterOptions;

  /**
   * When this process booted, as the DATABASE saw it — captured from `now()`
   * on the first write and then written back unchanged on every later cycle.
   *
   * Not `new Date()`. This process's clock is exactly the thing a reader of
   * this table cannot trust, so every column in the row is stamped by the one
   * clock the schedule itself is enforced against.
   */
  #startedAt: Date | null = null;

  constructor(options: HeartbeatWriterOptions) {
    this.#options = options;
  }

  /**
   * Record the end of a cycle and return what the previous one looked like.
   *
   * Every timestamp comes from the DATABASE clock, never from this process.
   * The sweep queries compare `available_from <= now()` against the database
   * clock, so a worker with a skewed clock must not be able to write a
   * heartbeat that disagrees with the schedule it is enforcing — or, worse,
   * declare itself healthy on the strength of its own wrong clock.
   */
  async record(observation: CycleObservation): Promise<HeartbeatReport> {
    const { pool, workerId, sweepIntervalSeconds } = this.#options;
    const clean = observation.failures.length === 0;
    const lastError = clean ? null : summariseFailures(observation.failures);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        // Read before write, under the row lock, so the previous cycle's
        // timestamp is observed rather than overwritten. `ON CONFLICT DO
        // UPDATE … RETURNING` cannot give both values: in RETURNING the table
        // alias already refers to the updated row.
        const before = await client.query<{ swept_at: Date; consecutive_failures: number }>(
          `SELECT swept_at, consecutive_failures
             FROM research.system_heartbeats
            WHERE worker_id = $1
            FOR UPDATE`,
          [workerId],
        );

        const previousRow = before.rows[0] ?? null;

        const written = await client.query<{
          swept_at: Date;
          started_at: Date;
          consecutive_failures: number;
          db_now: Date;
        }>(
          `INSERT INTO research.system_heartbeats AS h
             (worker_id, started_at, swept_at, sweep_interval_seconds,
              consecutive_failures, last_error)
           VALUES ($1, COALESCE($2::timestamptz, now()), now(), $3, $4, $5)
           ON CONFLICT (worker_id) DO UPDATE SET
             -- NULL on the first cycle after a restart, so a new process stamps
             -- its own boot time here. A started_at that keeps moving while
             -- swept_at never gets far ahead of it is a crash loop.
             started_at             = COALESCE($2::timestamptz, now()),
             swept_at               = now(),
             sweep_interval_seconds = EXCLUDED.sweep_interval_seconds,
             last_error             = EXCLUDED.last_error,
             -- Counted, not set: consecutive failures are only meaningful as a
             -- run. A clean cycle resets to zero, which is what makes a rising
             -- value mean "still broken" rather than "broke once, ever".
             consecutive_failures   = CASE
               WHEN $6::boolean THEN 0
               ELSE h.consecutive_failures + 1
             END
           RETURNING swept_at, started_at, consecutive_failures, now() AS db_now`,
          [workerId, this.#startedAt, sweepIntervalSeconds, clean ? 0 : 1, lastError, clean],
        );

        await client.query("COMMIT");

        const row = written.rows[0];
        if (!row) {
          // Unreachable: an upsert with a RETURNING clause always yields a row.
          // Stated rather than assumed, because a silently missing heartbeat is
          // the one failure this table exists to make impossible.
          throw new Error("heartbeat upsert returned no row");
        }

        this.#startedAt = row.started_at;

        return {
          sweptAt: row.swept_at,
          consecutiveFailures: row.consecutive_failures,
          previous: this.#classifyPrevious(previousRow, row.db_now),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          /* the transaction is dead either way; the original error explains it */
        });
        throw error;
      }
    } finally {
      client.release();
    }
  }

  /**
   * Compare the previous heartbeat against the database's own `now()`.
   *
   * A STALE verdict here means this worker was running but not sweeping — a
   * blocked event loop, a wedged connection, a container frozen and resumed.
   * That is a different failure from the worker being down, and it is the only
   * one the worker itself can detect: a process that is not running cannot
   * report on itself. Detecting the worker being *absent* is a reader's job,
   * using the same classification against this table.
   */
  #classifyPrevious(
    previous: { swept_at: Date; consecutive_failures: number } | null,
    dbNow: Date,
  ): SweeperHealth | null {
    if (previous === null) return null;

    const health = classifySweeperHeartbeat(
      {
        workerId: this.#options.workerId,
        sweptAt: previous.swept_at,
        consecutiveFailures: previous.consecutive_failures,
      },
      {
        clock: fixedClock(dbNow),
        ...(this.#options.staleAfterMs === undefined
          ? {}
          : { staleAfterMs: this.#options.staleAfterMs }),
      },
    );

    if (health.status === "STALE") {
      this.#options.logger.error(
        `${HEARTBEAT_SWEEPER_NAME}: this worker did not sweep for ` +
          `${String(Math.round(health.ageMs / 1000))}s. Scheduling was not being ` +
          `reconciled during that window (ADR-005).`,
      );
      this.#options.onStale?.(health);
    }

    return health;
  }
}

/**
 * Sweeper names and error messages, never a payload or a participant
 * identifier (AGENT.md §5). The column is read by an operator asking "what
 * broke?", and the answer is which sweeper and why.
 */
function summariseFailures(failures: readonly string[]): string {
  const summary = failures.join("; ");
  return summary.length > MAX_LAST_ERROR_LENGTH
    ? `${summary.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : summary;
}
