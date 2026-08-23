import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateOperationalAlerts } from "@lpr/domain";

/**
 * Every alert points at a runbook that exists on disk.
 *
 * ── Why this test is here rather than in `@lpr/domain` ──────────────────────
 * The domain package may not perform I/O (ADR-001), and checking that a file
 * exists is I/O. Its own test asserts the SHAPE of the path; this one asserts
 * that the path resolves.
 *
 * ── Why it is worth a test at all ───────────────────────────────────────────
 * The reference is a string. Rename or move a runbook and nothing breaks, no
 * type fails, no lint fires — the alert simply starts naming a file that is not
 * there, and nobody finds out until the alert fires, which is the worst
 * possible moment to discover the procedure is missing.
 */
describe("operational alerts reference real runbooks", () => {
  const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

  /**
   * An observation deliberately constructed to trip EVERY alert at once, so
   * this test covers each code without enumerating them by hand — a new alert
   * added without a runbook fails here rather than being silently skipped.
   */
  const everythingWrong = evaluateOperationalAlerts({
    sweepers: [],
    deadLetteredJobs: [{ queue: "notification.send.dlq", count: 3 }],
    notifications: { last24h: 100, accepted: 40, failed: 60 },
    pushSubscriptions: { active: 10, recentlyLost: 90 },
  });

  it("trips every alert, so the check below covers all of them", () => {
    // Two sweeper alerts cannot co-occur with SWEEPER_ABSENT (an absent sweeper
    // has no rows to be stale or failing), so the maximum here is four.
    expect(everythingWrong.length).toBeGreaterThanOrEqual(4);
  });

  it.each(everythingWrong.map((alert) => [alert.code, alert.runbook] as const))(
    "%s points at %s, which exists",
    (_code, runbook) => {
      expect(existsSync(new URL(runbook, `file://${repoRoot}`))).toBe(true);
    },
  );
});
