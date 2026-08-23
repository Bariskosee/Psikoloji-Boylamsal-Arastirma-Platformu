"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type { EnrollResponse, Locale, PublicStudyResponse } from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * The enrollment gate.
 *
 * Study information, then the consent document, then one explicit affirmative
 * action. The button stays disabled until the box is ticked: consent has to be
 * something the participant DID, not something the interface assumed from their
 * arrival on the page (FR-05).
 *
 * The consent version the participant is shown is sent back with the
 * enrollment, and the server refuses it if a newer one was published while they
 * were reading — agreeing to text that is no longer the study's is not consent.
 */
export default function JoinPage() {
  const t = useTranslations("join");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const code = params?.code ?? "";

  const [study, setStudy] = useState<PublicStudyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [agreed, setAgreed] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStudy(
        await api.get<PublicStudyResponse>(`/api/participant/studies/${code}?locale=${locale}`),
      );
      setStatus("ready");
    } catch {
      // Every failure here is the same answer by design — the API cannot
      // distinguish a wrong code from a study that is not open, and neither
      // can this screen.
      setStatus("missing");
    }
  }, [code, locale]);

  useEffect(() => {
    if (code) void load();
  }, [code, load]);

  async function join() {
    if (!study || !agreed) return;
    setJoining(true);
    setError(null);
    try {
      const enrolled = await api.post<EnrollResponse>(`/api/participant/studies/${code}/enroll`, {
        consentVersionId: study.consent.versionId,
        consented: true,
        consentLocale: locale,
        locale,
        // Read from the device rather than asked: the participant should not
        // have to know their IANA zone, and every wall-clock schedule depends
        // on getting it right.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      });

      // Carried in memory to the confirmation screen, never persisted. The
      // recovery code exists in exactly one place after this: wherever the
      // participant chooses to put it.
      sessionStorage.setItem(
        "lpr_enrollment",
        JSON.stringify({ publicCode: enrolled.publicCode, recoveryCode: enrolled.recoveryCode }),
      );
      router.replace("/welcome");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CONSENT_VERSION_STALE") {
        setError(t("consentStale"));
        await load();
      } else {
        setError(t("error"));
      }
      setJoining(false);
    }
  }

  if (status === "loading") return <p style={styles.page}>{t("loading")}</p>;
  if (status === "missing" || !study) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("notFound")}</ErrorBanner>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>{study.name}</h1>

      {study.description ? (
        <section style={styles.card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("aboutTitle")}</h2>
          <p style={styles.prose}>{study.description}</p>
        </section>
      ) : null}

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{study.consent.title}</h2>
        <p style={{ color: "var(--muted-foreground)" }}>{t("readCarefully")}</p>
        {/* Plain text, rendered as text. The document is stored without markup
            precisely so there is nothing here to interpret. */}
        <div style={styles.prose}>{study.consent.body}</div>
      </section>

      <ErrorBanner>{error}</ErrorBanner>

      {study.acceptingEnrollments ? (
        <>
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
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              style={{ width: 24, height: 24, marginTop: 2 }}
            />
            <span style={{ fontSize: 16 }}>{t("agree")}</span>
          </label>

          <button
            type="button"
            onClick={() => void join()}
            disabled={!agreed || joining}
            style={{ ...styles.button, opacity: agreed && !joining ? 1 : 0.5 }}
          >
            {joining ? t("joining") : t("continue")}
          </button>
        </>
      ) : (
        <ErrorBanner>{t("closed")}</ErrorBanner>
      )}
    </div>
  );
}
