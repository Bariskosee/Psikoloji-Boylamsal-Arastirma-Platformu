import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUSH_SUBSCRIPTION_RETENTION_DAYS } from "@lpr/domain";
import { createPool, type Pool } from "@lpr/db";
import { expireSubscriptionsSweeper, pruneSubscriptionsSweeper } from "./push-sweepers.js";
import type { SweepContext, SweepLogger } from "./sweeper.js";

/**
 * Push subscription hygiene, against real PostgreSQL (PLAN.md Phase 8).
 *
 * These sweepers are the only place in the system that DELETES, so what they
 * must be proved not to do matters more than what they do: never touch a live
 * subscription, never delete one inside its retention window, and never delete
 * one that came back to life between the claim and the lock.
 *
 * Nothing here needs the `research` scaffolding the session sweepers build.
 * `identity.push_subscriptions` deliberately carries no foreign key into the
 * research schema — that separation is what keeps an export path from reaching
 * a device identifier — so a plain UUID stands in for a participant.
 */

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests.");

let pool: Pool;

const silentLogger: SweepLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const context = (): SweepContext => ({
  pool,
  logger: silentLogger,
  signal: new AbortController().signal,
});

const DAY = "86400 seconds";

interface SubscriptionSeed {
  readonly isActive?: boolean;
  /** SQL interval, ago. Null leaves the column null. */
  readonly deactivatedDaysAgo?: number | null;
  readonly expiresInDays?: number | null;
}

let endpointCounter = 0;

async function seed(input: SubscriptionSeed = {}): Promise<string> {
  endpointCounter += 1;
  const isActive = input.isActive ?? true;

  const result = await pool.query<{ id: string }>(
    `INSERT INTO identity.push_subscriptions
       (participant_id, endpoint, p256dh_key, auth_key,
        expiration_time, is_active, deactivated_at, deactivation_reason)
     VALUES ($1, $2, 'p256dh', 'auth',
             CASE WHEN $3::numeric IS NULL THEN NULL
                  ELSE now() + ($3::numeric * INTERVAL '${DAY}') END,
             $4,
             CASE WHEN $5::numeric IS NULL THEN NULL
                  ELSE now() - ($5::numeric * INTERVAL '${DAY}') END,
             CASE WHEN $5::numeric IS NULL THEN NULL ELSE 'UNSUBSCRIBED' END)
     RETURNING id`,
    [
      randomUUID(),
      `https://push.example.org/s/${String(endpointCounter)}`,
      input.expiresInDays ?? null,
      isActive,
      input.deactivatedDaysAgo ?? null,
    ],
  );

  return result.rows[0]!.id;
}

async function read(
  id: string,
): Promise<{ is_active: boolean; deactivation_reason: string | null } | null> {
  const result = await pool.query<{ is_active: boolean; deactivation_reason: string | null }>(
    `SELECT is_active, deactivation_reason FROM identity.push_subscriptions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

beforeAll(() => {
  pool = createPool({ connectionString: connectionString!, max: 4 });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE identity.push_subscriptions`);
});

describe("sweep.expire_subscriptions", () => {
  it("deactivates a subscription whose stated expiry has passed", async () => {
    const id = await seed({ expiresInDays: -1 });

    const outcome = await expireSubscriptionsSweeper().run(context());

    expect(outcome.acted).toBe(1);
    expect(await read(id)).toEqual({ is_active: false, deactivation_reason: "EXPIRED" });
  });

  it("leaves a subscription whose expiry is still ahead", async () => {
    const id = await seed({ expiresInDays: 30 });

    const outcome = await expireSubscriptionsSweeper().run(context());

    expect(outcome.claimed).toBe(0);
    expect((await read(id))?.is_active).toBe(true);
  });

  it("leaves the overwhelming majority, which state no expiry at all", async () => {
    // Chrome and Firefox never set `expirationTime`. A sweeper that treated a
    // NULL expiry as "expired" would deactivate every subscription in the
    // system on its first run.
    const id = await seed({ expiresInDays: null });

    await expireSubscriptionsSweeper().run(context());

    expect((await read(id))?.is_active).toBe(true);
  });

  it("is safe to run twice", async () => {
    const id = await seed({ expiresInDays: -1 });

    await expireSubscriptionsSweeper().run(context());
    const second = await expireSubscriptionsSweeper().run(context());

    // The second pass finds nothing: the row is no longer active, so the claim
    // does not return it. Running twice is not merely harmless, it is a no-op.
    expect(second.claimed).toBe(0);
    expect((await read(id))?.deactivation_reason).toBe("EXPIRED");
  });
});

describe("sweep.prune_subscriptions", () => {
  it("deletes a dead subscription past its retention window", async () => {
    const id = await seed({
      isActive: false,
      deactivatedDaysAgo: PUSH_SUBSCRIPTION_RETENTION_DAYS + 1,
    });

    const outcome = await pruneSubscriptionsSweeper().run(context());

    expect(outcome.acted).toBe(1);
    expect(await read(id)).toBeNull();
  });

  it("keeps a dead subscription still inside its retention window", async () => {
    // The operational question — "when did this participant stop getting
    // reminders?" — surfaces weeks after the fact. A deleted row answers it
    // with silence.
    const id = await seed({
      isActive: false,
      deactivatedDaysAgo: PUSH_SUBSCRIPTION_RETENTION_DAYS - 1,
    });

    const outcome = await pruneSubscriptionsSweeper().run(context());

    expect(outcome.claimed).toBe(0);
    expect(await read(id)).not.toBeNull();
  });

  it("never touches an active subscription, however old", async () => {
    const id = await seed({ isActive: true });

    const outcome = await pruneSubscriptionsSweeper().run(context());

    expect(outcome.claimed).toBe(0);
    expect(await read(id)).not.toBeNull();
  });

  it("never deletes an active subscription whose stated expiry has long passed", async () => {
    // "The push service said this would expire" and "we have marked it dead"
    // are different facts, and only the second starts the retention clock. The
    // expiry sweeper handles this row; the prune sweeper must not.
    const id = await seed({ isActive: true, expiresInDays: -365 });

    await pruneSubscriptionsSweeper().run(context());

    expect(await read(id)).not.toBeNull();
  });

  it("refuses a row that came back to life between the claim and the lock", async () => {
    const id = await seed({
      isActive: false,
      deactivatedDaysAgo: PUSH_SUBSCRIPTION_RETENTION_DAYS + 1,
    });

    // Re-registered after the sweeper would have claimed it. `decide` re-derives
    // from the LOCKED row, so the claim is only ever a hint.
    await pool.query(
      `UPDATE identity.push_subscriptions
          SET is_active = true, deactivated_at = NULL, deactivation_reason = NULL
        WHERE id = $1`,
      [id],
    );

    const outcome = await pruneSubscriptionsSweeper().run(context());

    expect(outcome.acted).toBe(0);
    expect(await read(id)).not.toBeNull();
  });

  it("converges on a backlog in one cycle and then does nothing", async () => {
    // The shape of the first run after this migration lands on a system that
    // has been accumulating dead subscriptions.
    for (let index = 0; index < 25; index += 1) {
      await seed({ isActive: false, deactivatedDaysAgo: PUSH_SUBSCRIPTION_RETENTION_DAYS + 5 });
    }
    const survivor = await seed({ isActive: true });

    const first = await pruneSubscriptionsSweeper().run(context());
    const second = await pruneSubscriptionsSweeper().run(context());

    expect(first.acted).toBe(25);
    expect(first.failed).toBe(0);
    // Idempotent by construction: after the first pass there is nothing left to
    // find, which is why running this every sweep cycle rather than once a day
    // costs an indexed lookup that returns no rows.
    expect(second.claimed).toBe(0);
    expect(await read(survivor)).not.toBeNull();
  });

  it("acts once when two replicas sweep concurrently", async () => {
    const id = await seed({
      isActive: false,
      deactivatedDaysAgo: PUSH_SUBSCRIPTION_RETENTION_DAYS + 1,
    });

    const [a, b] = await Promise.all([
      pruneSubscriptionsSweeper().run(context()),
      pruneSubscriptionsSweeper().run(context()),
    ]);

    // Exactly one deletion between them, whichever got there first.
    expect(a.acted + b.acted).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(await read(id)).toBeNull();
  });
});
