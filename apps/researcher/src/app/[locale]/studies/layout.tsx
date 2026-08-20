"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { ResearcherProfile } from "@lpr/contracts";
import { api } from "@/lib/api";
import { styles } from "@/lib/ui";

/**
 * The signed-in shell for every `/studies/**` screen.
 *
 * Two things live here because both were previously missing:
 *
 * 1. **The session gate.** Authentication used to be enforced only as a side
 *    effect of each page's first data fetch returning 401. A screen that
 *    fetches nothing on mount — `/studies/new` is the whole form — therefore
 *    rendered in full to a signed-out visitor. Nothing leaked, because every
 *    write is refused server-side, but the visitor got a working-looking form
 *    that could only fail on submit. Resolving `/api/auth/me` once, here,
 *    makes the answer the same on every route.
 *
 * 2. **Sign out.** `POST /api/auth/logout` and the `auth.signOut` label both
 *    already existed; no screen ever called them, so a researcher had no way
 *    to end a session from the interface (PLAN.md Phase 2).
 *
 * It renders nothing until the session resolves. Flashing the dashboard and
 * then redirecting is worse than a brief blank: on a shared machine the flash
 * is exactly the frame someone should not see.
 */
export default function StudiesLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [user, setUser] = useState<ResearcherProfile | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.get<{ user: ResearcherProfile }>("/api/auth/me");
        if (!cancelled) setUser(response.user);
      } catch {
        // Any failure to establish a session lands on the login screen. A
        // network error is indistinguishable from an expired cookie from here,
        // and login is where both are recoverable.
        if (!cancelled) router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.post("/api/auth/logout");
    } finally {
      // Leave regardless. If the call failed the cookie may still be live, but
      // staying on an authenticated screen after the user asked to leave is
      // the worse of the two outcomes.
      router.replace("/login");
    }
  }

  if (!user) return null;

  return (
    <div style={styles.page}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 24,
        }}
      >
        <span style={{ fontSize: 14, color: "#5b6472" }}>{user.email}</span>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={signingOut}
          style={styles.secondaryButton}
        >
          {t("signOut")}
        </button>
      </header>
      {children}
    </div>
  );
}
