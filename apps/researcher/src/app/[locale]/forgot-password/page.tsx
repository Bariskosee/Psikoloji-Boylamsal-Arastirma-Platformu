"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Request a password reset (PLAN.md Phase 12, FR-06).
 *
 * ── Why the confirmation is shown for every outcome ─────────────────────────
 * Including for an address that has no account. The API answers identically on
 * purpose — a reset endpoint that distinguishes them publishes an institution's
 * researcher list one query at a time — and a page that said "no such account"
 * would rebuild that oracle in the client, where it is even easier to script.
 *
 * The wording is chosen to be honest about the uncertainty rather than to
 * imply something was sent: "if that address belongs to an account".
 */
export default function ForgotPasswordPage() {
  const t = useTranslations("auth");

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await api.post("/api/auth/password-reset/request", { email });
      setSent(true);
    } catch (caught) {
      // Rate limiting is the one failure worth reporting: it is the researcher's
      // own repeated clicking, and telling them to wait is actionable. Anything
      // else would leak the outcome this endpoint hides.
      setError(
        caught instanceof ApiError && caught.code === "RATE_LIMITED"
          ? t("errors.rateLimited")
          : t("errors.unknown"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <h1>{t("resetRequestTitle")}</h1>

      {sent ? (
        <>
          <p style={{ lineHeight: 1.7 }} role="status">
            {t("resetRequestSent")}
          </p>
          <Link href="/login" style={styles.secondaryButton}>
            {t("backToSignIn")}
          </Link>
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <ErrorBanner>{error}</ErrorBanner>
          <p style={{ lineHeight: 1.7 }}>{t("resetRequestIntro")}</p>

          <div style={styles.field}>
            <label htmlFor="email" style={styles.label}>
              {t("email")}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={styles.input}
            />
          </div>

          <button type="submit" disabled={pending} style={styles.button}>
            {pending ? t("resetRequestSending") : t("resetRequestSubmit")}
          </button>
        </form>
      )}
    </div>
  );
}
