"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { OperationsHealthResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Operational health, admin only (PLAN.md Phase 10, ADR-005, ADR-010).
 *
 * ── Why sweeper liveness is the first thing on the page ─────────────────────
 * ADR-010's warning: on a hosting tier that idles services out, the
 * reconciliation loop stops and the whole scheduling guarantee disappears with
 * no error anywhere. A halted sweeper looks exactly like a sweeper with nothing
 * to do, so `system_heartbeats` is the only evidence it is still running — and
 * an empty list here means nothing is, which is why it renders as an alarm
 * rather than as an empty state.
 *
 * ── Why "accepted" is annotated where the number is ─────────────────────────
 * An operator reading "1,240 accepted" will otherwise conclude 1,240 people
 * were notified. A push service accepting a message is the strongest thing this
 * system observes (ADR-006, FR-15); delivery is not observable at all. The
 * caveat sits under the number, not in a footnote somewhere else.
 */
export default function OperationsPage() {
  const t = useTranslations("analytics");

  const [health, setHealth] = useState<OperationsHealthResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    void (async () => {
      try {
        setHealth(await api.get<OperationsHealthResponse>("/api/ops/health"));
        setStatus("ready");
      } catch {
        // Covers the 403 a non-admin gets as well as a genuine failure. The
        // page does not distinguish them: telling a non-admin that the page
        // exists and they may not see it is not information they need.
        setStatus("error");
      }
    })();
  }, []);

  if (status === "loading") return <p style={styles.page}>…</p>;
  if (status === "error" || health === null) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("loadFailed")}</ErrorBanner>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>{t("operations")}</h1>

      {/*
        Alerts first, above every panel of raw counts (Phase 12).

        The panels below are evidence and the alerts are the conclusion, and an
        operator opening this page under pressure should not have to derive the
        second from the first. Placing the verdict last would mean the person
        who scrolls least is the person who sees least — and on this page, the
        person in a hurry is exactly the person something is wrong for.

        `alerts` is computed by `@lpr/domain`, so what is rendered here and what
        an external monitor polls are the same judgement, not two thresholds
        that drift apart.
      */}
      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("opsAlerts")}</h2>
        {health.alerts.length === 0 ? (
          <p style={{ color: "#5b6472", margin: 0 }}>{t("opsNoAlerts")}</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {health.alerts.map((alert) => {
              const critical = alert.severity === "CRITICAL";
              return (
                <li
                  key={alert.code}
                  style={{
                    borderLeft: `4px solid ${critical ? "#b42318" : "#b54708"}`,
                    background: critical ? "#fef3f2" : "#fffaeb",
                    padding: "10px 12px",
                    marginBottom: 8,
                    borderRadius: 4,
                  }}
                >
                  {/*
                    Severity is a word, not only a colour. Roughly one man in
                    twelve cannot reliably separate the red from the amber, and
                    an alert nobody can grade is an alert nobody acts on.
                  */}
                  <strong>
                    {alert.severity === "CRITICAL"
                      ? t("opsSeverityCRITICAL")
                      : t("opsSeverityWARNING")}
                  </strong>{" "}
                  <span style={{ color: "#5b6472", fontSize: 13 }}>{alert.code}</span>
                  <p style={{ margin: "6px 0 4px", lineHeight: 1.6 }}>{alert.summary}</p>
                  {/*
                    The procedure travels with the alert. Going to look for the
                    runbook is the last thing anyone should be doing at the
                    moment they need it.
                  */}
                  <p style={{ margin: 0, fontSize: 13, color: "#5b6472" }}>
                    {t("opsRunbook")}: <code>{alert.runbook}</code>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <p style={{ fontSize: 13, color: "#5b6472", marginBottom: 0 }}>{t("opsAlertsHint")}</p>
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("opsSweepers")}</h2>
        {health.sweepers.length === 0 ? (
          <ErrorBanner>{t("opsNoSweepers")}</ErrorBanner>
        ) : (
          health.sweepers.map((sweeper) => (
            <p key={sweeper.workerId} style={{ margin: "6px 0" }}>
              <strong>{sweeper.workerId}</strong>{" "}
              <span style={{ color: sweeper.stale ? "#b42318" : "#067647" }}>
                {sweeper.stale ? t("opsStale") : t("opsHealthy")}
              </span>
              <br />
              <span style={{ color: "#5b6472", fontSize: 13 }}>
                {t("opsLastSweep")} {sweeper.ageSeconds}s · {t("opsFailures")}{" "}
                {sweeper.consecutiveFailures}
                {sweeper.lastError === null ? "" : ` · ${sweeper.lastError}`}
              </span>
            </p>
          ))
        )}
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("opsDeadLetters")}</h2>
        {health.deadLetteredJobs.length === 0 ? (
          <p style={{ color: "#5b6472", margin: 0 }}>{t("opsNoDeadLetters")}</p>
        ) : (
          health.deadLetteredJobs.map((queue) => (
            <p key={queue.queue} style={{ margin: "4px 0" }}>
              <strong>{queue.queue}</strong>: {queue.count}
            </p>
          ))
        )}
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("opsNotifications")}</h2>
        <p style={{ margin: "4px 0" }}>
          {t("opsAccepted")}: <strong>{health.notifications.accepted}</strong>
        </p>
        <p style={{ color: "#5b6472", fontSize: 13, marginTop: 0 }}>{t("opsAcceptedHint")}</p>
        <p style={{ margin: "4px 0" }}>
          {t("opsFailed")}: <strong>{health.notifications.failed}</strong>
        </p>
        <p style={{ margin: "4px 0" }}>
          {t("opsSuppressed")}: <strong>{health.notifications.suppressed}</strong>
        </p>
        {/*
          Broken out by reason rather than totalled: a spike in SUPPRESSED_STALE
          is an outage, and a spike in SUPPRESSED_NO_SUBSCRIPTION is
          participants losing push. One number would hide both.
        */}
        {Object.entries(health.notifications.suppressionReasons).map(([reason, count]) => (
          <p key={reason} style={{ margin: "2px 0 2px 16px", color: "#5b6472", fontSize: 13 }}>
            {reason}: {count}
          </p>
        ))}
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("opsSubscriptions")}</h2>
        <p style={{ margin: "4px 0" }}>
          {t("opsSubsActive")}: <strong>{health.pushSubscriptions.active}</strong>
        </p>
        <p style={{ margin: "4px 0" }}>
          {t("opsSubsInactive")}: <strong>{health.pushSubscriptions.inactive}</strong>
        </p>
        <p style={{ margin: "4px 0" }}>
          {t("opsSubsLost")}: <strong>{health.pushSubscriptions.recentlyLost}</strong>
        </p>
      </section>
    </div>
  );
}
