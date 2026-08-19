"use client";

import { useState } from "react";
import type { Locale, QuestionnaireVersionDetail } from "@lpr/contracts";
import { tokens } from "@lpr/ui";
import { groupByPage } from "@/lib/questionnaire";
import { QuestionPreview } from "./QuestionPreview";

/**
 * The participant's-eye view, one page at a time, at phone width.
 *
 * ── Why the frame is fixed at 390px ──────────────────────────────────────────
 * Participants answer on phones (AGENT.md §3.5), and the failure this pane
 * exists to prevent is a researcher writing a twelve-word Likert anchor that
 * wraps into unreadability on a real device. A preview that inherits the
 * dashboard's desktop width would hide exactly that. 390px is the iPhone 14/15
 * logical width and a reasonable stand-in for the narrow end of Android too.
 *
 * Paging comes from `pageIndex`, the same field the participant runtime will
 * read — so what a researcher checks here is the grouping that will actually
 * ship, not an approximation of it.
 */
export function PreviewPane({
  version,
  locale,
  labels,
}: {
  version: QuestionnaireVersionDetail;
  locale: Locale;
  labels: {
    empty: string;
    page: string;
    of: string;
    previous: string;
    next: string;
    required: string;
    untranslated: string;
    submit: string;
  };
}) {
  const pages = groupByPage(version.questions);
  const [pageNumber, setPageNumber] = useState(0);
  const current = pages[Math.min(pageNumber, Math.max(pages.length - 1, 0))];

  return (
    <div>
      <div
        style={{
          width: 390,
          maxWidth: "100%",
          margin: "0 auto",
          border: "1px solid #b6bcc4",
          borderRadius: 24,
          overflow: "hidden",
          background: "#fff",
        }}
      >
        {!current ? (
          <p style={{ padding: tokens.spacing.lg, color: "#5b6472" }}>{labels.empty}</p>
        ) : (
          <>
            <div
              style={{
                padding: tokens.spacing.sm,
                background: "#f4f5f7",
                borderBottom: "1px solid #e6e8eb",
                fontSize: 13,
                color: "#5b6472",
                textAlign: "center",
              }}
            >
              {labels.page} {pages.indexOf(current) + 1} {labels.of} {pages.length}
            </div>
            <ul style={{ margin: 0, padding: 0 }}>
              {current.questions.map((question, index) => (
                <QuestionPreview
                  key={question.id}
                  question={question}
                  locale={locale}
                  index={index + 1}
                  requiredLabel={labels.required}
                  untranslatedLabel={labels.untranslated}
                />
              ))}
            </ul>
            <div style={{ padding: tokens.spacing.md }}>
              {/* Inert, like every control in the preview — see QuestionPreview. */}
              <button type="button" disabled style={submitStyle}>
                {labels.submit}
              </button>
            </div>
          </>
        )}
      </div>

      {pages.length > 1 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: tokens.spacing.sm,
            marginTop: tokens.spacing.sm,
          }}
        >
          <button
            type="button"
            onClick={() => setPageNumber((value) => Math.max(0, value - 1))}
            disabled={pages.indexOf(current!) === 0}
            style={navStyle}
          >
            ← {labels.previous}
          </button>
          <button
            type="button"
            onClick={() => setPageNumber((value) => Math.min(pages.length - 1, value + 1))}
            disabled={pages.indexOf(current!) === pages.length - 1}
            style={navStyle}
          >
            {labels.next} →
          </button>
        </div>
      ) : null}
    </div>
  );
}

const submitStyle = {
  width: "100%",
  minHeight: tokens.touchTargetMinPx,
  borderRadius: tokens.radiusPx,
  border: "1px solid #b6bcc4",
  background: "#e6e8eb",
  color: "#5b6472",
  fontSize: 16,
} as const;

const navStyle = {
  minHeight: 36,
  padding: `4px ${tokens.spacing.sm}px`,
  borderRadius: tokens.radiusPx,
  border: "1px solid #b6bcc4",
  background: "#fff",
  cursor: "pointer",
} as const;
