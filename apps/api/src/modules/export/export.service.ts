import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database, Pool } from "@lpr/db";
import {
  LONG_COLUMNS,
  RESPONSE_STATUS_DEFINITIONS,
  RESPONSE_STATUSES,
  UTF8_BOM,
  classifyResponse,
  csvInstant,
  csvRow,
  encodeValue,
  valueFor,
  wideHeader,
  wideStatusColumn,
  wideValueColumn,
  compliancePercent,
  participantCompliance,
  type ComplianceSession,
  type SelectedOption,
  type SessionStatus,
} from "@lpr/domain";
import type { QuestionType } from "@lpr/contracts";
import { ANALYTICS_DATABASE, ANALYTICS_POOL } from "../database/database.module.js";

/**
 * Research-ready export (PLAN.md Phase 11, `docs/export-codebook.md`).
 *
 * ── Streamed, not assembled ─────────────────────────────────────────────────
 * Every format yields row by row from an async generator, driven by a database
 * CURSOR. A study on the reference protocol produces roughly a hundred thousand
 * long rows; building that in memory would work in development, hold ~80MB per
 * concurrent export in production, and fail on the first study that outgrew it
 * — at the moment a researcher most needs their data.
 *
 * PLAN.md sets the promotion threshold at ~500 000 rows, after which this
 * becomes a job producing a downloadable artefact. The generator interface is
 * what makes that a contained change rather than a rewrite.
 *
 * ── The analytics role, again ───────────────────────────────────────────────
 * Every query here runs on `app_analytics`: SELECT on `research`, nothing on
 * `identity`. §6.1 requires that exports contain `public_code` and no contact
 * detail, no endpoint, no credential — and requires it enforced by the database
 * role rather than by convention. An export query that reached for an email
 * address does not return one; it fails.
 */

/** Chunk size for the cursor. Large enough to amortise round trips, small
 * enough that one chunk is never a memory problem. */
const CURSOR_BATCH = 500;

export interface ExportScope {
  readonly studyId: string;
  /** Omitted means every participant. */
  readonly participantIds?: readonly string[];
}

export interface ExportResult {
  readonly rows: AsyncGenerator<string>;
  /** Resolved once the generator is exhausted; drives the audit row. */
  readonly rowCount: () => number;
}

interface LongRow {
  participant_public_code: string;
  study_id: string;
  protocol_version: number;
  step_key: string;
  step_index: number;
  occurrence_index: number;
  participant_session_id: string;
  session_status: string;
  questionnaire_key: string;
  questionnaire_version: number;
  question_key: string;
  question_version_id: string;
  question_type: string;
  question_text: string | null;
  value_kind: string | null;
  value_number: number | null;
  value_text: string | null;
  value_boolean: boolean | null;
  option_payload: string | null;
  answered_at: string | Date | null;
  scheduled_at: string | Date | null;
  available_from: string | Date | null;
  available_until: string | Date | null;
  completed_at: string | Date | null;
  participant_timezone: string | null;
  enrolled_at: string | Date;
  participant_status: string;
}

/**
 * One row per (participant, step, occurrence, question).
 *
 * A CROSS JOIN of every session against the questions of the version that
 * session administered, LEFT JOINed to the answers. The cross join is the
 * point: the rows with no answer are the ones the missingness contract exists
 * for, and an inner join would silently produce a shorter file in which absent
 * items are indistinguishable from items that were never asked.
 */
const LONG_SQL = `
  SELECT p.public_code                              AS participant_public_code,
         s.study_id::text                           AS study_id,
         pv.version_number                          AS protocol_version,
         ps.step_key,
         ps.step_index,
         s.occurrence_index,
         s.id::text                                 AS participant_session_id,
         s.status                                   AS session_status,
         q.name                                     AS questionnaire_key,
         qver.version_number                        AS questionnaire_version,
         qv.question_key,
         qv.id::text                                AS question_version_id,
         qv.type                                    AS question_type,
         qt.text                                    AS question_text,
         r.value_kind,
         r.value_number,
         r.value_text,
         r.value_boolean,
         (
           SELECT string_agg(
                    qo.option_key || E'\\x1f' || COALESCE(ot.label, qo.option_key)
                                  || E'\\x1f' || COALESCE(qo.value_number::text, '')
                                  || E'\\x1f' || qo.display_order::text,
                    E'\\x1e' ORDER BY qo.display_order)
             FROM research.response_option_selections sel
             JOIN research.question_options qo ON qo.id = sel.question_option_id
             LEFT JOIN research.question_option_translations ot
                    ON ot.question_option_id = qo.id AND ot.locale = p.locale
            WHERE sel.response_id = r.id
         )                                          AS option_payload,
         r.answered_at,
         s.scheduled_at,
         s.available_from,
         s.available_until,
         s.completed_at,
         p.timezone                                 AS participant_timezone,
         p.enrolled_at,
         p.status                                   AS participant_status
    FROM research.participant_sessions s
    JOIN research.participants p             ON p.id = s.participant_id
    JOIN research.protocol_steps ps          ON ps.id = s.protocol_step_id
    JOIN research.protocol_versions pv       ON pv.id = s.protocol_version_id
    JOIN research.questionnaire_versions qver ON qver.id = s.questionnaire_version_id
    JOIN research.questionnaires q           ON q.id = qver.questionnaire_id
    JOIN research.question_versions qv       ON qv.questionnaire_version_id = qver.id
    LEFT JOIN research.question_version_translations qt
           ON qt.question_version_id = qv.id AND qt.locale = p.locale
    LEFT JOIN research.responses r
           ON r.session_id = s.id AND r.question_version_id = qv.id
   WHERE s.study_id = $1
   ORDER BY p.public_code, ps.step_index, s.occurrence_index, qv.display_order`;

@Injectable()
export class ExportService {
  constructor(
    @Inject(ANALYTICS_DATABASE) private readonly db: Database,
    @Inject(ANALYTICS_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Long format — the primary format for repeated-measures analysis (§3).
   *
   * Authoritative. §4 is explicit that wide format degrades as a working format
   * long before it becomes invalid, and that long remains the format to reach
   * for with a long recurring block.
   */
  longFormat(scope: ExportScope): ExportResult {
    let count = 0;
    const pool = this.pool;

    async function* generate(): AsyncGenerator<string> {
      yield UTF8_BOM + csvRow([...LONG_COLUMNS]);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DECLARE export_long NO SCROLL CURSOR FOR ${LONG_SQL}`, [scope.studyId]);

        for (;;) {
          const chunk = await client.query<LongRow>(
            `FETCH ${String(CURSOR_BATCH)} FROM export_long`,
          );
          if (chunk.rows.length === 0) break;

          for (const row of chunk.rows) {
            count += 1;
            yield longRow(row);
          }
        }

        await client.query("CLOSE export_long");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    return { rows: generate(), rowCount: () => count };
  }

  /**
   * Wide format — one row per participant (§4).
   *
   * The header is derived from the protocol, not from the data: a participant
   * who was cancelled out of every occurrence still gets the full set of
   * columns, filled with `NOT_APPLICABLE`. Deriving it from the rows present
   * would give different files different shapes, which is the one thing a
   * repeated-measures analyst cannot work with.
   */
  async wideFormat(scope: ExportScope): Promise<ExportResult> {
    const layout = await this.protocolLayout(scope.studyId);
    const header = wideHeader(layout);

    let count = 0;
    const pool = this.pool;

    async function* generate(): AsyncGenerator<string> {
      yield UTF8_BOM + csvRow(header);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DECLARE export_wide NO SCROLL CURSOR FOR ${LONG_SQL}`, [scope.studyId]);

        /**
         * The long query, folded into one row per participant.
         *
         * It is ordered by `public_code`, so a participant's rows arrive
         * contiguously and only ONE participant is ever held in memory —
         * the wide file is pivoted without ever materialising the study.
         */
        let current: string | null = null;
        let cells = new Map<string, string>();
        let sessions: ComplianceSession[] = [];
        let meta: { enrolledAt: string; status: string; timezone: string } | null = null;

        const flush = (): string | null => {
          if (current === null || meta === null) return null;
          count += 1;
          return wideRow(header, current, meta, cells, sessions);
        };

        for (;;) {
          const chunk = await client.query<LongRow>(
            `FETCH ${String(CURSOR_BATCH)} FROM export_wide`,
          );
          if (chunk.rows.length === 0) break;

          for (const row of chunk.rows) {
            if (row.participant_public_code !== current) {
              const finished = flush();
              if (finished !== null) yield finished;
              current = row.participant_public_code;
              cells = new Map();
              sessions = [];
              meta = null;
            }

            meta ??= {
              enrolledAt: csvInstant(row.enrolled_at),
              status: row.participant_status,
              timezone: row.participant_timezone ?? "",
            };

            const key = {
              stepKey: row.step_key,
              occurrenceIndex: row.occurrence_index,
              questionKey: row.question_key,
            };
            const { status, value } = shape(row);
            cells.set(wideValueColumn(key), value);
            cells.set(wideStatusColumn(key), status);

            // One entry per SESSION, not per question row, or a
            // hundred-item baseline would count as a hundred sessions.
            const marker = `${row.step_key}#${String(row.occurrence_index)}`;
            if (!sessions.some((s) => s.stepKey === marker)) {
              sessions.push({
                stepKey: marker,
                status: row.session_status as SessionStatus,
                countsTowardCompliance: true,
              });
            }
          }
        }

        const last = flush();
        if (last !== null) yield last;

        await client.query("CLOSE export_wide");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    return { rows: generate(), rowCount: () => count };
  }

  /**
   * The codebook (§5), plus the fixed trailer defining all seven statuses.
   *
   * Emitted with every export so the dataset is self-describing and
   * reproducible without access to the platform. An analyst who receives only
   * the CSV files has nothing else to read, which is why the trailer is not
   * optional.
   */
  async codebook(scope: ExportScope): Promise<ExportResult> {
    const rows = await this.db.execute<{
      question_key: string;
      question_version_id: string;
      questionnaire_key: string;
      questionnaire_version: number;
      text_en: string | null;
      text_tr: string | null;
      question_type: string;
      is_required: boolean;
      option_key: string | null;
      option_label_en: string | null;
      option_label_tr: string | null;
      option_value: number | null;
      first_seen_at: string | Date | null;
      last_seen_at: string | Date | null;
    }>(sql`
      SELECT qv.question_key,
             qv.id::text AS question_version_id,
             q.name      AS questionnaire_key,
             qver.version_number AS questionnaire_version,
             (SELECT text FROM research.question_version_translations
               WHERE question_version_id = qv.id AND locale = 'en') AS text_en,
             (SELECT text FROM research.question_version_translations
               WHERE question_version_id = qv.id AND locale = 'tr') AS text_tr,
             qv.type AS question_type,
             qv.is_required,
             qo.option_key,
             (SELECT label FROM research.question_option_translations
               WHERE question_option_id = qo.id AND locale = 'en') AS option_label_en,
             (SELECT label FROM research.question_option_translations
               WHERE question_option_id = qo.id AND locale = 'tr') AS option_label_tr,
             qo.value_number AS option_value,
             (SELECT min(r.answered_at) FROM research.responses r
               WHERE r.question_version_id = qv.id) AS first_seen_at,
             (SELECT max(r.answered_at) FROM research.responses r
               WHERE r.question_version_id = qv.id) AS last_seen_at
        FROM research.question_versions qv
        JOIN research.questionnaire_versions qver ON qver.id = qv.questionnaire_version_id
        JOIN research.questionnaires q ON q.id = qver.questionnaire_id
        LEFT JOIN research.question_options qo ON qo.question_version_id = qv.id
       WHERE q.study_id = ${scope.studyId}
         AND EXISTS (
           SELECT 1 FROM research.participant_sessions s
            WHERE s.questionnaire_version_id = qver.id AND s.study_id = ${scope.studyId}
         )
       ORDER BY q.name, qver.version_number, qv.display_order, qo.display_order
    `);

    let count = 0;
    async function* generate(): AsyncGenerator<string> {
      yield UTF8_BOM +
        csvRow([
          "question_key",
          "question_version_id",
          "questionnaire_key",
          "questionnaire_version",
          "question_text_en",
          "question_text_tr",
          "question_type",
          "is_required",
          "option_key",
          "option_label_en",
          "option_label_tr",
          "option_value",
          "first_seen_at",
          "last_seen_at",
        ]);

      for (const row of rows.rows) {
        count += 1;
        yield csvRow([
          row.question_key,
          row.question_version_id,
          row.questionnaire_key,
          row.questionnaire_version,
          row.text_en ?? "",
          row.text_tr ?? "",
          row.question_type,
          row.is_required ? "true" : "false",
          row.option_key ?? "",
          row.option_label_en ?? "",
          row.option_label_tr ?? "",
          row.option_value ?? "",
          csvInstant(row.first_seen_at),
          csvInstant(row.last_seen_at),
        ]);
      }

      // The trailer. Without it a recipient holding only these files has no way
      // to interpret an empty cell, which is the whole point of the export.
      yield csvRow([]);
      yield csvRow(["response_status", "meaning"]);
      for (const status of RESPONSE_STATUSES) {
        yield csvRow([status, RESPONSE_STATUS_DEFINITIONS[status]]);
      }
    }

    return { rows: generate(), rowCount: () => count };
  }

  /**
   * `steps.csv` (§5) — the design, reconstructible from the files alone.
   *
   * `repeats_step_key` is what makes a pre/post design MACHINE-readable: a
   * script reads `endline → repeats_step_key = baseline` and pairs the two
   * column groups without anyone hard-coding step names or trusting that two
   * similarly-named columns measure the same thing (FR-47).
   */
  async steps(scope: ExportScope): Promise<ExportResult> {
    const rows = await this.db.execute<{
      step_key: string;
      step_index: number;
      questionnaire_key: string;
      questionnaire_version: number;
      questionnaire_version_id: string;
      occurrence_count: number;
      trigger_type: string;
      offset_iso: string;
      window_duration_iso: string;
      counts_toward_compliance: boolean;
    }>(sql`
      SELECT ps.step_key, ps.step_index, q.name AS questionnaire_key,
             qver.version_number AS questionnaire_version,
             qver.id::text AS questionnaire_version_id,
             ps.occurrence_count, ps.trigger_type, ps.offset_iso,
             ps.window_duration_iso, ps.counts_toward_compliance
        FROM research.protocol_steps ps
        JOIN research.protocol_versions pv ON pv.id = ps.protocol_version_id
        JOIN research.protocols p ON p.id = pv.protocol_id
        JOIN research.questionnaire_versions qver ON qver.id = ps.questionnaire_version_id
        JOIN research.questionnaires q ON q.id = qver.questionnaire_id
       WHERE p.study_id = ${scope.studyId} AND pv.status = 'PUBLISHED'
       ORDER BY pv.version_number DESC, ps.step_index
    `);

    // The first step to administer a given questionnaire version is the
    // original; every later one repeats it.
    const firstUse = new Map<string, string>();
    const repeats = new Map<string, string>();
    for (const row of rows.rows) {
      const seen = firstUse.get(row.questionnaire_version_id);
      if (seen === undefined) firstUse.set(row.questionnaire_version_id, row.step_key);
      else repeats.set(row.step_key, seen);
    }

    let count = 0;
    async function* generate(): AsyncGenerator<string> {
      yield UTF8_BOM +
        csvRow([
          "step_key",
          "step_index",
          "questionnaire_key",
          "questionnaire_version",
          "occurrence_count",
          "trigger_description",
          "window_duration_iso",
          "counts_toward_compliance",
          "repeats_step_key",
        ]);

      for (const row of rows.rows) {
        count += 1;
        yield csvRow([
          row.step_key,
          row.step_index,
          row.questionnaire_key,
          row.questionnaire_version,
          row.occurrence_count,
          `${row.trigger_type.toLowerCase()} + ${row.offset_iso}`,
          row.window_duration_iso,
          row.counts_toward_compliance ? "true" : "false",
          repeats.get(row.step_key) ?? "",
        ]);
      }
    }

    return { rows: generate(), rowCount: () => count };
  }

  /** The published protocol's shape, for the wide header. */
  private async protocolLayout(studyId: string): Promise<
    {
      stepKey: string;
      stepIndex: number;
      occurrenceCount: number;
      questions: { questionKey: string; displayOrder: number }[];
    }[]
  > {
    const rows = await this.db.execute<{
      step_key: string;
      step_index: number;
      occurrence_count: number;
      question_key: string;
      display_order: number;
    }>(sql`
      SELECT ps.step_key, ps.step_index, ps.occurrence_count,
             qv.question_key, qv.display_order
        FROM research.protocol_steps ps
        JOIN research.protocol_versions pv ON pv.id = ps.protocol_version_id
        JOIN research.protocols p ON p.id = pv.protocol_id
        JOIN research.question_versions qv
             ON qv.questionnaire_version_id = ps.questionnaire_version_id
       WHERE p.study_id = ${studyId} AND pv.status = 'PUBLISHED'
       ORDER BY ps.step_index, qv.display_order
    `);

    const byStep = new Map<
      string,
      {
        stepKey: string;
        stepIndex: number;
        occurrenceCount: number;
        questions: { questionKey: string; displayOrder: number }[];
      }
    >();

    for (const row of rows.rows) {
      const existing = byStep.get(row.step_key) ?? {
        stepKey: row.step_key,
        stepIndex: row.step_index,
        occurrenceCount: row.occurrence_count,
        questions: [],
      };
      if (!existing.questions.some((q) => q.questionKey === row.question_key)) {
        existing.questions.push({
          questionKey: row.question_key,
          displayOrder: row.display_order,
        });
      }
      byStep.set(row.step_key, existing);
    }

    return [...byStep.values()];
  }
}

/** Decode the packed option payload back into the domain's shape. */
function readOptions(payload: string | null): SelectedOption[] {
  if (payload === null || payload === "") return [];
  return payload.split("").map((entry) => {
    const [optionKey = "", label = "", valueNumber = "", displayOrder = "0"] = entry.split("");
    return {
      optionKey,
      label,
      valueNumber: valueNumber === "" ? null : Number(valueNumber),
      displayOrder: Number(displayOrder),
    };
  });
}

/** The status and value for one cell, from the shared domain rules. */
function shape(row: LongRow): { status: string; value: string; label: string } {
  const encoded =
    row.value_kind === null
      ? { value: "", label: "", hasValue: false }
      : encodeValue(row.question_type as QuestionType, {
          valueKind: row.value_kind as "NUMBER" | "TEXT" | "OPTION" | "BOOLEAN",
          valueNumber: row.value_number,
          valueText: row.value_text,
          valueBoolean: row.value_boolean,
          options: readOptions(row.option_payload),
        });

  const status = classifyResponse(row.session_status as SessionStatus, encoded.hasValue);

  return {
    status,
    // The guard, applied at the only place a value cell is produced.
    value: valueFor(status, encoded.value),
    label: valueFor(status, encoded.label),
  };
}

function longRow(row: LongRow): string {
  const { status, value, label } = shape(row);

  return csvRow([
    row.participant_public_code,
    row.study_id,
    row.protocol_version,
    row.step_key,
    row.step_index,
    row.occurrence_index,
    row.participant_session_id,
    row.session_status,
    row.questionnaire_key,
    row.questionnaire_version,
    row.question_key,
    row.question_version_id,
    row.question_type,
    row.question_text ?? "",
    status,
    value,
    label,
    csvInstant(row.answered_at),
    csvInstant(row.scheduled_at),
    csvInstant(row.available_from),
    csvInstant(row.available_until),
    csvInstant(row.completed_at),
    row.participant_timezone ?? "",
  ]);
}

function wideRow(
  header: readonly string[],
  publicCode: string,
  meta: { enrolledAt: string; status: string; timezone: string },
  cells: Map<string, string>,
  sessions: readonly ComplianceSession[],
): string {
  const compliance = participantCompliance(sessions, []);

  return csvRow(
    header.map((column) => {
      switch (column) {
        case "participant_public_code":
          return publicCode;
        case "enrolled_at":
          return meta.enrolledAt;
        case "participant_status":
          return meta.status;
        case "elapsed_compliance": {
          const percent = compliancePercent(compliance.elapsed);
          // Empty, never 0, when nothing has come due — the §5 rule of the
          // compliance contract, carried into the export.
          return percent === null ? "" : String(percent);
        }
        case "strict_compliance": {
          const percent = compliancePercent(compliance.strict);
          return percent === null ? "" : String(percent);
        }
        case "participant_timezone":
          return meta.timezone;
        default:
          /**
           * A column the protocol defines but this participant has no row for
           * — they were cancelled out of the occurrence, or the step was added
           * after they enrolled. `NOT_APPLICABLE` on the status column and an
           * empty value, never a blank pair that could read as an unanswered
           * question they were actually asked.
           */
          if (column.endsWith("__status")) return cells.get(column) ?? "NOT_APPLICABLE";
          return cells.get(column) ?? "";
      }
    }),
  );
}
