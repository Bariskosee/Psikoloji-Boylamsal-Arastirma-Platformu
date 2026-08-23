"use client";

import { useTranslations } from "next-intl";
import { cva, type VariantProps } from "class-variance-authority";
import type { ParticipantStatus, SessionStatusValue, StudyStatus } from "@lpr/contracts";
import { cn } from "@/lib/utils";

/**
 * Status, coloured by what it MEANS rather than by what looks nice.
 *
 * ── Why colour is never the only signal ─────────────────────────────────────
 * Every badge carries its translated word. Roughly one man in twelve cannot
 * reliably separate red from amber, and a compliance dashboard read as "the
 * green ones are fine" by somebody who cannot see green is a dashboard that
 * misreports a study. The colour is an accelerant for people who can use it,
 * never the carrier of the fact.
 *
 * ── Why the mapping is centralised ──────────────────────────────────────────
 * A status that is amber on the monitoring page and grey on the participant
 * page is not a style inconsistency, it is two different claims about the same
 * session. These maps are the single answer.
 */
const badge = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground border-transparent",
        info: "bg-info-muted text-info-muted-foreground border-transparent",
        success: "bg-success-muted text-success-muted-foreground border-transparent",
        warning: "bg-warning-muted text-warning-muted-foreground border-transparent",
        danger: "bg-danger-muted text-danger-muted-foreground border-transparent",
        outline: "text-foreground border-border bg-transparent",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type StatusTone = NonNullable<VariantProps<typeof badge>["tone"]>;

/**
 * A study's lifecycle.
 *
 * ACTIVE is the only one that is "good news" — the rest are states of not
 * collecting data, and PAUSED is amber rather than grey because a study nobody
 * meant to leave paused is one of the quieter ways to lose a fortnight.
 */
const STUDY_TONES: Record<StudyStatus, StatusTone> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  PAUSED: "warning",
  CLOSED: "info",
  ARCHIVED: "neutral",
};

/**
 * A participant session.
 *
 * ── Why "missed" is amber and not red ───────────────────────────────────────
 * A missed session is ordinary in longitudinal research and it is DATA, not an
 * error. `docs/compliance-formula.md` is emphatic that a non-response is a
 * measurement; painting it red trains a researcher to read normal attrition as
 * a fault, and to "fix" it.
 *
 * The two expiries keep their own labels rather than collapsing into one
 * badge. "Never opened" and "opened and abandoned partway" are different facts
 * about a participant, they drive different follow-up, and the export codebook
 * treats them as different missingness statuses. A single "Missed" pill would
 * throw that away on the one screen where somebody might act on it.
 */
const SESSION_TONES: Record<SessionStatusValue, StatusTone> = {
  PENDING_TRIGGER: "neutral",
  SCHEDULED: "neutral",
  AVAILABLE: "info",
  STARTED: "info",
  COMPLETED: "success",
  EXPIRED_UNSTARTED: "warning",
  EXPIRED_PARTIAL: "warning",
  CANCELLED: "neutral",
};

export function StatusBadge({
  children,
  tone,
  className,
}: {
  children: React.ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  return <span className={cn(badge({ tone }), className)}>{children}</span>;
}

export function StudyStatusBadge({ status }: { status: StudyStatus }) {
  const t = useTranslations("studies");
  return <StatusBadge tone={STUDY_TONES[status]}>{t(`statuses.${status}`)}</StatusBadge>;
}

export function SessionStatusBadge({ status }: { status: SessionStatusValue }) {
  const t = useTranslations("analytics");
  return <StatusBadge tone={SESSION_TONES[status]}>{t(`sessionStatus.${status}`)}</StatusBadge>;
}

/**
 * A participant's standing in the study.
 *
 * It was rendered as the raw enum — a Turkish dashboard showing the word
 * "ACTIVE" in a column of otherwise translated text. The platform already
 * fixed this class of defect for study statuses; the participant list was
 * missed.
 *
 * COMPLETED is the good outcome here, not ACTIVE: somebody who finished the
 * protocol is the point of the study, and somebody still active is simply
 * still going.
 */
const PARTICIPANT_TONES: Record<ParticipantStatus, StatusTone> = {
  ACTIVE: "info",
  COMPLETED: "success",
  WITHDRAWN: "neutral",
};

export function ParticipantStatusBadge({ status }: { status: ParticipantStatus }) {
  const t = useTranslations("analytics");
  return (
    <StatusBadge tone={PARTICIPANT_TONES[status]}>{t(`participantStatus.${status}`)}</StatusBadge>
  );
}
