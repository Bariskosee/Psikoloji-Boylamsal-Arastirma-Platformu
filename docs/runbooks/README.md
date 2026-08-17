# Runbooks

Operational procedures for running the platform during a live study.

**Status:** Placeholders. These are written and walked through in **Phase 12** of `PLAN.md`, and each must be executed at least once before the pilot begins (Phase 13). A runbook that has never been followed is a guess.

## Planned runbooks

| File | Purpose | Written in |
|---|---|---|
| `outage-recovery.md` | What to check and in what order after an API or worker outage. Confirms sweepers resumed and no session was silently skipped. | Phase 12 |
| `restore-drill.md` | Restoring the database from point-in-time backup into a clean environment, with measured timings. Repeated on a schedule. | Phase 12 |
| `dead-letter-triage.md` | Diagnosing and reprocessing jobs that exhausted their retries. | Phase 12 |
| `push-failure-triage.md` | Interpreting push failure rates by status code; distinguishing expired subscriptions from a transport problem. | Phase 12 |
| `participant-relink.md` | Manually reconnecting a participant who lost their device and recovery code, without creating a duplicate enrollment. | Phase 12 |
| `data-erasure.md` | Executing an erasure request while preserving study integrity and audit obligations. | Phase 12 |
| `study-launch-checklist.md` | Pre-launch verification for a new study: protocol preview reviewed, reminder cadence sane, consent published, timezone correct. | Phase 12 |

## Operational facts that belong in every runbook

- **The worker must be always-on.** A hosting tier that spins down stops the reconciliation sweepers and silently disables all scheduling. Check `system_heartbeats` first whenever scheduling looks wrong. See `docs/adr/ADR-010-deployment-platform.md`.
- **Sweepers are self-healing.** After any outage, the correct first action is usually to confirm the worker is running and let the sweepers converge, not to manually manipulate session rows. See `docs/adr/ADR-005-scheduling-guarantee.md`.
- **Never edit `participant_sessions` by hand** on a live study without recording an audit event and a written justification. Session state is research data.
