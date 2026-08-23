import type { QuestionType } from "@lpr/contracts";
import { MULTI_VALUE_SEPARATOR } from "./csv.js";

/**
 * Value encoding by question type (`docs/export-codebook.md` §3).
 *
 * Two columns, deliberately: `value` is what an analysis computes on, and
 * `value_label` is what a human reads. Collapsing them would force one of the
 * two audiences to do a lookup on every row — and an analyst who computes a
 * mean over labels gets nothing, while a reader shown option keys gets an
 * unintelligible table.
 */

export interface SelectedOption {
  readonly optionKey: string;
  readonly label: string;
  /** The numeric code a Likert anchor carries; null for a plain choice. */
  readonly valueNumber: number | null;
  readonly displayOrder: number;
}

export interface RawResponse {
  readonly valueKind: "NUMBER" | "TEXT" | "OPTION" | "BOOLEAN";
  readonly valueNumber: number | null;
  readonly valueText: string | null;
  readonly valueBoolean: boolean | null;
  readonly options: readonly SelectedOption[];
}

export interface EncodedValue {
  /** Empty when there is genuinely nothing — never a zero or a sentinel. */
  readonly value: string;
  readonly label: string;
  /** False when the cell is empty, which drives the missingness status. */
  readonly hasValue: boolean;
}

const EMPTY: EncodedValue = Object.freeze({ value: "", label: "", hasValue: false });

/**
 * Encode one answer for the export.
 *
 * Ordered by option `displayOrder` for multiple choice, so the same set of
 * selections always serialises identically. Without that, two participants who
 * chose the same options could produce different strings, and a naive
 * `GROUP BY value` would report them as different answers.
 */
export function encodeValue(type: QuestionType, response: RawResponse | null): EncodedValue {
  if (response === null) return EMPTY;

  switch (type) {
    case "LIKERT": {
      // The NUMERIC CODE of the chosen anchor, with the anchor text as the
      // label. A Likert item exported as its label alone cannot be averaged,
      // which is the single most common thing done with one.
      const option = response.options[0];
      if (option === undefined) return EMPTY;
      const code = option.valueNumber ?? response.valueNumber;
      if (code === null || code === undefined) return EMPTY;
      return { value: String(code), label: option.label, hasValue: true };
    }

    case "SINGLE_CHOICE": {
      const option = response.options[0];
      if (option === undefined) return EMPTY;
      return { value: option.optionKey, label: option.label, hasValue: true };
    }

    case "MULTI_CHOICE": {
      if (response.options.length === 0) return EMPTY;
      const ordered = [...response.options].sort((a, b) => a.displayOrder - b.displayOrder);
      return {
        // Semicolon, not comma: a comma inside a CSV field is ambiguous even
        // when quoted, and the codebook lists every option so the field can be
        // split reliably (§3).
        value: ordered.map((o) => o.optionKey).join(MULTI_VALUE_SEPARATOR),
        label: ordered.map((o) => o.label).join(MULTI_VALUE_SEPARATOR),
        hasValue: true,
      };
    }

    case "NUMERIC": {
      if (response.valueNumber === null) return EMPTY;
      // No label: the number IS the meaning, and a duplicate column would
      // invite an analyst to wonder which one is authoritative.
      return { value: String(response.valueNumber), label: "", hasValue: true };
    }

    case "FREE_TEXT": {
      const text = response.valueText;
      // A whitespace-only answer is treated as no answer. §2 forbids "a
      // whitespace string that could be confused with a genuine short-text
      // answer", and an intentionally blank field is SKIPPED_OPTIONAL rather
      // than ANSWERED with an empty value.
      if (text === null || text.trim() === "") return EMPTY;
      return { value: text, label: "", hasValue: true };
    }
  }
}
