"use client";

import { useTranslations } from "next-intl";
import type { ComplianceFigure, StepComplianceSummary } from "@lpr/contracts";
import { cn } from "@/lib/utils";

/**
 * How a compliance figure is rendered — the only place that decides.
 *
 * `docs/compliance-formula.md` opens by forbidding any formula from being
 * re-implemented in a dashboard component, and nothing here computes one: the
 * server sends `{ numerator, denominator, percent }` straight from
 * `packages/domain/src/compliance`. What this file owns is the *presentation*
 * rules, which are just as easy to get wrong in three places:
 *
 *  1. **`percent: null` is never rendered as 0%.** Zero percent means "had
 *     opportunities and took none" — a materially different claim about a
 *     person from "nothing has come due yet" (§5). The null branch is first so
 *     it cannot be fallen through.
 *  2. **The denominator is always shown.** PLAN.md Phase 10 requires it
 *     displayed rather than hidden, and §1 explains why: it is the part of a
 *     compliance claim most often left implicit and the part that moves the
 *     number most. "80%" over ten sessions and over two are different claims.
 *  3. **A single-occurrence step never gets a percentage.** "Did they do the
 *     endline?" is a yes-or-no question, and 100% is a category error that
 *     makes a table of anchors and blocks unreadable (§6).
 *
 * ── The bar, and why it does not replace the number ─────────────────────────
 * A column of percentages is hard to scan; a bar is not. But a bar alone
 * cannot carry a denominator, and a denominator is the thing §1 says must not
 * be dropped. So the bar is decoration behind the figure — `aria-hidden`,
 * because a screen reader that announced it would read the number twice — and
 * the text remains the source of truth.
 */
export function ComplianceFigureView({
  figure,
  label,
  showBar = false,
}: {
  figure: ComplianceFigure;
  label?: string;
  showBar?: boolean;
}) {
  const t = useTranslations("analytics");

  if (figure.percent === null) {
    return (
      <span className="text-muted-foreground" title={t("notApplicableHint")}>
        {t("notApplicable")}
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 flex-col gap-1">
      <span className="whitespace-nowrap">
        <strong className="tabular-nums">{figure.percent}%</strong>{" "}
        {/*
          The denominator, always. Not a tooltip and not an expander — a figure
          whose basis is one click away is a figure people quote without it.
        */}
        <span className="text-muted-foreground text-xs tabular-nums">
          ({figure.numerator}/{figure.denominator}
          {label === undefined ? "" : ` ${label}`})
        </span>
      </span>
      {showBar ? (
        <span aria-hidden className="bg-muted block h-1 w-16 overflow-hidden rounded-full">
          <span
            className={cn(
              "block h-full rounded-full",
              figure.percent >= 80
                ? "bg-success"
                : figure.percent >= 50
                  ? "bg-warning"
                  : "bg-danger",
            )}
            style={{ width: `${String(figure.percent)}%` }}
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * One step's figure, rendered according to its kind.
 *
 * `ADHERENCE` gets a percentage; `COMPLETION` gets a word. The server decides
 * which, so this component cannot accidentally print "0%" against an endline
 * the participant has not reached yet.
 */
export function StepFigureView({ step }: { step: StepComplianceSummary }) {
  const t = useTranslations("analytics");

  if (!step.countsTowardCompliance) {
    // Excluded by the researcher's own configuration. Shown rather than hidden,
    // because a step missing from the table looks like a bug.
    return <span className="text-muted-foreground">{t("notCounted")}</span>;
  }

  if (step.kind === "ADHERENCE") {
    return <ComplianceFigureView figure={step.compliance} showBar />;
  }

  const state = step.state ?? "NOT_YET_DUE";

  return (
    <span
      className={cn(
        "whitespace-nowrap",
        state === "COMPLETED" && "text-success-muted-foreground font-medium",
        // Amber rather than red: a missed measurement is data, not a fault.
        state === "MISSED" && "text-warning-muted-foreground font-medium",
        state !== "COMPLETED" && state !== "MISSED" && "text-muted-foreground",
      )}
    >
      {t(`state${state}`)}
    </span>
  );
}
