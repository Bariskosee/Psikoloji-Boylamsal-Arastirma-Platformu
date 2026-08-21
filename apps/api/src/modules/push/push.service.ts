import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { pushSubscriptions, type Database } from "@lpr/db";
import type {
  CredentialContext,
  PushSubscriptionSummary,
  RegisterPushSubscriptionRequest,
} from "@lpr/contracts";
import { DATABASE } from "../database/database.module.js";

/**
 * Push subscription storage (PLAN.md Phase 8, ADR-006).
 *
 * **This phase stores subscriptions and sends nothing.** No `web-push`
 * dependency, no VAPID signing, no payloads. Sending is Phase 9, and keeping
 * the two apart is what makes each reviewable: a subscription lifecycle that is
 * wrong in a way nobody notices produces reminders that go to the wrong device
 * or to nobody, and that failure is much easier to see when no send logic is
 * in the same file arguing for attention.
 *
 * The one thing this service must get right is that re-registration is an
 * update. A browser re-subscribes routinely — on service-worker updates,
 * whenever the client is unsure of its own state, whenever the participant
 * revisits the notifications screen — and a service that inserted each time
 * would accumulate rows that all point at one device, so Phase 9 would send the
 * same reminder to the same phone four times.
 */

/** The fixed vocabulary the `deactivation_reason` check constraint accepts. */
export type DeactivationReason = "UNSUBSCRIBED" | "WITHDRAWN" | "EXPIRED" | "REJECTED_BY_SERVICE";

@Injectable()
export class PushService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Register, or re-register, one device.
   *
   * An UPSERT on the endpoint, which is the browser's own identifier for
   * (device, origin, subscription). Three cases collapse into it, and all three
   * are ordinary:
   *
   *  - the same participant re-registering the same device — the common path;
   *  - a subscription that was deactivated and has come back, which happens
   *    when someone re-enables notifications after turning them off;
   *  - a device previously registered to a DIFFERENT participant. That is a
   *    shared or handed-on phone, and the row must move: leaving it would send
   *    one person's reminders to another's device, which is a privacy incident
   *    rather than a duplicate.
   *
   * The uniqueness is the database's (`push_subscriptions_endpoint_idx`), not a
   * check performed here. A check here loses the race between two taps.
   */
  async register(
    participantId: string,
    input: RegisterPushSubscriptionRequest,
    credentialContext: CredentialContext,
    now: Date,
  ): Promise<PushSubscriptionSummary> {
    const expirationTime = input.expirationTime === null ? null : new Date(input.expirationTime);

    const row = (
      await this.db
        .insert(pushSubscriptions)
        .values({
          participantId,
          endpoint: input.endpoint,
          p256dhKey: input.keys.p256dh,
          authKey: input.keys.auth,
          expirationTime,
          credentialContext,
          isActive: true,
          deactivatedAt: null,
          deactivationReason: null,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            participantId,
            // Re-sent every time and re-stored every time. A browser may rotate
            // its keys for an endpoint it keeps, and a stale key pair is a
            // subscription that accepts sends and delivers nothing.
            p256dhKey: input.keys.p256dh,
            authKey: input.keys.auth,
            expirationTime,
            credentialContext,
            isActive: true,
            deactivatedAt: null,
            deactivationReason: null,
            lastSeenAt: now,
            updatedAt: now,
          },
        })
        .returning()
    )[0];
    if (!row) throw new Error("push subscription upsert returned no row");

    return summarise(row);
  }

  /**
   * The participant's own list, for the notifications settings screen.
   *
   * Active rows only. A participant does not need to be shown the wreckage of
   * subscriptions that have died — that history is kept for the operator, and
   * surfacing it here would turn a settings screen into a list of devices the
   * participant has to reason about.
   */
  async listActive(participantId: string): Promise<PushSubscriptionSummary[]> {
    const rows = await this.db
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.participantId, participantId),
          eq(pushSubscriptions.isActive, true),
        ),
      )
      .orderBy(asc(pushSubscriptions.createdAt));

    return rows.map(summarise);
  }

  /**
   * Stop using one endpoint.
   *
   * Scoped to the participant in the WHERE clause, never by checking a fetched
   * row afterwards: the endpoint arrives from the client, and an unscoped
   * update would let anyone holding an endpoint silence someone else's
   * reminders.
   *
   * Deactivation rather than deletion — see `push-subscriptions.ts` for why the
   * evidence is worth keeping, and `@lpr/domain`'s retention rule for when it
   * stops being.
   */
  async deactivateEndpoint(
    participantId: string,
    endpoint: string,
    reason: DeactivationReason,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(pushSubscriptions)
      .set({ isActive: false, deactivatedAt: now, deactivationReason: reason, updatedAt: now })
      .where(
        and(
          eq(pushSubscriptions.participantId, participantId),
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.isActive, true),
        ),
      )
      .returning({ id: pushSubscriptions.id });

    return updated.length > 0;
  }

  /**
   * Silence every device a participant has (FR-30, FR-18).
   *
   * Called inside the withdrawal transaction. Withdrawal means "stop contacting
   * me", and a subscription that survives it is a promise that the next
   * reminder chain will break — a participant who has left being pushed a
   * questionnaire is the single most damaging notification this system could
   * send.
   *
   * Takes the caller's transaction so it commits with the withdrawal or not at
   * all. A separate write could succeed while the withdrawal rolled back, or
   * fail while it committed, and the second failure is the one that reaches a
   * phone.
   */
  async deactivateAllForParticipant(
    tx: Database,
    participantId: string,
    reason: DeactivationReason,
    now: Date,
  ): Promise<number> {
    const updated = await tx
      .update(pushSubscriptions)
      .set({ isActive: false, deactivatedAt: now, deactivationReason: reason, updatedAt: now })
      .where(
        and(
          eq(pushSubscriptions.participantId, participantId),
          eq(pushSubscriptions.isActive, true),
        ),
      )
      .returning({ id: pushSubscriptions.id });

    return updated.length;
  }
}

/**
 * The row, minus everything that could identify a device.
 *
 * The endpoint and both keys stop here. Nothing outside this service — no
 * response, no log line, no researcher view — has any use for them, and a
 * summary that carried them would be one careless `res.json(row)` away from
 * publishing a device identifier (AGENT.md §3.2).
 */
function summarise(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionSummary {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    credentialContext: row.credentialContext as CredentialContext,
  };
}
