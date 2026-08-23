"use client";

import { useTranslations } from "next-intl";
import type { ComplianceFigure, StepComplianceSummary } from "@lpr/contracts";

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
 */
export function ComplianceFigureView({
  figure,
  label,
}: {
  figure: ComplianceFigure;
  label?: string;
}) {
  const t = useTranslations("analytics");

  if (figure.percent === null) {
    return (
      <span style={{ color: "#5b6472" }} title={t("notApplicableHint")}>
        {t("notApplicable")}
      </span>
    );
  }

  return (
    <span>
      <strong>{figure.percent}%</strong>{" "}
      {/*
        The denominator, always. Not a tooltip and not an expander — a figure
        whose basis is one click away is a figure people quote without it.
      */}
      <span style={{ color: "#5b6472", fontSize: 13 }}>
        ({figure.numerator}/{figure.denominator}
        {label === undefined ? "" : ` ${label}`})
      </span>
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
    return <span style={{ color: "#5b6472" }}>{t("notCounted")}</span>;
  }

  if (step.kind === "ADHERENCE") {
    return <ComplianceFigureView figure={step.compliance} />;
  }

  const state = step.state ?? "NOT_YET_DUE";
  const colour = state === "COMPLETED" ? "#067647" : state === "MISSED" ? "#b42318" : "#5b6472";

  return (
    <span style={{ color: colour, fontWeight: state === "MISSED" ? 600 : 400 }}>
      {t(`state${state}`)}
    </span>
  );
}
