"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { ClipboardList, Plus } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import type {
  QuestionnaireDetail,
  QuestionnaireListResponse,
  QuestionnaireSummary,
  StudyResponse,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollAreaX } from "@/components/ui/scroll-area-x";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorBanner, ErrorState, LoadingTable } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
  /**
   * Tracked separately from `questionnaires`, not derived from it being null.
   * A failed load leaves the list null forever, so "null means still loading"
   * renders the error banner and a spinner together and never resolves — the
   * screen a VIEWER used to get, since this resource requires EDITOR.
   */
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const [list, loadedStudy] = await Promise.all([
        api.get<QuestionnaireListResponse>(`/api/studies/${studyId}/questionnaires`),
        api.get<StudyResponse>(`/api/studies/${studyId}`),
      ]);
      setQuestionnaires(list.questionnaires);
      setStudy(loadedStudy);
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      // 403 and 404 are the same answer here: the guard collapses "not a
      // member" into "no such study" deliberately, so tell the researcher they
      // lack access rather than implying the platform is broken.
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
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ErrorBanner>{error}</ErrorBanner>

      {canEdit ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("create")}</CardTitle>
            <CardDescription>{t("nameHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-56 flex-1 gap-2">
                <Label htmlFor="questionnaire-name">{t("name")}</Label>
                <Input
                  id="questionnaire-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid min-w-56 flex-1 gap-2">
                <Label htmlFor="questionnaire-description">{t("description")}</Label>
                <Textarea
                  id="questionnaire-description"
                  rows={1}
                  className="min-h-9"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <Button type="button" onClick={create} disabled={creating || !name.trim()}>
                <Plus />
                {creating ? t("creating") : t("create")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {status === "loading" ? <LoadingTable rows={3} columns={3} /> : null}

      {status === "error" ? (
        <ErrorState
          title={error ?? t("errors.load")}
          onRetry={() => void load()}
          retryLabel={t("retry")}
        />
      ) : null}

      {status === "ready" && questionnaires?.length === 0 ? (
        <EmptyState icon={ClipboardList} title={t("empty")} description={t("emptyHint")} />
      ) : null}

      {status === "ready" && questionnaires && questionnaires.length > 0 ? (
        <Card className="overflow-hidden py-0">
          <CardContent className="px-0">
            <ScrollAreaX label={t("title")}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("name")}</TableHead>
                    <TableHead>{t("draft")}</TableHead>
                    <TableHead>{t("published")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {questionnaires.map((questionnaire) => (
                    <TableRow key={questionnaire.id} className="relative">
                      <TableCell className="font-medium">
                        <Link
                          href={`/studies/${studyId}/questionnaires/${questionnaire.id}`}
                          className="after:absolute after:inset-0 focus-visible:outline-none"
                        >
                          {questionnaire.name}
                        </Link>
                        {questionnaire.description ? (
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {questionnaire.description}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t("questionCount", { count: questionnaire.draft.questionCount })}
                      </TableCell>
                      <TableCell>
                        {questionnaire.latestPublished ? (
                          /*
                            A published version is the thing a protocol can
                            point at, so it reads as a positive state rather
                            than as a neutral chip.
                          */
                          <StatusBadge tone="success">
                            v{questionnaire.latestPublished.versionNumber ?? "?"}
                          </StatusBadge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            {t("neverPublished")}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollAreaX>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
