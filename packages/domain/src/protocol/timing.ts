import { DateTime, Duration } from "luxon";
import type { AnchorTimezoneSource } from "@lpr/contracts";

/**
 * Protocol timing (STRUCTURE.md §8.3, `docs/reference-protocol.md` §6).
 *
 * Given a step's configuration and one origin instant, produce the UTC window
 * of any occurrence. Pure and clock-free: the origin comes in as an argument,
 * so a thirty-day protocol crossing two daylight-saving transitions is testable
 * in milliseconds.
 *
 * ── The two modes ───────────────────────────────────────────────────────────
 * **Duration mode** adds a fixed number of seconds to the origin. Nothing about
 * it depends on a calendar or a zone, so it cannot be wrong across a
 * daylight-saving transition. "Baseline completion + 72h" is this.
 *
 * **Wall-clock mode** re-reads the instant in a zone, moves the calendar, and
 * sets a local time. "Every evening at 20:00" is this, and it is the only way
 * to express it — a pure duration would drift against the participant's day
 * whenever the offset is not exactly 24 hours.
 *
 * The window is ALWAYS duration arithmetic on top of whichever start was
 * computed. A window is a length of time the participant has, not a wall-clock
 * appointment, so a twelve-hour window is twelve hours on both sides of a
 * transition.
 */

/** Both anomalies a wall-clock anchor can hit, and what was done about it. */
export type WallClockAdjustment = "NONE" | "SPRING_FORWARD_GAP" | "FALL_BACK_AMBIGUOUS";

export interface OccurrenceWindow {
  readonly occurrenceIndex: number;
  readonly availableFrom: Date;
  readonly availableUntil: Date;
  /**
   * Recorded rather than silently handled: a researcher previewing a protocol
   * that lands on a transition should be able to see that it did, and a test
   * asserting DST behaviour needs something to assert on.
   */
  readonly adjustment: WallClockAdjustment;
}

export interface StepTiming {
  /** Duration-mode displacement applied to the origin, e.g. `P30D`. */
  readonly offsetIso: string;
  /** Wall-clock anchor; null for a pure duration step. */
  readonly anchorLocalTime: string | null;
  readonly anchorTimezoneSource: AnchorTimezoneSource | null;
  readonly windowDurationIso: string;
  readonly occurrenceCount: number;
  /** Required when `occurrenceCount > 1`. */
  readonly recurrenceIntervalIso: string | null;
}

export interface TimingZones {
  /** Always present — every study has one (FR-12). */
  readonly studyTimezone: string;
  /**
   * The participant's own zone where known. Falling back to the study's is the
   * documented behaviour (STRUCTURE.md §8.3): a participant who never reported
   * a zone still has to be scheduled, and the study's zone is the only defensible
   * guess, because it is where the research team believes the cohort lives.
   */
  readonly participantTimezone: string | null;
}

/**
 * Where a step's occurrence 0 is measured from.
 *
 * The two forms are not interchangeable, and collapsing them was a bug worth
 * recording. A `FIXED_DATETIME` step is anchored to a DAY the researcher picked
 * on a calendar — "the cohort starts on the 7th". If that day is turned into an
 * instant up front, it has to be turned into one in some zone, and a
 * participant whose anchor zone is further west then reads that instant as the
 * 6th. Their whole schedule shifts a day, silently, and only for some
 * participants.
 *
 * So a calendar date stays a calendar date until the anchor zone is known, and
 * is resolved per participant. An instant — enrollment, consent, another step's
 * completion — is already absolute and needs no such care.
 */
export type StepOrigin =
  | { readonly kind: "INSTANT"; readonly instant: Date }
  | { readonly kind: "CALENDAR_DATE"; readonly date: string };

export class ProtocolTimingError extends Error {}

function parseDuration(iso: string, field: string): Duration {
  const duration = Duration.fromISO(iso);
  if (!duration.isValid) {
    throw new ProtocolTimingError(`${field} is not a valid ISO-8601 duration: "${iso}"`);
  }
  return duration;
}

function resolveZone(source: AnchorTimezoneSource, zones: TimingZones): string {
  return source === "PARTICIPANT"
    ? (zones.participantTimezone ?? zones.studyTimezone)
    : zones.studyTimezone;
}

/**
 * Place one occurrence's start instant.
 *
 * Occurrence *n* is the ORIGIN plus *n* × interval — never occurrence *n−1*
 * plus the interval (FR-38). Chaining would make a missed or late occurrence
 * displace every one after it, so a participant who skipped Tuesday would get
 * Wednesday's report on Thursday for the rest of the study.
 */
function occurrenceStart(
  origin: DateTime,
  step: StepTiming,
  occurrenceIndex: number,
  zones: TimingZones,
): { start: DateTime; adjustment: WallClockAdjustment } {
  const offset = parseDuration(step.offsetIso, "offsetIso");

  /**
   * The displacement of occurrence n from the origin: the offset plus n whole
   * intervals. Multiplied rather than accumulated, so occurrence 29 is the same
   * instant whether or not 0–28 were ever computed (FR-38).
   */
  let displacement = offset;
  if (occurrenceIndex > 0) {
    if (step.recurrenceIntervalIso === null) {
      throw new ProtocolTimingError(
        "A step with more than one occurrence needs recurrenceIntervalIso",
      );
    }
    const interval = parseDuration(step.recurrenceIntervalIso, "recurrenceIntervalIso");
    displacement = offset.plus(interval.mapUnits((value) => value * occurrenceIndex));
  }

  const wallClock = step.anchorLocalTime !== null && step.anchorTimezoneSource !== null;

  if (!wallClock) {
    // Pure duration arithmetic on an absolute instant. No zone is consulted,
    // which is precisely what makes this mode immune to transitions.
    return { start: origin.plus(displacement), adjustment: "NONE" };
  }

  const zone = resolveZone(step.anchorTimezoneSource as AnchorTimezoneSource, zones);
  const local = origin.setZone(zone);
  if (!local.isValid) {
    throw new ProtocolTimingError(`"${zone}" is not a timezone this runtime knows`);
  }

  const [hourText, minuteText] = (step.anchorLocalTime as string).split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);

  /**
   * The displacement is added IN THE ANCHOR ZONE, not in UTC.
   *
   * "P1D" against a wall-clock anchor means the next calendar day, not 86 400
   * seconds later. On the day a zone shifts, those differ by an hour, and using
   * UTC arithmetic would move a 00:30 anchor onto the wrong date — every
   * occurrence after the transition would then be a day out.
   */
  const anchored = local.plus(displacement).set({ hour, minute, second: 0, millisecond: 0 });

  return { start: anchored, adjustment: describeAdjustment(anchored, hour, minute) };
}

/**
 * Detect the two transition anomalies, after the fact.
 *
 * Luxon resolves both for us — a nonexistent local time moves forward, an
 * ambiguous one takes the earlier offset — which happens to be exactly the
 * behaviour STRUCTURE.md §8.3 specifies. What it does not do is tell us that it
 * happened, so we ask afterwards:
 *
 * **Gap.** The hour we asked for is not the hour we got: the clock jumped over
 * it. Moving forward is right — the alternative is not scheduling at all on the
 * day the clocks change.
 *
 * **Ambiguity.** The local time exists twice. Taking the first maximises the
 * response window, which matters because the window is the participant's whole
 * opportunity to answer.
 */
function describeAdjustment(
  anchored: DateTime,
  requestedHour: number,
  requestedMinute: number,
): WallClockAdjustment {
  if (anchored.hour !== requestedHour || anchored.minute !== requestedMinute) {
    return "SPRING_FORWARD_GAP";
  }

  // A repeated local time is one where moving an hour FORWARD in absolute time
  // lands on the same wall-clock reading under a different offset. Luxon has
  // already given us the earlier of the two, which is what we want; this only
  // detects that there was a choice, so the preview can say so.
  const hourLater = anchored.plus({ hours: 1 });
  if (
    hourLater.offset !== anchored.offset &&
    hourLater.hour === anchored.hour &&
    hourLater.minute === anchored.minute
  ) {
    return "FALL_BACK_AMBIGUOUS";
  }

  return "NONE";
}

/**
 * Turn the declared origin into a DateTime positioned in the right zone.
 *
 * A calendar date is read at midnight in the zone the step's anchor names, so
 * "the 7th" is the 7th for this participant. An instant is read in UTC and then
 * moved into the anchor zone by `occurrenceStart`, which is lossless.
 */
function resolveOrigin(step: StepTiming, origin: StepOrigin, zones: TimingZones): DateTime {
  if (origin.kind === "INSTANT") {
    const instant = DateTime.fromJSDate(origin.instant, { zone: "utc" });
    if (!instant.isValid) throw new ProtocolTimingError("origin is not a valid instant");
    return instant;
  }

  // Without a wall-clock anchor there is no anchor zone to speak of, so the
  // study's zone decides which day the researcher meant.
  const zone =
    step.anchorTimezoneSource === null
      ? zones.studyTimezone
      : resolveZone(step.anchorTimezoneSource, zones);

  const midnight = DateTime.fromISO(origin.date, { zone });
  if (!midnight.isValid) {
    throw new ProtocolTimingError(`"${origin.date}" is not a calendar date in zone "${zone}"`);
  }
  return midnight;
}

/**
 * Every occurrence window for one step, given the origin its trigger resolved
 * to.
 *
 * The origin is supplied rather than derived: which instant it is depends on
 * the trigger type and on participant state this package deliberately cannot
 * see. Phase 7 resolves it; Phase 4's preview supplies a hypothetical one.
 */
export function computeOccurrenceWindows(
  step: StepTiming,
  origin: StepOrigin,
  zones: TimingZones,
): readonly OccurrenceWindow[] {
  if (step.occurrenceCount < 1) {
    throw new ProtocolTimingError("occurrenceCount must be at least 1");
  }

  const window = parseDuration(step.windowDurationIso, "windowDurationIso");
  const originDateTime = resolveOrigin(step, origin, zones);

  const windows: OccurrenceWindow[] = [];

  for (let index = 0; index < step.occurrenceCount; index += 1) {
    const { start, adjustment } = occurrenceStart(originDateTime, step, index, zones);

    windows.push({
      occurrenceIndex: index,
      availableFrom: start.toUTC().toJSDate(),
      // Duration arithmetic on an absolute instant: a twelve-hour window is
      // twelve hours even when the clocks change inside it.
      availableUntil: start.toUTC().plus(window).toJSDate(),
      adjustment,
    });
  }

  return windows;
}
