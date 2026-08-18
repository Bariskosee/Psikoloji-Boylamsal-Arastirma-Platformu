"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";
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
  const params = useParams<{ locale: string }>();

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
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <h1>{t("signIn")}</h1>

      <form onSubmit={onSubmit} noValidate>
        <ErrorBanner>{error}</ErrorBanner>

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

        <div style={styles.field}>
          <label htmlFor="password" style={styles.label}>
            {t("password")}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={styles.input}
          />
        </div>

        <button type="submit" disabled={pending} style={styles.button}>
          {pending ? t("signingIn") : t("signIn")}
        </button>
      </form>

      <p style={{ marginTop: 24, fontSize: 14, color: "#5b6472" }}>
        {t("noSelfService")}
        {params?.locale ? "" : ""}
      </p>
    </div>
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
