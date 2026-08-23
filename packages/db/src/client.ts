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

/**
 * A pool whose every connection has dropped to the analytics role (NFR-03).
 *
 * ── Why `SET ROLE` rather than a second credential ──────────────────────────
 * `app_analytics` is a NOLOGIN group role, deliberately: migration 0000 says
 * "the deployment grants them to the actual login users, so credentials never
 * appear in a migration". There is therefore nothing to put in a second
 * connection string, and inventing one would mean a second password to
 * provision, rotate and leak.
 *
 * `SET ROLE` gives the same guarantee from the same credential. Permission
 * checks after it use the target role — including for a superuser, who loses
 * superuser along with everything else. A query that joins `identity` then
 * fails with a permission error at the database, which is exactly the
 * enforcement NFR-03 asks for and exactly what an integration test can assert.
 *
 * ── Why it is set on every connection, not per query ────────────────────────
 * `SET ROLE` is session state, and a pooled connection outlives a request. Set
 * per query it would be forgotten on any path that failed to remember; set on
 * connect it is impossible to forget, and impossible to escape without an
 * explicit `RESET ROLE` that would stand out in review.
 *
 * `DATABASE_ANALYTICS_URL` still overrides where a deployment genuinely has a
 * separate login user — a read replica, say. The role is set either way, so the
 * guarantee does not depend on which was configured.
 */
export interface CreateAnalyticsPoolOptions extends CreatePoolOptions {
  /** Defaults to `app_analytics`; overridable only for tests. */
  role?: string;
}

/** Identifier, not a value: it is interpolated into SQL and cannot be bound. */
const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function createAnalyticsPool(options: CreateAnalyticsPoolOptions): Pool {
  const role = options.role ?? "app_analytics";
  if (!ROLE_NAME_PATTERN.test(role)) {
    throw new Error(`"${role}" is not a valid PostgreSQL role name.`);
  }

  const pool = createPool(options);

  /**
   * Fired for every NEW connection, before it is handed to a caller.
   *
   * A failure here must not be swallowed. If `SET ROLE` cannot be applied — the
   * login user is not a member of the group — then this pool would silently
   * hand out full-privilege connections to the analytics code path, which is
   * the one outcome NFR-03 exists to prevent. Destroying the client makes the
   * checkout fail loudly instead.
   */
  pool.on("connect", (client) => {
    void client.query(`SET ROLE ${role}`).catch((error: unknown) => {
      options.onError?.(
        new Error(
          `could not SET ROLE ${role} on an analytics connection: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "Refusing the connection rather than serving analytics with full privileges.",
        ),
      );
      client.release(true);
    });
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
