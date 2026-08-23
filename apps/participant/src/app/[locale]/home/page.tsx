"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ParticipantMeResponse, SessionListResponse, SessionSummary } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * The participant home screen.
 *
 * In Phase 5 it is legitimately empty: sessions do not exist until Phase 7, and
 * the screen says so rather than pretending to be broken. `hasAvailableWork`
 * comes from the server, so "nothing right now" is a stated fact rather than
 * something the client inferred from an endpoint it could not reach.
 */
export default function HomePage() {
  const t = useTranslations("home");
  const tSessions = useTranslations("sessions");

  const [me, setMe] = useState<ParticipantMeResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "anonymous">("loading");
  const [confirming, setConfirming] = useState(false);
  /**
   * Set locally after a successful withdrawal rather than re-read from the
   * server.
   *
   * Withdrawing revokes every credential the participant holds, so the very
   * next `/me` is a 401 — reloading would tell someone who just chose to leave
   * that we "could not find" them, which reads as a failure instead of the
   * confirmation it is. The server state is already applied; this screen only
   * has to say so.
   */
  const [withdrawn, setWithdrawn] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await api.get<ParticipantMeResponse>("/api/participant/me"));
      // Fetched separately: a participant with no sessions is the normal case
      // until Phase 7, and this list failing must not make the home screen
      // look signed-out.
      try {
        const list = await api.get<SessionListResponse>("/api/participant/sessions");
        setSessions(list.sessions);
      } catch {
        setSessions([]);
      }
      setStatus("ready");
    } catch {
      // Any credential failure lands here: no cookie, unknown, revoked, or past
      // its grace period. The API deliberately does not distinguish them, and
      // neither does this screen — recovery is the answer to all four.
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function withdraw() {
    try {
      await api.post("/api/participant/withdraw", { reason: reason.trim() || undefined });
      setConfirming(false);
      setWithdrawn(true);
    } catch {
      setError(t("notSignedIn"));
    }
  }

  if (withdrawn || me?.status === "WITHDRAWN") {
    return (
      <div style={styles.page}>
        <h1>{t("withdrawnTitle")}</h1>
        <p style={styles.prose}>{t("withdrawnBody")}</p>
      </div>
    );
  }

  if (status === "loading") return <p style={styles.page}>…</p>;

  if (status === "anonymous") {
    return (
      <div style={styles.page}>
        <h1>{t("title")}</h1>
        <ErrorBanner>{t("notSignedIn")}</ErrorBanner>
        <Link
          href="/recover"
          style={{ ...styles.secondaryButton, textAlign: "center", textDecoration: "none" }}
        >
          {t("recover")}
        </Link>
      </div>
    );
  }

  if (!me) return null;

  /**
   * Only what the participant can actually act on.
   *
   * A scheduled session is a promise about the future, and listing it as
   * something to open would produce a screen full of buttons that refuse.
   */
  const open = sessions.filter(
    (session) => session.status === "AVAILABLE" || session.status === "STARTED",
  );

  return (
    <div style={styles.page}>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("signedInAs", { study: me.studyName })}
        </p>
      </header>

      <ErrorBanner>{error}</ErrorBanner>

      {/*
        ── The one thing this screen is for ──────────────────────────────────
        A participant opens this app because a notification told them
        something is ready. Everything else — their code, notification
        settings, install instructions, withdrawal — is secondary, and it used
        to be laid out as five stacked cards of roughly equal weight with the
        actual task first among equals.

        Now the open session is a full-width primary action carrying the
        questionnaire's name and when it closes, and the rest is demoted.
      */}
      {open.length === 0 ? (
        <section style={styles.card} className="text-center">
          <p className="mt-0 text-lg font-medium">{t("nothingDue")}</p>
          <p className="text-muted-foreground mb-0 text-sm">{t("nothingDueHint")}</p>
        </section>
      ) : (
        <section aria-labelledby="ready-heading" className="mb-6">
          <h2 id="ready-heading" className="mb-2 text-sm font-medium">
            {tSessions("available")}
          </h2>
          <ul className="space-y-3">
            {open.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  style={styles.button}
                  className="!h-auto !flex-col !items-stretch !gap-1 py-4 text-left"
                >
                  <span className="text-lg font-semibold">{session.questionnaireName}</span>
                  {/*
                    When it closes, on the button itself. A participant
                    deciding whether to answer now or later cannot make that
                    decision without it, and a missed window is a lost
                    measurement rather than an inconvenience.
                  */}
                  {session.availableUntil === null ? null : (
                    <span className="text-sm font-normal opacity-90">
                      {tSessions("closesAt", {
                        at: new Date(session.availableUntil).toLocaleString(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }),
                      })}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={styles.card}>
        <p className="text-muted-foreground mt-0 text-sm">{t("yourCode")}</p>
        <p style={{ ...styles.code, fontSize: 20 }} className="mb-0">
          {me.publicCode}
        </p>
      </section>

      {/*
        The non-nagging path FR-16 asks for. A participant who declined
        notifications, or who has since changed their mind, finds them here —
        rather than being asked again by a banner they cannot get rid of.
      */}
      <nav aria-label={t("manage")} className="space-y-2">
        <Link href="/notifications" style={styles.secondaryButton}>
          {t("notifications")}
        </Link>
        <Link href="/install" style={styles.secondaryButton}>
          {t("install")}
        </Link>
      </nav>

      {/*
        Withdrawal, separated by a rule and set in small quiet type.

        It was previously a full-width button identical to "Notifications" and
        sitting directly beneath it — one slip away from a participant ending
        their participation while looking for a settings screen. It is still
        one tap to reach and it is no longer the same weight as a navigation
        link.
      */}
      <section aria-labelledby="withdraw-heading" className="mt-10 border-t pt-6">
        <h2
          id="withdraw-heading"
          className="text-muted-foreground mb-2 text-xs tracking-wide uppercase"
        >
          {t("withdrawHeading")}
        </h2>

        {confirming ? (
          <div
            style={styles.card}
            className="border-danger/40 bg-danger-muted text-danger-muted-foreground"
          >
            <p className="mt-0 text-sm">{t("withdrawConfirm")}</p>
            <label className="mb-3 block">
              <span className="mb-1 block text-sm">{t("withdrawReason")}</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                style={{ ...styles.input, minHeight: 90 }}
              />
            </label>
            <button
              type="button"
              onClick={() => void withdraw()}
              style={styles.button}
              className="!border-danger !bg-danger !text-danger-foreground"
            >
              {t("withdrawAction")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={styles.secondaryButton}
              className="mt-2"
            >
              {t("cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-muted-foreground hover:text-foreground min-h-11 text-sm underline underline-offset-4"
          >
            {t("withdraw")}
          </button>
        )}
      </section>
    </div>
  );
}
