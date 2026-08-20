import type { Locale, QuestionResponse, QuestionType } from "@lpr/contracts";

/**
 * Pure helpers behind the questionnaire builder.
 *
 * Kept out of the components so the parts with real logic — page grouping and
 * the drag-reorder move — are unit-testable without mounting React, and so the
 * builder and the preview cannot disagree about how questions are grouped.
 */

export interface QuestionPage {
  pageIndex: number;
  questions: QuestionResponse[];
}

/**
 * Groups questions into the pages a participant will see.
 *
 * Ordered by `pageIndex`, and within a page by the questions' existing order,
 * which is already `display_order` as the server returned it. Gaps in
 * `pageIndex` are not filled: a page nobody put a question on is not a page.
 */
export function groupByPage(questions: readonly QuestionResponse[]): QuestionPage[] {
  const pages = new Map<number, QuestionResponse[]>();
  for (const question of questions) {
    const bucket = pages.get(question.pageIndex);
    if (bucket) bucket.push(question);
    else pages.set(question.pageIndex, [question]);
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageIndex, pageQuestions]) => ({ pageIndex, questions: pageQuestions }));
}

/**
 * The array with the item at `from` moved to `to`.
 *
 * The whole of drag-and-drop reordering on the client. The result is sent to
 * `PUT .../questions/order` as a complete id list, and the server re-validates
 * it as a permutation — this function is convenience, never authority.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/**
 * The config a newly created question of `type` starts with.
 *
 * Mirrors the defaults in `@lpr/contracts`' per-type schemas so the editor can
 * render populated controls immediately. The server applies its own defaults
 * regardless, so a drift here produces a mildly stale form, never a bad row.
 */
export function defaultConfigFor(type: QuestionType): Record<string, unknown> {
  switch (type) {
    case "SINGLE_CHOICE":
      return {};
    case "MULTI_CHOICE":
      return { minSelections: 0, maxSelections: null };
    case "LIKERT":
      return { minValue: 1, maxValue: 5, minLabel: "", maxLabel: "" };
    case "NUMERIC":
      return { minValue: null, maxValue: null, step: null };
    case "FREE_TEXT":
      return { maxLength: 1000, multiline: true };
  }
}

/**
 * The text to display for a translation record.
 *
 * Falls back to any other locale that IS filled in rather than rendering an
 * empty line: a question translated only into Turkish must still be
 * recognisable while an English preview is open. Returns `null` when nothing
 * is filled in at all, so the caller can show its own "not translated yet"
 * affordance instead of an empty box.
 */
export function localizedText(
  translations: Partial<Record<Locale, string>>,
  locale: Locale,
): { text: string; isFallback: boolean } | null {
  const exact = translations[locale];
  if (exact) return { text: exact, isFallback: false };

  const fallback = Object.values(translations).find((value) => Boolean(value));
  return fallback ? { text: fallback, isFallback: true } : null;
}
