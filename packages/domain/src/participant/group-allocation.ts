/**
 * Study group allocation (FR-45).
 *
 * A study with no groups behaves as a single-group study, and nothing about
 * that case is harder — that is the requirement, so the empty list returns null
 * rather than being an error the caller has to special-case.
 *
 * Allocation is decided ONCE, at enrollment, and stored on the enrollment row.
 * It is never recomputed: re-assigning a participant mid-study would mean their
 * earlier responses were collected under one condition and their later ones
 * under another, which invalidates that participant's data entirely.
 *
 * Randomness is injected, so a test can assert that a given draw lands in a
 * given group instead of enrolling a thousand fake participants and hoping.
 */

export interface AllocatableGroup {
  readonly id: string;
  readonly key: string;
  /** Relative share. A group with weight 0 is defined but not recruiting. */
  readonly allocationWeight: number;
  readonly isActive: boolean;
}

/**
 * Pick a group for one participant.
 *
 * `draw` is a uniform value in [0, 1). Weighted rather than round-robin
 * because round-robin makes the next assignment predictable from the last one,
 * and in an open-recruitment study anyone who can enroll twice could then
 * choose their own condition.
 */
export function allocateGroup(
  groups: readonly AllocatableGroup[],
  draw: number,
): AllocatableGroup | null {
  const eligible = groups.filter((group) => group.isActive && group.allocationWeight > 0);
  if (eligible.length === 0) return null;

  const total = eligible.reduce((sum, group) => sum + group.allocationWeight, 0);
  if (total <= 0) return null;

  // Clamp rather than trust: a draw of exactly 1 — or a caller that passed a
  // percentage by mistake — would otherwise fall off the end and return null,
  // silently un-grouping a participant in a study that has groups.
  const target = Math.min(Math.max(draw, 0), 0.999_999_999) * total;

  let cumulative = 0;
  for (const group of eligible) {
    cumulative += group.allocationWeight;
    if (target < cumulative) return group;
  }

  return eligible[eligible.length - 1] ?? null;
}
