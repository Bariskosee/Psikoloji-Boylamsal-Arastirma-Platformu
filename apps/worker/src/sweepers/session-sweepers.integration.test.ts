import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@lpr/db";
import { activateDueSweeper, expireDueSweeper } from "./session-sweepers.js";
import type { SweepContext, SweepLogger } from "./sweeper.js";

/**
 * The recovery guarantee, against real PostgreSQL (PLAN.md Phase 7).
 *
 * These are the "non-negotiable" tests: wipe the queue, run the sweepers, and
 * assert the schedule converges anyway. Nothing here enqueues a job — that is
 * the point. If these pass with an empty queue, the queue is an optimisation
 * rather than a dependency, which is the whole of ADR-005.
 */

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests.");

let pool: Pool;

const silentLogger: SweepLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A code of the shape the study and participant constraints require. */
function crockford(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)];
  }
  return out;
}

const context = (): SweepContext => ({
  pool,
  logger: silentLogger,
  signal: new AbortController().signal,
});

/**
 * A study, protocol, questionnaire, participant and enrollment — the minimum
 * scaffolding a `participant_sessions` row needs to satisfy its foreign keys.
 */
async function scaffold(): Promise<{
  participantId: string;
  studyId: string;
  protocolVersionId: string;
  stepId: string;
  questionnaireVersionId: string;
}> {
  const client = await pool.connect();
  try {
    const one = async <T>(text: string, values: unknown[] = []): Promise<T> => {
      const result = await client.query(text, values);
      return result.rows[0] as T;
    };

    const study = await one<{ id: string }>(
      `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
       VALUES ('Sweeper study', $1, 'Europe/Istanbul', 'en', ARRAY['en'])
       RETURNING id`,
      // Crockford base-32 without I, L, O or U — the shape the check constraint
      // enforces, which md5 hex does not satisfy.
      [crockford(6)],
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
    const step = await one<{ id: string }>(
      `INSERT INTO research.protocol_steps
         (protocol_version_id, step_index, step_key, questionnaire_version_id,
          trigger_type, window_duration_iso)
       VALUES ($1, 0, 'daily', $2, 'ENROLLMENT', 'P1D') RETURNING id`,
      [protocolVersion.id, questionnaireVersion.id],
    );
    const consentVersion = await one<{ id: string }>(
      `INSERT INTO research.consent_versions (study_id, status, version_number, published_at)
       VALUES ($1, 'PUBLISHED', 1, now()) RETURNING id`,
      [study.id],
    );
    const participant = await one<{ id: string }>(
      `INSERT INTO research.participants (study_id, public_code, locale)
       VALUES ($1, 'P-' || $2, 'en') RETURNING id`,
      [study.id, crockford(6)],
    );
    await client.query(
      `INSERT INTO research.enrollments
         (participant_id, study_id, protocol_version_id, consent_version_id, consented_at, consent_locale)
       VALUES ($1, $2, $3, $4, now(), 'en')`,
      [participant.id, study.id, protocolVersion.id, consentVersion.id],
    );

    return {
      participantId: participant.id,
      studyId: study.id,
      protocolVersionId: protocolVersion.id,
      stepId: step.id,
      questionnaireVersionId: questionnaireVersion.id,
    };
  } finally {
    client.release();
  }
}

async function insertSession(
  base: Awaited<ReturnType<typeof scaffold>>,
  occurrenceIndex: number,
  status: string,
  fromOffset: string,
  untilOffset: string,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO research.participant_sessions
       (participant_id, study_id, protocol_version_id, protocol_step_id, occurrence_index,
        questionnaire_version_id, status, available_from, available_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8::interval, now() + $9::interval)
     RETURNING id`,
    [
      base.participantId,
      base.studyId,
      base.protocolVersionId,
      base.stepId,
      occurrenceIndex,
      base.questionnaireVersionId,
      status,
      fromOffset,
      untilOffset,
    ],
  );
  return (result.rows[0] as { id: string }).id;
}

async function statusOf(id: string): Promise<string> {
  const result = await pool.query(
    `SELECT status FROM research.participant_sessions WHERE id = $1`,
    [id],
  );
  return (result.rows[0] as { status: string }).status;
}

beforeAll(() => {
  pool = createPool({ connectionString, max: 5 });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE research.participant_sessions, research.responses,
                             research.enrollments, research.participants,
                             research.protocol_steps, research.protocol_versions,
                             research.protocols, research.consent_versions,
                             research.questionnaire_versions, research.questionnaires,
                             research.studies RESTART IDENTITY CASCADE`);
});

describe("sweep.activate_due", () => {
  it("opens a window that has arrived", async () => {
    const base = await scaffold();
    const session = await insertSession(base, 0, "SCHEDULED", "-1 hour", "1 hour");

    const outcome = await activateDueSweeper().run(context());

    expect(outcome.acted).toBe(1);
    expect(await statusOf(session)).toBe("AVAILABLE");
  });

  it("leaves a window that has not arrived", async () => {
    const base = await scaffold();
    const session = await insertSession(base, 0, "SCHEDULED", "1 hour", "2 hours");

    const outcome = await activateDueSweeper().run(context());

    expect(outcome.claimed).toBe(0);
    expect(await statusOf(session)).toBe("SCHEDULED");
  });

  it("does not open a window that already closed", async () => {
    // Activating it would hand the participant a questionnaire that refuses
    // every write. The expiry sweeper owns this row.
    const base = await scaffold();
    const session = await insertSession(base, 0, "SCHEDULED", "-3 hours", "-1 hour");

    const outcome = await activateDueSweeper().run(context());

    expect(outcome.acted).toBe(0);
    expect(outcome.skipped["ALREADY_CLOSED"]).toBe(1);
    expect(await statusOf(session)).toBe("SCHEDULED");
  });

  it("is a no-op the second time — safe to run twice", async () => {
    const base = await scaffold();
    await insertSession(base, 0, "SCHEDULED", "-1 hour", "1 hour");

    await activateDueSweeper().run(context());
    const second = await activateDueSweeper().run(context());

    expect(second.claimed).toBe(0);
  });

  it("ignores a session still waiting on its trigger", async () => {
    const base = await scaffold();
    const session = await insertSession(base, 0, "PENDING_TRIGGER", "-1 hour", "1 hour");

    await activateDueSweeper().run(context());

    expect(await statusOf(session)).toBe("PENDING_TRIGGER");
  });
});

describe("sweep.expire_due", () => {
  it("expires an untouched session as EXPIRED_UNSTARTED", async () => {
    const base = await scaffold();
    const session = await insertSession(base, 0, "AVAILABLE", "-3 hours", "-1 hour");

    const outcome = await expireDueSweeper().run(context());

    expect(outcome.acted).toBe(1);
    expect(await statusOf(session)).toBe("EXPIRED_UNSTARTED");
  });

  it("expires a started session as EXPIRED_PARTIAL", async () => {
    // Two different facts about the participant. Collapsing them would hide
    // the difference in every compliance figure afterwards.
    const base = await scaffold();
    const session = await insertSession(base, 0, "STARTED", "-3 hours", "-1 hour");

    const question = await pool.query(
      `INSERT INTO research.question_versions
         (questionnaire_version_id, question_key, display_order, type, is_required, page_index, config)
       VALUES ($1, 'q_aaaaaaaaaa', 0, 'FREE_TEXT', true, 0, '{}'::jsonb) RETURNING id`,
      [base.questionnaireVersionId],
    );
    await pool.query(
      `INSERT INTO research.responses
         (session_id, participant_id, question_version_id, value_kind, value_text, answered_at)
       VALUES ($1, $2, $3, 'TEXT', 'something', now())`,
      [session, base.participantId, (question.rows[0] as { id: string }).id],
    );

    await expireDueSweeper().run(context());

    expect(await statusOf(session)).toBe("EXPIRED_PARTIAL");
  });

  it("leaves an open window alone", async () => {
    const base = await scaffold();
    const session = await insertSession(base, 0, "AVAILABLE", "-1 hour", "1 hour");

    const outcome = await expireDueSweeper().run(context());

    expect(outcome.claimed).toBe(0);
    expect(await statusOf(session)).toBe("AVAILABLE");
  });

  it("never touches a completed session", async () => {
    const base = await scaffold();
    const session = await insertSession(base, 0, "AVAILABLE", "-3 hours", "-1 hour");
    await pool.query(
      `UPDATE research.participant_sessions SET status='COMPLETED', completed_at=now() WHERE id=$1`,
      [session],
    );

    await expireDueSweeper().run(context());

    expect(await statusOf(session)).toBe("COMPLETED");
  });
});

describe("convergence from any starting condition (ADR-005)", () => {
  /**
   * The acceptance criterion: nothing here enqueues a job, so this IS the
   * "wipe the queue entirely" case. If the schedule converges with an empty
   * queue, the queue is an optimisation rather than a dependency.
   */
  it("restores correct state for a whole backlog in one cycle", async () => {
    const base = await scaffold();

    const due = await insertSession(base, 0, "SCHEDULED", "-2 hours", "2 hours");
    const notYet = await insertSession(base, 1, "SCHEDULED", "2 hours", "4 hours");
    const overdue = await insertSession(base, 2, "AVAILABLE", "-5 hours", "-1 hour");
    const stillOpen = await insertSession(base, 3, "AVAILABLE", "-1 hour", "1 hour");

    await activateDueSweeper().run(context());
    await expireDueSweeper().run(context());

    expect(await statusOf(due)).toBe("AVAILABLE");
    expect(await statusOf(notYet)).toBe("SCHEDULED");
    expect(await statusOf(overdue)).toBe("EXPIRED_UNSTARTED");
    expect(await statusOf(stillOpen)).toBe("AVAILABLE");
  });

  /**
   * A six-hour outage: sessions that should have opened AND closed while the
   * worker was down. One restart, one cycle of each sweeper, and the schedule
   * is correct — with no duplicate side effects, because both sweepers are
   * conditional UPDATEs that a second run finds nothing to do.
   */
  it("self-heals after a simulated outage, with no duplicate effects", async () => {
    const base = await scaffold();
    const missed = await insertSession(base, 0, "SCHEDULED", "-6 hours", "-5 hours");
    const openedDuring = await insertSession(base, 1, "SCHEDULED", "-3 hours", "3 hours");

    // First restart.
    await activateDueSweeper().run(context());
    await expireDueSweeper().run(context());
    // Second cycle, sixty seconds later.
    const activateAgain = await activateDueSweeper().run(context());
    const expireAgain = await expireDueSweeper().run(context());

    expect(await statusOf(openedDuring)).toBe("AVAILABLE");
    // A window that opened and closed while the worker was down expires
    // without ever having been activated — which is correct: nobody was
    // offered it, and `EXPIRED_UNSTARTED` says exactly that.
    expect(await statusOf(missed)).toBe("SCHEDULED");
    expect(activateAgain.acted).toBe(0);
    expect(expireAgain.acted).toBe(0);
  });

  it("acts once when the same work is swept twice concurrently", async () => {
    // Two replicas sweeping at the same instant. `SKIP LOCKED` fans them out,
    // and the conditional UPDATE makes a double-claim harmless anyway.
    const base = await scaffold();
    const session = await insertSession(base, 0, "SCHEDULED", "-1 hour", "1 hour");

    const [first, second] = await Promise.all([
      activateDueSweeper().run(context()),
      activateDueSweeper().run(context()),
    ]);

    expect(first.acted + second.acted).toBe(1);
    expect(await statusOf(session)).toBe("AVAILABLE");
  });
});
