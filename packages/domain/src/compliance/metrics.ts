import { classifySession, type ComplianceSession } from "./classification.js";

/**
 * Compliance metrics (`docs/compliance-formula.md` §3–§7, FR-44, FR-28).
 *
 * The single implementation. `docs/compliance-formula.md` opens by saying that
 * nothing here may be re-implemented in a dashboard component, and the reason
 * is not tidiness: a compliance percentage that reaches a methods section has
 * to be reproducible and defensible, and the denominator rule is the part most
 * often left implicit and the part that moves the number most.
 *
 * Everything below is pure. A metric that reads a clock could not be checked
 * against the worked examples in §9, and those examples are the specification.
 */

/**
 * A ratio, or the explicit refusal to compute one.
 *
 * `NOT_APPLICABLE` is a first-class value rather than a null, a zero, or a NaN
 * (§5). Zero percent means "had opportunities and took none" — a materially
 * different claim about a person from "nothing has come due yet" — and a type
 * that cannot express the difference is a type that will eventually publish the
 * wrong one.
 */
export type ComplianceRatio =
  | {
      readonly applicable: true;
      readonly numerator: number;
      readonly denominator: number;
      /** 0–1. Present only when a denominator exists. */
      readonly ratio: number;
    }
  | {
      readonly applicable: false;
      readonly numerator: 0;
      readonly denominator: 0;
      readonly reason: "NO_SESSIONS_DUE";
    };

export const NOT_APPLICABLE: ComplianceRatio = Object.freeze({
  applicable: false,
  numerator: 0,
  denominator: 0,
  reason: "NO_SESSIONS_DUE",
});

function ratio(numerator: number, denominator: number): ComplianceRatio {
  // The §5 rule, enforced at the only place a ratio is constructed. A caller
  // cannot accidentally divide by zero into an Infinity or a NaN and render it.
  if (denominator === 0) return NOT_APPLICABLE;
  return { applicable: true, numerator, denominator, ratio: numerator / denominator };
}

const counted = (sessions: readonly ComplianceSession[]): readonly ComplianceSession[] =>
  sessions.filter((session) => session.countsTowardCompliance);

/**
 * Elapsed compliance — the default shown everywhere (§3).
 *
 * "Of the work that has actually come due, how much did they do?" That is the
 * question a researcher monitoring an ongoing study is asking, and it is the
 * only one whose answer is stable: a participant who enrolled yesterday into a
 * thirty-day protocol has not failed twenty-nine sessions that do not yet exist
 * for them.
 */
export function elapsedCompliance(sessions: readonly ComplianceSession[]): ComplianceRatio {
  let met = 0;
  let due = 0;

  for (const session of counted(sessions)) {
    const bucket = classifySession(session.status);
    if (bucket === "MET") {
      met += 1;
      due += 1;
    } else if (bucket === "MISSED") {
      due += 1;
    }
  }

  return ratio(met, due);
}

/**
 * Strict compliance — the full protocol as the denominator (§4).
 *
 * Meaningful only once a participant's protocol has finished, where it equals
 * elapsed compliance. Mid-study it reads as damningly low for someone doing
 * everything asked of them, which is why §4 requires it to be labelled
 * "strict" wherever it appears, and why it is never the default.
 *
 * Cancelled sessions leave this denominator too. That is the §5 note made
 * concrete: a late enrollment must not depress the strict figure either.
 */
export function strictCompliance(sessions: readonly ComplianceSession[]): ComplianceRatio {
  let met = 0;
  let total = 0;

  for (const session of counted(sessions)) {
    const bucket = classifySession(session.status);
    if (bucket === "EXCLUDED") continue;
    total += 1;
    if (bucket === "MET") met += 1;
  }

  return ratio(met, total);
}

/**
 * What a single step's figure actually is — and whether a percentage is even
 * the right shape for it (§6).
 *
 * A step with one occurrence is a yes-or-no question. Rendering "0%" or "100%"
 * for "did they do the endline?" is a category error that makes a table of
 * anchors and blocks unreadable, so the kind travels with the number and the
 * interface renders accordingly.
 */
export type StepComplianceKind = "ADHERENCE" | "COMPLETION";

export type StepCompletionState = "COMPLETED" | "MISSED" | "NOT_YET_DUE" | "OPEN" | "EXCLUDED";

export interface StepCompliance {
  readonly stepKey: string;
  readonly occurrenceCount: number;
  /**
   * `ADHERENCE` for a recurring block — "how many of the daily reports did they
   * file?". `COMPLETION` for a single measurement — "did they do it?".
   */
  readonly kind: StepComplianceKind;
  /** Populated for `ADHERENCE`; also present for `COMPLETION` as 1/1 or 0/1. */
  readonly compliance: ComplianceRatio;
  /** Populated for `COMPLETION` only; null for a recurring block. */
  readonly state: StepCompletionState | null;
  /** False when the step is flagged out of compliance entirely (§2). */
  readonly countsTowardCompliance: boolean;
}

/**
 * Per-step compliance, which FR-44 requires and §6 explains is not optional.
 *
 * A protocol mixing a long recurring block with a few anchor measurements
 * produces an overall figure dominated by the block. §6's two participants both
 * report 16/32 = 50% overall: one completed the baseline and the endline and is
 * usable for the primary analysis, the other missed both and is not. One
 * number, two entirely different research situations.
 */
export function stepCompliance(
  sessions: readonly ComplianceSession[],
  step: { stepKey: string; occurrenceCount: number; countsTowardCompliance: boolean },
): StepCompliance {
  const own = sessions.filter((session) => session.stepKey === step.stepKey);
  const kind: StepComplianceKind = step.occurrenceCount > 1 ? "ADHERENCE" : "COMPLETION";

  if (kind === "COMPLETION") {
    // A single occurrence: report the state, not a ratio. The ratio is computed
    // anyway so that an aggregate over many participants still has something to
    // add up, but the interface is expected to read `state`.
    const bucket = own[0] === undefined ? "NOT_YET_DUE" : classifySession(own[0].status);
    const state: StepCompletionState =
      bucket === "MET"
        ? "COMPLETED"
        : bucket === "MISSED"
          ? "MISSED"
          : bucket === "OPEN"
            ? "OPEN"
            : bucket === "EXCLUDED"
              ? "EXCLUDED"
              : "NOT_YET_DUE";

    return {
      stepKey: step.stepKey,
      occurrenceCount: step.occurrenceCount,
      kind,
      compliance: elapsedCompliance(own),
      state,
      countsTowardCompliance: step.countsTowardCompliance,
    };
  }

  return {
    stepKey: step.stepKey,
    occurrenceCount: step.occurrenceCount,
    kind,
    compliance: elapsedCompliance(own),
    state: null,
    countsTowardCompliance: step.countsTowardCompliance,
  };
}

export interface ParticipantCompliance {
  readonly elapsed: ComplianceRatio;
  readonly strict: ComplianceRatio;
  readonly perStep: readonly StepCompliance[];
}

export function participantCompliance(
  sessions: readonly ComplianceSession[],
  steps: readonly { stepKey: string; occurrenceCount: number; countsTowardCompliance: boolean }[],
): ParticipantCompliance {
  return {
    elapsed: elapsedCompliance(sessions),
    strict: strictCompliance(sessions),
    perStep: steps.map((step) => stepCompliance(sessions, step)),
  };
}

export interface StudyAverage {
  /** Null when no participant has a denominator yet — never 0 (§5). */
  readonly mean: number | null;
  /**
   * How many participants the mean is over. §7 requires this to be displayed
   * alongside any average: "68%" over three people and over three hundred are
   * different claims, and only one of them belongs in a methods section.
   */
  readonly participantCount: number;
  readonly withdrawnCount: number;
  /** Counted separately so the gap between the two totals is explicable. */
  readonly notYetApplicableCount: number;
}

/**
 * The study-level average (§7).
 *
 * Two choices worth restating, because both change the number:
 *
 * **Unweighted by participant, not pooled over sessions.** A pooled ratio lets
 * one participant with thirty occurrences outvote ten with two each. The
 * per-participant mean treats each person as one observation, which is how
 * compliance is normally reported.
 *
 * **Withdrawn participants are excluded from the mean** but counted separately
 * (FR-27). Their partial compliance is not deleted — withdrawal is simply a
 * different phenomenon from non-compliance, and averaging the two together
 * describes neither.
 */
export function studyAverageCompliance(
  participants: readonly { withdrawn: boolean; elapsed: ComplianceRatio }[],
): StudyAverage {
  const withdrawnCount = participants.filter((p) => p.withdrawn).length;

  const eligible = participants.filter((p) => !p.withdrawn && p.elapsed.applicable);
  const notYetApplicableCount = participants.filter(
    (p) => !p.withdrawn && !p.elapsed.applicable,
  ).length;

  if (eligible.length === 0) {
    return { mean: null, participantCount: 0, withdrawnCount, notYetApplicableCount };
  }

  const total = eligible.reduce((sum, p) => sum + (p.elapsed.applicable ? p.elapsed.ratio : 0), 0);

  return {
    mean: total / eligible.length,
    participantCount: eligible.length,
    withdrawnCount,
    notYetApplicableCount,
  };
}

/**
 * Format a ratio for display, or refuse to.
 *
 * Returns null for the not-applicable case so a caller is forced to render
 * something other than a number. Every interface string here goes through
 * i18n; this returns the percentage, not the words.
 */
export function compliancePercent(value: ComplianceRatio): number | null {
  return value.applicable ? Math.round(value.ratio * 1000) / 10 : null;
}
