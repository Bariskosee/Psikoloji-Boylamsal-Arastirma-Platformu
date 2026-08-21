"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import type {
  ProtocolDetail,
  ProtocolListResponse,
  ProtocolSummary,
  StudyResponse,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, StatusBadge, TableScroll, styles } from "@/lib/ui";

/**
 * The study's protocols.
 *
 * A protocol is a stable label; what a participant is bound to at enrollment is
 * one of its versions. The list therefore shows the draft's step count and the
 * highest published version, because "is this schedule live yet" is the
 * question a researcher actually has when scanning it.
 */
export default function ProtocolsPage() {
  const t = useTranslations("protocols");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [protocols, setProtocols] = useState<ProtocolSummary[] | null>(null);
  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const [list, loadedStudy] = await Promise.all([
        api.get<ProtocolListResponse>(`/api/studies/${studyId}/protocols`),
        api.get<StudyResponse>(`/api/studies/${studyId}`),
      ]);
      setProtocols(list.protocols);
      setStudy(loadedStudy);
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      const denied = caught instanceof ApiError && (caught.status === 403 || caught.status === 404);
      setError(denied ? t("errors.forbidden") : t("errors.load"));
      setStatus("error");
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
      const created = await api.post<ProtocolDetail>(`/api/studies/${studyId}/protocols`, {
        name: name.trim(),
        description: description.trim(),
      });
      router.push(`/studies/${studyId}/protocols/${created.id}`);
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
            <label htmlFor="protocol-name" style={styles.label}>
              {t("name")}
            </label>
            <input
              id="protocol-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              style={styles.input}
            />
          </div>
          <div style={styles.field}>
            <label htmlFor="protocol-description" style={styles.label}>
              {t("description")}
            </label>
            <textarea
              id="protocol-description"
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

      {status === "error" ? null : protocols === null ? (
        <p>{t("loading")}</p>
      ) : protocols.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <TableScroll label={t("title")}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.cell}>{t("name")}</th>
                <th style={styles.cell}>{t("draft")}</th>
                <th style={styles.cell}>{t("published")}</th>
              </tr>
            </thead>
            <tbody>
              {protocols.map((protocol) => (
                <tr key={protocol.id}>
                  <td style={styles.cell}>
                    <Link href={`/studies/${studyId}/protocols/${protocol.id}`}>
                      {protocol.name}
                    </Link>
                  </td>
                  <td style={styles.cell}>{t("stepCount", { count: protocol.draft.stepCount })}</td>
                  <td style={styles.cell}>
                    {protocol.latestPublished ? (
                      <StatusBadge
                        status={`v${String(protocol.latestPublished.versionNumber ?? "?")}`}
                      />
                    ) : (
                      <span style={{ color: "#5b6472" }}>{t("neverPublished")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}
