import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ProtocolPreviewResponse } from "@lpr/contracts";
import { withIntl } from "../questionnaire/test-intl";
import { TimelinePreview } from "./TimelinePreview";

/**
 * The preview is the researcher's only defence against misconfiguring a study
 * (PLAN.md Phase 4), so what it must never do is stay silent about a
 * measurement a participant can lose.
 */

const noop = (): void => undefined;

function renderPreview(preview: ProtocolPreviewResponse) {
  render(
    withIntl(
      <TimelinePreview
        preview={preview}
        enrolledAt="2026-09-04T09:12"
        participantTimezone="Europe/Istanbul"
        busy={false}
        onEnrolledAtChange={noop}
        onParticipantTimezoneChange={noop}
        onRefresh={noop}
      />,
    ),
  );
}

const unconditionalStep = {
  stepId: "11111111-1111-4111-8111-111111111111",
  stepKey: "baseline",
  questionnaireVersionId: "22222222-2222-4222-8222-222222222222",
  dependency: "UNCONDITIONAL" as const,
  dependsOnCompletionOf: [],
  occurrences: [
    {
      occurrenceIndex: 0,
      availableFrom: "2026-09-04T09:12:00.000Z",
      availableUntil: "2026-09-07T09:12:00.000Z",
      adjustment: "NONE" as const,
    },
  ],
  unresolvedReason: null,
};

describe("TimelinePreview", () => {
  it("shows the computed window for an unconditional step", () => {
    renderPreview({ steps: [unconditionalStep], totalOccurrences: 1 });

    expect(screen.getByText(/2026-09-04 09:12:00Z/)).toBeTruthy();
    expect(screen.getByText("Unconditional")).toBeTruthy();
  });

  it("names what a conditional step depends on, and says what missing it costs", () => {
    // FR-48b: the label is informational, but the consequence has to be stated
    // in words — that is the whole point of showing it before publish.
    renderPreview({
      steps: [
        {
          ...unconditionalStep,
          stepKey: "endline",
          dependency: "CONDITIONAL",
          dependsOnCompletionOf: ["baseline"],
          occurrences: null,
          unresolvedReason: "PREREQUISITE_NOT_COMPLETED",
        },
      ],
      totalOccurrences: 0,
    });

    expect(screen.getByText("Depends on baseline")).toBeTruthy();
    expect(screen.getByText(/does not complete baseline never receives this step/)).toBeTruthy();
    expect(screen.getByText(/the step it waits on was not completed/)).toBeTruthy();
  });

  it("collapses a long recurring block instead of listing thirty rows", () => {
    const occurrences = Array.from({ length: 30 }, (_, index) => ({
      occurrenceIndex: index,
      availableFrom: `2026-09-${String(7 + index).padStart(2, "0")}T17:00:00.000Z`,
      availableUntil: `2026-09-${String(8 + index).padStart(2, "0")}T05:00:00.000Z`,
      adjustment: "NONE" as const,
    }));

    renderPreview({
      steps: [{ ...unconditionalStep, stepKey: "daily", occurrences }],
      totalOccurrences: 30,
    });

    expect(screen.getByText(/and 26 more/)).toBeTruthy();
  });

  it("surfaces a daylight-saving adjustment rather than hiding it", () => {
    renderPreview({
      steps: [
        {
          ...unconditionalStep,
          occurrences: [{ ...unconditionalStep.occurrences[0]!, adjustment: "SPRING_FORWARD_GAP" }],
        },
      ],
      totalOccurrences: 1,
    });

    expect(screen.getByText(/does not exist on this day/)).toBeTruthy();
  });

  it("explains a participant-initiated step having no scheduled time", () => {
    renderPreview({
      steps: [
        {
          ...unconditionalStep,
          occurrences: null,
          unresolvedReason: "PARTICIPANT_INITIATED",
        },
      ],
      totalOccurrences: 0,
    });

    expect(screen.getByText(/Started by the participant/)).toBeTruthy();
  });
});
