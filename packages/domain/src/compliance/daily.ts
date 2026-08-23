import type { SessionStatus } from "../session/state-machine.js";

/**
 * The daily compliance view (`docs/compliance-formula.md` §8, FR-28).
 *
 * The four questions a researcher asks each morning: how many windows closed
 * yesterday, how many were answered, how many were opened and abandoned, and
 * how many are open right now.
 *
 * ── Why this is a breakdown and not four counts ─────────────────────────────
 * §8 defines the categories in a way that OVERLAPS by construction: a session
 * that expired unstarted is both "not started" and "missed". Rendered as four
 * independent numbers they appear to double-count, and a reader who adds them
 * up gets a total larger than the number of sessions — which destroys trust in
 * every other number on the page.
 *
 * So the shape here is the canonical presentation §8 prescribes: two groups,
 * each of whose parts sum exactly to its total. `closed = completed +
 * missedUnstarted + missedPartial` and `open = notStarted + inProgress`, and
 * there is a test asserting both.
 *
 * Pure: the caller decides which sessions overlapped the date, in the study's
 * timezone. Date arithmetic belongs at the query, where the timezone is known;
 * classification belongs here, where it can be tested exhaustively.
 */

export interface DailySessionInput {
  readonly status: SessionStatus;
  /** True when this session's window CLOSED on the date being reported. */
  readonly windowClosedOnDate: boolean;
  /** True when the participant had written at least one response. */
  readonly hasResponses: boolean;
}

export interface DailyBreakdown {
  /** Windows that closed on this date. */
  readonly closed: number;
  readonly completed: number;
  readonly missedUnstarted: number;
  readonly missedPartial: number;

  /** Windows still open right now. */
  readonly open: number;
  readonly notStarted: number;
  readonly inProgress: number;
}

export function summariseDay(sessions: readonly DailySessionInput[]): DailyBreakdown {
  let completed = 0;
  let missedUnstarted = 0;
  let missedPartial = 0;
  let notStarted = 0;
  let inProgress = 0;

  for (const session of sessions) {
    switch (session.status) {
      case "COMPLETED":
        // Counted against the date its window closed, not the date it was
        // completed on: otherwise a session answered just after midnight would
        // vanish from the day it belonged to and reappear in a day that had no
        // window at all.
        if (session.windowClosedOnDate) completed += 1;
        break;

      case "EXPIRED_UNSTARTED":
        if (session.windowClosedOnDate) missedUnstarted += 1;
        break;

      case "EXPIRED_PARTIAL":
        if (session.windowClosedOnDate) missedPartial += 1;
        break;

      case "AVAILABLE":
      case "STARTED":
        /**
         * Open now. Split on whether anything was written rather than on the
         * status label: `STARTED` means the participant opened it, but a
         * session can carry responses while still reading `AVAILABLE` if the
         * transition has not been applied yet, and "did they type anything?"
         * is the fact a researcher is actually asking about.
         */
        if (session.hasResponses) inProgress += 1;
        else notStarted += 1;
        break;

      // Not yet due, or never offered. Neither closed today nor open today.
      case "PENDING_TRIGGER":
      case "SCHEDULED":
      case "CANCELLED":
        break;
    }
  }

  return {
    closed: completed + missedUnstarted + missedPartial,
    completed,
    missedUnstarted,
    missedPartial,
    open: notStarted + inProgress,
    notStarted,
    inProgress,
  };
}
