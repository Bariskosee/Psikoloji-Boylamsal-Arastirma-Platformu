"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import type {
  QuestionnaireDetail,
  QuestionnaireListResponse,
  QuestionnaireSummary,
  StudyResponse,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, StatusBadge, styles } from "@/lib/ui";

/**
 * The study's questionnaires.
 *
 * A questionnaire is a stable label; what a participant answers is one of its
 * versions. This list therefore shows both the draft (always present, always
 * editable) and the highest published version, because "has this been
 * published yet" is the question a researcher actually has when scanning it.
 */
export default function QuestionnairesPage() {
  const t = useTranslations("questionnaires");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [questionnaires, setQuestionnaires] = useState<QuestionnaireSummary[] | null>(null);
  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, loadedStudy] = await Promise.all([
        api.get<QuestionnaireListResponse>(`/api/studies/${studyId}/questionnaires`),
        api.get<StudyResponse>(`/api/studies/${studyId}`),
      ]);
      setQuestionnaires(list.questionnaires);
      setStudy(loadedStudy);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      setError(t("errors.load"));
    }
  }, [router, studyId, t]);

  useEffect(() => {
    if (studyId) void load();
  }, [load, studyId]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<QuestionnaireDetail>(
        `/api/studies/${studyId}/questionnaires`,
        { name: name.trim(), description: description.trim() },
      );
      router.push(`/studies/${studyId}/questionnaires/${created.id}`);
    } catch {
      setError(t("errors.create"));
      setCreating(false);
    }
  }

  const canEdit = study?.viewerRole === "OWNER" || study?.viewerRole === "EDITOR";

  return (
    <div style={styles.page}>
      <p>
        <Link href={`/studies/${studyId}`}>← {t("backToStudy")}</Link>
      </p>
      <h1>{t("title")}</h1>
      <ErrorBanner>{error}</ErrorBanner>

      {canEdit ? (
        <section style={styles.card}>
          <h2 style={{ marginTop: 0 }}>{t("create")}</h2>
          <div style={styles.field}>
            <label htmlFor="questionnaire-name" style={styles.label}>
              {t("name")}
            </label>
            <input
              id="questionnaire-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              style={styles.input}
            />
          </div>
          <div style={styles.field}>
            <label htmlFor="questionnaire-description" style={styles.label}>
              {t("description")}
            </label>
            <textarea
              id="questionnaire-description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              style={{ ...styles.input, minHeight: 60 }}
            />
          </div>
          <button
            type="button"
            onClick={create}
            disabled={creating || !name.trim()}
            style={styles.button}
          >
            {creating ? t("creating") : t("create")}
          </button>
        </section>
      ) : null}

      {questionnaires === null ? (
        <p>{t("loading")}</p>
      ) : questionnaires.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.cell}>{t("name")}</th>
              <th style={styles.cell}>{t("draft")}</th>
              <th style={styles.cell}>{t("published")}</th>
            </tr>
          </thead>
          <tbody>
            {questionnaires.map((questionnaire) => (
              <tr key={questionnaire.id}>
                <td style={styles.cell}>
                  <Link href={`/studies/${studyId}/questionnaires/${questionnaire.id}`}>
                    {questionnaire.name}
                  </Link>
                </td>
                <td style={styles.cell}>
                  {t("questionCount", { count: questionnaire.draft.questionCount })}
                </td>
                <td style={styles.cell}>
                  {questionnaire.latestPublished ? (
                    <StatusBadge
                      status={`v${questionnaire.latestPublished.versionNumber ?? "?"}`}
                    />
                  ) : (
                    <span style={{ color: "#5b6472" }}>{t("neverPublished")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
