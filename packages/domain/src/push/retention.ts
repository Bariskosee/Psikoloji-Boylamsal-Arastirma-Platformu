/**
 * When a push subscription stops being ours to keep (ADR-006, NFR-03).
 *
 * A subscription endpoint is re-identifying data. Keeping one after it has
 * stopped working is holding a device identifier for a participant we can no
 * longer reach with it — no research value, and the retention question a data
 * protection review asks first.
 *
 * Two separate events, deliberately not collapsed:
 *
 * **Deactivation** is immediate and reversible-in-principle. The participant
 * unsubscribed, withdrew, or the push service answered 404/410 in Phase 9. The
 * row stays, inactive, so an operator investigating "why did this participant
 * stop getting reminders?" has an answer rather than an absence.
 *
 * **Pruning** is deletion, and happens only after the retention window. By then
 * the operational question has been asked or never will be, and the endpoint is
 * pure liability.
 */

/**
 * How long a dead subscription is kept as evidence before deletion.
 *
 * Chosen against the incident it exists for: a researcher noticing a
 * participant's compliance dropping and asking when their notifications
 * stopped. That question surfaces weeks after the fact, not hours. Thirty days
 * is comfortably longer than that and comfortably shorter than a study.
 *
 * Configuration, not a constant anyone may read as protocol: this is an
 * infrastructure retention policy, not a parameter of any study's design
 * (AGENT.md §3.4 concerns the latter).
 */
export const PUSH_SUBSCRIPTION_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export interface PushSubscriptionState {
  readonly isActive: boolean;
  /** Set when the subscription stopped being usable; null while it is active. */
  readonly deactivatedAt: Date | null;
  /**
   * What the push service told the browser, where it said anything at all.
   * Usually null: Chrome and Firefox leave it unset, which is why an expiry
   * check can never be the only way a dead subscription is noticed.
   */
  readonly expirationTime: Date | null;
}

/**
 * Has the push service's own stated expiry passed?
 *
 * Separate from `isPrunable` because the consequence is different: an expired
 * subscription should be *deactivated* now, and only deleted once its retention
 * window has also run. Deleting on expiry would erase the evidence in the same
 * moment it became interesting.
 */
export function hasExpired(state: PushSubscriptionState, now: Date): boolean {
  if (state.expirationTime === null) return false;
  return state.expirationTime.getTime() <= now.getTime();
}

/**
 * May this row be deleted outright?
 *
 * An active subscription never can, whatever its timestamps say — including one
 * whose `expiration_time` has passed, because "the push service said this would
 * expire" and "we have marked it dead" are different facts and only the second
 * starts the retention clock. A row that is inactive with no `deactivated_at`
 * is a data defect rather than a prunable row, so it is kept: deleting on
 * missing evidence is how a bug quietly erases what would have explained it.
 */
export function isPrunable(state: PushSubscriptionState, now: Date): boolean {
  if (state.isActive) return false;
  if (state.deactivatedAt === null) return false;

  const cutoff = state.deactivatedAt.getTime() + PUSH_SUBSCRIPTION_RETENTION_DAYS * DAY_MS;
  return now.getTime() >= cutoff;
}

/** The instant before which a deactivated subscription may be pruned. */
export function pruneCutoff(now: Date): Date {
  return new Date(now.getTime() - PUSH_SUBSCRIPTION_RETENTION_DAYS * DAY_MS);
}
