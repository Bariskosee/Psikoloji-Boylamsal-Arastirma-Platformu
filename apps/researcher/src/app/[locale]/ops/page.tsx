"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Activity, CheckCircle2, Inbox } from "lucide-react";
import type { OperationsHealthResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, StatCard } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorState, LoadingCards } from "@/components/ui/states";
import { cn } from "@/lib/utils";

/**
 * Operational health, admin only (PLAN.md Phase 10, ADR-005, ADR-010).
 *
 * ── Why the alerts are the first thing on the page ──────────────────────────
 * The panels below are evidence; the alerts are the conclusion, computed once
 * in `@lpr/domain` so that what an operator reads here and what an external
 * monitor polls are the same judgement. An operator opening this page under
 * pressure should not have to derive the second from the first.
 *
 * ── Why sweeper liveness comes next ─────────────────────────────────────────
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
  const tNav = useTranslations("nav");

  const [health, setHealth] = useState<OperationsHealthResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setHealth(await api.get<OperationsHealthResponse>("/api/ops/health"));
      setStatus("ready");
    } catch {
      // Covers the 403 a non-admin gets as well as a genuine failure. The
      // page does not distinguish them: telling a non-admin that the page
      // exists and they may not see it is not information they need.
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={tNav("operations")} description={t("opsSubtitle")} />

      {status === "loading" ? <LoadingCards count={4} /> : null}
      {status === "error" ? (
        <ErrorState title={t("loadFailed")} onRetry={() => void load()} retryLabel={t("retry")} />
      ) : null}

      {status === "ready" && health ? (
        <div className="space-y-6">
          <section aria-labelledby="alerts">
            <h2 id="alerts" className="mb-3 text-sm font-medium">
              {t("opsAlerts")}
            </h2>
            {health.alerts.length === 0 ? (
              <Alert className="border-success/40 bg-success-muted text-success-muted-foreground">
                <CheckCircle2 />
                <AlertDescription className="text-success-muted-foreground">
                  {t("opsNoAlerts")}
                </AlertDescription>
              </Alert>
            ) : (
              <ul className="space-y-3">
                {health.alerts.map((alert) => {
                  const critical = alert.severity === "CRITICAL";
                  return (
                    <li key={alert.code}>
                      <Alert
                        className={cn(
                          critical
                            ? "border-danger/40 bg-danger-muted text-danger-muted-foreground"
                            : "border-warning/40 bg-warning-muted text-warning-muted-foreground",
                        )}
                      >
                        <AlertTriangle />
                        <AlertTitle className="flex flex-wrap items-center gap-2">
                          {/*
                            Severity is a word, not only a colour. Roughly one
                            man in twelve cannot reliably separate the red from
                            the amber, and an alert nobody can grade is an
                            alert nobody acts on.
                          */}
                          {critical ? t("opsSeverityCRITICAL") : t("opsSeverityWARNING")}
                          <code className="font-mono text-xs font-normal opacity-80">
                            {alert.code}
                          </code>
                        </AlertTitle>
                        <AlertDescription
                          className={
                            critical
                              ? "text-danger-muted-foreground"
                              : "text-warning-muted-foreground"
                          }
                        >
                          <p>{alert.summary}</p>
                          {/*
                            The procedure travels with the alert. Going to look
                            for the runbook is the last thing anyone should be
                            doing at the moment they need it.
                          */}
                          <p className="text-xs">
                            {t("opsRunbook")}: <code className="font-mono">{alert.runbook}</code>
                          </p>
                        </AlertDescription>
                      </Alert>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-muted-foreground mt-2 text-xs">{t("opsAlertsHint")}</p>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>{t("opsSweepers")}</CardTitle>
              <CardDescription>{t("opsSweepersHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              {health.sweepers.length === 0 ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription>{t("opsNoSweepers")}</AlertDescription>
                </Alert>
              ) : (
                <ul className="divide-y">
                  {health.sweepers.map((sweeper) => (
                    <li
                      key={sweeper.workerId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-mono text-sm">
                          <Activity className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="truncate">{sweeper.workerId}</span>
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {t("opsLastSweep")} {sweeper.ageSeconds}s · {t("opsFailures")}{" "}
                          {sweeper.consecutiveFailures}
                        </p>
                        {sweeper.lastError === null ? null : (
                          <p className="text-danger-muted-foreground mt-1 font-mono text-xs">
                            {sweeper.lastError}
                          </p>
                        )}
                      </div>
                      <StatusBadge tone={sweeper.stale ? "danger" : "success"}>
                        {sweeper.stale ? t("opsStale") : t("opsHealthy")}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("opsDeadLetters")}</CardTitle>
            </CardHeader>
            <CardContent>
              {health.deadLetteredJobs.length === 0 ? (
                <EmptyState icon={Inbox} title={t("opsNoDeadLetters")} className="py-8" />
              ) : (
                <ul className="divide-y">
                  {health.deadLetteredJobs.map((queue) => (
                    <li key={queue.queue} className="flex items-center justify-between py-2.5">
                      <code className="font-mono text-sm">{queue.queue}</code>
                      <span className="font-semibold tabular-nums">{queue.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("opsNotifications")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard
                  label={t("opsAccepted")}
                  value={health.notifications.accepted}
                  /* The caveat, under the number it qualifies. */
                  hint={t("opsAcceptedHint")}
                />
                <StatCard
                  label={t("opsFailed")}
                  value={health.notifications.failed}
                  tone={health.notifications.failed > 0 ? "warning" : "default"}
                />
                <StatCard label={t("opsSuppressed")} value={health.notifications.suppressed} />
              </div>
              {Object.keys(health.notifications.suppressionReasons).length > 0 ? (
                <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {Object.entries(health.notifications.suppressionReasons).map(
                    ([reason, count]) => (
                      <li key={reason}>
                        <code className="font-mono">{reason}</code>: {count}
                      </li>
                    ),
                  )}
                </ul>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("opsSubscriptions")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label={t("opsSubsActive")} value={health.pushSubscriptions.active} />
                <StatCard label={t("opsSubsInactive")} value={health.pushSubscriptions.inactive} />
                <StatCard
                  label={t("opsSubsLost")}
                  value={health.pushSubscriptions.recentlyLost}
                  hint={t("opsSubsLostHint")}
                  tone={health.pushSubscriptions.recentlyLost > 0 ? "warning" : "default"}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
