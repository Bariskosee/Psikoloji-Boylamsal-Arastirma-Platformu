/**
 * The ParticipantSession state machine (STRUCTURE.md §7).
 *
 * Every transition a session can make, and the guard on each. Pure: it decides
 * from a status, a clock reading passed in, and counts — never from a
 * client-supplied timestamp, which is the one input that could let a
 * participant extend their own window.
 *
 * The forbidden transitions matter as much as the permitted ones, and are
 * tested as such: nothing leaves a terminal state, nothing goes backwards, and
 * `SCHEDULED` never reaches `COMPLETED` without passing through the states
 * that prove the window was open when the answers were given.
 */

export const SESSION_STATUSES = [
  "PENDING_TRIGGER",
  "SCHEDULED",
  "AVAILABLE",
  "STARTED",
  "COMPLETED",
  "EXPIRED_UNSTARTED",
  "EXPIRED_PARTIAL",
  "CANCELLED",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Nothing leaves these. */
export const TERMINAL_SESSION_STATUSES = [
  "COMPLETED",
  "EXPIRED_UNSTARTED",
  "EXPIRED_PARTIAL",
  "CANCELLED",
] as const;

export function isTerminal(status: SessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly SessionStatus[]).includes(status);
}

/** The two states in which a participant may write an answer. */
export function acceptsAnswers(status: SessionStatus): boolean {
  return status === "AVAILABLE" || status === "STARTED";
}

export type WriteRefusal =
  "NOT_YET_AVAILABLE" | "WINDOW_CLOSED" | "ALREADY_COMPLETED" | "CANCELLED" | "EXPIRED";

export type WriteVerdict =
  | { readonly allowed: true; readonly transitionTo: "STARTED" | null }
  | { readonly allowed: false; readonly reason: WriteRefusal };

export interface SessionWindow {
  readonly status: SessionStatus;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
}

/**
 * May the participant write to this session right now?
 *
 * `now` is the SERVER's clock, always. A window check against a
 * client-supplied instant is the difference between a response window and a
 * suggestion — a participant whose device clock is wrong, or who sets it
 * deliberately, must get the same answer as everyone else.
 *
 * The status is re-derived from the stored window rather than trusted, because
 * a session can sit in `AVAILABLE` past its expiry until a sweeper reaches it
 * (ADR-005). Refusing on the timestamps rather than on the label means a
 * late sweep delays the bookkeeping, never the correctness.
 */
export function canWriteAnswer(session: SessionWindow, now: Date): WriteVerdict {
  switch (session.status) {
    case "COMPLETED":
      return { allowed: false, reason: "ALREADY_COMPLETED" };
    case "CANCELLED":
      return { allowed: false, reason: "CANCELLED" };
    case "EXPIRED_UNSTARTED":
    case "EXPIRED_PARTIAL":
      return { allowed: false, reason: "EXPIRED" };
    case "PENDING_TRIGGER":
    case "SCHEDULED":
      return { allowed: false, reason: "NOT_YET_AVAILABLE" };
    case "AVAILABLE":
    case "STARTED":
      break;
  }

  if (session.availableFrom !== null && now.getTime() < session.availableFrom.getTime()) {
    return { allowed: false, reason: "NOT_YET_AVAILABLE" };
  }
  if (session.availableUntil !== null && now.getTime() >= session.availableUntil.getTime()) {
    return { allowed: false, reason: "WINDOW_CLOSED" };
  }

  // The first accepted answer is what moves a session to STARTED — the state
  // exists to distinguish "offered and ignored" from "opened and abandoned",
  // which are different data points in the compliance denominator (FR-44).
  return { allowed: true, transitionTo: session.status === "AVAILABLE" ? "STARTED" : null };
}

export type CompletionRefusal = WriteRefusal | "NOT_STARTED" | "REQUIRED_UNANSWERED";

export type CompletionVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: CompletionRefusal;
      readonly missing?: readonly string[];
    };

/**
 * May this session be completed?
 *
 * Required-question validation is here, in the domain, because it is the same
 * computation the client runs for its own convenience and the server runs as
 * the authority. A client that skips it must reach exactly this answer.
 */
export function canComplete(
  session: SessionWindow,
  now: Date,
  requiredQuestionKeys: readonly string[],
  answeredQuestionKeys: readonly string[],
): CompletionVerdict {
  const write = canWriteAnswer(session, now);
  if (!write.allowed) return { allowed: false, reason: write.reason };

  const answered = new Set(answeredQuestionKeys);
  const missing = requiredQuestionKeys.filter((key) => !answered.has(key));
  if (missing.length > 0) return { allowed: false, reason: "REQUIRED_UNANSWERED", missing };

  return { allowed: true };
}

/**
 * What an expiry sweep should do with a session (STRUCTURE.md §8.4).
 *
 * The distinction is the whole reason two expired states exist: a session
 * nobody opened and a session someone started and abandoned mean different
 * things about the participant, and collapsing them would hide the difference
 * in every compliance figure afterwards.
 */
export function expiryOutcome(
  status: SessionStatus,
  responseCount: number,
): "EXPIRED_UNSTARTED" | "EXPIRED_PARTIAL" | null {
  if (status !== "AVAILABLE" && status !== "STARTED") return null;
  return responseCount > 0 ? "EXPIRED_PARTIAL" : "EXPIRED_UNSTARTED";
}
