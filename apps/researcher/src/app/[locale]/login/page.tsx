"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { AuthCard } from "@/components/shell/AuthCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/components/ui/states";
import type { LoginResponse } from "@lpr/contracts";

/**
 * Researcher login.
 *
 * A client component because the session cookie belongs to the API's origin
 * (ADR-009) — see `lib/api.ts`.
 */
export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await api.post<LoginResponse>("/api/auth/login", { email, password });
      router.push("/studies");
    } catch (caught) {
      // The message is translated from the CODE, never taken from the server's
      // English string — otherwise an English sentence appears mid-Turkish.
      setError(messageFor(caught, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard
      title={t("signIn")}
      footer={<span className="text-muted-foreground">{t("noSelfService")}</span>}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <ErrorBanner>{error}</ErrorBanner>

        <div className="grid gap-2">
          <Label htmlFor="email">{t("email")}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            // The first field is focused, so a returning researcher can type
            // straight away rather than reaching for the mouse.
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="password">{t("password")}</Label>
            {/*
              Beside the field rather than below the form. Somebody who has
              forgotten their password realises it here, at the password box,
              not after scrolling past the button.
            */}
            <Link
              href="/forgot-password"
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              {t("forgotPassword")}
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? t("signingIn") : t("signIn")}
        </Button>
      </form>
    </AuthCard>
  );
}

/**
 * Maps a machine-readable error code to a localised sentence.
 *
 * Login failures are deliberately uniform on the server (STRUCTURE.md §11.5),
 * so there is exactly ONE message for a bad email, a bad password, and a
 * disabled account. Distinguishing them here would rebuild the account
 * enumeration oracle the API took care to avoid.
 */
function messageFor(error: unknown, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t("errors.unknown");
  switch (error.code) {
    case "INVALID_CREDENTIALS":
      return t("errors.invalidCredentials");
    case "RATE_LIMITED":
      return t("errors.rateLimited");
    case "NETWORK_ERROR":
      return t("errors.network");
    case "VALIDATION_FAILED":
      return t("errors.validation");
    default:
      return t("errors.unknown");
  }
}
