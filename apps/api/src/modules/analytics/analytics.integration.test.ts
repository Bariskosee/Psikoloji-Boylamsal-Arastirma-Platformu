import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createAnalyticsPool, createDatabase, type Pool } from "@lpr/db";
import {
  Client,
  VALID_STUDY,
  createHarness,
  createUser,
  addMember,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * The monitoring dashboard against real PostgreSQL (PLAN.md Phase 10).
 *
 * Two things are asserted that nothing else can assert:
 *
 *  1. **The numbers reconcile against a hand-counted fixture.** The fixture
 *     below is worked example E from `docs/compliance-formula.md`, built as
 *     rows. If the dashboard and the document disagree, one of them is wrong
 *     and a published figure is at stake.
 *  2. **The analytics role cannot reach `identity`.** Not by convention, not by
 *     review — the query fails at the database. That is the whole of NFR-03,
 *     and the only way to know it holds is to try it.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.db);
  harness.resetRateLimits();
});

interface Fixture {
  studyId: string;
  participantId: string;
  owner: Client;
}

/**
 * Worked example E, as rows.
 *
 * baseline ×1, daily ×30, endline ×1 — the reference design. The participant
 * joined a fixed-date block two days after it started, so `daily` #0–#1 are
 * `CANCELLED` with `ENROLLED_AFTER_WINDOW`; #2–#10 are seven completed, one
 * unstarted and one partial; #11 is open; the rest are scheduled.
 *
 * Expected, from the document: elapsed 8/10, strict 8/30, daily adherence 7/9,
 * baseline completed, endline not yet due.
 */
async function workedExampleE(): Promise<Fixture> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);

  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = study.body.id;

  const db = harness.db;
  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => {
    const result = await db.execute(sql.raw(bind(text, values)));
    return result.rows[0] as T;
  };

  const questionnaire = await one<{ id: string }>(
    `INSERT INTO research.questionnaires (study_id, name) VALUES ('${studyId}', 'core') RETURNING id`,
  );
  const qVersion = await one<{ id: string }>(
    `INSERT INTO research.questionnaire_versions (questionnaire_id, status, version_number, published_at)
     VALUES ('${questionnaire.id}', 'PUBLISHED', 1, now()) RETURNING id`,
  );
  const protocol = await one<{ id: string }>(
    `INSERT INTO research.protocols (study_id, name) VALUES ('${studyId}', 'main') RETURNING id`,
  );
  const pVersion = await one<{ id: string }>(
    `INSERT INTO research.protocol_versions (protocol_id, status, version_number, published_at)
     VALUES ('${protocol.id}', 'PUBLISHED', 1, now()) RETURNING id`,
  );

  const step = async (key: string, index: number, occurrences: number, counts = true) =>
    one<{ id: string }>(
      `INSERT INTO research.protocol_steps
         (protocol_version_id, step_index, step_key, questionnaire_version_id,
          trigger_type, window_duration_iso, occurrence_count, recurrence_interval_iso,
          counts_toward_compliance)
       VALUES ('${pVersion.id}', ${String(index)}, '${key}', '${qVersion.id}',
               'ENROLLMENT', 'P1D', ${String(occurrences)},
               ${occurrences > 1 ? "'P1D'" : "NULL"}, ${counts ? "true" : "false"})
       RETURNING id`,
    );

  const baseline = await step("baseline", 0, 1);
  const daily = await step("daily", 1, 30);
  const endline = await step("endline", 2, 1);

  const consent = await one<{ id: string }>(
    `INSERT INTO research.consent_versions (study_id, status, version_number, published_at)
     VALUES ('${studyId}', 'PUBLISHED', 1, now()) RETURNING id`,
  );
  const participant = await one<{ id: string }>(
    `INSERT INTO research.participants (study_id, public_code, locale, timezone)
     VALUES ('${studyId}', 'P-AAA111', 'en', 'Europe/Istanbul') RETURNING id`,
  );
  await db.execute(
    sql.raw(
      `INSERT INTO research.enrollments
         (participant_id, study_id, protocol_version_id, consent_version_id, consented_at, consent_locale)
       VALUES ('${participant.id}', '${studyId}', '${pVersion.id}', '${consent.id}', now(), 'en')`,
    ),
  );

  const session = async (
    stepId: string,
    occurrence: number,
    status: string,
    extra = "",
  ): Promise<void> => {
    await db.execute(
      sql.raw(
        `INSERT INTO research.participant_sessions
           (participant_id, study_id, protocol_version_id, protocol_step_id, occurrence_index,
            questionnaire_version_id, status, available_from, available_until,
            completed_at, expired_at, cancelled_at, cancellation_reason)
         VALUES ('${participant.id}', '${studyId}', '${pVersion.id}', '${stepId}',
                 ${String(occurrence)}, '${qVersion.id}', '${status}',
                 now() - interval '2 hours', now() + interval '2 hours',
                 ${status === "COMPLETED" ? "now()" : "NULL"},
                 ${status.startsWith("EXPIRED") ? "now()" : "NULL"},
                 ${status === "CANCELLED" ? "now()" : "NULL"},
                 ${extra === "" ? "NULL" : `'${extra}'`})`,
      ),
    );
  };

  await session(baseline.id, 0, "COMPLETED");
  for (let i = 0; i < 2; i += 1) await session(daily.id, i, "CANCELLED", "ENROLLED_AFTER_WINDOW");
  for (let i = 2; i < 9; i += 1) await session(daily.id, i, "COMPLETED");
  await session(daily.id, 9, "EXPIRED_UNSTARTED");
  await session(daily.id, 10, "EXPIRED_PARTIAL");
  await session(daily.id, 11, "AVAILABLE");
  for (let i = 12; i < 30; i += 1) await session(daily.id, i, "SCHEDULED");
  await session(endline.id, 0, "SCHEDULED");

  return { studyId, participantId: participant.id, owner: client };
}

/** Minimal parameter binding for the raw fixture SQL above. */
function bind(text: string, values: unknown[]): string {
  return values.reduce<string>(
    (acc, value, index) => acc.replaceAll(`$${String(index + 1)}`, `'${String(value)}'`),
    text,
  );
}

describe("the overview reconciles with a hand-counted fixture", () => {
  it("counts sessions by bucket exactly", async () => {
    const { studyId, owner } = await workedExampleE();

    const response = await owner.get(`/api/studies/${studyId}/analytics/overview`).expect(200);

    // Hand-counted from the fixture: 8 completed (1 baseline + 7 daily),
    // 2 missed, 1 open, 19 not yet due (18 daily + endline), 2 cancelled. 32.
    expect(response.body.sessions).toEqual({
      completed: 8,
      missed: 2,
      open: 1,
      notYetDue: 19,
      cancelled: 2,
    });
  });

  it("reports the average with the participant count behind it", async () => {
    const { studyId, owner } = await workedExampleE();

    const response = await owner.get(`/api/studies/${studyId}/analytics/overview`).expect(200);

    // 8/10 = 80%, over one participant. §7 requires the count to be displayed
    // alongside any average, so the API cannot omit it.
    expect(response.body.averageCompliancePercent).toBe(80);
    expect(response.body.averageOverParticipants).toBe(1);
    expect(response.body.participants.total).toBe(1);
  });
});

describe("per-participant compliance matches docs/compliance-formula.md §9 example E", () => {
  it("reports elapsed 8/10 and strict 8/30, with the denominators", async () => {
    const { studyId, participantId, owner } = await workedExampleE();

    const response = await owner
      .get(`/api/studies/${studyId}/participants/${participantId}`)
      .expect(200);

    // The denominator travels with the percentage. PLAN.md Phase 10 requires it
    // displayed rather than hidden, because the denominator rule is the part
    // that moves the number most.
    expect(response.body.elapsed).toEqual({ numerator: 8, denominator: 10, percent: 80 });
    expect(response.body.strict).toEqual({ numerator: 8, denominator: 30, percent: 26.7 });
  });

  it("reports the daily block separately from the anchors — FR-44", async () => {
    const { studyId, participantId, owner } = await workedExampleE();

    const response = await owner
      .get(`/api/studies/${studyId}/participants/${participantId}`)
      .expect(200);

    const byKey = new Map<string, Record<string, unknown>>(
      response.body.perStep.map((s: { stepKey: string }) => [s.stepKey, s]),
    );

    // One figure covering thirty occurrences and two anchors hides the number
    // that matters most, which is why §6 requires all three.
    expect(byKey.get("daily")).toMatchObject({
      kind: "ADHERENCE",
      compliance: { numerator: 7, denominator: 9, percent: 77.8 },
    });
    expect(byKey.get("baseline")).toMatchObject({ kind: "COMPLETION", state: "COMPLETED" });
    expect(byKey.get("endline")).toMatchObject({ kind: "COMPLETION", state: "NOT_YET_DUE" });
  });

  it("never renders a single-occurrence step as a percentage", async () => {
    const { studyId, participantId, owner } = await workedExampleE();

    const response = await owner
      .get(`/api/studies/${studyId}/participants/${participantId}`)
      .expect(200);

    const endline = response.body.perStep.find(
      (s: { stepKey: string }) => s.stepKey === "endline",
    ) as { kind: string; state: string; compliance: { percent: number | null } };

    // "Did they do the endline?" is a yes-or-no question; 0% would be a
    // category error, and §6 forbids it.
    expect(endline.kind).toBe("COMPLETION");
    expect(endline.compliance.percent).toBeNull();
    expect(endline.state).toBe("NOT_YET_DUE");
  });
});

describe("the timeline shows every session the protocol implies", () => {
  it("includes all thirty occurrences and the two cancelled by late enrollment", async () => {
    const { studyId, participantId, owner } = await workedExampleE();

    const response = await owner
      .get(`/api/studies/${studyId}/participants/${participantId}`)
      .expect(200);

    expect(response.body.timeline).toHaveLength(32);

    const daily = response.body.timeline.filter(
      (entry: { stepKey: string }) => entry.stepKey === "daily",
    );
    expect(daily).toHaveLength(30);

    // Cancelled sessions carry their reason, so the interface can read them as
    // "not applicable" rather than as missed.
    const cancelled = daily.filter((e: { status: string }) => e.status === "CANCELLED");
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0].cancellationReason).toBe("ENROLLED_AFTER_WINDOW");
  });

  it("orders by step then occurrence, so a block reads in sequence", async () => {
    const { studyId, participantId, owner } = await workedExampleE();

    const response = await owner
      .get(`/api/studies/${studyId}/participants/${participantId}`)
      .expect(200);

    const daily = response.body.timeline
      .filter((entry: { stepKey: string }) => entry.stepKey === "daily")
      .map((entry: { occurrenceIndex: number }) => entry.occurrenceIndex);

    expect(daily).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });
});

describe("the daily view sums correctly", () => {
  it("counts an open session whose window closes today exactly once", async () => {
    /**
     * The regression this exists for, found by driving the live dashboard.
     *
     * A session that is still AVAILABLE but whose `available_until` falls on
     * today appeared in BOTH halves of the query — once as a window closing
     * today, once as a window still open — and was counted twice. The overview
     * said two sessions were open while the daily table said three.
     *
     * That is precisely the failure `docs/compliance-formula.md` §8 warns
     * about: categories that appear to double-count destroy trust in every
     * other number on the page. A session is open or it is closed, never both.
     */
    const { studyId, owner } = await workedExampleE();

    // The fixture's sessions all run now−2h … now+2h, so the AVAILABLE one
    // closes today and is exactly the shape that was double-counted.
    const response = await owner.get(`/api/studies/${studyId}/analytics/daily`).expect(200);

    const totalOpen = response.body.days.reduce(
      (sum: number, day: { open: number }) => sum + day.open,
      0,
    );
    const overview = await owner.get(`/api/studies/${studyId}/analytics/overview`).expect(200);

    // One AVAILABLE session in the fixture, counted once.
    expect(overview.body.sessions.open).toBe(1);
    expect(totalOpen).toBe(1);

    // And every day's parts still sum to its own totals.
    for (const day of response.body.days) {
      expect(day.completed + day.missedUnstarted + day.missedPartial).toBe(day.closed);
      expect(day.notStarted + day.inProgress).toBe(day.open);
    }
  });
});

describe("the participant list", () => {
  it("paginates by cursor, not offset", async () => {
    const { studyId, owner } = await workedExampleE();

    const page = await owner.get(`/api/studies/${studyId}/participants?limit=1`).expect(200);

    expect(page.body.participants).toHaveLength(1);
    // One participant in the fixture, so there is nothing after them.
    expect(page.body.nextCursor).toBeNull();
  });

  it("carries per-step compliance on every row", async () => {
    const { studyId, owner } = await workedExampleE();

    const page = await owner.get(`/api/studies/${studyId}/participants`).expect(200);

    expect(page.body.participants[0].perStep).toHaveLength(3);
    expect(page.body.participants[0].elapsed.denominator).toBe(10);
  });

  it("exposes no contact detail, endpoint or credential", async () => {
    // Structurally impossible rather than merely absent: the analytics role
    // cannot read `identity` at all. This asserts the consequence.
    const { studyId, owner } = await workedExampleE();

    const page = await owner.get(`/api/studies/${studyId}/participants`).expect(200);
    const body = JSON.stringify(page.body);

    expect(body).not.toContain("endpoint");
    expect(body).not.toContain("token");
    expect(body).toContain("P-AAA111");
  });
});

describe("NFR-03 — the analytics role cannot reach identity", () => {
  let analyticsPool: Pool;

  beforeAll(() => {
    analyticsPool = createAnalyticsPool({
      connectionString: process.env["DATABASE_URL"] as string,
      max: 2,
    });
  });

  afterAll(async () => {
    await analyticsPool.end();
  });

  it("reads the research schema", async () => {
    const db = createDatabase(analyticsPool);
    const result = await db.execute(sql`SELECT count(*)::text AS count FROM research.studies`);

    expect(result.rows[0]).toBeDefined();
  });

  it("fails at the database when a query joins a push endpoint", async () => {
    /**
     * The test that makes NFR-03 enforceable rather than aspirational.
     *
     * An export or dashboard query that accidentally reached for an endpoint
     * does not silently succeed and leak — it fails here, in CI, before review.
     */
    const db = createDatabase(analyticsPool);

    await expect(
      db.execute(sql`SELECT endpoint FROM identity.push_subscriptions LIMIT 1`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("fails on a researcher password hash too", async () => {
    const db = createDatabase(analyticsPool);

    await expect(
      db.execute(sql`SELECT password_hash FROM identity.researcher_users LIMIT 1`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot write to the research schema either", async () => {
    // SELECT only. A dashboard has no business mutating research data, and the
    // role makes an accidental UPDATE impossible rather than unlikely.
    const db = createDatabase(analyticsPool);

    await expect(
      db.execute(sql`UPDATE research.studies SET name = 'x' WHERE false`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("authorization", () => {
  it("lets a VIEWER see aggregate monitoring", async () => {
    const { studyId, owner } = await workedExampleE();
    const viewer = await createUser(harness.db);
    await addMember(harness.db, studyId, viewer.id, "VIEWER");
    const client = await Client.login(harness.app, viewer);

    await client.get(`/api/studies/${studyId}/analytics/overview`).expect(200);
    await client.get(`/api/studies/${studyId}/participants`).expect(200);
    void owner;
  });

  it("refuses a VIEWER the response inspector", async () => {
    // The line VIEWER must not cross: individual psychological answers
    // (REQUIREMENTS.md §5.2). Aggregate monitoring is fine; this is not.
    const { studyId } = await workedExampleE();
    const viewer = await createUser(harness.db);
    await addMember(harness.db, studyId, viewer.id, "VIEWER");
    const client = await Client.login(harness.app, viewer);

    const sessions = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM research.participant_sessions LIMIT 1`,
    );

    await client
      .get(`/api/studies/${studyId}/sessions/${sessions.rows[0]!.id}/responses`)
      .expect(403);
  });

  it("answers a non-member with 404, not 403", async () => {
    /**
     * Deliberate, and not a weaker check than 403.
     *
     * `StudyPermissionGuard` refuses to distinguish "this study exists but you
     * may not see it" from "no such study". A member of study A must not be
     * able to enumerate study B's existence by watching status codes.
     */
    const { studyId } = await workedExampleE();
    const stranger = await createUser(harness.db);
    const client = await Client.login(harness.app, stranger);

    await client.get(`/api/studies/${studyId}/analytics/overview`).expect(404);
  });

  it("refuses the operations page to a non-admin", async () => {
    const user = await createUser(harness.db, { isAdmin: false });
    const client = await Client.login(harness.app, user);

    await client.get("/api/ops/health").expect(403);
  });

  it("serves the operations page to an admin", async () => {
    const admin = await createUser(harness.db, { isAdmin: true });
    const client = await Client.login(harness.app, admin);

    const response = await client.get("/api/ops/health").expect(200);

    expect(response.body).toHaveProperty("sweepers");
    expect(response.body).toHaveProperty("pushSubscriptions");
    // Counts only — an operations page is somewhere a screen gets left open.
    expect(JSON.stringify(response.body)).not.toContain("endpoint");
  });
});

describe("the response inspector", () => {
  it("is audited, and records the count rather than the answers", async () => {
    const { studyId, owner } = await workedExampleE();

    const sessions = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM research.participant_sessions WHERE status = 'COMPLETED' LIMIT 1`,
    );
    const sessionId = sessions.rows[0]!.id;

    await owner.get(`/api/studies/${studyId}/sessions/${sessionId}/responses`).expect(200);

    const audit = await harness.db.execute<{ action: string; metadata: unknown }>(
      sql`SELECT action, metadata FROM research.audit_events WHERE action = 'response.view'`,
    );

    expect(audit.rows).toHaveLength(1);
    // The audit trail must not become a second copy of the psychological data
    // it exists to protect.
    expect(JSON.stringify(audit.rows[0]?.metadata)).toMatch(/answerCount/);
  });

  it("refuses a session belonging to another study", async () => {
    const first = await workedExampleE();
    const second = await workedExampleE();

    const sessions = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM research.participant_sessions WHERE study_id = ${second.studyId} LIMIT 1`,
    );

    await first.owner
      .get(`/api/studies/${first.studyId}/sessions/${sessions.rows[0]!.id}/responses`)
      .expect(404);
  });
});
