"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { AuthCard } from "@/components/shell/AuthCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/components/ui/states";

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
    <AuthCard
      title={t("resetRequestTitle")}
      description={sent ? undefined : t("resetRequestIntro")}
      footer={
        <Link
          href="/login"
          className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
        >
          {t("backToSignIn")}
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm leading-relaxed" role="status">
          {t("resetRequestSent")}
        </p>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <ErrorBanner>{error}</ErrorBanner>

          <div className="grid gap-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? t("resetRequestSending") : t("resetRequestSubmit")}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
