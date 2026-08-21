"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import { styles } from "@/lib/ui";

/**
 * The identity confirmation, shown once.
 *
 * This is the only moment the recovery code exists anywhere the participant can
 * see it. It is stored hashed, so the platform genuinely cannot show it again —
 * which is why the screen insists, and why the continue button waits for an
 * explicit acknowledgement rather than letting someone tap past it.
 *
 * The code is read from `sessionStorage` and removed immediately. Session
 * storage dies with the tab and is not shared across origins; the alternative,
 * putting it in the URL, would write it into history and any referrer header.
 * The continuity token is not here at all — it is in an HttpOnly cookie the
 * client cannot read.
 */
export default function WelcomePage() {
  const t = useTranslations("identity");
  const router = useRouter();

  const [codes, setCodes] = useState<{ publicCode: string; recoveryCode: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  /**
   * Read, but do NOT consume, in the effect.
   *
   * Clearing here loses the recovery code outright: React re-invokes effects on
   * a remount — Strict Mode does it on every mount in development, and a fast
   * refresh or a back-navigation does it in production — so the second run
   * would find nothing and redirect straight past the only screen that ever
   * shows the code. It is consumed in `continue`, once it has been seen and
   * acknowledged.
   */
  useEffect(() => {
    const raw = sessionStorage.getItem("lpr_enrollment");
    if (raw === null) {
      // Reached without enrolling, or after the code was already acknowledged.
      router.replace("/home");
      return;
    }
    setCodes(JSON.parse(raw) as { publicCode: string; recoveryCode: string });
  }, [router]);

  function done(): void {
    sessionStorage.removeItem("lpr_enrollment");
    /**
     * Straight to installation, not to the home screen (Phase 8).
     *
     * This is the moment §11.4 specifies: consent has completed, the credential
     * exists in THIS browser, and it is the only moment a handoff code can be
     * minted with the participant still present. Sending them home first means
     * most of them never see the install screen at all — and on iOS, the ones
     * who install later without it become new people.
     *
     * `/install` offers a skip, so this adds a screen a participant may decline
     * rather than a step they must complete.
     */
    router.replace("/install");
  }

  if (!codes) return null;

  return (
    <div style={styles.page}>
      <h1>{t("title")}</h1>

      <section style={styles.card}>
        <p style={{ marginTop: 0, color: "#5b6472" }}>{t("codeLabel")}</p>
        <p style={styles.code}>{codes.publicCode}</p>
      </section>

      <section style={{ ...styles.card, borderColor: "#b54708", background: "#fffaeb" }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("recoveryTitle")}</h2>
        <p style={styles.code}>{codes.recoveryCode}</p>
        <p style={{ fontSize: 15, lineHeight: 1.6 }}>{t("recoveryBody")}</p>
      </section>

      <label
        style={{
          display: "flex",
          gap: tokens.spacing.sm,
          alignItems: "flex-start",
          minHeight: tokens.touchTargetMinPx,
          marginBottom: tokens.spacing.md,
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          style={{ width: 24, height: 24, marginTop: 2 }}
        />
        <span style={{ fontSize: 16 }}>{t("acknowledge")}</span>
      </label>

      <button
        type="button"
        disabled={!acknowledged}
        onClick={done}
        style={{ ...styles.button, opacity: acknowledged ? 1 : 0.5 }}
      >
        {t("continue")}
      </button>
    </div>
  );
}
