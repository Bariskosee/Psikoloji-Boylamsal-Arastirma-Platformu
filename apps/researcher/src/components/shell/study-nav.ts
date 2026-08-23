import type { StudyRole } from "@lpr/contracts";

/**
 * The sections of a study, and who may see each.
 *
 * ── Why this is data in one file rather than JSX in the sidebar ─────────────
 * The visibility rules were previously spread across the study overview page
 * as a run of conditional `<p><Link/></p>` blocks, each with its own comment
 * explaining the rule. They were correct, and they were unverifiable: nothing
 * connected them to the permissions the server actually enforces, and a sixth
 * link added later would have had to rediscover the reasoning.
 *
 * As data it is testable — `study-nav.test.ts` pins every row against the
 * permission matrix in REQUIREMENTS.md §5.2 — and the sidebar becomes a loop.
 *
 * ── Hiding is not authorization ─────────────────────────────────────────────
 * Every one of these is re-checked server-side (NFR-04). What this controls is
 * whether a researcher is OFFERED a door they cannot open, because a link that
 * always 403s teaches people to ignore links.
 */
export type StudySectionId =
  | "overview"
  | "questionnaires"
  | "protocols"
  | "participants"
  | "monitoring"
  | "analytics"
  | "export"
  | "members";

export interface StudySection {
  readonly id: StudySectionId;
  /** Appended to `/studies/{id}`; empty for the overview itself. */
  readonly segment: string;
  /** Key under the `nav` catalogue. */
  readonly labelKey: string;
  readonly icon: StudySectionId;
  /** Roles that may reach it. Mirrors the server's permission checks. */
  readonly roles: readonly StudyRole[];
}

const ALL: readonly StudyRole[] = ["OWNER", "EDITOR", "ANALYST", "VIEWER"];
const EDITORS: readonly StudyRole[] = ["OWNER", "EDITOR"];
/** `export:run` is ANALYST and above — everyone except VIEWER. */
const ANALYSTS: readonly StudyRole[] = ["OWNER", "EDITOR", "ANALYST"];

/**
 * Ordered as a study is actually worked through: set it up, watch it run, then
 * analyse it. Administration sits at the end because it is visited rarely.
 */
export const STUDY_SECTIONS: readonly StudySection[] = [
  { id: "overview", segment: "", labelKey: "overview", icon: "overview", roles: ALL },
  {
    id: "questionnaires",
    segment: "/questionnaires",
    labelKey: "questionnaires",
    icon: "questionnaires",
    // Reads included: every route under `/questionnaires` requires
    // `questionnaire:edit`, which the controller explains.
    roles: EDITORS,
  },
  {
    id: "protocols",
    segment: "/protocols",
    labelKey: "protocols",
    icon: "protocols",
    roles: EDITORS,
  },
  {
    id: "participants",
    segment: "/participants",
    labelKey: "participants",
    icon: "participants",
    roles: ALL,
  },
  {
    id: "monitoring",
    segment: "/monitoring",
    labelKey: "monitoring",
    icon: "monitoring",
    // Aggregate monitoring is open to every member (REQUIREMENTS.md §5.2).
    // The response inspector inside it is ANALYST and refuses on its own.
    roles: ALL,
  },
  { id: "analytics", segment: "/analytics", labelKey: "analytics", icon: "analytics", roles: ALL },
  { id: "export", segment: "/export", labelKey: "export", icon: "export", roles: ANALYSTS },
  { id: "members", segment: "/members", labelKey: "members", icon: "members", roles: ["OWNER"] },
];

export function sectionsFor(role: StudyRole): readonly StudySection[] {
  return STUDY_SECTIONS.filter((section) => section.roles.includes(role));
}

/**
 * Which section a path is in.
 *
 * Longest match wins, so `/studies/x/participants/y` resolves to the
 * participants section rather than to the overview — a breadcrumb that
 * collapses to "Overview" on every detail page is worse than none, because it
 * actively misreports where the reader is.
 */
export function activeSection(pathname: string, studyId: string): StudySectionId | null {
  const base = `/studies/${studyId}`;
  if (!pathname.includes(base)) return null;

  const rest = pathname.slice(pathname.indexOf(base) + base.length);
  let best: StudySection | null = null;
  for (const section of STUDY_SECTIONS) {
    if (section.segment === "") continue;
    if (rest === section.segment || rest.startsWith(`${section.segment}/`)) {
      if (best === null || section.segment.length > best.segment.length) best = section;
    }
  }
  if (best !== null) return best.id;
  return rest === "" || rest === "/" ? "overview" : null;
}
