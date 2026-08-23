/**
 * Wide-format column naming (`docs/export-codebook.md` §4, FR-43, FR-47).
 *
 * ── Why the name is built from these three keys and nothing else ────────────
 * `step_key`, `occurrence_index`, `question_key` are all stable across
 * versions. Publishing a new questionnaire version that rewords a question
 * therefore does not change a single column name, and an analyst's script from
 * last month still runs. Question TEXT and version ids deliberately appear
 * nowhere in a column name: both change, and a column name that changes is a
 * broken join in somebody's analysis.
 *
 * ── Why every value column is paired with a status column ───────────────────
 * §4 calls the doubling deliberate. A wide file without status columns forces
 * the analyst straight back into §2's ambiguity — an empty cell that could mean
 * six different things — which defeats the entire purpose of the export.
 *
 * ── One instrument, two administrations (FR-47) ─────────────────────────────
 * A protocol that administers the same questionnaire version at two steps
 * produces two column groups with IDENTICAL `question_key` suffixes:
 *
 *     baseline_0__mood_1   endline_0__mood_1
 *
 * That is the intended layout, not a collision: a pre/post comparison becomes a
 * direct column pair with no key reconciliation. Which groups are the same
 * instrument is stated in the codebook's steps section rather than left to be
 * inferred from the naming.
 */

/** Separates the step/occurrence prefix from the question key. */
const GROUP_SEPARATOR = "__";

/** Marks the status companion of a value column. */
const STATUS_SUFFIX = "__status";

export interface WideColumnKey {
  readonly stepKey: string;
  readonly occurrenceIndex: number;
  readonly questionKey: string;
}

export function wideValueColumn(key: WideColumnKey): string {
  return `${key.stepKey}_${String(key.occurrenceIndex)}${GROUP_SEPARATOR}${key.questionKey}`;
}

export function wideStatusColumn(key: WideColumnKey): string {
  return `${wideValueColumn(key)}${STATUS_SUFFIX}`;
}

/**
 * The leading columns of every wide row (§4).
 *
 * Compliance is included because the question an analyst asks first is "who do
 * I keep?", and answering it should not require joining a second file. Both
 * figures are strings rather than numbers so that the not-applicable case can
 * be empty — never `0`, which would claim a participant with nothing due had
 * taken no opportunities (`docs/compliance-formula.md` §5).
 */
export const WIDE_LEADING_COLUMNS = [
  "participant_public_code",
  "enrolled_at",
  "participant_status",
  "elapsed_compliance",
  "strict_compliance",
  "participant_timezone",
] as const;

/** The long-format header, in the order §3 specifies. */
export const LONG_COLUMNS = [
  "participant_public_code",
  "study_id",
  "protocol_version",
  "step_key",
  "step_index",
  "occurrence_index",
  "participant_session_id",
  "session_status",
  "questionnaire_key",
  "questionnaire_version",
  "question_key",
  "question_version_id",
  "question_type",
  "question_text",
  "response_status",
  "value",
  "value_label",
  "answered_at",
  "scheduled_at",
  "available_from",
  "available_until",
  "completed_at",
  "participant_timezone",
] as const;

/**
 * Build the full ordered wide header for a protocol.
 *
 * Ordered by step, then occurrence, then the question's display order — so the
 * file reads in the sequence the participant experienced it, and a thirty-day
 * block appears as thirty consecutive groups rather than interleaved.
 */
export function wideHeader(
  steps: readonly {
    stepKey: string;
    stepIndex: number;
    occurrenceCount: number;
    questions: readonly { questionKey: string; displayOrder: number }[];
  }[],
): string[] {
  const columns: string[] = [...WIDE_LEADING_COLUMNS];

  for (const step of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    for (let occurrence = 0; occurrence < step.occurrenceCount; occurrence += 1) {
      for (const question of [...step.questions].sort((a, b) => a.displayOrder - b.displayOrder)) {
        const key = {
          stepKey: step.stepKey,
          occurrenceIndex: occurrence,
          questionKey: question.questionKey,
        };
        // Value then status, adjacent. An analyst reading the header sees the
        // pairing immediately; separating them into two blocks would make the
        // status columns look like an afterthought and invite ignoring them.
        columns.push(wideValueColumn(key), wideStatusColumn(key));
      }
    }
  }

  return columns;
}
