import { PUSH_SUBSCRIPTION_RETENTION_DAYS, hasExpired, isPrunable } from "@lpr/domain";
import { ACT, noOp, reconcile, type ReconcileDecision, type SweepClient } from "./reconcile.js";
import { SWEEP_BATCH_LIMIT } from "./reconcile.js";
import type { SweepContext, SweepOutcome, Sweeper } from "./sweeper.js";

/**
 * Push subscription hygiene (PLAN.md Phase 8, ADR-006, NFR-03).
 *
 * Two sweepers, mirroring the session pair: one marks subscriptions dead,
 * the other deletes the dead ones once their evidence has served its purpose.
 *
 * ── Why these are sweepers and not a daily cron job ─────────────────────────
 * PLAN.md Phase 8 calls this "the daily subscription-pruning job". It is
 * implemented here instead, and the difference is worth stating.
 *
 * A cron job would need pg-boss scheduling switched on, a queue, a handler, and
 * a definition — infrastructure Phase 7 deliberately did not build, and which
 * Phase 9 will design properly around notification sends. Pruning needs none of
 * it: the work is defined entirely by what is in the table, it is idempotent by
 * construction, and after the first pass on any given day there is nothing left
 * to find, so running it every sweep cycle costs one indexed lookup that
 * returns no rows. The partial index `push_subscriptions_prune_idx` exists for
 * exactly that query.
 *
 * "Daily" was a statement about how often the work needs doing, not about the
 * mechanism. Running it more often than required is free here; adding a second
 * scheduling mechanism to achieve less frequency is not.
 *
 * ── Why deletion is not conditional on anything but time ────────────────────
 * A pruned row is a push endpoint we no longer hold. That is the desirable
 * direction: it is re-identifying data (STRUCTURE.md §11.1) and keeping it past
 * its usefulness is the retention question a data protection review asks first.
 * Phase 9's `notification_attempts` records which subscription an attempt went
 * to, and deliberately carries NO foreign key to it — the two tables are in
 * different schemas, and a cross-schema constraint would reintroduce the
 * coupling ADR-003 separated them to avoid. Pruning is therefore safe by
 * construction: deleting a dead endpoint leaves every attempt intact, which is
 * right, because the attempt is research evidence and the endpoint was only
 * ever the means of delivery.
 */

interface SubscriptionRow {
  readonly id: string;
  readonly is_active: boolean;
  readonly deactivated_at: Date | null;
  readonly expiration_time: Date | null;
  readonly db_now: Date;
}

/**
 * Subscriptions the push service told us would expire, and which have.
 *
 * Rare: most browsers leave `expirationTime` unset, which is precisely why this
 * can never be the only way a dead subscription is noticed. Phase 9's handling
 * of a 404 or 410 from the push service is the common path. This sweeper exists
 * so that the uncommon one does not sit active forever, being selected for
 * every send and failing every time.
 */
export function expireSubscriptionsSweeper(): Sweeper {
  return {
    name: "sweep.expire_subscriptions",
    run: (context: SweepContext): Promise<SweepOutcome> =>
      reconcile<SubscriptionRow>(context, "sweep.expire_subscriptions", {
        claim: async (client) =>
          claimIds(
            client,
            `SELECT id FROM identity.push_subscriptions
            WHERE is_active = true
              AND expiration_time IS NOT NULL
              AND expiration_time <= now()
            ORDER BY expiration_time
            FOR UPDATE SKIP LOCKED
            LIMIT ${String(SWEEP_BATCH_LIMIT)}`,
          ),

        lock: (client, id) => lockSubscription(client, id),

        decide: (row): ReconcileDecision => {
          // Re-derived from the row, not from the claim: between the two, a
          // participant may have re-registered this endpoint, which resets it
          // to active with a fresh expiry.
          if (!row.is_active) return noOp("ALREADY_INACTIVE");
          if (
            !hasExpired(
              {
                isActive: row.is_active,
                deactivatedAt: row.deactivated_at,
                expirationTime: row.expiration_time,
              },
              row.db_now,
            )
          ) {
            return noOp("NOT_EXPIRED");
          }
          return ACT;
        },

        apply: async (client, row) => {
          await client.query(
            `UPDATE identity.push_subscriptions
                SET is_active = false,
                    deactivated_at = now(),
                    deactivation_reason = 'EXPIRED',
                    updated_at = now()
              WHERE id = $1 AND is_active = true`,
            [row.id],
          );
        },
      }),
  };
}

/**
 * Dead subscriptions past their retention window (`@lpr/domain`, `push/retention.ts`).
 *
 * The only sweeper in the system that DELETES. That asymmetry is deliberate and
 * worth naming: everywhere else, state is corrected and history is kept,
 * because history is research evidence. A push endpoint is not evidence about
 * anything — it is a device identifier we needed while it worked, and the
 * reason to hold it ends when it stops working plus however long an operator
 * might reasonably ask what happened.
 */
export function pruneSubscriptionsSweeper(): Sweeper {
  return {
    name: "sweep.prune_subscriptions",
    run: (context: SweepContext): Promise<SweepOutcome> =>
      reconcile<SubscriptionRow>(context, "sweep.prune_subscriptions", {
        claim: async (client) =>
          claimIds(
            client,
            // Hits `push_subscriptions_prune_idx`, which is partial on
            // `is_active = false`. On a healthy system this returns nothing and
            // touches almost no pages, which is what makes running it every
            // cycle rather than once a day free.
            `SELECT id FROM identity.push_subscriptions
            WHERE is_active = false
              AND deactivated_at IS NOT NULL
              AND deactivated_at <= now() - INTERVAL '${String(PUSH_SUBSCRIPTION_RETENTION_DAYS)} days'
            ORDER BY deactivated_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${String(SWEEP_BATCH_LIMIT)}`,
          ),

        lock: (client, id) => lockSubscription(client, id),

        decide: (row): ReconcileDecision => {
          /**
           * The retention rule itself, applied under the lock, by the domain.
           *
           * The claim's SQL and this function must agree, and only one of them
           * is unit-tested. Re-deriving here means the claim is an optimisation
           * — "these are probably prunable" — while the decision that actually
           * deletes a row is the tested one. A row re-registered between the
           * claim and the lock is active again and is refused here.
           */
          if (
            !isPrunable(
              {
                isActive: row.is_active,
                deactivatedAt: row.deactivated_at,
                expirationTime: row.expiration_time,
              },
              row.db_now,
            )
          ) {
            return noOp(row.is_active ? "REACTIVATED" : "WITHIN_RETENTION");
          }
          return ACT;
        },

        apply: async (client, row) => {
          await client.query(
            `DELETE FROM identity.push_subscriptions WHERE id = $1 AND is_active = false`,
            [row.id],
          );
        },
      }),
  };
}

async function claimIds(client: SweepClient, text: string): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(text);
  return result.rows.map((row) => row.id);
}

/**
 * Re-read one subscription with the database's own `now()` in the SAME
 * statement.
 *
 * The same discipline as `session-sweepers.ts`, for the same reason: the
 * decision must be about one instant, under one lock, using one clock — the
 * database's. Two worker replicas with drifted process clocks would otherwise
 * disagree about which subscriptions had passed their retention window, and a
 * worker an hour fast would delete evidence an hour early with nothing in the
 * system to contradict it.
 */
async function lockSubscription(client: SweepClient, id: string): Promise<SubscriptionRow | null> {
  const result = await client.query<SubscriptionRow>(
    `SELECT s.id, s.is_active, s.deactivated_at, s.expiration_time, now() AS db_now
       FROM identity.push_subscriptions s
      WHERE s.id = $1
      FOR UPDATE OF s`,
    [id],
  );
  return result.rows[0] ?? null;
}
