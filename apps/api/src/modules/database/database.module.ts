import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createAnalyticsPool, createDatabase, createPool, type Database, type Pool } from "@lpr/db";
import { loadEnv } from "../../config/env.js";

/** Injection tokens. Symbols, so nothing can collide with a string provider. */
export const DB_POOL = Symbol("DB_POOL");
export const DATABASE = Symbol("DATABASE");
/** The restricted pool. SELECT on `research` only; no access to `identity`. */
export const ANALYTICS_POOL = Symbol("ANALYTICS_POOL");
export const ANALYTICS_DATABASE = Symbol("ANALYTICS_DATABASE");

/**
 * One connection pool for the process, shared by every module.
 *
 * Phase 0 created a pool inside HealthModule so `/ready` had something to
 * probe. That was the right size then and the wrong size now: a second module
 * building its own pool would double the connections against a database whose
 * connection limit is the binding constraint on a small managed plan.
 *
 * Global, because every domain module needs it and threading an import through
 * each one adds ceremony without adding a boundary.
 *
 * ── The second pool (Phase 10, ADR-003, NFR-03) ─────────────────────────────
 * Every dashboard and analytics query runs on `ANALYTICS_DATABASE`, whose
 * connections have dropped to the `app_analytics` role. That role has SELECT on
 * `research` and NOTHING on `identity`, so a query that accidentally reaches
 * for a push endpoint or a password hash fails at the database rather than
 * quietly returning it.
 *
 * Small on purpose: dashboard traffic is a handful of researchers, and every
 * connection here is one the participant-facing path cannot have.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: (): Pool => {
        const logger = new Logger("DbPool");
        return createPool({
          connectionString: loadEnv().DATABASE_URL,
          max: 10,
          // Log and carry on. The pool reconnects; the process must not die,
          // or a brief database blip would take down the API and the worker.
          onError: (error) => logger.error(`idle client error: ${error.message}`),
        });
      },
    },
    {
      provide: DATABASE,
      inject: [DB_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
    {
      provide: ANALYTICS_POOL,
      useFactory: (): Pool => {
        const logger = new Logger("AnalyticsPool");
        /**
         * The SAME connection string, dropped to `app_analytics` by `SET ROLE`.
         *
         * There is deliberately no second credential. `app_analytics` is a
         * NOLOGIN group role — migration 0000 says so explicitly, "the
         * deployment grants them to the actual login users, so credentials
         * never appear in a migration" — and inventing a login user for it
         * would mean a second password to provision, rotate and leak, for a
         * guarantee `SET ROLE` already provides at the database.
         *
         * This is not hypothetical tidiness. An earlier version accepted an
         * optional `DATABASE_ANALYTICS_URL`, and the placeholder left in a
         * developer's `.env` pointed at a user that did not exist — which
         * failed the entire dashboard with an authentication error rather than
         * degrading. One credential cannot go stale against itself.
         */
        return createAnalyticsPool({
          connectionString: loadEnv().DATABASE_URL,
          max: 4,
          onError: (error) => logger.error(error.message),
        });
      },
    },
    {
      provide: ANALYTICS_DATABASE,
      inject: [ANALYTICS_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
  ],
  exports: [DB_POOL, DATABASE, ANALYTICS_POOL, ANALYTICS_DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(ANALYTICS_POOL) private readonly analyticsPool: Pool,
  ) {}

  /**
   * Nest calls this on SIGTERM because `enableShutdownHooks()` is on.
   *
   * Without it the process would hold its connections open through the whole
   * shutdown grace period, and the replacement instance would start against a
   * database already at its connection limit — a deploy that fails only under
   * load, which is the worst kind to diagnose.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.analyticsPool.end()]);
  }
}
