import { Inject, Injectable } from "@nestjs/common";
import { DEFAULT_JOB_SCHEMA, ping, type Pool } from "@lpr/db";
import {
  healthResponseSchema,
  readyResponseSchema,
  type HealthResponse,
  type ReadyResponse,
} from "@lpr/contracts";
import { DB_POOL } from "../database/database.module.js";

const SERVICE_NAME = "api";
const JOB_SCHEMA = DEFAULT_JOB_SCHEMA;
const VERSION = process.env["npm_package_version"] ?? "0.0.0";

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  liveness(): HealthResponse {
    // Responses are parsed through the shared schema, not merely typed as it,
    // so a contract drift fails here rather than in a consumer.
    return healthResponseSchema.parse({
      status: "ok",
      service: SERVICE_NAME,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    });
  }

  /**
   * Readiness: every dependency this process needs is reachable.
   *
   * ── Why the job schema is checked, and how (Phase 12) ───────────────────
   * PLAN.md asks readiness to cover the database AND the job system. The API
   * attaches to pg-boss as a CLIENT (ADR-004): it enqueues and never migrates.
   * If the `pgboss` schema is absent — the worker has never run, or a deploy
   * brought the API up first — every enqueue fails, and until now the API
   * would have reported itself ready and then dropped notifications on the
   * floor.
   *
   * Checked by asking whether the schema exists rather than by starting a
   * queue: readiness must be cheap enough to run every few seconds, and
   * starting pg-boss to answer it would open connections and run maintenance
   * on a probe.
   *
   * ── Why a missing job schema does NOT make the API unready ──────────────
   * It is reported as a failing check but does not flip `ready` to false. The
   * API's core job — serving participants their questionnaires and saving
   * answers — works perfectly without the queue, and ADR-005 is explicit that
   * the sweepers make the system correct while jobs only make it prompt.
   * Draining traffic from a healthy API because the worker has not booted yet
   * would turn a degraded feature into a total outage, which is precisely the
   * inversion ADR-005 exists to prevent.
   *
   * So it is visible on the probe and in the operations page, and it does not
   * take the service down.
   */
  async readiness(): Promise<ReadyResponse> {
    const [database, jobs] = await Promise.all([ping(this.pool), this.pingJobSchema()]);

    return readyResponseSchema.parse({
      // The database alone decides readiness. Without it nothing works; without
      // the queue, everything works one sweep interval later.
      ready: database.ok,
      service: SERVICE_NAME,
      checks: [
        {
          name: "postgres",
          ok: database.ok,
          latencyMs: database.latencyMs,
          ...(database.error ? { error: database.error } : {}),
        },
        {
          name: "jobs",
          ok: jobs.ok,
          latencyMs: jobs.latencyMs,
          ...(jobs.error ? { error: jobs.error } : {}),
        },
      ],
    });
  }

  /**
   * Is the pg-boss schema installed?
   *
   * One catalogue lookup. It answers the only question the API can usefully ask
   * about the queue as a client — "is there something to enqueue into?" —
   * without taking on the cost or the side effects of connecting as one.
   */
  private async pingJobSchema(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      const result = await this.pool.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
         ) AS present`,
        [JOB_SCHEMA],
      );
      const present = result.rows[0]?.present === true;
      return {
        ok: present,
        latencyMs: Date.now() - started,
        ...(present
          ? {}
          : {
              error:
                `the "${JOB_SCHEMA}" schema does not exist yet. The worker installs it as ` +
                "queue owner (ADR-004); notifications will be late until it has run.",
            }),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
