import { describe, expect, it } from "vitest";
import type { StudyRole } from "@lpr/contracts";
import { STUDY_SECTIONS, activeSection, sectionsFor } from "./study-nav";

/**
 * The navigation must offer exactly what the server permits — no more, and no
 * less.
 *
 * Offering MORE trains researchers to ignore links, because some of them
 * always fail. Offering LESS is worse and quieter: a VIEWER who is never shown
 * monitoring concludes the platform does not have it, and nothing anywhere
 * reports that they were wrong.
 *
 * The expectations below are written out per role rather than derived from
 * `STUDY_SECTIONS`, so that a change to the table has to be made twice —
 * deliberately, since this is the file that pins it to REQUIREMENTS.md §5.2.
 */
describe("study navigation by role", () => {
  const ids = (role: StudyRole) => sectionsFor(role).map((section) => section.id);

  it("gives an OWNER everything", () => {
    expect(ids("OWNER")).toEqual([
      "overview",
      "questionnaires",
      "protocols",
      "participants",
      "monitoring",
      "analytics",
      "export",
      "members",
    ]);
  });

  it("gives an EDITOR everything except member administration", () => {
    expect(ids("EDITOR")).toEqual([
      "overview",
      "questionnaires",
      "protocols",
      "participants",
      "monitoring",
      "analytics",
      "export",
    ]);
  });

  /** An ANALYST reads and exports; they do not author instruments. */
  it("gives an ANALYST the reading sections and export, but no authoring", () => {
    expect(ids("ANALYST")).toEqual([
      "overview",
      "participants",
      "monitoring",
      "analytics",
      "export",
    ]);
  });

  /**
   * A VIEWER sees aggregate monitoring — that is deliberate and matches the
   * API — but may not export. Export is every psychological answer in the
   * study, and `export:run` starts at ANALYST.
   */
  it("gives a VIEWER the reading sections and no export", () => {
    expect(ids("VIEWER")).toEqual(["overview", "participants", "monitoring", "analytics"]);
  });

  it("never hides the overview from anybody who can open the study at all", () => {
    for (const role of ["OWNER", "EDITOR", "ANALYST", "VIEWER"] as const) {
      expect(ids(role)).toContain("overview");
    }
  });

  it("has a unique segment per section, so the active match is unambiguous", () => {
    const segments = STUDY_SECTIONS.map((section) => section.segment);
    expect(new Set(segments).size).toBe(segments.length);
  });
});

describe("resolving the active section", () => {
  const STUDY = "11111111-1111-4111-8111-111111111111";

  it("matches the overview at the study root", () => {
    expect(activeSection(`/en/studies/${STUDY}`, STUDY)).toBe("overview");
  });

  it("matches a section at its own path", () => {
    expect(activeSection(`/en/studies/${STUDY}/monitoring`, STUDY)).toBe("monitoring");
  });

  /**
   * The reason `activeSection` takes the longest match rather than the first.
   *
   * A detail page is still inside its section. Collapsing to "overview" there
   * would put the highlight and the breadcrumb on the wrong entry, which
   * actively misreports where the reader is — worse than showing nothing.
   */
  it("stays in the section on a detail page beneath it", () => {
    expect(activeSection(`/en/studies/${STUDY}/participants/abc`, STUDY)).toBe("participants");
    expect(activeSection(`/tr/studies/${STUDY}/questionnaires/q/`, STUDY)).toBe("questionnaires");
  });

  it("is locale-independent", () => {
    expect(activeSection(`/tr/studies/${STUDY}/export`, STUDY)).toBe("export");
  });

  it("returns null outside the study", () => {
    expect(activeSection("/en/studies", STUDY)).toBeNull();
    expect(activeSection("/en/ops", STUDY)).toBeNull();
  });
});
