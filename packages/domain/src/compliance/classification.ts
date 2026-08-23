import type { SessionStatus } from "../session/state-machine.js";

/**
 * Session classification (`docs/compliance-formula.md` §2).
 *
 * Every ParticipantSession falls into exactly one bucket, and the bucket
 * decides which terms of a compliance ratio it joins. This table is the whole
 * of §2, transcribed once, and **nothing anywhere else may re-derive it** — a
 * compliance percentage published in a paper has to be reproducible, and a
 * second copy of this mapping in a dashboard component is how two numbers that
 * should be identical stop being so.
 *
 * ── Why `CANCELLED` leaves both terms ───────────────────────────────────────
 * A cancelled session was never offered to the participant. The commonest cause
 * is `ENROLLED_AFTER_WINDOW` — someone joining a fixed-date block after some of
 * its occurrences had already closed (STRUCTURE.md §8.2). Charging those as
 * missed would make compliance depend on enrollment date rather than on
 * behaviour, and would penalise a participant hardest for joining late through
 * no fault of their own.
 *
 * ── Why open windows leave both terms ───────────────────────────────────────
 * The participant still has time. Counting them would make every score dip the
 * moment a window opened and recover when it was answered, producing a metric
 * that oscillates for reasons that have nothing to do with the person.
 */

export type ComplianceBucket =
  /** `PENDING_TRIGGER`, `SCHEDULED` — the protocol has not reached this yet. */
  | "NOT_YET_DUE"
  /** `AVAILABLE`, `STARTED` — the participant still has time. */
  | "OPEN"
  /** `COMPLETED` — due, and met. */
  | "MET"
  /** `EXPIRED_UNSTARTED`, `EXPIRED_PARTIAL` — due, and missed. */
  | "MISSED"
  /** `CANCELLED` — never offered; excluded from every figure. */
  | "EXCLUDED";

const BUCKETS: Readonly<Record<SessionStatus, ComplianceBucket>> = Object.freeze({
  PENDING_TRIGGER: "NOT_YET_DUE",
  SCHEDULED: "NOT_YET_DUE",
  AVAILABLE: "OPEN",
  STARTED: "OPEN",
  COMPLETED: "MET",
  EXPIRED_UNSTARTED: "MISSED",
  EXPIRED_PARTIAL: "MISSED",
  CANCELLED: "EXCLUDED",
});

export function classifySession(status: SessionStatus): ComplianceBucket {
  return BUCKETS[status];
}

/**
 * One session, reduced to the three facts a compliance figure depends on.
 *
 * `countsTowardCompliance` comes from the protocol step, not the session. A
 * researcher marking an optional exit interview as excluded means it never
 * affects either term however the participant behaves (§2, worked example D) —
 * while still appearing in their timeline and their export, because it did
 * happen.
 */
export interface ComplianceSession {
  readonly stepKey: string;
  readonly status: SessionStatus;
  readonly countsTowardCompliance: boolean;
}
