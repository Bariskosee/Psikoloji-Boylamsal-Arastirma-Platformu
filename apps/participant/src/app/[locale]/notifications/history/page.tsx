"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type {
  NotificationHistoryEntry,
  NotificationHistoryResponse,
  NotificationSuppressionReason,
} from "@lpr/contracts";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * What this study has sent the participant (PLAN.md Phase 9, FR-19).
 *
 * ── Why suppressions are shown ──────────────────────────────────────────────
 * A gap in a contact record is unanswerable. "We did not remind you because you
 * had already finished" is both true and reassuring; showing nothing invites a
 * participant to conclude the app is broken, or that they missed something.
 * Every suppression reason therefore has a plain-language sentence.
 *
 * ── Why "Sent" carries a footnote ───────────────────────────────────────────
 * Because it does not mean what it appears to mean. A push service accepting a
 * message is the strongest observation available (ADR-006, FR-15); whether the
 * device received or displayed it is unobservable. The note is not legal
 * throat-clearing — it is the difference between a participant thinking their
 * phone is broken and knowing that notifications are inherently unreliable.
 */
export default function NotificationHistoryPage() {
  const t = useTranslations("notifications");
  const locale = useLocale();

  const [entries, setEntries] = useState<NotificationHistoryEntry[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    void (async () => {
      try {
        const response = await api.get<NotificationHistoryResponse>(
          "/api/participant/notifications",
        );
        setEntries(response.attempts);
        setStatus("ready");
      } catch {
        // An explicit error state, never inferred from `entries === null`:
        // deriving loading from missing data renders a permanent spinner
        // alongside the error banner.
        setStatus("error");
      }
    })();
  }, []);

  const reasonText = (reason: NotificationSuppressionReason): string => {
    switch (reason) {
      case "SUPPRESSED_STATE":
        return t("reasonState");
      case "SUPPRESSED_EXPIRED":
        return t("reasonExpired");
      case "SUPPRESSED_WITHDRAWN":
        return t("reasonWithdrawn");
      case "SUPPRESSED_CAP":
        return t("reasonCap");
      case "SUPPRESSED_NO_SUBSCRIPTION":
        return t("reasonNoSubscription");
      case "SUPPRESSED_QUIET_HOURS":
        return t("reasonQuietHours");
      case "SUPPRESSED_STALE":
        return t("reasonStale");
    }
  };

  const outcomeText = (entry: NotificationHistoryEntry): string => {
    switch (entry.outcome) {
      case "SENT_ACCEPTED":
        return t("outcomeSentAccepted");
      // Committed before the network call and never updated: the process died
      // mid-send. We may or may not have sent it, and we will not try again —
      // so the participant is told the same thing as for an accepted send,
      // which is the honest reading of "we tried once".
      case "ATTEMPTED":
        return t("outcomeAttempted");
      case "FAILED":
        return t("outcomeFailed");
      case "SUPPRESSED":
        return t("outcomeSuppressed");
    }
  };

  if (status === "loading") return <p style={styles.page}>…</p>;

  return (
    <div style={styles.page}>
      <h1>{t("historyTitle")}</h1>

      {status === "error" ? <ErrorBanner>{t("failed")}</ErrorBanner> : null}

      {entries !== null && entries.length === 0 ? (
        <p style={styles.prose}>{t("historyEmpty")}</p>
      ) : null}

      {(entries ?? []).map((entry) => (
        <section
          key={`${entry.sessionId}:${entry.kind}:${String(entry.occurrenceIndex)}`}
          style={styles.card}
        >
          <p style={{ marginTop: 0, fontWeight: 600 }}>
            {entry.kind === "INITIAL" ? t("kindInitial") : t("kindReminder")}
          </p>
          <p style={{ color: "#5b6472", margin: 0 }}>
            {new Date(entry.scheduledFor).toLocaleString(locale)}
          </p>
          <p style={{ margin: `${String(tokens.spacing.sm)}px 0 0` }}>{outcomeText(entry)}</p>
          {entry.suppressionReason !== null ? (
            <p style={{ color: "#5b6472", margin: "4px 0 0", fontSize: 15 }}>
              {reasonText(entry.suppressionReason)}
            </p>
          ) : null}
        </section>
      ))}

      {/* The footnote that stops "Sent" from being read as a delivery receipt. */}
      <p style={{ fontSize: 14, color: "#5b6472" }}>{t("acceptedNote")}</p>

      <Link
        href="/notifications"
        style={{ ...styles.secondaryButton, textAlign: "center", textDecoration: "none" }}
      >
        {t("historyBack")}
      </Link>
    </div>
  );
}
