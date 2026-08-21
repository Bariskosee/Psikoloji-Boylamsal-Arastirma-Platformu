"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type { ParticipantMeResponse } from "@lpr/contracts";
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

  const [me, setMe] = useState<ParticipantMeResponse | null>(null);
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

  return (
    <div style={styles.page}>
      <h1>{t("title")}</h1>
      <p style={{ color: "#5b6472" }}>{t("signedInAs", { study: me.studyName })}</p>

      <section style={styles.card}>
        {me.hasAvailableWork ? null : (
          <>
            <p style={{ marginTop: 0, fontSize: 17 }}>{t("nothingDue")}</p>
            <p style={{ color: "#5b6472", marginBottom: 0 }}>{t("nothingDueHint")}</p>
          </>
        )}
      </section>

      <section style={styles.card}>
        <p style={{ marginTop: 0, color: "#5b6472" }}>{t("yourCode")}</p>
        <p style={{ ...styles.code, fontSize: 20 }}>{me.publicCode}</p>
      </section>

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
