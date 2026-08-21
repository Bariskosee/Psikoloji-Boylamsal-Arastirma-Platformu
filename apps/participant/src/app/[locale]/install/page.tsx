"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type { HandoffMintResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { detectPlatform, type DevicePlatform } from "@/lib/push-availability";
import { isStandalone } from "@/lib/push";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Home Screen installation, and the iOS handoff (STRUCTURE.md §11.4, ADR-007,
 * FR-41).
 *
 * ADR-007 calls the iOS install problem "the single most likely cause of silent
 * participant loss in the entire system", and this screen is the whole of the
 * remedy. The failure it prevents: a participant enrols in Safari, we ask them
 * to install, they do — and the installed application opens with an empty
 * cookie store and treats them as a stranger. Their longitudinal chain ends at
 * the exact moment they did what we asked.
 *
 * The one-time code below is what carries their identity across that boundary.
 * It is minted here, in the tab that HAS the credential, and redeemed at
 * `/r/:code` inside the installed application, which does not.
 *
 * ── Why the code is minted for iOS only ─────────────────────────────────────
 * On Android an installed PWA shares storage with the browser, so the
 * credential simply comes along and a handoff code would be a live capability
 * minted for no reason. Every secret this system issues has to earn its
 * existence.
 */
export default function InstallPage() {
  const t = useTranslations("install");
  const locale = useLocale();
  const router = useRouter();

  const [platform, setPlatform] = useState<DevicePlatform | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [handoff, setHandoff] = useState<HandoffMintResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Read the platform after mount, never during render.
   *
   * `navigator` does not exist on the server, and this page is prerendered.
   * `platform === null` on the first paint is the honest state: we do not yet
   * know what device this is.
   */
  useEffect(() => {
    setPlatform(detectPlatform(navigator.userAgent, navigator.maxTouchPoints));
    setStandalone(isStandalone());
  }, []);

  const mint = useCallback(async () => {
    setError(null);
    try {
      setHandoff(await api.post<HandoffMintResponse>("/api/participant/handoff"));
    } catch {
      // Not fatal. The install instructions above are still worth following,
      // and the participant can retry — so this reports and does not replace
      // the screen.
      setError(t("handoffFailed"));
    }
  }, [t]);

  /**
   * Mint only where it is needed, and only once.
   *
   * Gated on iOS-in-a-browser-tab: that is the only configuration where the
   * installed application cannot inherit the credential. Minting for everyone
   * would put a 24-hour key to a participant's identity on screens that have no
   * use for one.
   */
  useEffect(() => {
    if (platform === "IOS" && !standalone && handoff === null) void mint();
  }, [platform, standalone, handoff, mint]);

  const handoffUrl =
    handoff === null ? null : `${window.location.origin}/${locale}/r/${handoff.code}`;

  async function copy(): Promise<void> {
    if (handoffUrl === null) return;
    try {
      await navigator.clipboard.writeText(handoffUrl);
      setCopied(true);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The link
      // is visible and tappable either way, so this needs no error of its own.
    }
  }

  if (standalone) {
    // Already inside the installed application: there is nothing to install and
    // no container to hand off to.
    return (
      <div style={styles.page}>
        <h1>{t("title")}</h1>
        <p style={styles.prose}>{t("alreadyInstalled")}</p>
        <button
          type="button"
          onClick={() => router.replace("/notifications")}
          style={styles.button}
        >
          {t("continue")}
        </button>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>{t("title")}</h1>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("whyTitle")}</h2>
        <p style={{ ...styles.prose, marginBottom: 0 }}>{t("whyBody")}</p>
      </section>

      {platform === "ANDROID" ? (
        <section style={styles.card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("androidStepsTitle")}</h2>
          <ol style={{ ...styles.prose, paddingLeft: "1.25rem", marginBottom: 0 }}>
            <li>{t("androidStep1")}</li>
            <li>{t("androidStep2")}</li>
          </ol>
        </section>
      ) : (
        /*
         * Shown for iOS AND for an unrecognised platform. Someone on a browser
         * we cannot identify is far better served by Apple's instructions —
         * which they can ignore — than by nothing at all.
         */
        <section style={styles.card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("iosStepsTitle")}</h2>
          <ol style={{ ...styles.prose, paddingLeft: "1.25rem", marginBottom: 0 }}>
            <li>{t("iosStep1")}</li>
            <li>{t("iosStep2")}</li>
            <li>{t("iosStep3")}</li>
            {handoffUrl !== null ? <li>{t("iosStep4")}</li> : null}
          </ol>
        </section>
      )}

      <ErrorBanner>{error}</ErrorBanner>

      {handoffUrl !== null && handoff !== null ? (
        <section style={{ ...styles.card, borderColor: "#b54708", background: "#fffaeb" }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("handoffTitle")}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.6 }}>{t("handoffBody")}</p>

          {/*
            A real anchor, not a copy button alone. Inside the installed
            application the participant taps it and it just works; in Safari the
            copy button is the fallback for people who prefer to paste.
          */}
          <a
            href={handoffUrl}
            style={{
              ...styles.code,
              display: "block",
              wordBreak: "break-all",
              marginBottom: tokens.spacing.sm,
            }}
          >
            {handoffUrl}
          </a>

          <p style={{ fontSize: 14, color: "#5b6472" }}>
            {t("handoffExpires", {
              time: new Date(handoff.expiresAt).toLocaleString(locale),
            })}
          </p>

          <button type="button" onClick={() => void copy()} style={styles.secondaryButton}>
            {copied ? t("handoffCopied") : t("handoffCopy")}
          </button>
        </section>
      ) : error !== null ? (
        <button type="button" onClick={() => void mint()} style={styles.secondaryButton}>
          {t("handoffAgain")}
        </button>
      ) : null}

      <Link
        href="/notifications"
        style={{ ...styles.button, textAlign: "center", textDecoration: "none" }}
      >
        {t("continue")}
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
        {t("skip")}
      </Link>
    </div>
  );
}
