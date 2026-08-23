"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import type { StudyResponse, StudyStatus } from "@lpr/contracts";
import { ApiError, api, apiUrl } from "@/lib/api";
import { ErrorBanner, StatusBadge, styles } from "@/lib/ui";

/**
 * Study settings, lifecycle, and enrollment materials.
 *
 * What the screen OFFERS is driven by `viewerRole`, but that is presentation
 * only — the server re-checks every operation (NFR-04). Hiding a control is
 * not authorization, so a VIEWER who crafts the request still gets a 403.
 */
export default function StudyPage() {
  const t = useTranslations("studies");
  const tProtocols = useTranslations("protocols");
  const tAnalytics = useTranslations("analytics");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.get<StudyResponse>(`/api/studies/${studyId}`);
      setStudy(loaded);
      setName(loaded.name);
      setDescription(loaded.description);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      // A study the caller cannot see returns the same 404 as one that does
      // not exist, so the interface says the same thing for both.
      setError(t("errors.notFound"));
    }
  }, [router, studyId, t]);

  useEffect(() => {
    if (studyId) void load();
  }, [load, studyId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<StudyResponse>(`/api/studies/${studyId}`, {
        name,
        description,
      });
      setStudy(updated);
    } catch {
      setError(t("errors.save"));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: StudyStatus) {
    setError(null);
    try {
      setStudy(await api.put<StudyResponse>(`/api/studies/${studyId}/status`, { status }));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "INVALID_STUDY_TRANSITION"
          ? t("errors.transition")
          : t("errors.save"),
      );
    }
  }

  if (error && !study) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{error}</ErrorBanner>
        <Link href="/studies">{t("backToList")}</Link>
      </div>
    );
  }

  if (!study) return <p>{t("loading")}</p>;

  const canEdit = study.viewerRole === "OWNER" || study.viewerRole === "EDITOR";
  const canAdminister = study.viewerRole === "OWNER";

  return (
    <div style={styles.page}>
      <p>
        <Link href="/studies">← {t("backToList")}</Link>
      </p>

      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>{study.name}</h1>
        <StatusBadge status={t(`statuses.${study.status}`)} />
      </header>

      <ErrorBanner>{error}</ErrorBanner>

      <section style={styles.card}>
        <h2>{t("enrollment")}</h2>
        <p>
          {t("code")}: <code style={{ fontSize: 20 }}>{study.enrollmentCode}</code>
        </p>
        <p>
          <a href={study.enrollmentUrl} target="_blank" rel="noreferrer">
            {study.enrollmentUrl}
          </a>
        </p>
        {/* The QR is fetched by the browser with the session cookie attached. */}
        <img
          src={apiUrl(`/api/studies/${studyId}/qr`)}
          alt={t("qrAlt")}
          width={180}
          height={180}
          style={{ border: "1px solid #d8dbe0", borderRadius: 8, background: "#fff" }}
        />
      </section>

      <section style={styles.card}>
        <h2>{t("settings")}</h2>
        <div style={styles.field}>
          <label htmlFor="name" style={styles.label}>
            {t("name")}
          </label>
          <input
            id="name"
            value={name}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="description" style={styles.label}>
            {t("description")}
          </label>
          <textarea
            id="description"
            rows={3}
            value={description}
            disabled={!canEdit}
            onChange={(event) => setDescription(event.target.value)}
            style={{ ...styles.input, minHeight: 80 }}
          />
        </div>
        <dl style={{ fontSize: 14, color: "#5b6472" }}>
          <dt style={{ fontWeight: 600 }}>{t("timezone")}</dt>
          <dd style={{ margin: "0 0 8px" }}>{study.timezone}</dd>
          <dt style={{ fontWeight: 600 }}>{t("locales")}</dt>
          <dd style={{ margin: "0 0 8px" }}>
            {study.supportedLocales.join(", ")} ({t("defaultLocale")}: {study.defaultLocale})
          </dd>
          <dt style={{ fontWeight: 600 }}>{t("capacity")}</dt>
          <dd style={{ margin: 0 }}>{study.enrollmentCapacity ?? t("uncapped")}</dd>
        </dl>
        {canEdit ? (
          <button type="button" onClick={save} disabled={saving} style={styles.button}>
            {saving ? t("saving") : t("save")}
          </button>
        ) : null}
      </section>

      {canAdminister ? (
        <section style={styles.card}>
          <h2>{t("lifecycle")}</h2>
          <p style={{ fontSize: 14, color: "#5b6472" }}>{t("lifecycleHint")}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {nextStatuses(study.status).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => changeStatus(status)}
                style={styles.secondaryButton}
              >
                {t(`transitions.${status}`)}
              </button>
            ))}
            {nextStatuses(study.status).length === 0 ? <p>{t("lifecycleTerminal")}</p> : null}
          </div>
        </section>
      ) : null}

      {/*
        EDITOR and above only, matching the server: every route under
        `/questionnaires` requires `questionnaire:edit`, reads included
        (QuestionnaireController explains why). Offering the link to a VIEWER
        sent them to a screen that could only ever fail.
      */}
      {canEdit ? (
        <p>
          <Link href={`/studies/${studyId}/questionnaires`}>{t("manageQuestionnaires")} →</Link>
        </p>
      ) : null}

      {canEdit ? (
        <p>
          <Link href={`/studies/${studyId}/protocols`}>{tProtocols("title")} →</Link>
        </p>
      ) : null}

      {/*
        Monitoring is `analytics:view` and the participant list is
        `participant:view` — both VIEWER (REQUIREMENTS.md §5.2). Unconditional
        here, deliberately: every member of a study may see aggregate
        monitoring, and hiding it from a VIEWER would contradict the API, which
        is the authority. The response inspector, which is ANALYST, is reached
        from a participant's timeline and refuses on its own.
      */}
      <p>
        <Link href={`/studies/${studyId}/monitoring`}>{tAnalytics("title")} →</Link>
      </p>

      <p>
        <Link href={`/studies/${studyId}/participants`}>{tAnalytics("participants")} →</Link>
      </p>

      {canAdminister ? (
        <p>
          <Link href={`/studies/${studyId}/members`}>{t("manageMembers")} →</Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The transitions to offer.
 *
 * Mirrors `nextStudyStatuses` in @lpr/domain, which the server enforces. This
 * copy decides only which buttons appear; an out-of-date copy produces a
 * rejected request, never an illegal transition.
 */
function nextStatuses(status: StudyStatus): StudyStatus[] {
  switch (status) {
    case "DRAFT":
      return ["ACTIVE", "ARCHIVED"];
    case "ACTIVE":
      return ["PAUSED", "CLOSED"];
    case "PAUSED":
      return ["ACTIVE", "CLOSED"];
    case "CLOSED":
      return ["ARCHIVED"];
    case "ARCHIVED":
      return [];
  }
}
