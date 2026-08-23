# Runbooks

Operational procedures for running the platform during a live study.

**Status:** Written and reviewed in **Phase 12**. `first-deploy.md` was written against a rehearsal on a non-superuser database and has not yet been followed against a real provider. `restore-drill.md` has been executed once (2026-08-23) and carries its measured timings and two findings; the rest are written but have not all been followed under real pressure. A runbook that has never been followed is still partly a guess — walk each one during the pilot (Phase 13) and correct it from what actually happened.

## The runbooks

| File | Purpose | Alert codes |
|---|---|---|
| `first-deploy.md` | Standing up an environment that has never existed — including the two steps no error message will tell you about. | — |
| `sweeper-stall.md` | Scheduling has stopped. The highest-severity state in the platform, and the quietest. | `SWEEPER_ABSENT`, `SWEEPER_STALE`, `SWEEPER_FAILING` |
| `dead-letter-triage.md` | Jobs that exhausted their retries: which were notifications, and what that cost. | `DEAD_LETTERS` |
| `push-failure-triage.md` | Telling a transport or credential failure apart from ordinary subscriber attrition. | `PUSH_FAILURE_RATE`, `PUSH_ATTRITION` |
| `outage-recovery.md` | What to check, in what order, after anything was down. | — |
| `restore-drill.md` | Restoring into a clean environment and proving all four properties survived. Executed on a schedule. | — |
| `participant-relink.md` | Reconnecting a participant who lost their device and recovery code, without a duplicate and without a wrong match. | — |
| `data-erasure.md` | Retention and erasure, and the distinction from withdrawal. | — |
| `study-launch-checklist.md` | Pre-launch verification, run with the researcher before the first enrollment. | — |

Alerts are computed in `packages/domain/src/operations/alerts.ts`, surfaced on the researcher operations page, and each one names the file above that says what to do. If you add an alert, add its procedure in the same change.

## Operational facts that belong in every runbook

- **The worker must be always-on.** A hosting tier that spins down stops the reconciliation sweepers and silently disables all scheduling. Check `system_heartbeats` first whenever scheduling looks wrong. See `docs/adr/ADR-010-deployment-platform.md`.
- **A worker can be up with its queue down.** `boss.start()` failing is not fatal: the worker logs it, reports it, and runs with sweepers only, because a crash loop reconciles nothing at all. The startup line says `pg-boss UNAVAILABLE` and scheduling is correct but up to one sweep interval late. Fix the queue; do not restart in the hope that it clears.
- **Sweepers are self-healing.** After any outage, the correct first action is usually to confirm the worker is running and let the sweepers converge, not to manually manipulate session rows. See `docs/adr/ADR-005-scheduling-guarantee.md`.
- **Never edit `participant_sessions` by hand** on a live study without recording an audit event and a written justification. Session state is research data.
