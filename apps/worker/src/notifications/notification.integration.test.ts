import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@lpr/db";
import { processNotification } from "./send.js";
import { RecordingPushTransport } from "./transport.js";
import { notificationsDueSweeper } from "../sweepers/notification-sweeper.js";
import type { SweepContext, SweepLogger } from "../sweepers/sweeper.js";

/**
 * The notification engine against real PostgreSQL (PLAN.md Phase 9).
 *
 * The tests that carry this phase are the ones about things NOT happening:
 * completion racing an in-flight reminder and producing zero sends, an eight-
 * hour outage producing no burst, duplicate delivery producing one row. Each of
 * them is a property of the whole stack — a row lock, a unique index, a clock
 * read inside a statement — and every one of them would pass against a mocked
 * database while being false in production.
 */

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests.");

let pool: Pool;
let transport: RecordingPushTransport;

const silentLogger: SweepLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const deps = () => ({ pool, transport, queue: null, logger: silentLogger });

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function crockford(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)];
  }
  return out;
}

interface Policy {
  initialDelay?: string;
  interval?: string;
  maxReminders?: number;
  quietStart?: string | null;
  quietEnd?: string | null;
  quietBehavior?: "SKIP" | "DEFER";
}

interface Scaffold {
  participantId: string;
  sessionId: string;
  subscriptionId: string;
  endpoint: string;
}

/**
 * A study, a protocol with a reminder policy, an enrolled participant with an
 * active push subscription, and one open session.
 *
 * `policy: null` builds a step with NO reminder policy — the "notify once,
 * never chase" case, which the pipeline must treat as `maxReminders: 0` rather
 * than as a missing configuration to complain about.
 */
async function scaffold(
  options: {
    policy?: Policy | null;
    windowFrom?: string;
    windowUntil?: string;
    sessionStatus?: string;
    participantStatus?: string;
    withSubscription?: boolean;
    timezone?: string;
  } = {},
): Promise<Scaffold> {
  const client = await pool.connect();
  try {
    const one = async <T>(text: string, values: unknown[] = []): Promise<T> => {
      const result = await client.query(text, values);
      return result.rows[0] as T;
    };

    const study = await one<{ id: string }>(
      `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
       VALUES ('Notification study', $1, $2, 'en', ARRAY['en']) RETURNING id`,
      [crockford(6), options.timezone ?? "Europe/Istanbul"],
    );
    const questionnaire = await one<{ id: string }>(
      `INSERT INTO research.questionnaires (study_id, name) VALUES ($1, 'q') RETURNING id`,
      [study.id],
    );
    const questionnaireVersion = await one<{ id: string }>(
      `INSERT INTO research.questionnaire_versions (questionnaire_id, status, version_number, published_at)
       VALUES ($1, 'PUBLISHED', 1, now()) RETURNING id`,
      [questionnaire.id],
    );
    const protocol = await one<{ id: string }>(
      `INSERT INTO research.protocols (study_id, name) VALUES ($1, 'p') RETURNING id`,
      [study.id],
    );
    const protocolVersion = await one<{ id: string }>(
      `INSERT INTO research.protocol_versions (protocol_id, status, version_number, published_at)
       VALUES ($1, 'PUBLISHED', 1, now()) RETURNING id`,
      [protocol.id],
    );

    let policyId: string | null = null;
    if (options.policy !== null) {
      const p = options.policy ?? {};
      const row = await one<{ id: string }>(
        `INSERT INTO research.reminder_policies
           (initial_delay_iso, interval_iso, max_reminders,
            quiet_hours_start, quiet_hours_end, quiet_hours_behavior)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          p.initialDelay ?? "PT0S",
          p.interval ?? "PT3H",
          p.maxReminders ?? 3,
          p.quietStart ?? null,
          p.quietEnd ?? null,
          p.quietBehavior ?? "SKIP",
        ],
      );
      policyId = row.id;
    }

    const step = await one<{ id: string }>(
      `INSERT INTO research.protocol_steps
         (protocol_version_id, step_index, step_key, questionnaire_version_id,
          trigger_type, window_duration_iso, reminder_policy_id)
       VALUES ($1, 0, 'daily', $2, 'ENROLLMENT', 'P1D', $3) RETURNING id`,
      [protocolVersion.id, questionnaireVersion.id, policyId],
    );
    const consentVersion = await one<{ id: string }>(
      `INSERT INTO research.consent_versions (study_id, status, version_number, published_at)
       VALUES ($1, 'PUBLISHED', 1, now()) RETURNING id`,
      [study.id],
    );
    const participant = await one<{ id: string }>(
      // `withdrawn_at` is set together with the status:
      // `participants_withdrawal_complete` refuses a withdrawal with no
      // instant, and it is right to — "they left" with no date is not a fact
      // anyone could act on later.
      `INSERT INTO research.participants (study_id, public_code, locale, status, timezone, withdrawn_at)
       VALUES ($1, 'P-' || $2, 'en', $3, $4,
               CASE WHEN $3 = 'WITHDRAWN' THEN now() ELSE NULL END) RETURNING id`,
      [study.id, crockford(6), options.participantStatus ?? "ACTIVE", options.timezone ?? null],
    );
    await client.query(
      `INSERT INTO research.enrollments
         (participant_id, study_id, protocol_version_id, consent_version_id, consented_at, consent_locale)
       VALUES ($1, $2, $3, $4, now(), 'en')`,
      [participant.id, study.id, protocolVersion.id, consentVersion.id],
    );

    const session = await one<{ id: string }>(
      `INSERT INTO research.participant_sessions
         (participant_id, study_id, protocol_version_id, protocol_step_id, occurrence_index,
          questionnaire_version_id, status, available_from, available_until, completed_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6, now() + $7::interval, now() + $8::interval,
               CASE WHEN $6 = 'COMPLETED' THEN now() ELSE NULL END)
       RETURNING id`,
      [
        participant.id,
        study.id,
        protocolVersion.id,
        step.id,
        questionnaireVersion.id,
        options.sessionStatus ?? "AVAILABLE",
        options.windowFrom ?? "-1 hour",
        options.windowUntil ?? "12 hours",
      ],
    );

    const endpoint = `https://push.example.org/s/${randomUUID()}`;
    let subscriptionId = "";
    if (options.withSubscription !== false) {
      const sub = await one<{ id: string }>(
        `INSERT INTO identity.push_subscriptions
           (participant_id, endpoint, p256dh_key, auth_key)
         VALUES ($1, $2, 'not-a-real-p256dh-key', 'not-a-real-auth-key') RETURNING id`,
        [participant.id, endpoint],
      );
      subscriptionId = sub.id;
    }

    return { participantId: participant.id, sessionId: session.id, subscriptionId, endpoint };
  } finally {
    client.release();
  }
}

async function attempts(
  sessionId: string,
): Promise<
  { kind: string; occurrence_index: number; outcome: string; suppression_reason: string | null }[]
> {
  const result = await pool.query(
    `SELECT kind, occurrence_index, outcome, suppression_reason
       FROM research.notification_attempts
      WHERE session_id = $1
      ORDER BY (kind = 'INITIAL') DESC, occurrence_index`,
    [sessionId],
  );
  return result.rows as never;
}

const sweepContext = (): SweepContext => ({
  pool,
  logger: silentLogger,
  signal: new AbortController().signal,
});

beforeAll(() => {
  pool = createPool({ connectionString: connectionString!, max: 6 });
  transport = new RecordingPushTransport();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  transport.clear();
  await pool.query(`TRUNCATE identity.push_subscriptions`);
  await pool.query(`TRUNCATE research.notification_attempts, research.participant_sessions,
                             research.responses, research.enrollments, research.participants,
                             research.protocol_steps, research.reminder_policies,
                             research.protocol_versions, research.protocols,
                             research.consent_versions, research.questionnaire_versions,
                             research.questionnaires, research.studies
                    RESTART IDENTITY CASCADE`);
});

describe("sending", () => {
  it("sends one notification and records it as accepted, not delivered", async () => {
    const base = await scaffold();

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });

    expect(result).toEqual({ status: "SENT" });
    expect(transport.sent).toHaveLength(1);
    // `SENT_ACCEPTED`, never `DELIVERED`. The push service took the message;
    // whether it reached a phone is not observable (FR-15, ADR-006).
    expect(await attempts(base.sessionId)).toEqual([
      { kind: "INITIAL", occurrence_index: 0, outcome: "SENT_ACCEPTED", suppression_reason: null },
    ]);
  });

  it("puts no research content in the payload", async () => {
    // Payloads pass through Google's, Apple's or Mozilla's infrastructure. A
    // study about a sensitive topic must not announce itself on a lock screen
    // (ADR-006, STRUCTURE.md §9.4).
    const base = await scaffold();

    await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });

    const payload = transport.sent[0]?.payload;
    expect(payload?.sessionId).toBe(base.sessionId);
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "body",
      "locale",
      "sessionId",
      "tag",
      "title",
    ]);
    // Nothing naming the study, the questionnaire, or a question.
    expect(JSON.stringify(payload)).not.toContain("Notification study");
  });
});

describe("the guard chain against real state", () => {
  it("suppresses on a completed session — FR-18", async () => {
    const base = await scaffold({ sessionStatus: "COMPLETED" });

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "REMINDER",
      occurrenceIndex: 1,
      scheduledFor: new Date(),
    });

    expect(result).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_STATE" });
    expect(transport.sent).toHaveLength(0);
    // The suppression record PLAN.md asks for as proof the guard fired.
    expect(await attempts(base.sessionId)).toEqual([
      {
        kind: "REMINDER",
        occurrence_index: 1,
        outcome: "SUPPRESSED",
        suppression_reason: "SUPPRESSED_STATE",
      },
    ]);
  });

  it("suppresses for a withdrawn participant", async () => {
    const base = await scaffold({ participantStatus: "WITHDRAWN" });

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });

    expect(result).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_WITHDRAWN" });
    expect(transport.sent).toHaveLength(0);
  });

  it("suppresses when the participant has no active subscription", async () => {
    const base = await scaffold({ withSubscription: false });

    expect(
      await processNotification(deps(), {
        sessionId: base.sessionId,
        kind: "INITIAL",
        occurrenceIndex: 0,
        scheduledFor: new Date(),
      }),
    ).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_NO_SUBSCRIPTION" });
  });

  it("suppresses a job left over from an eight-hour outage", async () => {
    const base = await scaffold({ policy: { interval: "PT3H" } });

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "REMINDER",
      occurrenceIndex: 1,
      scheduledFor: new Date(Date.now() - 8 * 3_600_000),
    });

    expect(result).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_STALE" });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("quiet hours against a real participant timezone", () => {
  /**
   * A window covering the whole day in the participant's own zone.
   *
   * Pinning "now" is not possible here — the decision uses the DATABASE's
   * clock, deliberately, so that two workers cannot disagree. An all-day window
   * makes the assertion independent of when the suite happens to run, which is
   * the honest way to test a rule whose whole point is that it reads a real
   * clock.
   */
  const ALL_DAY = { quietStart: "00:00", quietEnd: "23:59" };

  it("SKIP records a suppression and leaves the chain alive", async () => {
    const base = await scaffold({
      policy: { ...ALL_DAY, quietBehavior: "SKIP", maxReminders: 3 },
      timezone: "Europe/Istanbul",
    });

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });

    expect(result).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_QUIET_HOURS" });
    expect(transport.sent).toHaveLength(0);
    expect(await attempts(base.sessionId)).toHaveLength(1);
  });

  it("DEFER records nothing at all", async () => {
    // A deferral is not a decision about the notification — the whole guard
    // chain runs again when the window ends, and by then the participant may
    // have finished. A row here would be a suppression that never happened.
    const base = await scaffold({
      policy: { ...ALL_DAY, quietBehavior: "DEFER" },
      timezone: "Europe/Istanbul",
    });

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });

    expect(result.status).toBe("DEFERRED");
    expect(transport.sent).toHaveLength(0);
    expect(await attempts(base.sessionId)).toHaveLength(0);
  });
});

describe("duplicate delivery and concurrency", () => {
  it("produces exactly one attempt row under duplicate job delivery", async () => {
    const base = await scaffold();
    const request = {
      sessionId: base.sessionId,
      kind: "INITIAL" as const,
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    };

    await processNotification(deps(), request);
    const second = await processNotification(deps(), request);

    expect(second).toEqual({ status: "ALREADY_ATTEMPTED" });
    expect(transport.sent).toHaveLength(1);
    expect(await attempts(base.sessionId)).toHaveLength(1);
  });

  it("sends once when two workers process the same link concurrently", async () => {
    const base = await scaffold();
    const request = {
      sessionId: base.sessionId,
      kind: "INITIAL" as const,
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    };

    // Both take the same row lock; the second blocks, then reads the attempt
    // the first committed and stops at the idempotency guard. The unique index
    // is the backstop if the timing ever defeats that.
    const results = await Promise.allSettled([
      processNotification(deps(), request),
      processNotification(deps(), request),
    ]);

    const sent = results.filter(
      (r) => r.status === "fulfilled" && r.value.status === "SENT",
    ).length;

    expect(sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await attempts(base.sessionId)).toHaveLength(1);
  });
});

describe("a push service that says the subscription is gone", () => {
  it("deactivates the subscription and records the failure", async () => {
    const base = await scaffold();
    transport.markGone(base.endpoint);

    const result = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });

    expect(result).toEqual({ status: "SEND_FAILED" });

    const sub = await pool.query(
      `SELECT is_active, deactivation_reason FROM identity.push_subscriptions WHERE id = $1`,
      [base.subscriptionId],
    );
    expect(sub.rows[0]).toMatchObject({
      is_active: false,
      deactivation_reason: "REJECTED_BY_SERVICE",
    });
  });

  it("stops that chain: the next link finds nothing to send to", async () => {
    const base = await scaffold({ policy: { maxReminders: 3, interval: "PT1S" } });
    transport.markGone(base.endpoint);

    await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(),
    });
    const next = await processNotification(deps(), {
      sessionId: base.sessionId,
      kind: "REMINDER",
      occurrenceIndex: 1,
      scheduledFor: new Date(),
    });

    expect(next).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_NO_SUBSCRIPTION" });
  });
});

describe("the notifications-due sweeper, with no queue at all", () => {
  /**
   * Every test here runs with `queue: null`. That is the ADR-005 criterion made
   * literal: wipe the queue entirely and the notification subsystem still
   * reaches every participant it owes, one sweep interval late.
   */
  it("starts a chain for an open session that has never been notified", async () => {
    const base = await scaffold({ policy: { initialDelay: "PT0S" } });

    const outcome = await notificationsDueSweeper(deps()).run(sweepContext());

    expect(outcome.claimed).toBe(1);
    expect(outcome.acted).toBe(1);
    expect(await attempts(base.sessionId)).toEqual([
      { kind: "INITIAL", occurrence_index: 0, outcome: "SENT_ACCEPTED", suppression_reason: null },
    ]);
  });

  it("waits for the configured initial delay before starting", async () => {
    await scaffold({ policy: { initialDelay: "PT6H" }, windowFrom: "-1 minute" });

    const outcome = await notificationsDueSweeper(deps()).run(sweepContext());

    expect(outcome.claimed).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it("walks the whole chain and stops at the cap — FR-40", async () => {
    /**
     * The acceptance criterion: reminders fire at the configured interval and
     * stop at the cap. A one-second interval makes the whole chain due
     * immediately, so successive sweeps walk it without the test waiting hours.
     */
    /**
     * A zero interval, and a window that opened a moment ago.
     *
     * Two fixture choices, each avoiding a way this test would otherwise lie:
     *
     *  - A zero interval makes every link due at once, so six sweeps in a few
     *    milliseconds walk the whole chain. With a one-second interval the loop
     *    outruns the schedule and the test passes for the wrong reason — "no
     *    third reminder" because it was not due yet, rather than because the
     *    cap held.
     *  - The window opens a second ago rather than an hour ago, because a short
     *    interval collapses the staleness tolerance to its fifteen-minute
     *    floor, and an hour-old chain is then correctly suppressed as stale.
     *
     * The spacing itself is asserted where it belongs: on `nextChainLink` in
     * the domain, without a clock.
     */
    const base = await scaffold({
      policy: { initialDelay: "PT0S", interval: "PT0S", maxReminders: 2 },
      windowFrom: "-1 second",
    });

    for (let cycle = 0; cycle < 6; cycle += 1) {
      await notificationsDueSweeper(deps()).run(sweepContext());
    }

    const recorded = await attempts(base.sessionId);
    // One initial plus exactly two reminders. Never a third, however many times
    // the sweeper runs.
    expect(recorded.map((r) => `${r.kind}:${String(r.occurrence_index)}`)).toEqual([
      "INITIAL:0",
      "REMINDER:1",
      "REMINDER:2",
    ]);
    expect(transport.sent).toHaveLength(3);
  });

  it("sends once and never chases when the step has no reminder policy", async () => {
    const base = await scaffold({ policy: null });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await notificationsDueSweeper(deps()).run(sweepContext());
    }

    expect(await attempts(base.sessionId)).toHaveLength(1);
  });

  it("ignores a session whose window has closed", async () => {
    await scaffold({ windowFrom: "-3 hours", windowUntil: "-1 hour" });

    expect((await notificationsDueSweeper(deps()).run(sweepContext())).claimed).toBe(0);
  });

  it("ignores a completed session", async () => {
    await scaffold({ sessionStatus: "COMPLETED" });

    expect((await notificationsDueSweeper(deps()).run(sweepContext())).claimed).toBe(0);
  });

  it("ignores a withdrawn participant", async () => {
    await scaffold({ participantStatus: "WITHDRAWN" });

    expect((await notificationsDueSweeper(deps()).run(sweepContext())).claimed).toBe(0);
  });

  it("is idempotent: a second sweep in the same instant does nothing", async () => {
    const base = await scaffold({ policy: { initialDelay: "PT0S", interval: "PT3H" } });

    await notificationsDueSweeper(deps()).run(sweepContext());
    const second = await notificationsDueSweeper(deps()).run(sweepContext());

    // The next link is not due for three hours, so there is nothing to claim.
    expect(second.claimed).toBe(0);
    expect(await attempts(base.sessionId)).toHaveLength(1);
  });
});

describe("completion racing an in-flight reminder — the FR-18 race", () => {
  it("produces zero post-completion sends", async () => {
    /**
     * The race PLAN.md names, run for real.
     *
     * `POST /complete` sets COMPLETED while holding the session row lock. The
     * notification handler takes the SAME lock, so it either runs before the
     * completion — and sends legitimately — or blocks on it, reads COMPLETED,
     * and fails guard 1. There is no interleaving in which it sends afterwards,
     * and that is a property of the lock rather than of any cancellation API
     * (STRUCTURE.md §9.2).
     *
     * Here the completion goes first and holds its transaction open while the
     * reminder starts, which forces the handler to wait on the lock — the exact
     * ordering that would produce a post-completion send if the two paths did
     * not serialise.
     */
    const base = await scaffold({ policy: { maxReminders: 3 } });

    const completer = await pool.connect();
    let reminder: Promise<{ status: string }>;
    try {
      await completer.query("BEGIN");
      await completer.query(
        `SELECT id FROM research.participant_sessions WHERE id = $1 FOR UPDATE`,
        [base.sessionId],
      );
      await completer.query(
        `UPDATE research.participant_sessions
            SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
        [base.sessionId],
      );

      // Started while the completion still holds the lock.
      reminder = processNotification(deps(), {
        sessionId: base.sessionId,
        kind: "REMINDER",
        occurrenceIndex: 1,
        scheduledFor: new Date(),
      });

      // Give the handler time to reach the lock and block on it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await completer.query("COMMIT");
    } finally {
      completer.release();
    }

    const result = await reminder;

    expect(result).toEqual({ status: "SUPPRESSED", reason: "SUPPRESSED_STATE" });
    expect(transport.sent).toHaveLength(0);
    // The suppression record that proves the guard fired, rather than the
    // reminder merely happening not to run.
    expect(await attempts(base.sessionId)).toEqual([
      {
        kind: "REMINDER",
        occurrence_index: 1,
        outcome: "SUPPRESSED",
        suppression_reason: "SUPPRESSED_STATE",
      },
    ]);
  });

  it("stops the rest of the chain too", async () => {
    // Window opened a moment ago — see the note on the cap test above for why
    // a one-second interval and an hour-old window do not mix.
    const base = await scaffold({
      policy: { initialDelay: "PT0S", interval: "PT0S", maxReminders: 3 },
      windowFrom: "-1 second",
    });

    await notificationsDueSweeper(deps()).run(sweepContext());
    expect(transport.sent).toHaveLength(1);

    await pool.query(
      `UPDATE research.participant_sessions SET status = 'COMPLETED', completed_at = now()
        WHERE id = $1`,
      [base.sessionId],
    );

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await notificationsDueSweeper(deps()).run(sweepContext());
    }

    // Completing mid-chain stops all further reminders. The sweeper does not
    // even claim the session, because a completed session is not open.
    expect(transport.sent).toHaveLength(1);
  });
});

describe("no burst after an outage", () => {
  it("suppresses accumulated links instead of sending them", async () => {
    /**
     * The scenario ADR-005 exists for: the worker was down for eight hours, and
     * on restart the sweeper correctly discovers every reminder that was owed.
     * Sending them is literally correct and operationally indefensible — a
     * participant's phone lighting up four times at once.
     *
     * The chain is back-dated by writing the initial attempt eight hours ago,
     * which is exactly the state a real outage leaves behind.
     */
    const base = await scaffold({
      policy: { initialDelay: "PT0S", interval: "PT2H", maxReminders: 3 },
      windowFrom: "-9 hours",
      windowUntil: "6 hours",
    });

    await pool.query(
      `INSERT INTO research.notification_attempts
         (session_id, participant_id, kind, occurrence_index, scheduled_for, attempted_at, outcome)
       VALUES ($1, $2, 'INITIAL', 0, now() - interval '9 hours', now() - interval '9 hours',
               'SENT_ACCEPTED')`,
      [base.sessionId, base.participantId],
    );

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await notificationsDueSweeper(deps()).run(sweepContext());
    }

    // Not one buzz. Every overdue link is recorded as suppressed, so the miss
    // is visible in the data rather than being invisible or looking like the
    // participant ignored us.
    expect(transport.sent).toHaveLength(0);

    const recorded = await attempts(base.sessionId);
    const suppressed = recorded.filter((r) => r.suppression_reason === "SUPPRESSED_STALE");
    expect(suppressed.length).toBeGreaterThan(0);
    // And it terminates at the cap rather than recording forever.
    expect(recorded.length).toBeLessThanOrEqual(4);
  });
});
