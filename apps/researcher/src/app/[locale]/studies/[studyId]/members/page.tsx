"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import {
  STUDY_ROLES,
  type StudyMemberListResponse,
  type StudyMemberResponse,
  type StudyRole,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Study membership — OWNER only, enforced server-side.
 *
 * Phase 2 has no invitation email (that is Phase 12), so a colleague must
 * already hold an account. The API says so explicitly rather than creating a
 * shell account, and this screen surfaces that as its own message.
 */
export default function MembersPage() {
  const t = useTranslations("members");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [members, setMembers] = useState<StudyMemberResponse[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StudyRole>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get<StudyMemberListResponse>(`/api/studies/${studyId}/members`);
      setMembers(response.members);
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

  async function add(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/studies/${studyId}/members`, { email, role });
      setEmail("");
      await load();
    } catch (caught) {
      setError(messageFor(caught, t));
    } finally {
      setPending(false);
    }
  }

  async function changeRole(userId: string, next: StudyRole) {
    setError(null);
    try {
      await api.patch(`/api/studies/${studyId}/members/${userId}`, { role: next });
      await load();
    } catch (caught) {
      setError(messageFor(caught, t));
    }
  }

  async function remove(userId: string) {
    setError(null);
    try {
      await api.delete(`/api/studies/${studyId}/members/${userId}`);
      await load();
    } catch (caught) {
      setError(messageFor(caught, t));
    }
  }

  return (
    <div style={styles.page}>
      <p>
        <Link href={`/studies/${studyId}`}>← {t("backToStudy")}</Link>
      </p>
      <h1>{t("title")}</h1>

      <ErrorBanner>{error}</ErrorBanner>

      <section style={styles.card}>
        <h2>{t("add")}</h2>
        <form onSubmit={add} style={{ display: "flex", gap: 8, flexWrap: "wrap" }} noValidate>
          <div style={{ flex: "1 1 240px" }}>
            <label htmlFor="member-email" style={styles.label}>
              {t("email")}
            </label>
            <input
              id="member-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={styles.input}
            />
          </div>
          <div style={{ flex: "0 1 160px" }}>
            <label htmlFor="member-role" style={styles.label}>
              {t("role")}
            </label>
            <select
              id="member-role"
              value={role}
              onChange={(event) => setRole(event.target.value as StudyRole)}
              style={styles.input}
            >
              {STUDY_ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={pending}
            style={{ ...styles.button, alignSelf: "flex-end" }}
          >
            {t("add")}
          </button>
        </form>
        <p style={{ fontSize: 14, color: "#5b6472" }}>{t("accountRequired")}</p>
      </section>

      <section style={styles.card}>
        <h2>{t("current")}</h2>
        {members === null ? <p>{t("loading")}</p> : null}
        {members && members.length > 0 ? (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.cell}>{t("name")}</th>
                <th style={styles.cell}>{t("email")}</th>
                <th style={styles.cell}>{t("role")}</th>
                <th style={styles.cell} />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td style={styles.cell}>{member.displayName}</td>
                  <td style={styles.cell}>{member.email}</td>
                  <td style={styles.cell}>
                    <select
                      aria-label={t("role")}
                      value={member.role}
                      onChange={(event) =>
                        changeRole(member.userId, event.target.value as StudyRole)
                      }
                      style={{ ...styles.input, minHeight: 36 }}
                    >
                      {STUDY_ROLES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={styles.cell}>
                    <button
                      type="button"
                      onClick={() => remove(member.userId)}
                      style={styles.secondaryButton}
                    >
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}

function messageFor(error: unknown, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t("errors.unknown");
  switch (error.code) {
    case "NOT_FOUND":
      return t("errors.noAccount");
    case "CONFLICT":
      return t("errors.alreadyMember");
    case "LAST_OWNER_REQUIRED":
      // The rule exists so a study can never end up with nobody able to
      // administer it — worth saying plainly rather than as a generic failure.
      return t("errors.lastOwner");
    case "STUDY_ROLE_REQUIRED":
      return t("errors.forbidden");
    default:
      return t("errors.unknown");
  }
}
