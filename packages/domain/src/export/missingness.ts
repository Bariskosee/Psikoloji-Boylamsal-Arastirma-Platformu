import type { SessionStatus } from "../session/state-machine.js";

/**
 * The missingness contract (`docs/export-codebook.md` §2, FR-43, AGENT.md §17).
 *
 * ── Why this is the most important file in the export ───────────────────────
 * §1 of the codebook opens by naming the worst thing this platform can do, and
 * it is not a crash: it is exporting a missing value as `0`, having it averaged
 * into a mean, and having that mean published. `0` is a real number in every
 * statistical package and no reader downstream can tell it from one a
 * participant typed.
 *
 * A blank cell in a longitudinal dataset means at least six different things,
 * and they are not interchangeable in any missing-data analysis. "Missed the
 * whole session" and "skipped one optional item" call for entirely different
 * handling. So the rule is absolute: **`value` carries data only when
 * `response_status = ANSWERED`**, and in every other case the status carries
 * the reason.
 *
 * ── Why it lives here rather than beside a query ────────────────────────────
 * Three places need this answer — the response inspector, the long export, and
 * the wide export — and they must never disagree. A researcher who reads a cell
 * as `SKIPPED_OPTIONAL` on screen and `MISSED_ITEM_PARTIAL` in the CSV has been
 * told two incompatible things about one participant, and has no way to know
 * which is true.
 */

export const RESPONSE_STATUSES = [
  "ANSWERED",
  "SKIPPED_OPTIONAL",
  "MISSED_ITEM_PARTIAL",
  "MISSED_SESSION",
  "IN_PROGRESS",
  "NOT_YET_DUE",
  "NOT_APPLICABLE",
] as const;

export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/**
 * Which status applies to one (session, question) cell.
 *
 * The SESSION's state decides first, because it is the stronger fact. A
 * question with no answer inside a session nobody ever opened is
 * `MISSED_SESSION`; calling it `SKIPPED_OPTIONAL` would claim the participant
 * made a choice they never had the chance to make.
 *
 * `hasValue` rather than "a response row exists": an intentionally blank
 * short-text answer is `SKIPPED_OPTIONAL`, not `ANSWERED` with an empty value
 * (§2). A blank cell next to "answered" is indistinguishable from a bug, and
 * the codebook explicitly makes that combination an export-validation failure.
 */
export function classifyResponse(sessionStatus: SessionStatus, hasValue: boolean): ResponseStatus {
  switch (sessionStatus) {
    case "COMPLETED":
      // Inside a completed session an absent answer IS a decision: the
      // participant submitted, and the completion transaction had already
      // verified every required question. What is missing here was optional.
      return hasValue ? "ANSWERED" : "SKIPPED_OPTIONAL";

    case "EXPIRED_PARTIAL":
      // They engaged and never reached, or never answered, this item.
      // Different from never opening the session, and the difference is what a
      // missing-at-random judgement turns on.
      return hasValue ? "ANSWERED" : "MISSED_ITEM_PARTIAL";

    case "EXPIRED_UNSTARTED":
      // Never opened at all. Any value here would be a data defect, so the
      // status does not consult `hasValue` — there is nothing it could mean.
      return "MISSED_SESSION";

    case "AVAILABLE":
    case "STARTED":
      // Not missing yet: the window is open and they still have time. Anything
      // already written is real data and is reported as such.
      return hasValue ? "ANSWERED" : "IN_PROGRESS";

    case "PENDING_TRIGGER":
    case "SCHEDULED":
      return "NOT_YET_DUE";

    case "CANCELLED":
      // Never offered — most often a late enrollment into a fixed-date block,
      // or a withdrawal. Not a failure of the participant's.
      return "NOT_APPLICABLE";
  }
}

/**
 * May a value be emitted for this status?
 *
 * The guard behind the rule, expressed so a caller cannot forget it. Every
 * writer of a `value` cell passes through here, and the six non-`ANSWERED`
 * statuses get an empty string — never `0`, never `NA`, never `-99`, never a
 * whitespace string that could pass for a short-text answer (§2, "prohibited
 * representations").
 */
export function valueFor(status: ResponseStatus, value: string | null): string {
  return status === "ANSWERED" && value !== null ? value : "";
}

/** The plain-language definitions the codebook's trailer section carries (§5). */
export const RESPONSE_STATUS_DEFINITIONS: Readonly<Record<ResponseStatus, string>> = Object.freeze({
  ANSWERED: "Real data. The participant answered this item.",
  SKIPPED_OPTIONAL:
    "Deliberate non-response to an optional item in a session the participant completed.",
  MISSED_ITEM_PARTIAL:
    "The participant engaged with the session but never reached or answered this item, and the window then closed.",
  MISSED_SESSION: "The participant never opened this session at all before the window closed.",
  IN_PROGRESS: "The response window was open at export time. Not yet missing.",
  NOT_YET_DUE: "The protocol had not reached this point for this participant.",
  NOT_APPLICABLE:
    "This measurement was never offered — cancelled by a late enrollment or by withdrawal.",
});
