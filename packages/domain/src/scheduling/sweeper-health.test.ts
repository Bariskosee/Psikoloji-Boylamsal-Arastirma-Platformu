import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock.js";
import {
  HEARTBEAT_FAILURE_THRESHOLD,
  HEARTBEAT_STALE_AFTER_MS,
  classifySweeperHeartbeat,
  type SweeperHeartbeat,
} from "./sweeper-health.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const clock = fixedClock(NOW);

function heartbeat(overrides: Partial<SweeperHeartbeat> = {}): SweeperHeartbeat {
  return {
    workerId: "worker-1",
    sweptAt: NOW,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** `NOW` minus a number of milliseconds, for readable ages. */
function agedBy(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("classifySweeperHeartbeat", () => {
  it("calls a worker that just swept healthy", () => {
    const health = classifySweeperHeartbeat(heartbeat(), { clock });

    expect(health.status).toBe("HEALTHY");
    expect(health.ageMs).toBe(0);
    expect(health.workerId).toBe("worker-1");
  });

  /**
   * The boundary is the whole reason this lives in one tested function. Five
   * minutes is the number in ADR-005, STRUCTURE.md §17, and the deployment
   * runbook; an off-by-one here makes all three documents wrong.
   */
  it("treats a heartbeat exactly at the threshold as still on time", () => {
    const health = classifySweeperHeartbeat(
      heartbeat({ sweptAt: agedBy(HEARTBEAT_STALE_AFTER_MS) }),
      { clock },
    );

    expect(health.status).toBe("HEALTHY");
    expect(health.ageMs).toBe(HEARTBEAT_STALE_AFTER_MS);
  });

  it("calls it stale one millisecond later", () => {
    const health = classifySweeperHeartbeat(
      heartbeat({ sweptAt: agedBy(HEARTBEAT_STALE_AFTER_MS + 1) }),
      { clock },
    );

    expect(health.status).toBe("STALE");
  });

  it("tolerates failures below the threshold, because one bad cycle self-repairs", () => {
    const health = classifySweeperHeartbeat(
      heartbeat({ consecutiveFailures: HEARTBEAT_FAILURE_THRESHOLD - 1 }),
      { clock },
    );

    expect(health.status).toBe("HEALTHY");
    expect(health.consecutiveFailures).toBe(HEARTBEAT_FAILURE_THRESHOLD - 1);
  });

  it("calls a run of failures FAILING", () => {
    const health = classifySweeperHeartbeat(
      heartbeat({ consecutiveFailures: HEARTBEAT_FAILURE_THRESHOLD }),
      { clock },
    );

    expect(health.status).toBe("FAILING");
  });

  /**
   * A worker that stopped an hour ago was very likely also failing when it
   * stopped. "The loop is not running" is the finding that has to reach an
   * operator, because it means the guarantee is currently switched off.
   */
  it("reports STALE rather than FAILING when both are true", () => {
    const health = classifySweeperHeartbeat(
      heartbeat({ sweptAt: agedBy(60 * 60_000), consecutiveFailures: 99 }),
      { clock },
    );

    expect(health.status).toBe("STALE");
  });

  /**
   * Only reachable when the writer's clock and the reader's clock disagree.
   * Reported rather than clamped: a negative age is diagnostic, and clamping it
   * to zero would present a clock-skew fault as perfect health.
   */
  it("reports a negative age for a heartbeat from the future instead of hiding it", () => {
    const health = classifySweeperHeartbeat(
      heartbeat({ sweptAt: new Date(NOW.getTime() + 30_000) }),
      { clock },
    );

    expect(health.ageMs).toBe(-30_000);
    expect(health.status).toBe("HEALTHY");
  });

  it("honours a caller-supplied threshold", () => {
    const health = classifySweeperHeartbeat(heartbeat({ sweptAt: agedBy(2_000) }), {
      clock,
      staleAfterMs: 1_000,
    });

    expect(health.status).toBe("STALE");
  });

  it("honours a caller-supplied failure threshold", () => {
    const health = classifySweeperHeartbeat(heartbeat({ consecutiveFailures: 1 }), {
      clock,
      failureThreshold: 1,
    });

    expect(health.status).toBe("FAILING");
  });

  describe("rejects inputs that would silently produce a wrong verdict", () => {
    it("refuses an invalid sweptAt", () => {
      expect(() =>
        classifySweeperHeartbeat(heartbeat({ sweptAt: new Date("not a date") }), { clock }),
      ).toThrow(TypeError);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      "refuses staleAfterMs of %s",
      (staleAfterMs) => {
        expect(() => classifySweeperHeartbeat(heartbeat(), { clock, staleAfterMs })).toThrow(
          RangeError,
        );
      },
    );

    it.each([0, -1, 1.5, Number.NaN])("refuses a failureThreshold of %s", (failureThreshold) => {
      expect(() => classifySweeperHeartbeat(heartbeat(), { clock, failureThreshold })).toThrow(
        RangeError,
      );
    });
  });
});
