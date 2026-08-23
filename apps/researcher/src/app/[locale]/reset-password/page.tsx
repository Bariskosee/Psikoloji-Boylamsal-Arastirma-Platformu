"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { AuthCard } from "@/components/shell/AuthCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/components/ui/states";

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
      <AuthCard title={t("resetConfirmTitle")}>
        <p className="text-sm leading-relaxed" role="status">
          {t("resetConfirmDone")}
        </p>
        <Button asChild className="mt-5 w-full">
          <Link href="/login">{t("backToSignIn")}</Link>
        </Button>
      </AuthCard>
    );
  }

  if (token === "") {
    return (
      <AuthCard title={t("resetConfirmTitle")}>
        {/*
          A link that arrived without its token — mangled by a mail client, or
          copied by hand. Say what to do rather than presenting a form that
          cannot possibly work.
        */}
        <ErrorBanner>{t("resetMissingToken")}</ErrorBanner>
        <Button asChild variant="outline" className="w-full">
          <Link href="/forgot-password">{t("resetRequestSubmit")}</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("resetConfirmTitle")} description={t("resetConfirmIntro")}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <ErrorBanner>{error}</ErrorBanner>

        <div className="grid gap-2">
          <Label htmlFor="new-password">{t("newPassword")}</Label>
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="confirm-password">{t("confirmPassword")}</Label>
          <Input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? t("resetConfirmSaving") : t("resetConfirmSubmit")}
        </Button>
      </form>
    </AuthCard>
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
