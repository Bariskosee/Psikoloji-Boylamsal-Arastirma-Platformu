/**
 * Reorder validation (PLAN.md Phase 3: "reordering within a single
 * transaction... idempotent").
 *
 * The service applies the resulting order inside one transaction; this
 * function only decides whether a proposed order is legal — a permutation of
 * exactly the current item set, nothing added, nothing dropped, nothing
 * duplicated. Applying the same legal order twice produces the same
 * `display_order` values both times, which is what makes the operation
 * idempotent.
 */

export interface ReorderResult {
  ok: boolean;
  reason?: "COUNT_MISMATCH" | "DUPLICATE_ID" | "UNKNOWN_ID" | "MISSING_ID";
  /** The validated order, present only when `ok`. */
  order?: readonly string[];
}

export function planReorder(
  currentIds: readonly string[],
  desiredOrder: readonly string[],
): ReorderResult {
  if (desiredOrder.length !== currentIds.length) return { ok: false, reason: "COUNT_MISMATCH" };

  const desiredSet = new Set(desiredOrder);
  if (desiredSet.size !== desiredOrder.length) return { ok: false, reason: "DUPLICATE_ID" };

  const currentSet = new Set(currentIds);
  for (const id of desiredOrder) {
    if (!currentSet.has(id)) return { ok: false, reason: "UNKNOWN_ID" };
  }
  // Defensive: `currentIds` come from primary keys and are never duplicated in
  // practice, so given the equal-length and no-duplicate-desired checks above,
  // this can only trigger if that assumption is ever violated by a caller bug.
  for (const id of currentIds) {
    if (!desiredSet.has(id)) return { ok: false, reason: "MISSING_ID" };
  }

  return { ok: true, order: desiredOrder };
}

/** `{ id, displayOrder }` pairs ready to persist, 0-based and contiguous. */
export function assignDisplayOrder(
  order: readonly string[],
): ReadonlyArray<{ id: string; displayOrder: number }> {
  return order.map((id, index) => ({ id, displayOrder: index }));
}
