"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Spend a reset link and choose a new password (PLAN.md Phase 12, FR-06).
 *
 * ── Why this does not sign the researcher in on success ─────────────────────
 * The API deliberately does not issue a session here, so the page cannot
 * either. Arriving from a link in an inbox is not the same as proving you are
 * the account holder at a keyboard, and a reset that ended in a live session
 * would make a stolen link strictly more valuable. Signing in afterwards is
 * also how the researcher finds out the new password really saved.
 */
export default function ResetPasswordPage() {
  // `useSearchParams` requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const t = useTranslations("auth");
  const token = useSearchParams().get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    /**
     * Checked here rather than only at the API, because a mistyped
     * confirmation is the one error where a round trip would SPEND the token.
     * The researcher would then be told their link is invalid, which is true
     * and useless.
     */
    if (password !== confirmation) {
      setError(t("errors.passwordsDoNotMatch"));
      return;
    }

    setPending(true);
    try {
      await api.post("/api/auth/password-reset/confirm", { token, newPassword: password });
      setDone(true);
    } catch (caught) {
      setError(messageFor(caught, t));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 420, margin: "0 auto" }}>
        <h1>{t("resetConfirmTitle")}</h1>
        <p style={{ lineHeight: 1.7 }} role="status">
          {t("resetConfirmDone")}
        </p>
        <Link href="/login" style={styles.button}>
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <h1>{t("resetConfirmTitle")}</h1>

      {token === "" ? (
        <>
          {/*
            A link that arrived without its token — mangled by a mail client,
            or copied by hand. Say what to do rather than presenting a form
            that cannot possibly work.
          */}
          <ErrorBanner>{t("resetMissingToken")}</ErrorBanner>
          <Link href="/forgot-password" style={styles.secondaryButton}>
            {t("resetRequestSubmit")}
          </Link>
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <ErrorBanner>{error}</ErrorBanner>
          <p style={{ lineHeight: 1.7 }}>{t("resetConfirmIntro")}</p>

          <div style={styles.field}>
            <label htmlFor="new-password" style={styles.label}>
              {t("newPassword")}
            </label>
            <input
              id="new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="confirm-password" style={styles.label}>
              {t("confirmPassword")}
            </label>
            <input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              style={styles.input}
            />
          </div>

          <button type="submit" disabled={pending} style={styles.button}>
            {pending ? t("resetConfirmSaving") : t("resetConfirmSubmit")}
          </button>
        </form>
      )}
    </div>
  );
}

function messageFor(error: unknown, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t("errors.unknown");
  switch (error.code) {
    case "INVALID_RESET_TOKEN":
      return t("errors.invalidResetToken");
    case "PASSWORD_TOO_WEAK":
      return t("errors.passwordTooWeak");
    case "RATE_LIMITED":
      return t("errors.rateLimited");
    case "NETWORK_ERROR":
      return t("errors.network");
    default:
      return t("errors.unknown");
  }
}
