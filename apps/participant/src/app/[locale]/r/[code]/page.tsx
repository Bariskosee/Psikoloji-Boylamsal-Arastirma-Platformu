"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import { api } from "@/lib/api";
import { styles } from "@/lib/ui";

/**
 * Install handoff redemption (STRUCTURE.md §4, §11.4; ADR-007; FR-41).
 *
 * The only identifier-bearing URL in the participant application, and the one
 * place ADR-007 permits a secret in a path. It is redeemable once, expires in
 * twenty-four hours, is rate limited, and is worth nothing afterwards — none of
 * which is true of the continuity token, which is why that one may never appear
 * in a URL at all.
 *
 * This page is opened INSIDE the freshly installed application, whose cookie
 * store is empty. Redeeming mints a credential there and binds it to the same
 * participant, so their longitudinal chain survives the install.
 *
 * ── Why it redeems on mount, without asking ─────────────────────────────────
 * Tapping the link WAS the affirmative action, and the participant took it two
 * screens ago after being told exactly what it does. A confirmation button here
 * would be a second gate on a single-use code, and someone who tapped through
 * and then hesitated would spend it for nothing.
 *
 * The effect is guarded against React's double invocation in Strict Mode for
 * precisely that reason: two redemptions of a single-use code means the second
 * one fails, and a participant staring at "that link did not work" while the
 * first call was quietly succeeding is the worst possible outcome of a screen
 * whose entire purpose is reassurance.
 */
export default function HandoffPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const t = useTranslations("handoff");

  const [status, setStatus] = useState<"working" | "ok" | "failed">("working");

  useEffect(() => {
    // React re-invokes effects on remount — Strict Mode does it on every mount
    // in development, and a fast refresh does it in production. A single-use
    // code cannot survive being spent twice, so the second run must not fire.
    let redeemed = false;

    void (async () => {
      if (redeemed) return;
      redeemed = true;

      try {
        await api.post("/api/participant/handoff/redeem", { code });
        setStatus("ok");
      } catch {
        // Expired, already redeemed, or never ours — the API answers all three
        // identically, and so does this screen. What differs is only what the
        // participant should do next, and the failure copy covers every case.
        setStatus("failed");
      }
    })();

    return () => {
      redeemed = true;
    };
  }, [code]);

  if (status === "working") {
    return (
      <div style={styles.page}>
        <h1>{t("title")}</h1>
        <p style={styles.prose}>{t("working")}</p>
      </div>
    );
  }

  if (status === "ok") {
    return (
      <div style={styles.page}>
        <h1>{t("successTitle")}</h1>
        <p style={styles.prose}>{t("successBody")}</p>
        <Link
          href="/notifications"
          style={{ ...styles.button, textAlign: "center", textDecoration: "none" }}
        >
          {t("continue")}
        </Link>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>{t("failedTitle")}</h1>
      <p style={styles.prose}>{t("failedBody")}</p>
      {/*
        Recovery is offered here rather than only mentioned. A participant whose
        handoff failed is one step from being lost, and the recovery code they
        were shown at enrollment is the remedy that always works.
      */}
      <Link
        href="/recover"
        style={{ ...styles.button, textAlign: "center", textDecoration: "none" }}
      >
        {t("recover")}
      </Link>
      <Link
        href="/home"
        style={{
          ...styles.secondaryButton,
          textAlign: "center",
          textDecoration: "none",
          marginTop: tokens.spacing.sm,
        }}
      >
        {t("continue")}
      </Link>
    </div>
  );
}
