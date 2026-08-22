"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type { PushSubscriptionListResponse, PushSubscriptionSummary } from "@lpr/contracts";
import { api } from "@/lib/api";
import { disablePush, enablePush, fetchPushConfig, readPushEnvironment } from "@/lib/push";
import {
  classifyPushAvailability,
  mayRequestPermission,
  type PushAvailability,
} from "@/lib/push-availability";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Notification onboarding and settings (PLAN.md Phase 8, FR-16, ADR-006).
 *
 * ── The rule this screen exists to obey ─────────────────────────────────────
 * Permission is requested only after an explanation, and only from an explicit
 * tap. Not on page load, not on mount, not "once they seem engaged". The
 * explanation is rendered above the button, the button is the only caller of
 * `enablePush`, and there is no code path here that reaches
 * `Notification.requestPermission()` without one.
 *
 * That is not merely browser policy. A permission prompt fired without context
 * is refused by most people, and a refusal is close to permanent — it can only
 * be undone in system settings, which almost nobody does. One badly-timed
 * prompt costs a participant's reminders for the whole study.
 *
 * ── Non-nagging ─────────────────────────────────────────────────────────────
 * Every state that cannot be fixed from here — blocked, unsupported, iOS too
 * old, no VAPID key — renders an explanation and NO button. There is nothing to
 * dismiss and nothing that reappears. FR-16 asks for "a clear, non-nagging path
 * to enable notifications later", and a path the participant walks to is that;
 * a banner that follows them is not.
 *
 * ── Degradation ─────────────────────────────────────────────────────────────
 * Every branch ends with a link back to the study. A participant with
 * notifications denied can still open every questionnaire — that is what makes
 * push an improvement rather than a prerequisite (STRUCTURE.md §14).
 */
export default function NotificationsPage() {
  const t = useTranslations("notifications");

  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Re-read everything from the browser and the server.
   *
   * Called on mount and after every change, rather than the state being updated
   * optimistically. Permission is owned by the browser and can change outside
   * this page — the participant may revoke it in settings and come straight
   * back — so a local guess about it goes stale in a way nothing corrects.
   */
  const refresh = useCallback(async () => {
    let key: string | null = null;
    try {
      key = await fetchPushConfig();
    } catch {
      // Treated as "not configured": the screen then says the study runs
      // without notifications, which is the truthful thing to say when we
      // cannot establish that it does not.
    }
    setVapidKey(key);
    setAvailability(classifyPushAvailability(readPushEnvironment(key !== null)));

    try {
      const list = await api.get<PushSubscriptionListResponse>(
        "/api/participant/push/subscriptions",
      );
      setSubscriptions(list.subscriptions);
    } catch {
      setSubscriptions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * The ONLY caller of `enablePush`, and it is a click handler.
   *
   * If this ever needs to be invoked from anywhere else, that is the moment to
   * re-read FR-16 rather than to export it.
   */
  async function enable(): Promise<void> {
    if (vapidKey === null) return;
    setBusy(true);
    setError(null);

    const outcome = await enablePush(vapidKey);
    if (!outcome.ok) {
      // A dismissal is not a refusal, and saying "you have blocked
      // notifications" to someone who simply swiped the prompt away would send
      // them into system settings to fix something that is not set.
      setError(outcome.reason === "DISMISSED" ? t("permissionDismissed") : t("failed"));
    }

    await refresh();
    setBusy(false);
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    if (!(await disablePush())) setError(t("failed"));
    await refresh();
    setBusy(false);
  }

  if (availability === null) return <p style={styles.page}>…</p>;

  return (
    <div style={styles.page}>
      <h1>{t("title")}</h1>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("whyTitle")}</h2>
        <p style={styles.prose}>{t("whyBody")}</p>
        {/*
          Stated on the screen where permission is asked for, because it is part
          of what the participant is consenting to. Payloads pass through a
          third-party push service, so they carry no question text and no
          answers (ADR-006) — and saying so is the difference between an
          informed yes and a hopeful one.
        */}
        <p style={{ fontSize: 14, color: "#5b6472", marginBottom: 0 }}>{t("noContentNote")}</p>
      </section>

      <ErrorBanner>{error}</ErrorBanner>

      {availability === "ENABLED" ? (
        <section style={styles.card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("enabledTitle")}</h2>
          <p style={styles.prose}>{t("enabledBody")}</p>
          <p style={{ color: "#5b6472" }}>
            {subscriptions.length === 1
              ? t("deviceCount", { count: subscriptions.length })
              : t("deviceCountPlural", { count: subscriptions.length })}
          </p>
          <button
            type="button"
            onClick={() => void disable()}
            disabled={busy}
            style={{ ...styles.secondaryButton, opacity: busy ? 0.5 : 1 }}
          >
            {t("disable")}
          </button>
        </section>
      ) : null}

      {mayRequestPermission(availability) ? (
        <button
          type="button"
          onClick={() => void enable()}
          disabled={busy}
          style={{ ...styles.button, opacity: busy ? 0.5 : 1 }}
        >
          {t("enable")}
        </button>
      ) : null}

      {availability === "BLOCKED" ? (
        <Explanation title={t("blockedTitle")} body={t("blockedBody")} />
      ) : null}

      {availability === "REQUIRES_INSTALL" ? (
        <section style={styles.card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("requiresInstallTitle")}</h2>
          <p style={styles.prose}>{t("requiresInstallBody")}</p>
          {/*
            The one refusal state with an action, because it is the one the
            participant can genuinely resolve in the next thirty seconds.
          */}
          <Link
            href="/install"
            style={{ ...styles.button, textAlign: "center", textDecoration: "none" }}
          >
            {t("requiresInstallAction")}
          </Link>
        </section>
      ) : null}

      {availability === "REQUIRES_IOS_UPGRADE" ? (
        <Explanation title={t("requiresUpgradeTitle")} body={t("requiresUpgradeBody")} />
      ) : null}

      {availability === "UNSUPPORTED" ? (
        <Explanation title={t("unsupportedTitle")} body={t("unsupportedBody")} />
      ) : null}

      {availability === "NOT_CONFIGURED" ? (
        <Explanation title={t("notConfiguredTitle")} body={t("notConfiguredBody")} />
      ) : null}

      {/*
        Shown wherever notifications are on or could be turned on. Push delivery
        cannot be guaranteed and the system must never imply it can (FR-15,
        ADR-006) — so the participant is told, on the screen where they decide,
        that opening the study is the reliable check.
      */}
      {availability === "ENABLED" || availability === "READY" ? (
        <p style={{ fontSize: 14, color: "#5b6472" }}>{t("noGuarantee")}</p>
      ) : null}

      {/*
        The contact record. Reachable whatever the permission state, because a
        participant with notifications blocked is exactly the one likely to ask
        what they have missed.
      */}
      <Link
        href="/notifications/history"
        style={{
          ...styles.secondaryButton,
          textAlign: "center",
          textDecoration: "none",
          marginTop: tokens.spacing.sm,
        }}
      >
        {t("historyOpen")}
      </Link>
      <Link
        href="/home"
        style={{
          ...styles.secondaryButton,
          textAlign: "center",
          textDecoration: "none",
          marginTop: tokens.spacing.sm,
        }}
      >
        {t("back")}
      </Link>
    </div>
  );
}

/** A refusal state the participant cannot act on from here: reason, no button. */
function Explanation({ title, body }: { title: string; body: string }) {
  return (
    <section style={styles.card}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{title}</h2>
      <p style={{ ...styles.prose, marginBottom: 0 }}>{body}</p>
    </section>
  );
}
