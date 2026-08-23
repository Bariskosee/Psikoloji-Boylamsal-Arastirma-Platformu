/**
 * CSV encoding for research exports (`docs/export-codebook.md` §6).
 *
 * Small, and every decision in it is one that has corrupted somebody's dataset
 * before.
 */

/**
 * The UTF-8 byte-order mark.
 *
 * §6.4: files are UTF-8 **with a BOM**, so that Turkish characters open
 * correctly in Excel without the analyst going through the import wizard. Excel
 * on Windows otherwise reads a UTF-8 CSV as the system code page, and `ö`
 * becomes `Ã¶` in every row of a study conducted in Turkish. That is not a
 * cosmetic defect: participant-entered free text is data, and mangling it is
 * losing it.
 */
export const UTF8_BOM = "﻿";

/** The separator inside a multiple-choice value (§3). */
export const MULTI_VALUE_SEPARATOR = ";";

/**
 * Quote one field.
 *
 * ── Why a leading `=`, `+`, `-` or `@` is neutralised ───────────────────────
 * Excel and Google Sheets interpret a cell beginning with one of those as a
 * FORMULA. A participant who types `=1+1` into a free-text box has their answer
 * silently replaced by `2` in the analyst's spreadsheet — and one who types
 * something starting with `=HYPERLINK` or `=cmd|…` turns a research export into
 * a CSV-injection vector against the researcher's machine.
 *
 * Prefixing a tab preserves the exact characters the participant typed — the
 * string is recoverable, and a reader sees what was written — while stopping
 * the spreadsheet from evaluating it. Stripping or escaping the character
 * instead would silently alter data, which is the thing this whole document
 * exists to prevent.
 */
export function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;

  // Quote whenever the value could otherwise be misread. A quote inside a
  // quoted field is doubled, per RFC 4180.
  if (/[",\n\r\t]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

export function csvRow(fields: readonly (string | number | null | undefined)[]): string {
  return (
    fields
      .map((field) => {
        if (field === null || field === undefined) return "";
        // Numbers are never quoted and never formula-guarded: they came from
        // this system, not from a participant's keyboard.
        return typeof field === "number" ? String(field) : csvField(field);
      })
      .join(",") + "\r\n"
  );
}

/**
 * An ISO-8601 instant in UTC, or empty.
 *
 * §6.3: all timestamps are UTC with an explicit offset, and
 * `participant_timezone` is provided separately so an analyst can convert. A
 * mixture of local times in one column is the kind of error that survives peer
 * review, because every individual value looks plausible.
 */
export function csvInstant(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
