import { DateTime } from "luxon";

/**
 * Quiet hours (FR-40, STRUCTURE.md §9.1 guard 7).
 *
 * A window in the PARTICIPANT'S local wall-clock time during which this study
 * will not make their phone buzz. It is the one part of the notification engine
 * whose whole purpose is to be inconvenient to the researcher, and getting it
 * wrong has a specific cost: a reminder at 03:40 is how a participant learns to
 * turn notifications off, and a participant with notifications off is lost for
 * the remainder of a study measured in weeks.
 *
 * ── Why the window is a pair of wall-clock times, not a duration ────────────
 * "Do not disturb between 22:00 and 08:00" is a statement about the
 * participant's day, not about a number of hours after some instant. A duration
 * would drift against their day whenever the offset changed, and would land in
 * the middle of the evening twice a year.
 *
 * ── The overnight case is the normal case ───────────────────────────────────
 * Almost every real quiet-hours window wraps midnight, so `start > end` is not
 * an edge case to be handled defensively — it is the shape the feature exists
 * for, and the containment test below is written for it first.
 *
 * Pure and clock-free: the instant comes in as an argument, so "what happens at
 * 23:59 on the night the clocks change" is a unit test rather than a wait.
 */

export interface QuietHours {
  /** Local `HH:MM` in the participant's zone. */
  readonly start: string;
  readonly end: string;
}

export class QuietHoursError extends Error {}

function parseLocalTime(value: string, field: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new QuietHoursError(`${field} must be local time as HH:MM, got "${value}"`);
  }
  const hour = Number.parseInt(match[1] as string, 10);
  const minute = Number.parseInt(match[2] as string, 10);
  if (hour > 23 || minute > 59) {
    throw new QuietHoursError(`${field} is not a valid time of day: "${value}"`);
  }
  return { hour, minute };
}

/**
 * Is `instant` inside the quiet window, read in `zone`?
 *
 * Half-open: the start minute is inside, the end minute is outside. A window of
 * `22:00`–`08:00` therefore ends at 08:00 exactly, which is what a researcher
 * writing "quiet until eight" means — and it makes `08:00`–`08:00` an empty
 * window rather than an all-day silence, which is the safer reading of what is
 * almost certainly a typo.
 */
export function isWithinQuietHours(instant: Date, zone: string, quiet: QuietHours): boolean {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) {
    throw new QuietHoursError(`"${zone}" is not a timezone this runtime knows`);
  }

  const start = parseLocalTime(quiet.start, "quietHoursStart");
  const end = parseLocalTime(quiet.end, "quietHoursEnd");

  const minutesNow = local.hour * 60 + local.minute;
  const minutesStart = start.hour * 60 + start.minute;
  const minutesEnd = end.hour * 60 + end.minute;

  // Equal bounds describe no window at all. Treating it as "always quiet" would
  // silence a study permanently on a single mistyped digit, with no error
  // anywhere and no notification ever sent.
  if (minutesStart === minutesEnd) return false;

  if (minutesStart < minutesEnd) {
    // A same-day window, e.g. 13:00–14:00. Unusual but legal.
    return minutesNow >= minutesStart && minutesNow < minutesEnd;
  }

  // The overnight case: 22:00–08:00 is "at or after 22:00, or before 08:00".
  return minutesNow >= minutesStart || minutesNow < minutesEnd;
}

/**
 * The next instant at which the quiet window has ended, at or after `instant`.
 *
 * Used by the DEFER behaviour to re-enqueue a reminder for the moment the
 * participant may be disturbed again.
 *
 * ── Why this is computed in the zone rather than by adding hours ────────────
 * The end is a wall-clock time. On the night a zone shifts, "08:00 tomorrow" is
 * 23 or 25 hours away, not 24 — and a deferral computed by addition would fire
 * an hour inside the window twice a year, which is exactly the failure quiet
 * hours exist to prevent.
 *
 * Luxon resolves a nonexistent local time forward and an ambiguous one to the
 * earlier offset. Both are the right choices here: on a spring-forward night
 * "quiet until 03:00" in a zone that has no 03:00 must still end, and on a
 * fall-back night ending at the first 03:00 errs toward disturbing the
 * participant an hour later than strictly necessary rather than an hour early.
 */
export function quietHoursEndAfter(instant: Date, zone: string, quiet: QuietHours): Date {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) {
    throw new QuietHoursError(`"${zone}" is not a timezone this runtime knows`);
  }

  const end = parseLocalTime(quiet.end, "quietHoursEnd");
  const candidate = local.set({ hour: end.hour, minute: end.minute, second: 0, millisecond: 0 });

  // Today's end has already passed, so the window we are in ends tomorrow. The
  // comparison is on absolute instants, which is what makes this correct across
  // a transition where "tomorrow at 08:00" is not 24 hours away.
  if (candidate.toMillis() <= local.toMillis()) {
    return candidate.plus({ days: 1 }).toUTC().toJSDate();
  }

  return candidate.toUTC().toJSDate();
}

/**
 * Resolve the zone a quiet window is read in.
 *
 * The participant's own, falling back to the study's — the same rule the
 * scheduler uses (STRUCTURE.md §8.3). A participant who never reported a zone
 * still has to be protected from a 3am notification, and the study's zone is
 * the only defensible guess, because it is where the research team believes the
 * cohort lives.
 */
export function resolveQuietHoursZone(
  participantTimezone: string | null,
  studyTimezone: string,
): string {
  return participantTimezone ?? studyTimezone;
}
