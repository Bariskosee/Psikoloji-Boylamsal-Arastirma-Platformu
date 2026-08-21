"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
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
      <h1>{t("title")}</h1>
      <p style={{ color: "#5b6472" }}>{t("signedInAs", { study: me.studyName })}</p>

      <section style={styles.card}>
        {open.length === 0 ? (
          <>
            <p style={{ marginTop: 0, fontSize: 17 }}>{t("nothingDue")}</p>
            <p style={{ color: "#5b6472", marginBottom: 0 }}>{t("nothingDueHint")}</p>
          </>
        ) : (
          <>
            <p style={{ marginTop: 0, fontWeight: 600 }}>{tSessions("available")}</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {open.map((session) => (
                <li key={session.id} style={{ marginBottom: tokens.spacing.sm }}>
                  <Link
                    href={`/sessions/${session.id}`}
                    style={{ ...styles.button, textAlign: "center", textDecoration: "none" }}
                  >
                    {session.questionnaireName} — {tSessions("open")}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section style={styles.card}>
        <p style={{ marginTop: 0, color: "#5b6472" }}>{t("yourCode")}</p>
        <p style={{ ...styles.code, fontSize: 20 }}>{me.publicCode}</p>
      </section>

      {/*
        The non-nagging path FR-16 asks for. A participant who declined
        notifications, or who has since changed their mind, finds them here —
        rather than being asked again by a banner they cannot get rid of.
      */}
      <Link
        href="/notifications"
        style={{
          ...styles.secondaryButton,
          textAlign: "center",
          textDecoration: "none",
          marginBottom: tokens.spacing.sm,
        }}
      >
        {t("notifications")}
      </Link>
      <Link
        href="/install"
        style={{
          ...styles.secondaryButton,
          textAlign: "center",
          textDecoration: "none",
          marginBottom: tokens.spacing.md,
        }}
      >
        {t("install")}
      </Link>

      <ErrorBanner>{error}</ErrorBanner>

      {confirming ? (
        <section style={{ ...styles.card, borderColor: "#b42318", background: "#fffaf9" }}>
          <p style={{ marginTop: 0 }}>{t("withdrawConfirm")}</p>
          <label style={{ display: "block", marginBottom: tokens.spacing.sm }}>
            <span style={{ display: "block", marginBottom: 4 }}>{t("withdrawReason")}</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              style={{ ...styles.input, minHeight: 90 }}
            />
          </label>
          <button type="button" onClick={() => void withdraw()} style={styles.button}>
            {t("withdrawAction")}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            style={{ ...styles.secondaryButton, marginTop: tokens.spacing.sm }}
          >
            {t("cancel")}
          </button>
        </section>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} style={styles.secondaryButton}>
          {t("withdraw")}
        </button>
      )}
    </div>
  );
}
