import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDatabase, createPool, type Database, type Pool } from "@lpr/db";
import { loadEnv } from "../../config/env.js";

/** Injection tokens. Symbols, so nothing can collide with a string provider. */
export const DB_POOL = Symbol("DB_POOL");
export const DATABASE = Symbol("DATABASE");

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
 * The ANALYTICS pool (`DATABASE_ANALYTICS_URL`, ADR-003) is deliberately absent
 * until Phase 11 needs it. Creating a second pool now would open connections
 * nothing uses, and would invite a query to be written against the wrong role
 * before any test proves which role each path uses.
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
  ],
  exports: [DB_POOL, DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Nest calls this on SIGTERM because `enableShutdownHooks()` is on.
   *
   * Without it the process would hold its connections open through the whole
   * shutdown grace period, and the replacement instance would start against a
   * database already at its connection limit — a deploy that fails only under
   * load, which is the worst kind to diagnose.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
