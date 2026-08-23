import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateOperationalAlerts,
  type OperationalObservation,
} from "./alerts.js";

/** A system with nothing wrong: one healthy sweeper, clean push traffic. */
function healthy(overrides: Partial<OperationalObservation> = {}): OperationalObservation {
  return {
    sweepers: [
      {
        workerId: "worker-1",
        ageSeconds: 30,
        sweepIntervalSeconds: 60,
        consecutiveFailures: 0,
        stale: false,
      },
    ],
    deadLetteredJobs: [],
    notifications: { last24h: 120, accepted: 118, failed: 2 },
    pushSubscriptions: { active: 100, recentlyLost: 3 },
    ...overrides,
  };
}

const codes = (observation: OperationalObservation) =>
  evaluateOperationalAlerts(observation).map((alert) => alert.code);

describe("operational alerting", () => {
  it("is silent when nothing is wrong", () => {
    expect(evaluateOperationalAlerts(healthy())).toEqual([]);
  });

  describe("the sweepers", () => {
    /**
     * The single most important alert in the platform.
     *
     * ADR-010: on a hosting tier that idles the worker out, scheduling stops
     * and NOTHING reports an error. This is the only signal that exists.
     */
    it("is CRITICAL when no sweeper has ever reported", () => {
      const alerts = evaluateOperationalAlerts(healthy({ sweepers: [] }));

      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.code).toBe("SWEEPER_ABSENT");
      expect(alerts[0]?.severity).toBe("CRITICAL");
    });

    it("is CRITICAL when a sweeper is stale, and says how late against its interval", () => {
      const alerts = evaluateOperationalAlerts(
        healthy({
          sweepers: [
            {
              workerId: "worker-1",
              ageSeconds: 1800,
              sweepIntervalSeconds: 300,
              consecutiveFailures: 0,
              stale: true,
            },
          ],
        }),
      );

      expect(alerts[0]?.code).toBe("SWEEPER_STALE");
      expect(alerts[0]?.severity).toBe("CRITICAL");
      expect(alerts[0]?.summary).toContain("30 minutes ago");
      expect(alerts[0]?.summary).toContain("5-minute interval");
    });

    /**
     * Alive and failing is a DIFFERENT diagnosis from stopped, and must not
     * collapse into it: the process is up, so restarting it fixes nothing, and
     * the error it leaves behind is the actual answer.
     */
    it("distinguishes a sweeper that runs and fails from one that has stopped", () => {
      const running = healthy({
        sweepers: [
          {
            workerId: "worker-1",
            ageSeconds: 30,
            sweepIntervalSeconds: 60,
            consecutiveFailures: 5,
            stale: false,
          },
        ],
      });

      expect(codes(running)).toEqual(["SWEEPER_FAILING"]);
      expect(evaluateOperationalAlerts(running)[0]?.summary).toContain("alive");
    });

    it("tolerates failures below the threshold", () => {
      const blip = healthy({
        sweepers: [
          {
            workerId: "worker-1",
            ageSeconds: 30,
            sweepIntervalSeconds: 60,
            consecutiveFailures: DEFAULT_ALERT_THRESHOLDS.sweeperFailureCount - 1,
            stale: false,
          },
        ],
      });

      expect(codes(blip)).toEqual([]);
    });
  });

  describe("dead letters", () => {
    /**
     * ADR-005 in one assertion: a dead job does not break the schedule, it
     * only makes it late — except for notifications, which are at-most-once
     * and are gone. A CRITICAL here would page somebody for something the next
     * sweep repairs by itself.
     */
    it("is a WARNING, and says which part is actually lost", () => {
      const alerts = evaluateOperationalAlerts(
        healthy({ deadLetteredJobs: [{ queue: "notification.send.dlq", count: 4 }] }),
      );

      expect(alerts[0]?.code).toBe("DEAD_LETTERS");
      expect(alerts[0]?.severity).toBe("WARNING");
      expect(alerts[0]?.summary).toContain("will not be retried");
    });

    it("totals across queues", () => {
      const alerts = evaluateOperationalAlerts(
        healthy({
          deadLetteredJobs: [
            { queue: "notification.send.dlq", count: 4 },
            { queue: "session.open.dlq", count: 3 },
          ],
        }),
      );

      expect(alerts[0]?.summary).toContain("7 job(s)");
      expect(alerts[0]?.summary).toContain("2 queue(s)");
    });
  });

  describe("push failures", () => {
    it("fires once the failure share crosses the threshold", () => {
      const alerts = evaluateOperationalAlerts(
        healthy({ notifications: { last24h: 100, accepted: 70, failed: 30 } }),
      );

      expect(alerts[0]?.code).toBe("PUSH_FAILURE_RATE");
      expect(alerts[0]?.summary).toContain("30%");
    });

    /**
     * The false alarm this guard exists for: two failures out of three in a
     * quiet overnight hour is 67% and means nothing at all. An operator woken
     * by that once will mute the alert, and it will be muted on the night it
     * is real.
     */
    it("stays silent on a tiny sample, however bad the ratio looks", () => {
      const overnight = healthy({ notifications: { last24h: 3, accepted: 1, failed: 2 } });

      expect(codes(overnight)).toEqual([]);
    });

    it("counts suppressed attempts as neither success nor failure", () => {
      // 20 attempted, 4 failed = exactly the 20% threshold. A large number of
      // suppressions alongside must not dilute it below the line.
      const quiet = healthy({
        notifications: { last24h: 500, accepted: 16, failed: 4 },
      });

      expect(codes(quiet)).toContain("PUSH_FAILURE_RATE");
    });
  });

  describe("push attrition", () => {
    /**
     * The failure mode this was written for: a VAPID key rotated by mistake
     * deactivates every subscriber at once. Individually each looks like an
     * ordinary uninstall; only the rate distinguishes them.
     */
    it("fires when a large share of the subscriber base disappears in a week", () => {
      const alerts = evaluateOperationalAlerts(
        healthy({ pushSubscriptions: { active: 60, recentlyLost: 40 } }),
      );

      expect(alerts[0]?.code).toBe("PUSH_ATTRITION");
      expect(alerts[0]?.summary).toContain("40%");
      expect(alerts[0]?.summary).toContain("VAPID");
    });

    it("tolerates ordinary slow attrition", () => {
      expect(codes(healthy({ pushSubscriptions: { active: 100, recentlyLost: 5 } }))).toEqual([]);
    });

    it("does not divide by zero on a study with no subscribers", () => {
      expect(codes(healthy({ pushSubscriptions: { active: 0, recentlyLost: 0 } }))).toEqual([]);
    });
  });

  it("returns the most severe first, so a monitor reading only the head reads the worst", () => {
    const everything = evaluateOperationalAlerts(
      healthy({
        sweepers: [],
        deadLetteredJobs: [{ queue: "notification.send.dlq", count: 9 }],
        notifications: { last24h: 100, accepted: 50, failed: 50 },
      }),
    );

    expect(everything[0]?.severity).toBe("CRITICAL");
    expect(everything.map((alert) => alert.severity)).toEqual(["CRITICAL", "WARNING", "WARNING"]);
  });

  it("points every alert at a runbook that exists", () => {
    const all = evaluateOperationalAlerts(
      healthy({
        sweepers: [],
        deadLetteredJobs: [{ queue: "q.dlq", count: 1 }],
        notifications: { last24h: 100, accepted: 50, failed: 50 },
        pushSubscriptions: { active: 10, recentlyLost: 90 },
      }),
    );

    // Every code is covered by this observation, so this also asserts that no
    // alert can be added later without a procedure to go with it.
    expect(all).toHaveLength(4);
    for (const alert of all) {
      expect(alert.runbook).toMatch(/^docs\/runbooks\/[a-z-]+\.md$/);
    }
  });
});
