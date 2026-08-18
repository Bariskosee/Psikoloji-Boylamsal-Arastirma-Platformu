import { STUDY_STATUSES, type StudyStatus } from "@lpr/contracts";

/**
 * Study lifecycle transitions (STRUCTURE.md §5).
 *
 * ```text
 *   DRAFT ──▶ ACTIVE ⇄ PAUSED
 *     │          │        │
 *     │          └────────┴──▶ CLOSED ──▶ ARCHIVED
 *     └───────────────────────────────────▶ ARCHIVED
 * ```
 *
 * Pure and total: every (from, to) pair has a defined answer, so the
 * transition table can be asserted exhaustively rather than sampled.
 */

/** Terminal state. Nothing leaves it. */
export const TERMINAL_STUDY_STATUSES: readonly StudyStatus[] = ["ARCHIVED"];

const ALLOWED_TRANSITIONS: Readonly<Record<StudyStatus, readonly StudyStatus[]>> = {
  // A draft has no participants yet, so it may be launched or abandoned.
  DRAFT: ["ACTIVE", "ARCHIVED"],

  // Pausing suspends new enrollment and notification sending; it does not
  // cancel materialised sessions, so it is reversible without data loss.
  ACTIVE: ["PAUSED", "CLOSED"],
  PAUSED: ["ACTIVE", "CLOSED"],

  // CLOSED is one-way. Data collection has ended: open sessions were
  // cancelled and reminders stopped. Re-activating would resume a schedule
  // whose windows have since passed, producing sessions that expire the
  // instant they appear and a compliance denominator that no longer matches
  // what participants were actually asked to do.
  CLOSED: ["ARCHIVED"],

  ARCHIVED: [],
};

export interface StudyTransitionResult {
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  reason?: "SAME_STATUS" | "TERMINAL_STATUS" | "TRANSITION_NOT_ALLOWED";
}

export function canTransitionStudy(from: StudyStatus, to: StudyStatus): StudyTransitionResult {
  if (from === to) return { ok: false, reason: "SAME_STATUS" };
  if (TERMINAL_STUDY_STATUSES.includes(from)) return { ok: false, reason: "TERMINAL_STATUS" };
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: "TRANSITION_NOT_ALLOWED" };
  }
  return { ok: true };
}

/** Every legal next status from `from`, for rendering the available actions. */
export function nextStudyStatuses(from: StudyStatus): readonly StudyStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/**
 * May participants enroll right now?
 *
 * Only an ACTIVE study accepts enrollment. A DRAFT is not yet real, a PAUSED
 * study has deliberately stopped intake, and CLOSED/ARCHIVED have finished.
 * Capacity (FR-42) is a separate check made against the live participant count.
 */
export function acceptsEnrollment(status: StudyStatus): boolean {
  return status === "ACTIVE";
}

/**
 * May a study's configuration still be edited?
 *
 * Editing metadata after closure would silently rewrite the description of a
 * dataset that has already been analysed under the old one.
 */
export function acceptsConfigurationChanges(status: StudyStatus): boolean {
  return status === "DRAFT" || status === "ACTIVE" || status === "PAUSED";
}

/** All statuses, for exhaustive iteration in tests and UI. */
export const ALL_STUDY_STATUSES: readonly StudyStatus[] = STUDY_STATUSES;
