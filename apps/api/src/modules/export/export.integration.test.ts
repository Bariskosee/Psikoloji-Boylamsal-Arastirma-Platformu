import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  Client,
  VALID_STUDY,
  addMember,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * The export, against real PostgreSQL (PLAN.md Phase 11, `docs/export-codebook.md`).
 *
 * §1 names the worst thing this platform can do: export a missing value as `0`,
 * have it averaged into a mean, and have that mean published. The fixture below
 * is built to produce **all seven** missingness situations at once, and the
 * tests then check the one rule that matters — no cell anywhere carries a value
 * unless its status says `ANSWERED`.
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
  owner: Client;
}

const raw = async (text: string): Promise<Record<string, unknown>[]> => {
  const result = await harness.db.execute(sql.raw(text));
  return result.rows as Record<string, unknown>[];
};
const one = async <T>(text: string): Promise<T> => (await raw(text))[0] as T;

/**
 * A study producing every one of the seven statuses.
 *
 * Two steps sharing ONE questionnaire version — the pre/post shape of FR-47 —
 * plus a recurring block, so the wide file exercises repeated column groups
 * with identical question keys.
 */
async function everyMissingnessCase(): Promise<Fixture> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = study.body.id;

  const questionnaire = await one<{ id: string }>(
    `INSERT INTO research.questionnaires (study_id, name) VALUES ('${studyId}', 'core') RETURNING id`,
  );
  const qver = await one<{ id: string }>(
    `INSERT INTO research.questionnaire_versions (questionnaire_id, status, version_number, published_at)
     VALUES ('${questionnaire.id}', 'PUBLISHED', 1, now()) RETURNING id`,
  );

  // A Likert item (numeric code + label) and a free-text item (optional, so it
  // can legitimately be SKIPPED_OPTIONAL).
  const likert = await one<{ id: string }>(
    `INSERT INTO research.question_versions
       (questionnaire_version_id, question_key, display_order, type, is_required, page_index, config)
     VALUES ('${qver.id}', 'mood_1', 0, 'LIKERT', true, 0, '{}'::jsonb) RETURNING id`,
  );
  await raw(
    `INSERT INTO research.question_version_translations (question_version_id, locale, text)
     VALUES ('${likert.id}', 'en', 'How is your mood?'), ('${likert.id}', 'tr', 'Ruh haliniz nasıl?')`,
  );
  const option = await one<{ id: string }>(
    `INSERT INTO research.question_options (question_version_id, option_key, display_order, value_number)
     VALUES ('${likert.id}', 'good', 4, 5) RETURNING id`,
  );
  await raw(
    `INSERT INTO research.question_option_translations (question_option_id, locale, label)
     VALUES ('${option.id}', 'en', 'Very good'), ('${option.id}', 'tr', 'Çok iyi')`,
  );

  const free = await one<{ id: string }>(
    `INSERT INTO research.question_versions
       (questionnaire_version_id, question_key, display_order, type, is_required, page_index, config)
     VALUES ('${qver.id}', 'note', 1, 'FREE_TEXT', false, 0, '{}'::jsonb) RETURNING id`,
  );
  await raw(
    `INSERT INTO research.question_version_translations (question_version_id, locale, text)
     VALUES ('${free.id}', 'en', 'Anything to add?'), ('${free.id}', 'tr', 'Eklemek istediğiniz?')`,
  );

  const protocol = await one<{ id: string }>(
    `INSERT INTO research.protocols (study_id, name) VALUES ('${studyId}', 'main') RETURNING id`,
  );
  const pver = await one<{ id: string }>(
    `INSERT INTO research.protocol_versions (protocol_id, status, version_number, published_at)
     VALUES ('${protocol.id}', 'PUBLISHED', 1, now()) RETURNING id`,
  );

  const step = async (key: string, index: number, occurrences: number) =>
    one<{ id: string }>(
      `INSERT INTO research.protocol_steps
         (protocol_version_id, step_index, step_key, questionnaire_version_id,
          trigger_type, offset_iso, window_duration_iso, occurrence_count, recurrence_interval_iso)
       VALUES ('${pver.id}', ${String(index)}, '${key}', '${qver.id}', 'ENROLLMENT', 'PT0S',
               'P1D', ${String(occurrences)}, ${occurrences > 1 ? "'P1D'" : "NULL"})
       RETURNING id`,
    );

  // baseline and endline administer THE SAME questionnaire version (FR-47).
  const baseline = await step("baseline", 0, 1);
  // Four occurrences from the outset. A published protocol version is
  // immutable (ADR-008), so the count cannot be raised afterwards — and a
  // fixture that could raise it would be exercising a state the product
  // forbids.
  const daily = await step("daily", 1, 4);
  const endline = await step("endline", 2, 1);

  const consent = await one<{ id: string }>(
    `INSERT INTO research.consent_versions (study_id, status, version_number, published_at)
     VALUES ('${studyId}', 'PUBLISHED', 1, now()) RETURNING id`,
  );
  const participant = await one<{ id: string }>(
    `INSERT INTO research.participants (study_id, public_code, locale, timezone)
     VALUES ('${studyId}', 'P-ZZZ999', 'en', 'Europe/Istanbul') RETURNING id`,
  );
  await raw(
    `INSERT INTO research.enrollments
       (participant_id, study_id, protocol_version_id, consent_version_id, consented_at, consent_locale)
     VALUES ('${participant.id}', '${studyId}', '${pver.id}', '${consent.id}', now(), 'en')`,
  );

  const session = async (stepId: string, occurrence: number, status: string) =>
    one<{ id: string }>(
      `INSERT INTO research.participant_sessions
         (participant_id, study_id, protocol_version_id, protocol_step_id, occurrence_index,
          questionnaire_version_id, status, scheduled_at, available_from, available_until,
          completed_at, expired_at, cancelled_at, cancellation_reason)
       VALUES ('${participant.id}', '${studyId}', '${pver.id}', '${stepId}', ${String(occurrence)},
               '${qver.id}', '${status}', now() - interval '3 hours',
               now() - interval '2 hours', now() + interval '2 hours',
               ${status === "COMPLETED" ? "now()" : "NULL"},
               ${status.startsWith("EXPIRED") ? "now()" : "NULL"},
               ${status === "CANCELLED" ? "now()" : "NULL"},
               ${status === "CANCELLED" ? "'ENROLLED_AFTER_WINDOW'" : "NULL"})
       RETURNING id`,
    );

  /**
   * One session per status, chosen so that all seven cell statuses appear:
   *
   *   COMPLETED         → mood ANSWERED, note SKIPPED_OPTIONAL
   *   EXPIRED_PARTIAL   → mood ANSWERED, note MISSED_ITEM_PARTIAL
   *   EXPIRED_UNSTARTED → both MISSED_SESSION
   *   AVAILABLE         → both IN_PROGRESS
   *   SCHEDULED         → both NOT_YET_DUE
   *   CANCELLED         → both NOT_APPLICABLE
   */
  /**
   * Answered first, completed second — the real order of events.
   *
   * A trigger makes responses under a COMPLETED session immutable (Phase 6), so
   * a fixture that completes the session and then inserts an answer is refused.
   * It is right to be refused: that sequence cannot happen in the product, and
   * a fixture that could produce it would be testing a state the system never
   * reaches.
   */
  const completed = await session(baseline.id, 0, "STARTED");
  await raw(
    `INSERT INTO research.responses
       (session_id, participant_id, question_version_id, value_kind, answered_at, client_revision)
     VALUES ('${completed.id}', '${participant.id}', '${likert.id}', 'OPTION', now(), 1)`,
  );
  const completedResponse = await one<{ id: string }>(
    `SELECT id FROM research.responses WHERE session_id = '${completed.id}'`,
  );
  await raw(
    `INSERT INTO research.response_option_selections (response_id, question_option_id)
     VALUES ('${completedResponse.id}', '${option.id}')`,
  );
  await raw(
    `UPDATE research.participant_sessions
        SET status = 'COMPLETED', completed_at = now() WHERE id = '${completed.id}'`,
  );

  const partial = await session(daily.id, 0, "EXPIRED_PARTIAL");
  await raw(
    `INSERT INTO research.responses
       (session_id, participant_id, question_version_id, value_kind, value_text, answered_at, client_revision)
     VALUES ('${partial.id}', '${participant.id}', '${free.id}', 'TEXT', 'a note', now(), 1)`,
  );

  await session(daily.id, 1, "EXPIRED_UNSTARTED");
  await session(daily.id, 2, "AVAILABLE");
  await session(endline.id, 0, "SCHEDULED");

  // The fourth occurrence is cancelled, for NOT_APPLICABLE.
  await session(daily.id, 3, "CANCELLED");

  return { studyId, owner: client };
}

/** Parse a CSV the way an analyst's tooling would, honouring quotes. */
function parseCsv(body: string): { header: string[]; rows: string[][] } {
  // Strip the UTF-8 BOM by code point rather than by pasting the character,
  // which lint flags as irregular whitespace and which is invisible in review.
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      /* consumed with the \n */
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { header: rows[0] ?? [], rows: rows.slice(1).filter((r) => r.length > 1) };
}

describe("long format", () => {
  it("produces all seven missingness statuses from one fixture", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);
    const { header, rows } = parseCsv(response.text as string);

    const statusAt = header.indexOf("response_status");
    const produced = new Set(rows.map((r) => r[statusAt]));

    expect(produced).toEqual(
      new Set([
        "ANSWERED",
        "SKIPPED_OPTIONAL",
        "MISSED_ITEM_PARTIAL",
        "MISSED_SESSION",
        "IN_PROGRESS",
        "NOT_YET_DUE",
        "NOT_APPLICABLE",
      ]),
    );
  });

  it("carries a value ONLY where the status is ANSWERED — never a zero", async () => {
    /**
     * The rule the whole codebook exists for. Checked cell by cell rather than
     * by sampling: one leaked value in a hundred thousand rows is one published
     * mean that is wrong.
     */
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);
    const { header, rows } = parseCsv(response.text as string);

    const statusAt = header.indexOf("response_status");
    const valueAt = header.indexOf("value");
    const labelAt = header.indexOf("value_label");

    for (const row of rows) {
      if (row[statusAt] === "ANSWERED") {
        expect(row[valueAt]).not.toBe("");
      } else {
        expect(row[valueAt]).toBe("");
        expect(row[labelAt]).toBe("");
        // Explicitly not a sentinel of any kind.
        expect(["0", "NA", "N/A", "null", "NULL", "-99", "999", " "]).not.toContain(row[valueAt]);
      }
    }
  });

  it("encodes a Likert answer as its numeric code with the anchor label", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);
    const { header, rows } = parseCsv(response.text as string);

    const keyAt = header.indexOf("question_key");
    const statusAt = header.indexOf("response_status");
    const valueAt = header.indexOf("value");
    const labelAt = header.indexOf("value_label");

    const answered = rows.find((r) => r[keyAt] === "mood_1" && r[statusAt] === "ANSWERED");
    expect(answered?.[valueAt]).toBe("5");
    expect(answered?.[labelAt]).toBe("Very good");
  });

  it("reconciles row for row with the sessions × questions it should cover", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);
    const { rows } = parseCsv(response.text as string);

    const expected = await one<{ count: string }>(
      `SELECT (count(*) * 2)::text AS count FROM research.participant_sessions
        WHERE study_id = '${studyId}'`,
    );

    // Two questions per session, and every session present — the cross join,
    // not an inner join that would silently drop unanswered items.
    expect(rows).toHaveLength(Number(expected.count));
  });

  it("exposes the public code and no other participant identifier", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);
    const body = response.text as string;

    expect(body).toContain("P-ZZZ999");
    for (const forbidden of ["email", "endpoint", "token_hash", "password"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("is served as a UTF-8 CSV attachment with a BOM", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);

    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("long.csv");
    // Without the BOM, Turkish characters open as mojibake in Excel.
    expect((response.text as string).charCodeAt(0)).toBe(0xfeff);
  });
});

describe("wide format", () => {
  it("names columns from the three stable keys, with a status beside each", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/wide.csv`).expect(200);
    const { header } = parseCsv(response.text as string);

    expect(header).toContain("baseline_0__mood_1");
    expect(header).toContain("baseline_0__mood_1__status");
    expect(header).toContain("daily_2__note");
    expect(header).toContain("daily_2__note__status");
  });

  it("gives two administrations of one instrument identical question suffixes", async () => {
    // FR-47: a pre/post comparison should be a direct column pair.
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/wide.csv`).expect(200);
    const { header } = parseCsv(response.text as string);

    expect(header).toContain("baseline_0__mood_1");
    expect(header).toContain("endline_0__mood_1");
  });

  it("emits one row per participant, with the leading columns", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/wide.csv`).expect(200);
    const { header, rows } = parseCsv(response.text as string);

    expect(rows).toHaveLength(1);
    expect(header.slice(0, 6)).toEqual([
      "participant_public_code",
      "enrolled_at",
      "participant_status",
      "elapsed_compliance",
      "strict_compliance",
      "participant_timezone",
    ]);
    expect(rows[0]?.[0]).toBe("P-ZZZ999");
  });

  it("never puts a value in a cell whose status is not ANSWERED", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/wide.csv`).expect(200);
    const { header, rows } = parseCsv(response.text as string);
    const row = rows[0] as string[];

    for (let i = 0; i < header.length; i += 1) {
      const name = header[i] as string;
      if (!name.endsWith("__status")) continue;

      const valueIndex = header.indexOf(name.replace(/__status$/, ""));
      if (row[i] !== "ANSWERED") expect(row[valueIndex]).toBe("");
    }
  });
});

describe("the codebook makes the files self-describing", () => {
  it("lists every question version used, in both locales", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/codebook.csv`).expect(200);
    const body = response.text as string;

    expect(body).toContain("mood_1");
    expect(body).toContain("How is your mood?");
    expect(body).toContain("Ruh haliniz nasıl?");
    expect(body).toContain("Very good");
    expect(body).toContain("Çok iyi");
  });

  it("carries the trailer defining all seven statuses", async () => {
    // An analyst who receives only the CSV files has nothing else to read.
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/codebook.csv`).expect(200);
    const body = response.text as string;

    for (const status of [
      "ANSWERED",
      "SKIPPED_OPTIONAL",
      "MISSED_ITEM_PARTIAL",
      "MISSED_SESSION",
      "IN_PROGRESS",
      "NOT_YET_DUE",
      "NOT_APPLICABLE",
    ]) {
      expect(body).toContain(status);
    }
  });

  it("records which step repeats another's instrument", async () => {
    /**
     * `repeats_step_key` is what makes a pre/post design machine-readable: a
     * script reads it and pairs the column groups without anyone hard-coding
     * step names (FR-47).
     */
    const { studyId, owner } = await everyMissingnessCase();

    const response = await owner.get(`/api/studies/${studyId}/exports/steps.csv`).expect(200);
    const { header, rows } = parseCsv(response.text as string);

    const stepAt = header.indexOf("step_key");
    const repeatsAt = header.indexOf("repeats_step_key");

    const endline = rows.find((r) => r[stepAt] === "endline");
    const baseline = rows.find((r) => r[stepAt] === "baseline");

    expect(baseline?.[repeatsAt]).toBe("");
    expect(endline?.[repeatsAt]).toBe("baseline");
  });
});

describe("§6 — export integrity controls", () => {
  it("writes an audit event with the format and the row count", async () => {
    const { studyId, owner } = await everyMissingnessCase();

    await owner.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);

    const events = await harness.db.execute<{ metadata: unknown }>(
      sql`SELECT metadata FROM research.audit_events WHERE action = 'export.run'`,
    );

    expect(events.rows).toHaveLength(1);
    const metadata = JSON.stringify(events.rows[0]?.metadata);
    expect(metadata).toContain("long");
    expect(metadata).toMatch(/rowCount/);
    // Scope and volume, never content.
    expect(metadata).not.toContain("mood");
  });

  it("rejects a VIEWER and does not produce a file", async () => {
    const { studyId } = await everyMissingnessCase();
    const viewer = await createUser(harness.db);
    await addMember(harness.db, studyId, viewer.id, "VIEWER");
    const client = await Client.login(harness.app, viewer);

    await client.get(`/api/studies/${studyId}/exports/long.csv`).expect(403);

    const events = await harness.db.execute(
      sql`SELECT id FROM research.audit_events WHERE action = 'export.run'`,
    );
    // No export happened, so no export was recorded. The refusal itself is
    // covered by the authorization matrix.
    expect(events.rows).toHaveLength(0);
  });

  it("allows an ANALYST", async () => {
    const { studyId } = await everyMissingnessCase();
    const analyst = await createUser(harness.db);
    await addMember(harness.db, studyId, analyst.id, "ANALYST");
    const client = await Client.login(harness.app, analyst);

    await client.get(`/api/studies/${studyId}/exports/long.csv`).expect(200);
  });
});
