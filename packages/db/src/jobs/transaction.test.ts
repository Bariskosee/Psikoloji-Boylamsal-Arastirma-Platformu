import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { defineJob } from "./job-definition.js";
import type { EnqueueOptions, EnqueueResult } from "./queue.js";
import { connectionFor, withJobTransaction, type JobSender } from "./transaction.js";

const activate = defineJob({
  name: "session.activate",
  payload: { parse: (input: unknown) => input as { sessionId: string } },
});

interface Harness {
  pool: Pool;
  client: { queries: string[]; released: number };
  sender: JobSender & { calls: { name: string; options: EnqueueOptions }[] };
}

function harness(options: { rollbackFails?: boolean } = {}): Harness {
  const queries: string[] = [];
  const state = { queries, released: 0 };

  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (options.rollbackFails && text === "ROLLBACK") {
        throw new Error("connection terminated");
      }
      return { rows: [] };
    }),
    release: () => {
      state.released += 1;
    },
  };

  const calls: { name: string; options: EnqueueOptions }[] = [];

  return {
    pool: { connect: async () => client as unknown as PoolClient } as unknown as Pool,
    client: state,
    sender: {
      calls,
      send: async <T>(
        definition: { name: string },
        _payload: T,
        sendOptions: EnqueueOptions = {},
      ): Promise<EnqueueResult> => {
        calls.push({ name: definition.name, options: sendOptions });
        return { jobId: "job-1", deduplicated: false };
      },
    } as JobSender & { calls: { name: string; options: EnqueueOptions }[] },
  };
}

describe("withJobTransaction", () => {
  it("commits the domain write and the job together", async () => {
    const { pool, client, sender } = harness();

    const result = await withJobTransaction({ pool, queue: sender }, async ({ enqueue }) => {
      await enqueue(activate, { sessionId: "s-1" });
      return "done";
    });

    expect(result).toBe("done");
    expect(client.queries).toEqual(["BEGIN", "COMMIT"]);
    expect(sender.calls).toHaveLength(1);
  });

  it("enqueues on the transaction's own connection, not on the pool", async () => {
    // This is the whole point of ADR-004: if the job were inserted on a second
    // connection it would survive a rollback of the write that implied it.
    const { pool, sender } = harness();

    await withJobTransaction({ pool, queue: sender }, async ({ enqueue }) => {
      await enqueue(activate, { sessionId: "s-1" });
    });

    const connection = sender.calls[0]?.options.connection;
    expect(connection).toBeDefined();
    expect(typeof connection?.executeSql).toBe("function");
  });

  it("rolls back, so a failed write leaves no job behind", async () => {
    const { pool, client, sender } = harness();

    await expect(
      withJobTransaction({ pool, queue: sender }, async ({ enqueue }) => {
        await enqueue(activate, { sessionId: "s-1" });
        throw new Error("unique violation");
      }),
    ).rejects.toThrow("unique violation");

    expect(client.queries).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("reports the original failure even when the rollback also fails", async () => {
    const { pool, sender } = harness({ rollbackFails: true });

    await expect(
      withJobTransaction({ pool, queue: sender }, async () => {
        throw new Error("unique violation");
      }),
    ).rejects.toThrow("unique violation");
  });

  it("returns the connection to the pool on both paths", async () => {
    const committed = harness();
    await withJobTransaction({ pool: committed.pool, queue: committed.sender }, async () => "ok");
    expect(committed.client.released).toBe(1);

    const failed = harness();
    await expect(
      withJobTransaction({ pool: failed.pool, queue: failed.sender }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(failed.client.released).toBe(1);
  });

  it("exposes a transaction-bound Drizzle handle", async () => {
    const { pool, sender } = harness();

    const db = await withJobTransaction({ pool, queue: sender }, async (context) => context.db);

    expect(typeof db.select).toBe("function");
    expect(typeof db.execute).toBe("function");
  });

  it("does not let a caller redirect the enqueue off the transaction", async () => {
    const { pool, client, sender } = harness();
    const decoy = { executeSql: vi.fn(async () => ({ rows: [] })) };

    await withJobTransaction({ pool, queue: sender }, async ({ enqueue }) => {
      // `connection` is not part of the callback's option type. Even when one
      // is forced in, the transaction's own handle has to win — otherwise the
      // atomicity guarantee would be one cast away from being silently gone.
      await enqueue(activate, { sessionId: "s-1" }, {
        connection: decoy,
      } as Omit<EnqueueOptions, "connection">);
    });

    const forwarded = sender.calls[0]?.options.connection;
    expect(forwarded).toBeDefined();
    await forwarded?.executeSql("INSERT INTO pgboss.job", []);

    expect(decoy.executeSql).not.toHaveBeenCalled();
    expect(client.queries).toContain("INSERT INTO pgboss.job");
  });
});

describe("connectionFor", () => {
  it("executes pg-boss's SQL on the client it was given", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "job-1" }] }));
    const connection = connectionFor({ query } as unknown as PoolClient);

    const result = await connection.executeSql("INSERT INTO pgboss.job", ["session.activate"]);

    expect(query).toHaveBeenCalledWith("INSERT INTO pgboss.job", ["session.activate"]);
    expect(result.rows).toEqual([{ id: "job-1" }]);
  });
});
