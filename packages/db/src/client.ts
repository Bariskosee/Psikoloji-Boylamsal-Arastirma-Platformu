import { Pool, type PoolConfig } from "pg";

/**
 * Re-exported so consumers never need `pg` as a direct dependency. The driver
 * is an implementation detail of this package; callers depend on @lpr/db.
 */
export type { Pool } from "pg";
/**
 * A single checked-out connection. Exported because a handler that must hold
 * one transaction across several statements — the notification send pipeline
 * does (STRUCTURE.md §9.1) — needs to name the type without `apps/worker`
 * taking a direct dependency on `pg`, which `@lpr/db` exists to own.
 */
export type { PoolClient } from "pg";

/**
 * Connection roles (ADR-003, NFR-03).
 *
 * `readwrite` — full access to the research, identity, and pgboss schemas.
 *               Used by the API and the worker.
 *
 * `analytics` — SELECT on the research schema only, with NO privileges on the
 *               identity schema. Every analytics and export code path must use
 *               this role, so that a query accidentally joining a push endpoint
 *               or a contact detail fails at the database rather than silently
 *               leaking. The role itself is created in Phase 1.
 */
export type DbRole = "readwrite" | "analytics";

export interface CreatePoolOptions {
  connectionString: string;
  /** Keep this small; the API is not the bottleneck, the database is. */
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  /** Notified when an idle client dies. Wire this to your logger and Sentry. */
  onError?: (error: Error) => void;
}

export function createPool(options: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  };

  const pool = new Pool(config);

  /**
   * REQUIRED, not optional hygiene.
   *
   * `pg.Pool` emits 'error' when an IDLE client dies — a database restart, a
   * failover, an idle-connection timeout on the provider side. Node treats an
   * unhandled 'error' event as a fatal exception, so without this listener the
   * whole process exits whenever the database blips.
   *
   * That is precisely the wrong failure mode here: a brief database hiccup
   * would kill the API and, worse, the worker — stopping the reconciliation
   * sweepers that everything else depends on (ADR-005). The pool recovers on
   * its own; the process must survive to let it.
   */
  pool.on("error", (error: Error) => {
    options.onError?.(error);
  });

  return pool;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Reachability probe for the readiness endpoint.
 *
 * Deliberately trivial (`SELECT 1`): readiness answers "can this process reach
 * its dependencies", not "is the schema correct". Timing is measured with the
 * wall clock here rather than an injected Clock because this is I/O
 * instrumentation in an adapter, not domain logic.
 */
export async function ping(pool: Pool): Promise<PingResult> {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: describeDbError(error),
    };
  }
}

/**
 * Produce a non-empty, useful description of a connection failure.
 *
 * Node throws an `AggregateError` when a host resolves to both IPv4 and IPv6
 * and every attempt is refused. That error's `.message` is an EMPTY STRING, so
 * naively reading `error.message` yields a readiness failure with no stated
 * reason — precisely when someone is trying to diagnose an outage. This unwraps
 * the aggregate and falls back to the error code or name.
 */
export function describeDbError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const parts = error.errors.map((inner) => describeDbError(inner));
    return [...new Set(parts)].join("; ");
  }

  if (error instanceof Error) {
    if (error.message) return error.message;
    const code = (error as NodeJS.ErrnoException).code;
    if (code) return `${error.name}: ${code}`;
    return error.name || "unknown database error";
  }

  return typeof error === "string" && error ? error : "unknown database error";
}
