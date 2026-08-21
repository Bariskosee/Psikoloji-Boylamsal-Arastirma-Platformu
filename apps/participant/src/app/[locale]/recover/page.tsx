"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Recovery.
 *
 * The one way back in after a lost device or cleared browser data. A successful
 * redemption mints a new credential as a cookie and revokes every earlier one,
 * so the lost device stops working immediately.
 *
 * Every failure — unknown code, already redeemed, rate limited — shows the same
 * message, because the server does not distinguish them either.
 */
export default function RecoverPage() {
  const t = useTranslations("recover");
  const router = useRouter();

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (!code.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.post("/api/participant/recover", { recoveryCode: code.trim() });
      router.replace("/home");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <h1>{t("title")}</h1>
      <p style={styles.prose}>{t("body")}</p>

      {failed ? <ErrorBanner>{t("failed")}</ErrorBanner> : null}

      <label style={{ display: "block", marginBottom: 16 }}>
        <span style={{ display: "block", marginBottom: 4 }}>{t("codeLabel")}</span>
        <input
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          // Codes are transcribed from paper or a screenshot; autocorrect and
          // auto-capitalisation both corrupt them.
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          style={{ ...styles.input, fontFamily: "ui-monospace, monospace", letterSpacing: 2 }}
        />
      </label>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !code.trim()}
        style={{ ...styles.button, opacity: busy || !code.trim() ? 0.5 : 1 }}
      >
        {busy ? t("submitting") : t("submit")}
      </button>
    </div>
  );
}
