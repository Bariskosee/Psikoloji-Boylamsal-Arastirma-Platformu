/**
 * Operational alerting (PLAN.md Phase 12: "sweeper heartbeat alerting ·
 * push-failure alerting").
 *
 * ── Why alerting is a PURE function, and not an integration ─────────────────
 * "Alerting" usually means a pager. A pager is a deployment choice — the
 * institution running the study will have PagerDuty, or Opsgenie, or an email
 * alias, or a phone number on a whiteboard — and hard-coding one here would
 * make the platform depend on an integration the research team has not chosen.
 *
 * What CANNOT be left to a deployment is the judgement: which observations
 * warrant waking somebody, at what threshold, and what to do about it. That
 * judgement is domain knowledge about this platform's own failure modes, it is
 * exactly what a monitoring configuration gets wrong, and it is testable
 * without any I/O at all.
 *
 * So this module decides. The API exposes the decision at
 * `GET /api/operations/alerts`, the operations page renders it, and any monitor
 * that can poll a URL — including a cron job with `curl` — can page on it. The
 * platform is opinionated about what is wrong; the institution stays free about
 * who gets woken.
 *
 * ── Why every alert carries a runbook ───────────────────────────────────────
 * An alert that says "sweeper stale" at 03:00 to somebody who did not build
 * this system is a source of panic, not of repair. Each alert names the file in
 * `docs/runbooks/` that says what to do, because the moment an alert fires is
 * the worst possible moment to go looking for the procedure.
 */

/** How bad, and therefore who is woken. */
export type AlertSeverity = "CRITICAL" | "WARNING";

export interface OperationalAlert {
  /** Stable machine identifier. Monitors route and deduplicate on this. */
  readonly code: AlertCode;
  readonly severity: AlertSeverity;
  /** One line, in operational English, naming the observation and its scale. */
  readonly summary: string;
  /** The file under `docs/runbooks/` that says what to do next. */
  readonly runbook: string;
}

export type AlertCode =
  | "SWEEPER_ABSENT"
  | "SWEEPER_STALE"
  | "SWEEPER_FAILING"
  | "DEAD_LETTERS"
  | "PUSH_FAILURE_RATE"
  | "PUSH_ATTRITION";

/**
 * The shape this reads. Structurally the operations health response, restated
 * here so the domain does not depend on the transport contract.
 */
export interface OperationalObservation {
  readonly sweepers: readonly {
    readonly workerId: string;
    readonly ageSeconds: number;
    readonly sweepIntervalSeconds: number;
    readonly consecutiveFailures: number;
    readonly stale: boolean;
  }[];
  readonly deadLetteredJobs: readonly { readonly queue: string; readonly count: number }[];
  readonly notifications: {
    readonly last24h: number;
    readonly accepted: number;
    readonly failed: number;
  };
  readonly pushSubscriptions: {
    readonly active: number;
    readonly recentlyLost: number;
  };
}

export interface AlertThresholds {
  /** Consecutive sweep failures before the loop is considered broken. */
  readonly sweeperFailureCount: number;
  /** Share of push attempts that may fail before it is a transport problem. */
  readonly pushFailureRate: number;
  /** Minimum attempts before a rate is meaningful at all. */
  readonly pushFailureMinimum: number;
  /** Share of the subscriber base that may be lost in a week. */
  readonly pushAttritionRate: number;
}

/**
 * Defaults, each chosen against a specific false alarm.
 *
 * A threshold that fires on noise is worse than no threshold: the second time
 * an operator dismisses an alert, the alert has stopped working, and nobody
 * will notice the day it was real.
 */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = Object.freeze({
  // Three, matching the staleness rule. One failed sweep is a dropped
  // connection; three in a row is a loop that will not recover itself.
  sweeperFailureCount: 3,
  // A fifth of attempts. Ordinary push traffic loses subscriptions steadily as
  // participants uninstall — that is expected attrition and shows up as GONE,
  // not as failure. A fifth failing is a transport or credential problem.
  pushFailureRate: 0.2,
  // Below twenty attempts a rate is arithmetic, not evidence: two failures out
  // of three in a quiet overnight hour is 67% and means nothing.
  pushFailureMinimum: 20,
  // A quarter of the subscriber base lost in a week. Slow attrition is normal
  // and the studies are long; a quarter in seven days is a VAPID key rotated
  // by mistake, and every participant is silently no longer reachable.
  pushAttritionRate: 0.25,
});

/**
 * Decide what, if anything, is wrong.
 *
 * Returned most severe first, so a monitor that reads only the head of the list
 * still reads the worst thing happening.
 */
export function evaluateOperationalAlerts(
  observation: OperationalObservation,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];

  /**
   * No heartbeat row at all — the highest-severity state in the system.
   *
   * ADR-010's warning made concrete: on a hosting tier that idles services
   * out, the worker stops and scheduling silently ceases. Nothing errors.
   * Participants simply stop being given sessions, and the study degrades
   * invisibly until somebody looks at compliance weeks later.
   *
   * An empty table cannot be distinguished from "never deployed", and both
   * mean the same thing operationally: nothing is reconciling.
   */
  if (observation.sweepers.length === 0) {
    alerts.push({
      code: "SWEEPER_ABSENT",
      severity: "CRITICAL",
      summary:
        "No sweeper has ever reported. Scheduling is not running: no session will open or " +
        "expire, and no reminder will be sent, until a worker starts.",
      runbook: "docs/runbooks/sweeper-stall.md",
    });
  }

  const stale = observation.sweepers.filter((sweeper) => sweeper.stale);
  if (stale.length > 0) {
    const worst = stale.reduce((a, b) => (a.ageSeconds > b.ageSeconds ? a : b));
    alerts.push({
      code: "SWEEPER_STALE",
      severity: "CRITICAL",
      summary:
        `${stale.length} sweeper(s) have missed at least three cycles; the worst last swept ` +
        `${Math.round(worst.ageSeconds / 60)} minutes ago against a ` +
        `${Math.round(worst.sweepIntervalSeconds / 60)}-minute interval.`,
      runbook: "docs/runbooks/sweeper-stall.md",
    });
  }

  /**
   * Running, but failing every time.
   *
   * Separate from staleness on purpose, and deliberately not folded into it: a
   * sweeper that runs and throws still updates nothing, but it leaves an error
   * message behind. That message is the diagnosis, and an operator told only
   * "stale" would go looking for a dead process that is in fact alive.
   */
  const failing = observation.sweepers.filter(
    (sweeper) => sweeper.consecutiveFailures >= thresholds.sweeperFailureCount,
  );
  if (failing.length > 0) {
    const worst = failing.reduce((a, b) => (a.consecutiveFailures > b.consecutiveFailures ? a : b));
    alerts.push({
      code: "SWEEPER_FAILING",
      severity: "CRITICAL",
      summary:
        `A sweeper is running but has failed ${worst.consecutiveFailures} times in a row. It is ` +
        "alive and reconciling nothing; read its last error rather than restarting it.",
      runbook: "docs/runbooks/sweeper-stall.md",
    });
  }

  const deadLetters = observation.deadLetteredJobs.reduce((sum, queue) => sum + queue.count, 0);
  if (deadLetters > 0) {
    /**
     * WARNING, not CRITICAL, and the distinction is ADR-005.
     *
     * A dead-lettered job is work the queue gave up on — but the queue only
     * makes the schedule PROMPT, and the sweepers make it CORRECT. A session
     * whose job died will still be opened by the next sweep. What is genuinely
     * lost is a notification, because notifications are at-most-once by
     * design (`retryLimit: 0`) and are never retried by a sweeper.
     *
     * So: worth a human's attention today, not worth waking one tonight.
     */
    alerts.push({
      code: "DEAD_LETTERS",
      severity: "WARNING",
      summary:
        `${deadLetters} job(s) exhausted their retries across ` +
        `${observation.deadLetteredJobs.length} queue(s). Sessions will still be reconciled by ` +
        "the sweepers; any notification among them was not sent and will not be retried.",
      runbook: "docs/runbooks/dead-letter-triage.md",
    });
  }

  /**
   * Push failure rate over the last 24 hours.
   *
   * Guarded by a minimum count, because the denominator is what makes a rate a
   * fact. `attempted` here is accepted + failed: suppressed attempts are
   * excluded deliberately — a notification correctly withheld by quiet hours is
   * the system working, and counting it as traffic would dilute a real spike
   * below the threshold exactly when the study is quietest.
   */
  const attempted = observation.notifications.accepted + observation.notifications.failed;
  if (attempted >= thresholds.pushFailureMinimum) {
    const rate = observation.notifications.failed / attempted;
    if (rate >= thresholds.pushFailureRate) {
      alerts.push({
        code: "PUSH_FAILURE_RATE",
        severity: "WARNING",
        summary:
          `${Math.round(rate * 100)}% of push attempts failed in the last 24 hours ` +
          `(${observation.notifications.failed} of ${attempted}). Expired subscriptions are ` +
          "recorded separately, so this points at transport or credentials.",
        runbook: "docs/runbooks/push-failure-triage.md",
      });
    }
  }

  /**
   * Subscriber attrition over the last week.
   *
   * Measured against the base that is still active plus the ones just lost —
   * the population that HAD a subscription — because dividing by the survivors
   * alone would make the rate climb toward infinity precisely as the outage got
   * total, and a threshold crossed by everybody leaving is a threshold that
   * fired too late.
   */
  const hadSubscriptions =
    observation.pushSubscriptions.active + observation.pushSubscriptions.recentlyLost;
  if (hadSubscriptions > 0) {
    const attrition = observation.pushSubscriptions.recentlyLost / hadSubscriptions;
    if (attrition >= thresholds.pushAttritionRate) {
      alerts.push({
        code: "PUSH_ATTRITION",
        severity: "WARNING",
        summary:
          `${Math.round(attrition * 100)}% of push subscriptions were deactivated in the last ` +
          `7 days (${observation.pushSubscriptions.recentlyLost} of ${hadSubscriptions}). A ` +
          "rotated VAPID key deactivates every subscriber at once and looks exactly like this.",
        runbook: "docs/runbooks/push-failure-triage.md",
      });
    }
  }

  // Severity first, then insertion order within a severity — which is the order
  // an operator should read them in: the loop before the queue, the queue
  // before the transport.
  const rank: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
