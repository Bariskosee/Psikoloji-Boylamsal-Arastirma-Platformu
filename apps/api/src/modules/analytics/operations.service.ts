import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@lpr/db";
import type { OperationsHealthResponse } from "@lpr/contracts";
import { DATABASE } from "../database/database.module.js";

/**
 * The operations page (PLAN.md Phase 10, ADR-004, ADR-005, ADR-010).
 *
 * ── Why this does NOT use the analytics role ────────────────────────────────
 * Everything else on the dashboard does, and must. This one cannot: push
 * subscription attrition lives in `identity`, and the pgboss schema is neither
 * `research` nor `identity`. The analytics role is correctly denied both.
 *
 * That is not a hole in NFR-03, it is the boundary working. Operational health
 * is a different question from research analysis, asks it of different tables,
 * and is restricted differently — admin only, rather than by study role. The
 * two must not share a connection precisely so that neither inherits the
 * other's reach.
 *
 * ── What it deliberately cannot show ────────────────────────────────────────
 * Counts and timestamps. No participant identifiers, no endpoints, no payloads,
 * no dead-letter job bodies. An operations page is somewhere a screen gets left
 * open, and a job payload can name a participant (AGENT.md §5).
 *
 * ── Why sweeper heartbeats are first ────────────────────────────────────────
 * ADR-010's operational warning: on a hosting tier that idles services out, the
 * reconciliation loop stops and the entire scheduling guarantee disappears with
 * no error anywhere. `system_heartbeats` is the only evidence that something
 * which should be happening still is, and this page is where an operator looks.
 */
@Injectable()
export class OperationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async health(): Promise<OperationsHealthResponse> {
    const sweepers = await this.db.execute<{
      worker_id: string;
      swept_at: Date | string;
      age_seconds: string;
      sweep_interval_seconds: number;
      consecutive_failures: number;
      last_error: string | null;
    }>(sql`
      SELECT worker_id, swept_at,
             EXTRACT(EPOCH FROM (now() - swept_at))::bigint::text AS age_seconds,
             sweep_interval_seconds, consecutive_failures, last_error
        FROM research.system_heartbeats
       ORDER BY swept_at DESC
    `);

    /**
     * Dead letters, grouped by the queue they came from.
     *
     * The pgboss schema may not exist yet on a database where the worker has
     * never started — it is created by the worker as queue owner (ADR-004). A
     * missing schema is an ordinary state, not an error, so the query is
     * guarded rather than allowed to throw and blank the whole page.
     */
    let deadLetteredJobs: OperationsHealthResponse["deadLetteredJobs"] = [];
    try {
      const jobs = await this.db.execute<{
        name: string;
        count: string;
        newest: Date | string | null;
      }>(sql`
        SELECT name, count(*)::text AS count, max(created_on) AS newest
          FROM pgboss.job
         WHERE name LIKE '%.dlq'
         GROUP BY name
         ORDER BY name
      `);
      deadLetteredJobs = jobs.rows.map((row) => ({
        queue: row.name,
        count: Number(row.count),
        newestAt:
          row.newest === null || row.newest === undefined
            ? null
            : new Date(row.newest).toISOString(),
      }));
    } catch {
      // No pgboss schema: the worker has not run here. Reported as no dead
      // letters, which is true, and the empty sweeper list above is what tells
      // an operator the worker is absent.
      deadLetteredJobs = [];
    }

    const notifications = await this.db.execute<{
      outcome: string;
      suppression_reason: string | null;
      count: string;
    }>(sql`
      SELECT outcome, suppression_reason, count(*)::text AS count
        FROM research.notification_attempts
       WHERE scheduled_for > now() - interval '24 hours'
       GROUP BY outcome, suppression_reason
    `);

    let accepted = 0;
    let failed = 0;
    let suppressed = 0;
    let last24h = 0;
    const suppressionReasons: Record<string, number> = {};

    for (const row of notifications.rows) {
      const count = Number(row.count);
      last24h += count;
      if (row.outcome === "SENT_ACCEPTED" || row.outcome === "ATTEMPTED") accepted += count;
      else if (row.outcome === "FAILED") failed += count;
      else if (row.outcome === "SUPPRESSED") {
        suppressed += count;
        // Kept by reason rather than totalled: a spike in SUPPRESSED_STALE is
        // an outage, a spike in SUPPRESSED_NO_SUBSCRIPTION is participants
        // losing push, and averaging them together hides both.
        const reason = row.suppression_reason ?? "UNKNOWN";
        suppressionReasons[reason] = (suppressionReasons[reason] ?? 0) + count;
      }
    }

    const subscriptions = await this.db.execute<{
      active: string;
      inactive: string;
      recently_lost: string;
    }>(sql`
      SELECT count(*) FILTER (WHERE is_active)::text                            AS active,
             count(*) FILTER (WHERE NOT is_active)::text                        AS inactive,
             count(*) FILTER (
               WHERE NOT is_active AND deactivated_at > now() - interval '7 days'
             )::text                                                            AS recently_lost
        FROM identity.push_subscriptions
    `);
    const subs = subscriptions.rows[0];

    return {
      sweepers: sweepers.rows.map((row) => {
        const ageSeconds = Number(row.age_seconds);
        return {
          workerId: row.worker_id,
          sweptAt: new Date(row.swept_at).toISOString(),
          ageSeconds,
          sweepIntervalSeconds: row.sweep_interval_seconds,
          consecutiveFailures: row.consecutive_failures,
          lastError: row.last_error,
          /**
           * Stale at three missed cycles.
           *
           * One late cycle is ordinary jitter; three in a row is a loop that
           * has stopped, and stopping is invisible by any other means — a
           * halted sweeper looks exactly like a sweeper with nothing to do.
           */
          stale: ageSeconds > row.sweep_interval_seconds * 3,
        };
      }),
      deadLetteredJobs,
      notifications: { last24h, accepted, failed, suppressed, suppressionReasons },
      pushSubscriptions: {
        active: Number(subs?.active ?? 0),
        inactive: Number(subs?.inactive ?? 0),
        recentlyLost: Number(subs?.recently_lost ?? 0),
      },
    };
  }
}
