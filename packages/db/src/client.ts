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
  /**
   * Raw PostgreSQL startup options (the `options` connection parameter), e.g.
   * `-c role=app_analytics`. Applied by the server during connection setup.
   */
  startupOptions?: string;
}

export function createPool(options: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    // PostgreSQL startup options, applied by the server as part of establishing
    // the connection and therefore before any query can run on it. Used by
    // `createAnalyticsPool` to pin the role; see the reasoning there.
    ...(options.startupOptions === undefined ? {} : { options: options.startupOptions }),
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
 * The role is session state, and a pooled connection outlives a request. Set
 * per query it would be forgotten on any path that failed to remember; set on
 * the connection it is impossible to forget, and impossible to escape without
 * an explicit `RESET ROLE` that would stand out in review.
 *
 * ── Why a STARTUP PARAMETER and not a `SET ROLE` statement (Phase 12) ───────
 * This used to issue `SET ROLE` from a `pool.on("connect")` handler. That
 * handler is fire-and-forget: pg-pool emits the event and hands the client to
 * the waiting caller without awaiting anything the listener started. The
 * caller's first query and the `SET ROLE` were therefore in flight on the same
 * connection at the same time — pg says so out loud, with "Calling
 * client.query() when the client is already executing a query is deprecated",
 * which is how this was found.
 *
 * In practice `SET ROLE` won, because pg queues statements on a client in the
 * order they were issued and the listener issued first. That is ordering by
 * luck, not by construction: the queueing it relies on is the very behaviour pg
 * has deprecated and will remove. When it goes, an analytics query could run on
 * a connection whose role had not been switched yet — with full read-write
 * privileges, on the code path NFR-03 exists to constrain, and silently.
 *
 * `options=-c role=…` is applied by the SERVER while establishing the
 * connection. There is no window: the first query a caller can possibly send
 * already arrives as `app_analytics`. It costs no round trip, and it cannot be
 * skipped by any ordering of events in the client.
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

  /**
   * The role travels in the connection's startup packet.
   *
   * If the login user is not a member of the group, the CONNECTION fails rather
   * than succeeding with full privileges — which is the right way round. A pool
   * that could hand out an unrestricted connection to the analytics code path
   * is the one outcome NFR-03 exists to prevent, and here that state is not
   * reachable at all rather than merely guarded against.
   */
  return createPool({ ...options, startupOptions: `-c role=${role}` });
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
