import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@lpr/db";
import type { SessionStatus } from "@lpr/domain";
import type { InspectedAnswer, ResponseStatus, SessionInspectionResponse } from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ANALYTICS_DATABASE } from "../database/database.module.js";

/**
 * The longitudinal response inspector (PLAN.md Phase 10, `docs/export-codebook.md` §2).
 *
 * ── The one thing this must never do ────────────────────────────────────────
 * Emit a zero for an absent answer. `0` is a real value in every statistical
 * package, and no reader downstream can distinguish it from a genuine zero —
 * it is the single most damaging thing this system could produce, and AGENT.md
 * §17 lists it as a red flag for that reason.
 *
 * So `value` is `string | null`, never a number and never an empty string that
 * could be confused with a deliberately blank short-text answer. And the
 * absence always travels with a REASON: one of seven statuses saying which kind
 * of missing this is.
 *
 * ── Why all seven, and why they are distinct ────────────────────────────────
 * "They skipped an optional item", "they engaged but never reached this one",
 * "they never opened the session", "the window is still open", "the protocol
 * has not got there yet", and "this was never offered" are six different facts
 * about a participant. Collapsing any two of them loses information that cannot
 * be recovered later, and each supports a different analytic decision about
 * whether the value is missing at random.
 *
 * Runs on the analytics role: SELECT on `research`, nothing on `identity`.
 */
@Injectable()
export class InspectorService {
  constructor(@Inject(ANALYTICS_DATABASE) private readonly db: Database) {}

  async inspect(studyId: string, sessionId: string): Promise<SessionInspectionResponse> {
    const found = await this.db.execute<{
      id: string;
      status: string;
      occurrence_index: number;
      step_key: string;
      public_code: string;
      questionnaire_name: string;
      questionnaire_version_id: string;
    }>(sql`
      SELECT s.id, s.status, s.occurrence_index, ps.step_key, p.public_code,
             q.name AS questionnaire_name, s.questionnaire_version_id
        FROM research.participant_sessions s
        JOIN research.protocol_steps ps       ON ps.id = s.protocol_step_id
        JOIN research.participants p          ON p.id  = s.participant_id
        JOIN research.questionnaire_versions qv ON qv.id = s.questionnaire_version_id
        JOIN research.questionnaires q        ON q.id  = qv.questionnaire_id
       WHERE s.id = ${sessionId} AND s.study_id = ${studyId}
    `);
    const session = found.rows[0];
    if (session === undefined) throw ApiErrors.sessionNotFound();

    /**
     * Every question of the version the participant was SHOWN, left-joined to
     * their answers.
     *
     * A left join, not an inner one: the questions with no answer are precisely
     * the ones this screen exists to render. An inner join would silently
     * produce a shorter list, and a reader would have no way to know an item
     * was missing rather than absent from the instrument.
     *
     * The question TEXT comes from the version too, so the inspector shows the
     * wording that participant actually read — not today's wording after the
     * questionnaire was revised (FR-43, ADR-008).
     */
    const rows = await this.db.execute<{
      question_key: string;
      question_text: string | null;
      type: string;
      is_required: boolean;
      display_order: number;
      value_number: string | null;
      value_text: string | null;
      value_boolean: boolean | null;
      answered_at: Date | string | null;
      has_response: boolean;
      option_labels: string | null;
    }>(sql`
      SELECT qv.question_key,
             COALESCE(qt.text, '')            AS question_text,
             qv.type,
             qv.is_required,
             qv.display_order,
             r.value_number::text             AS value_number,
             r.value_text,
             r.value_boolean,
             r.answered_at,
             (r.id IS NOT NULL)               AS has_response,
             (
               SELECT string_agg(COALESCE(ot.label, qo.option_key), '; ' ORDER BY qo.display_order)
                 FROM research.response_option_selections sel
                 JOIN research.question_options qo ON qo.id = sel.question_option_id
                 LEFT JOIN research.question_option_translations ot
                        ON ot.question_option_id = qo.id AND ot.locale = ${"en"}
                WHERE sel.response_id = r.id
             )                                AS option_labels
        FROM research.question_versions qv
        LEFT JOIN research.question_version_translations qt
               ON qt.question_version_id = qv.id AND qt.locale = ${"en"}
        LEFT JOIN research.responses r
               ON r.question_version_id = qv.id AND r.session_id = ${sessionId}
       WHERE qv.questionnaire_version_id = ${session.questionnaire_version_id}
       ORDER BY qv.display_order
    `);

    const answers: InspectedAnswer[] = rows.rows.map((row) => {
      const value = readValue(row);
      const status = classifyAnswer(session.status as SessionStatus, row.has_response, value);

      return {
        questionKey: row.question_key,
        questionText: row.question_text ?? "",
        type: row.type,
        status,
        // Belt and braces on the rule that matters most: only `ANSWERED` ever
        // carries a value, whatever the row happened to contain.
        value: status === "ANSWERED" ? value : null,
        answeredAt: row.answered_at === null ? null : new Date(row.answered_at).toISOString(),
      };
    });

    return {
      sessionId: session.id,
      publicCode: session.public_code,
      stepKey: session.step_key,
      occurrenceIndex: session.occurrence_index,
      status: session.status as SessionStatus,
      questionnaireName: session.questionnaire_name,
      answers,
    };
  }
}

/**
 * The value as text, or null when there is genuinely nothing.
 *
 * An empty string is treated as nothing. `docs/export-codebook.md` §2 is
 * explicit that an intentionally blank short-text answer is `SKIPPED_OPTIONAL`
 * and not `ANSWERED` with an empty value — a blank cell next to "answered" is
 * indistinguishable from a bug.
 */
function readValue(row: {
  value_number: string | null;
  value_text: string | null;
  value_boolean: boolean | null;
  option_labels: string | null;
}): string | null {
  if (row.option_labels !== null && row.option_labels !== "") return row.option_labels;
  if (row.value_text !== null && row.value_text.trim() !== "") return row.value_text;
  if (row.value_number !== null) return row.value_number;
  if (row.value_boolean !== null) return row.value_boolean ? "true" : "false";
  return null;
}

/**
 * Which of the seven statuses applies (`docs/export-codebook.md` §2).
 *
 * The session's state decides first, because it is the stronger fact: a
 * question with no answer in a session nobody ever opened is `MISSED_SESSION`,
 * and calling it `SKIPPED_OPTIONAL` would claim the participant made a choice
 * they never had the chance to make.
 */
function classifyAnswer(
  sessionStatus: SessionStatus,
  hasResponse: boolean,
  value: string | null,
): ResponseStatus {
  switch (sessionStatus) {
    case "COMPLETED":
      // Inside a completed session, an absent answer IS a decision: the
      // participant submitted, and the completion transaction verified every
      // required question. What is missing here was optional.
      return hasResponse && value !== null ? "ANSWERED" : "SKIPPED_OPTIONAL";

    case "EXPIRED_PARTIAL":
      // They engaged with the session and never reached, or never answered,
      // this item. Different from never opening it at all, and the difference
      // matters to a missing-data analysis.
      return hasResponse && value !== null ? "ANSWERED" : "MISSED_ITEM_PARTIAL";

    case "EXPIRED_UNSTARTED":
      return "MISSED_SESSION";

    case "AVAILABLE":
    case "STARTED":
      // Not missing yet — the window is open and they still have time. Anything
      // already written is real data and is reported as such.
      return hasResponse && value !== null ? "ANSWERED" : "IN_PROGRESS";

    case "PENDING_TRIGGER":
    case "SCHEDULED":
      return "NOT_YET_DUE";

    case "CANCELLED":
      // Never offered. Most often a late enrollment into a fixed-date block.
      return "NOT_APPLICABLE";
  }
}
