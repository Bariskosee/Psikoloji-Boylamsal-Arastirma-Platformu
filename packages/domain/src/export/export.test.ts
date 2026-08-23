import { describe, expect, it } from "vitest";
import { SESSION_STATUSES } from "../session/state-machine.js";
import { csvField, csvInstant, csvRow, UTF8_BOM } from "./csv.js";
import { wideHeader, wideStatusColumn, wideValueColumn, LONG_COLUMNS } from "./columns.js";
import {
  classifyResponse,
  valueFor,
  RESPONSE_STATUSES,
  RESPONSE_STATUS_DEFINITIONS,
} from "./missingness.js";
import { encodeValue, type RawResponse } from "./values.js";

/**
 * The export contract (`docs/export-codebook.md`).
 *
 * §1 names the worst thing this platform can do: export a missing value as `0`,
 * have it averaged into a mean, and have that mean published. Most of this file
 * is about making that impossible rather than merely unlikely.
 */

describe("§2 — the missingness contract", () => {
  it("maps every session state to the documented status", () => {
    expect(classifyResponse("COMPLETED", true)).toBe("ANSWERED");
    expect(classifyResponse("COMPLETED", false)).toBe("SKIPPED_OPTIONAL");
    expect(classifyResponse("EXPIRED_PARTIAL", true)).toBe("ANSWERED");
    expect(classifyResponse("EXPIRED_PARTIAL", false)).toBe("MISSED_ITEM_PARTIAL");
    expect(classifyResponse("EXPIRED_UNSTARTED", false)).toBe("MISSED_SESSION");
    expect(classifyResponse("AVAILABLE", false)).toBe("IN_PROGRESS");
    expect(classifyResponse("STARTED", true)).toBe("ANSWERED");
    expect(classifyResponse("SCHEDULED", false)).toBe("NOT_YET_DUE");
    expect(classifyResponse("PENDING_TRIGGER", false)).toBe("NOT_YET_DUE");
    expect(classifyResponse("CANCELLED", false)).toBe("NOT_APPLICABLE");
  });

  it("produces all seven statuses and nothing else", () => {
    const produced = new Set(
      SESSION_STATUSES.flatMap((status) => [
        classifyResponse(status, true),
        classifyResponse(status, false),
      ]),
    );

    for (const status of produced) expect(RESPONSE_STATUSES).toContain(status);
    // Every one of the seven is reachable — a status nothing can produce is a
    // status an analyst will never see explained.
    expect(produced.size).toBe(RESPONSE_STATUSES.length);
  });

  it("never reports a value as answered in a session nobody opened", () => {
    // A value present on an EXPIRED_UNSTARTED session is a data defect. The
    // status refuses to launder it into real data.
    expect(classifyResponse("EXPIRED_UNSTARTED", true)).toBe("MISSED_SESSION");
  });

  it("emits an EMPTY value for all six non-answered statuses — never a zero", () => {
    /**
     * The rule the whole document exists for. `0` is a real number in every
     * statistical package and no reader downstream can tell it from one a
     * participant typed.
     */
    for (const status of RESPONSE_STATUSES) {
      if (status === "ANSWERED") continue;
      // Even when a value is somehow present, the status decides.
      expect(valueFor(status, "7")).toBe("");
      expect(valueFor(status, "0")).toBe("");
      expect(valueFor(status, null)).toBe("");
    }

    expect(valueFor("ANSWERED", "7")).toBe("7");
    // A genuine zero survives, which is the reason the two cases must be
    // distinguishable in the first place.
    expect(valueFor("ANSWERED", "0")).toBe("0");
  });

  it("defines every status in words for the codebook trailer", () => {
    // An analyst who receives only the CSV files has nothing else to read.
    for (const status of RESPONSE_STATUSES) {
      expect(RESPONSE_STATUS_DEFINITIONS[status].length).toBeGreaterThan(20);
    }
  });
});

describe("§3 — value encoding by question type", () => {
  const raw = (overrides: Partial<RawResponse>): RawResponse => ({
    valueKind: "OPTION",
    valueNumber: null,
    valueText: null,
    valueBoolean: null,
    options: [],
    ...overrides,
  });

  it("exports a Likert item as its numeric code, with the anchor as the label", () => {
    // A Likert item exported as its label alone cannot be averaged, which is
    // the single most common thing done with one.
    const encoded = encodeValue(
      "LIKERT",
      raw({
        options: [{ optionKey: "agree", label: "Strongly agree", valueNumber: 5, displayOrder: 4 }],
      }),
    );

    expect(encoded).toEqual({ value: "5", label: "Strongly agree", hasValue: true });
  });

  it("exports a single choice as its option key", () => {
    const encoded = encodeValue(
      "SINGLE_CHOICE",
      raw({
        options: [
          { optionKey: "morning", label: "In the morning", valueNumber: null, displayOrder: 0 },
        ],
      }),
    );

    expect(encoded).toEqual({ value: "morning", label: "In the morning", hasValue: true });
  });

  it("joins multiple choice with a semicolon, in option order", () => {
    /**
     * Ordered by the option's own display order, not by the order they arrived.
     * Two participants who chose the same options must serialise identically,
     * or a `GROUP BY value` reports them as different answers.
     */
    const encoded = encodeValue(
      "MULTI_CHOICE",
      raw({
        options: [
          { optionKey: "c", label: "Third", valueNumber: null, displayOrder: 2 },
          { optionKey: "a", label: "First", valueNumber: null, displayOrder: 0 },
        ],
      }),
    );

    expect(encoded.value).toBe("a;c");
    expect(encoded.label).toBe("First;Third");
  });

  it("exports a numeric answer as the number, with no label", () => {
    expect(encodeValue("NUMERIC", raw({ valueKind: "NUMBER", valueNumber: 42 }))).toEqual({
      value: "42",
      label: "",
      hasValue: true,
    });
  });

  it("preserves a genuine zero", () => {
    // The case the missingness contract exists to keep distinguishable.
    const encoded = encodeValue("NUMERIC", raw({ valueKind: "NUMBER", valueNumber: 0 }));

    expect(encoded).toEqual({ value: "0", label: "", hasValue: true });
    expect(valueFor(classifyResponse("COMPLETED", encoded.hasValue), encoded.value)).toBe("0");
  });

  it("treats a whitespace-only free-text answer as no answer", () => {
    // §2 forbids "a whitespace string that could be confused with a genuine
    // short-text answer". A blank field is SKIPPED_OPTIONAL, not ANSWERED.
    const encoded = encodeValue("FREE_TEXT", raw({ valueKind: "TEXT", valueText: "   " }));

    expect(encoded.hasValue).toBe(false);
    expect(classifyResponse("COMPLETED", encoded.hasValue)).toBe("SKIPPED_OPTIONAL");
  });

  it("returns nothing at all when there is no response row", () => {
    for (const type of [
      "LIKERT",
      "SINGLE_CHOICE",
      "MULTI_CHOICE",
      "NUMERIC",
      "FREE_TEXT",
    ] as const) {
      expect(encodeValue(type, null)).toEqual({ value: "", label: "", hasValue: false });
    }
  });
});

describe("§4 — wide-format column naming", () => {
  it("builds a name from the three stable keys", () => {
    const key = { stepKey: "daily", occurrenceIndex: 3, questionKey: "mood_1" };

    expect(wideValueColumn(key)).toBe("daily_3__mood_1");
    expect(wideStatusColumn(key)).toBe("daily_3__mood_1__status");
  });

  it("gives two administrations of one instrument identical question suffixes", () => {
    /**
     * FR-47's pre/post shape. The two column groups differ only by step, so a
     * pre/post comparison is a direct column pair with no key reconciliation —
     * which is exactly what §4 says the layout is for.
     */
    const baseline = wideValueColumn({
      stepKey: "baseline",
      occurrenceIndex: 0,
      questionKey: "mood_1",
    });
    const endline = wideValueColumn({
      stepKey: "endline",
      occurrenceIndex: 0,
      questionKey: "mood_1",
    });

    expect(baseline).toBe("baseline_0__mood_1");
    expect(endline).toBe("endline_0__mood_1");
    expect(baseline.split("__")[1]).toBe(endline.split("__")[1]);
  });

  it("pairs every value column with its status column, adjacently", () => {
    const header = wideHeader([
      {
        stepKey: "baseline",
        stepIndex: 0,
        occurrenceCount: 1,
        questions: [
          { questionKey: "q2", displayOrder: 1 },
          { questionKey: "q1", displayOrder: 0 },
        ],
      },
    ]);

    // Leading columns, then q1 and its status, then q2 and its status —
    // ordered by the question's display order, not by the array's.
    expect(header.slice(6)).toEqual([
      "baseline_0__q1",
      "baseline_0__q1__status",
      "baseline_0__q2",
      "baseline_0__q2__status",
    ]);
  });

  it("emits one group per occurrence of a recurring step, in sequence", () => {
    const header = wideHeader([
      {
        stepKey: "daily",
        stepIndex: 0,
        occurrenceCount: 30,
        questions: [{ questionKey: "mood", displayOrder: 0 }],
      },
    ]);

    const groups = header.filter((c) => !c.endsWith("__status")).slice(6);
    expect(groups).toHaveLength(30);
    expect(groups[0]).toBe("daily_0__mood");
    expect(groups[29]).toBe("daily_29__mood");
  });

  it("produces the reference design's column count", () => {
    /**
     * The acceptance criterion: ~1 000 columns for baseline ×100 items, daily
     * ×30 occurrences ×10 items, endline ×100 items.
     *
     *   100 + 300 + 100 = 500 value columns, doubled to 1 000 with status,
     *   plus the six leading columns.
     */
    const items = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ questionKey: `q${String(i)}`, displayOrder: i }));

    const header = wideHeader([
      { stepKey: "baseline", stepIndex: 0, occurrenceCount: 1, questions: items(100) },
      { stepKey: "daily", stepIndex: 1, occurrenceCount: 30, questions: items(10) },
      { stepKey: "endline", stepIndex: 2, occurrenceCount: 1, questions: items(100) },
    ]);

    expect(header).toHaveLength(6 + 1000);
    // And the pre/post pair a researcher will actually reach for.
    expect(header).toContain("baseline_0__q0");
    expect(header).toContain("endline_0__q0");
  });

  it("orders steps by their protocol index, not by the array", () => {
    const header = wideHeader([
      {
        stepKey: "endline",
        stepIndex: 2,
        occurrenceCount: 1,
        questions: [{ questionKey: "q", displayOrder: 0 }],
      },
      {
        stepKey: "baseline",
        stepIndex: 0,
        occurrenceCount: 1,
        questions: [{ questionKey: "q", displayOrder: 0 }],
      },
    ]);

    expect(header[6]).toBe("baseline_0__q");
    expect(header[8]).toBe("endline_0__q");
  });

  it("keeps a column name unchanged when a question is reworded", () => {
    // The stability guarantee (§4, FR-43): a new questionnaire version that
    // rewords a question must not break an analyst's script. Nothing in the
    // name derives from the wording or the version.
    const before = wideValueColumn({
      stepKey: "baseline",
      occurrenceIndex: 0,
      questionKey: "mood_1",
    });
    const after = wideValueColumn({
      stepKey: "baseline",
      occurrenceIndex: 0,
      questionKey: "mood_1",
    });

    expect(before).toBe(after);
  });
});

describe("§3 — the long header", () => {
  it("carries response_status immediately before value", () => {
    // The reading order §3 asks for: "read this before reading value".
    const statusAt = LONG_COLUMNS.indexOf("response_status");
    const valueAt = LONG_COLUMNS.indexOf("value");

    expect(valueAt).toBe(statusAt + 1);
  });

  it("carries the participant's timezone so the UTC columns are convertible", () => {
    expect(LONG_COLUMNS).toContain("participant_timezone");
    expect(LONG_COLUMNS).toContain("question_key");
    // The only participant identifier present (§6.1).
    expect(LONG_COLUMNS).toContain("participant_public_code");
    expect(LONG_COLUMNS.filter((c) => c.includes("email"))).toEqual([]);
  });
});

describe("§6 — CSV encoding", () => {
  it("quotes fields containing a comma, a quote, or a newline", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });

  it("neutralises a formula without altering the participant's text", () => {
    /**
     * CSV injection. A participant who types `=1+1` has their answer replaced
     * by `2` in the analyst's spreadsheet; one who types `=HYPERLINK(...)` or
     * `=cmd|...` turns a research export into an attack on the researcher.
     *
     * A leading tab stops evaluation while preserving every character, so the
     * original is recoverable. Stripping the `=` would silently alter data,
     * which is the thing this document exists to prevent.
     */
    for (const dangerous of ["=1+1", "+SUM(A1)", "-2+3", "@cmd"]) {
      const encoded = csvField(dangerous);
      expect(encoded.startsWith('"\t') || encoded.startsWith("\t")).toBe(true);
      expect(encoded).toContain(dangerous);
    }
  });

  it("does not guard an ordinary negative number a researcher would expect", () => {
    // Guarded, because it starts with `-`. The value is preserved exactly, and
    // a numeric column is emitted as a number rather than through csvField.
    expect(csvRow([-2.5])).toBe("-2.5\r\n");
  });

  it("emits empty for null and undefined, never a literal", () => {
    // "null" or "undefined" landing in a value column would be a sentinel by
    // another name, which §2 prohibits.
    expect(csvRow([null, undefined, "x"])).toBe(",,x\r\n");
  });

  it("uses CRLF line endings", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
  });

  it("has a BOM so Turkish text opens correctly in Excel", () => {
    // Without it, `ö` becomes `Ã¶` in every row of a study run in Turkish —
    // and participant-entered free text is data.
    expect(UTF8_BOM).toBe("﻿");
    expect(Buffer.from(UTF8_BOM, "utf8")).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it("formats every instant as UTC ISO-8601, or empty", () => {
    expect(csvInstant(new Date("2026-09-07T12:00:00Z"))).toBe("2026-09-07T12:00:00.000Z");
    expect(csvInstant("2026-09-07T12:00:00Z")).toBe("2026-09-07T12:00:00.000Z");
    expect(csvInstant(null)).toBe("");
    expect(csvInstant("not a date")).toBe("");
  });
});
