import { z } from "zod";
import { localeSchema } from "./locale.js";

/**
 * Notification vocabulary (PLAN.md Phase 9, STRUCTURE.md §9, ADR-006).
 *
 * ── The distinction this file exists to protect ─────────────────────────────
 * "The push service accepted this message" and "the participant received it"
 * are different facts, and only the first is observable. Every name here is
 * chosen so that no caller can accidentally write code — or a column header, or
 * an interface string — that claims the second (FR-15, FR-19, AGENT.md §17).
 *
 * `SENT_ACCEPTED` is deliberately not called `DELIVERED`, `SENT`, or `OK`. A
 * push service returning 201 has taken responsibility for a message; whether it
 * reaches a phone that is off, out of coverage, or has the app's notifications
 * muted at the OS level is not something this system can ever know.
 */

/** What a notification is for. Reminders repeat; the initial one does not. */
export const NOTIFICATION_KINDS = ["INITIAL", "REMINDER"] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * How one attempt ended.
 *
 * `ATTEMPTED` is written and COMMITTED before the network call, and is
 * therefore the state a row is left in when the process dies mid-send
 * (STRUCTURE.md §9.1). It means "we may or may not have sent this, and we will
 * not try again" — which is the correct reading, because at-most-once is the
 * guarantee this system chose. Losing a reminder is acceptable; notifying a
 * participant twice is both an annoyance and a compliance-data artefact.
 */
export const NOTIFICATION_OUTCOMES = [
  "ATTEMPTED",
  /** The push service accepted it. NOT a delivery receipt. */
  "SENT_ACCEPTED",
  "FAILED",
  "SUPPRESSED",
] as const;
export const notificationOutcomeSchema = z.enum(NOTIFICATION_OUTCOMES);
export type NotificationOutcome = z.infer<typeof notificationOutcomeSchema>;

/**
 * Why a notification was not sent.
 *
 * Recorded rather than inferred, and each reason is its own value rather than a
 * shared "skipped". This is research data: the difference between "we never
 * asked this participant" and "this participant ignored us" is the difference
 * between a suppression and a missed session, and a compliance analysis that
 * cannot tell them apart will read our outage as their non-adherence
 * (STRUCTURE.md §9.3).
 *
 * The order matches the guard chain in STRUCTURE.md §9.1, because the order the
 * guards run in is itself a decision — see `packages/domain/src/notification`.
 */
export const NOTIFICATION_SUPPRESSION_REASONS = [
  /** Guard 1: the session is no longer open. Completion lands here. */
  "SUPPRESSED_STATE",
  /** Guard 2: the response window closed. */
  "SUPPRESSED_EXPIRED",
  /** Guard 3: the participant withdrew. */
  "SUPPRESSED_WITHDRAWN",
  /** Guard 4: the reminder cap in the policy (FR-40). */
  "SUPPRESSED_CAP",
  /** Guard 6: nothing to send to — no active subscription. */
  "SUPPRESSED_NO_SUBSCRIPTION",
  /** Guard 7, SKIP behaviour: inside the participant's quiet hours. */
  "SUPPRESSED_QUIET_HOURS",
  /** Guard 8: too late to be worth sending (ADR-005, no post-outage burst). */
  "SUPPRESSED_STALE",
] as const;
export const notificationSuppressionReasonSchema = z.enum(NOTIFICATION_SUPPRESSION_REASONS);
export type NotificationSuppressionReason = z.infer<typeof notificationSuppressionReasonSchema>;

/**
 * The `notification.send` job payload.
 *
 * Identifiers and the scheduled instant, and nothing else. Every fact the
 * handler decides on is re-read from canonical state under a row lock — that is
 * the ADR-005 handler contract, and a payload carrying state would be a payload
 * a handler could be tempted to trust after it went stale in the queue.
 *
 * `scheduledFor` is the exception, and it is not state: it is what this job was
 * *asked* to do and when, which is precisely what guard 8 needs in order to
 * notice that the request is now hours old.
 */
export const notificationSendPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  kind: notificationKindSchema,
  /** 0 for the initial notification; 1..n for reminders in the chain. */
  occurrenceIndex: z.number().int().min(0),
  /** ISO-8601 instant this link in the chain was scheduled for. */
  scheduledFor: z.string().datetime(),
});

export type NotificationSendPayload = z.infer<typeof notificationSendPayloadSchema>;

/**
 * A push payload, as it leaves this system.
 *
 * **No research content** (ADR-006, STRUCTURE.md §9.4). Payloads pass through a
 * third-party push service, so no question text, no answers, and no
 * questionnaire name may appear. The title and body are generic localised
 * strings; the only identifier is a session id, and the endpoint the click
 * opens re-authorises from the credential rather than trusting it.
 *
 * There is deliberately no field for anything a researcher configured about the
 * *content* of a session. If a future phase wants per-study notification
 * wording, it must be researcher-authored generic text — and it will still be
 * subject to this rule.
 */
export const pushPayloadSchema = z.object({
  title: z.string().max(120),
  body: z.string().max(240),
  locale: localeSchema,
  /** Where the click goes. A session id only; nothing about its content. */
  sessionId: z.string().uuid(),
  /** Collapses an older notification for the same session on the device. */
  tag: z.string().max(120),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;

/**
 * Client-reported notification events (FR-19, STRUCTURE.md §9.3).
 *
 * **Best-effort and known to be lossy.** The service worker reports these, and
 * it is not running when the device is off, is killed under memory pressure,
 * and on iOS is inconsistent about `notificationclose` altogether. They are
 * recorded because they are the only window onto what happened after the push
 * service accepted a message, and they must never be treated as a denominator.
 */
export const CLIENT_NOTIFICATION_EVENTS = ["DISPLAYED", "CLICKED"] as const;
export const clientNotificationEventSchema = z.enum(CLIENT_NOTIFICATION_EVENTS);
export type ClientNotificationEvent = z.infer<typeof clientNotificationEventSchema>;

export const reportNotificationEventSchema = z.object({
  sessionId: z.string().uuid(),
  kind: notificationKindSchema,
  occurrenceIndex: z.number().int().min(0),
  event: clientNotificationEventSchema,
});

export type ReportNotificationEventRequest = z.infer<typeof reportNotificationEventSchema>;

/**
 * One attempt, as the participant's own notification history shows it.
 *
 * The participant is entitled to see what this study sent them and when — it is
 * their contact record. Suppressions are included: "we did not notify you
 * because you had already finished" is a more honest answer than a gap, and a
 * participant who believes they were never told is otherwise unanswerable.
 */
export const notificationHistoryEntrySchema = z.object({
  sessionId: z.string().uuid(),
  kind: notificationKindSchema,
  occurrenceIndex: z.number().int(),
  outcome: notificationOutcomeSchema,
  suppressionReason: notificationSuppressionReasonSchema.nullable(),
  scheduledFor: z.string(),
  attemptedAt: z.string().nullable(),
});

export type NotificationHistoryEntry = z.infer<typeof notificationHistoryEntrySchema>;

export const notificationHistorySchema = z.object({
  attempts: z.array(notificationHistoryEntrySchema),
});

export type NotificationHistoryResponse = z.infer<typeof notificationHistorySchema>;
