import { sql } from "drizzle-orm";
import { boolean, check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { identity } from "../schemas";

/**
 * Web Push subscriptions (PLAN.md Phase 8, ADR-006, STRUCTURE.md §11.2).
 *
 * In `identity`, not `research`, and this is the table the split was drawn
 * around. A push endpoint is a URL that wakes one specific device: it is a
 * device identifier in everything but name, and `app_analytics` — the role
 * every analytics and export code path uses — has no privileges on this schema
 * at all. An export query that accidentally joins an endpoint therefore fails
 * at the database, in CI, before review. That is what makes NFR-03 enforceable
 * rather than aspirational.
 *
 * ── Why the endpoint is unique, and what that buys ──────────────────────────
 * A browser hands out the same endpoint for the same (device, origin,
 * subscription) triple, and re-subscribing is ordinary: it happens on every
 * service-worker update and whenever the client is unsure of its own state. So
 * registration is an UPSERT keyed on the endpoint, and the uniqueness is
 * enforced HERE rather than by the service checking first — application-level
 * checks lose races, and the race is a participant tapping twice.
 *
 * The consequence worth stating: a participant who registers on two devices has
 * two rows, and a device handed to a second participant moves its row. The
 * unique key is the endpoint, not the participant, precisely so the second case
 * cannot silently deliver one person's reminders to another's phone.
 *
 * ── Why rows are deactivated rather than deleted ────────────────────────────
 * "This participant stopped receiving reminders on the 14th" is an operational
 * question that surfaces weeks later, and a deleted row answers it with
 * silence. Deactivation keeps the evidence; the retention rule in
 * `@lpr/domain` (`push/retention.ts`) deletes it once the window has run, and
 * the worker's prune sweeper applies that rule.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 * No user agent, no device name, no IP. They would be re-identifying data
 * collected for operator convenience, and the endpoint already gives us all the
 * reach we need. `credential_context` is the one contextual field, and it earns
 * its place: it is what tells a researcher which participants are reachable
 * only inside a browser tab (STRUCTURE.md §11.4).
 */
export const pushSubscriptions = identity.table(
  "push_subscriptions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /**
     * Deliberately NOT a foreign key to `research.participants`, for the same
     * reason as `participant_credentials`: a cross-schema constraint would
     * reintroduce exactly the coupling the schema separation exists to prevent.
     */
    participantId: uuid("participant_id").notNull(),

    /** The push service URL. A capability: whoever holds it can wake the device. */
    endpoint: text("endpoint").notNull(),

    /**
     * The participant's half of the ECDH exchange that encrypts payloads, so
     * the push service carrying a message cannot read it. Stored as the browser
     * produced them, base64url, and never transformed — a re-encoded key is a
     * subscription that fails to send months later for no visible reason.
     */
    p256dhKey: text("p256dh_key").notNull(),
    authKey: text("auth_key").notNull(),

    /**
     * When the push service says the subscription dies. Usually NULL — Chrome
     * and Firefox leave it unset — which is why expiry can never be the only
     * way a dead subscription is noticed.
     */
    expirationTime: timestamp("expiration_time", { withTimezone: true }),

    /** BROWSER or INSTALLED — where the credential that registered this was minted. */
    credentialContext: text("credential_context").notNull().default("BROWSER"),

    isActive: boolean("is_active").notNull().default(true),
    /** Set when the subscription stopped being usable; starts the retention clock. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    /** Why, in a fixed vocabulary — for the operator, never for the participant. */
    deactivationReason: text("deactivation_reason"),

    /**
     * Refreshed whenever the client re-registers the same endpoint. Distinct
     * from `updated_at`, which any column change touches: this one means "the
     * device was here and still believed in this subscription".
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "push_subscriptions_credential_context_valid",
      sql`${table.credentialContext} IN ('BROWSER', 'INSTALLED')`,
    ),
    /**
     * A row is either live, or dead with the instant it died. The retention
     * rule measures from `deactivated_at`, so an inactive row without one is a
     * row that can never be pruned — it would sit in the identity schema
     * forever, which is the outcome the retention policy exists to prevent.
     */
    check(
      "push_subscriptions_deactivation_complete",
      sql`(${table.isActive} = true AND ${table.deactivatedAt} IS NULL)
          OR (${table.isActive} = false AND ${table.deactivatedAt} IS NOT NULL)`,
    ),
    check(
      "push_subscriptions_deactivation_reason_valid",
      sql`${table.deactivationReason} IS NULL
          OR ${table.deactivationReason} IN ('UNSUBSCRIBED', 'WITHDRAWN', 'EXPIRED', 'REJECTED_BY_SERVICE')`,
    ),
    uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
    index("push_subscriptions_participant_idx").on(table.participantId),
    /**
     * The prune sweeper's access path: dead rows, oldest first. Partial, so the
     * index stays small — the overwhelming majority of rows are active and this
     * index should never have to know about them.
     */
    index("push_subscriptions_prune_idx")
      .on(table.deactivatedAt)
      .where(sql`${table.isActive} = false`),
  ],
);
