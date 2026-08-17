/**
 * The Clock port.
 *
 * Every piece of time-dependent logic in this package accepts a Clock rather
 * than reading the wall clock directly. That is what makes a 30-day protocol
 * with seven daily occurrences and two daylight-saving transitions testable in
 * milliseconds instead of requiring real time to pass.
 *
 * Reading the wall clock inside packages/domain is an ESLint error
 * (AGENT.md §17, ADR-002).
 */
export interface Clock {
  /** The current instant, always in UTC terms. */
  now(): Date;
}

/**
 * A Clock frozen at a caller-supplied instant. The instant comes in from
 * outside; this function never reads the wall clock itself.
 */
export function fixedClock(instant: Date): Clock {
  return {
    now: () => instant,
  };
}

/**
 * A Clock that can be advanced by the caller, for stepping a multi-day protocol
 * through its timeline inside a test.
 */
export interface MutableClock extends Clock {
  advanceBy(milliseconds: number): void;
  set(instant: Date): void;
}

export function mutableClock(start: Date): MutableClock {
  let current = start;
  return {
    now: () => current,
    advanceBy: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
    set: (instant: Date) => {
      current = instant;
    },
  };
}
