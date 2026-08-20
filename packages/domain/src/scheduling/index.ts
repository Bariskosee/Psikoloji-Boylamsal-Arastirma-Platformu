/**
 * scheduling/ — the timing logic ADR-005 depends on, kept pure.
 *
 * Present scope is the reconciliation guarantee itself: judging whether the
 * sweep loop is alive, and deciding when overdue work is too late to run.
 * Protocol timing computation (duration and wall-clock modes, DST anomalies,
 * recurrence expansion — STRUCTURE.md §8.3) joins this directory in Phase 7,
 * against the same injected-Clock rule.
 */
export * from "./sweeper-health.js";
export * from "./staleness.js";
