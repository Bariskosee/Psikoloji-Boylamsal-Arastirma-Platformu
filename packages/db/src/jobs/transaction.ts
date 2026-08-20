import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as schema from "../schema/index.js";
import type { Database } from "../drizzle.js";
import type { JobDefinition } from "./job-definition.js";
import type { EnqueueOptions, EnqueueResult, JobConnection } from "./queue.js";

/**
 * Transactional enqueue — the reason ADR-004 chose pg-boss over an external
 * queue.
 *
 * The domain write and the jobs it implies run on ONE database connection
 * inside ONE transaction, so they commit together or not at all. Without this
 * there is always a window in which the database says a session is completed
 * while the queue never received the follow-up job: the participant's next
 * questionnaire silently never appears, no error is raised anywhere, and the
 * measurement point is gone. That is the class of silent data loss AGENT.md
 * §3.1 forbids.
 *
 *     await withJobTransaction({ pool, queue }, async ({ db, enqueue }) => {
 *       await db.update(...);
 *       await enqueue(activateSession, { sessionId }, { startAfter: availableFrom });
 *     });
 *
 * If the update fails, the job was never inserted. If the insert fails, the
 * update is rolled back. There is no third outcome.
 *
 * Note what this does NOT buy: the sweepers in ADR-005 remain authoritative.
 * Atomicity removes the window between the write and the enqueue; it does not
 * make the queue the schedule.
 */

/** The part of `JobQueue` this needs. Narrow, so tests can substitute it. */
export interface JobSender {
  send<TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

export interface JobTransactionContext {
  /** Drizzle bound to the transaction's connection. */
  readonly db: Database;
  /** Enqueues on the same connection, inside the same transaction. */
  readonly enqueue: <TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options?: Omit<EnqueueOptions, "connection">,
  ) => Promise<EnqueueResult>;
}

export interface WithJobTransactionDeps {
  pool: Pool;
  queue: JobSender;
}

/**
 * Wrap a pg client as a handle pg-boss can execute its insert on.
 *
 * Everything routed through this object joins the caller's transaction, which
 * is the whole point: pg-boss's own pool would open a second connection and a
 * second, independently committed transaction.
 */
export function connectionFor(client: PoolClient): JobConnection {
  return {
    executeSql: async (text: string, values: unknown[]) => await client.query(text, values),
  };
}

export async function withJobTransaction<TResult>(
  deps: WithJobTransactionDeps,
  fn: (context: JobTransactionContext) => Promise<TResult>,
): Promise<TResult> {
  const client = await deps.pool.connect();
  const connection = connectionFor(client);

  try {
    await client.query("BEGIN");

    // Drizzle over the same checked-out client rather than over the pool, so
    // every query in the callback runs inside this transaction. Building it
    // from the pool here would be a subtle and near-invisible bug: the writes
    // would commit independently of the jobs.
    const db: Database = drizzle(client, { schema });

    const result = await fn({
      db,
      enqueue: async (definition, payload, options = {}) =>
        await deps.queue.send(definition, payload, { ...options, connection }),
    });

    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Report the original failure, not a rollback that failed because the
    // connection was already gone. The first error is the one that explains
    // what happened.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the transaction is dead either way; the original error is what matters */
    }
    throw error;
  } finally {
    client.release();
  }
}
