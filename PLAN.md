# PLAN.md

## 1. Objective

This plan defines a professional, phased path for delivering the **Longitudinal Psychology Research Platform** from an empty repository to a reliable MVP suitable for pilot research use.

The project must prioritize research integrity, participant compliance, privacy, durable scheduling, and mobile usability. The first release should prove the full longitudinal workflow before adding advanced analytics or nonessential features.

---

## 2. Delivery Strategy

Development should proceed in vertical slices rather than building isolated technical layers for a long period.

A useful vertical slice is one that connects:

```text
Researcher configuration
→ persisted backend model
→ participant behavior
→ background scheduling
→ dashboard result
→ automated test
```

The MVP should be considered complete only when the end-to-end acceptance scenario in `REQUIREMENTS.md` works reliably.

---

# Phase 0 — Architecture and Repository Foundation

## Goals

Establish the engineering baseline before feature development.

## Tasks

- Decide and record the backend framework in an ADR.
- Decide package manager / monorepo tooling.
- Create the repository structure described in `STRUCTURE.md`.
- Add `.gitignore` and `.env.example`.
- Configure TypeScript/lint/format tooling where applicable.
- Configure backend linting/formatting/testing.
- Configure CI for tests, linting, and builds.
- Define environment separation: local, test, staging, production.
- Define PostgreSQL migration workflow.
- Define Redis/background-job approach.
- Define shared API validation/contracts approach.
- Add Turkish and English i18n infrastructure.

## Architecture decisions required

At minimum create ADRs for:

1. Monorepo structure.
2. Backend framework.
3. Authentication strategy.
4. Participant continuity strategy.
5. Background job queue.
6. Push notification provider/interface.
7. Questionnaire/protocol versioning model.

## Exit Criteria

- Repository boots locally.
- Frontend and backend health checks run.
- Database migrations execute from a clean database.
- CI passes on a minimal application.
- No production secrets are committed.

---

# Phase 1 — Core Data Model and Researcher Authentication

## Goals

Create the durable foundation for all research definitions.

## Tasks

Implement database models and migrations for the initial versions of:

- Researcher/User;
- Study;
- StudyMember where needed;
- ConsentVersion;
- Participant;
- Enrollment;
- Questionnaire;
- QuestionnaireVersion;
- Question / QuestionVersion;
- QuestionOption;
- Protocol / ProtocolVersion;
- ProtocolStep;
- ParticipantSession;
- Response;
- PushSubscription;
- NotificationEvent;
- AuditLog.

Implement researcher authentication and server-side authorization.

## Tests

- Migration up/down or equivalent migration validation.
- Authentication success/failure.
- Unauthorized access rejection.
- Ownership/member access rules.
- Versioned entity creation.

## Exit Criteria

A researcher can authenticate and create/read a draft study through the API without exposing participant/research data publicly.

---

# Phase 2 — Study and Questionnaire Builder

## Goals

Allow researchers to define studies and questionnaire content without code changes.

## Tasks

### Study Management

- Create study.
- Edit study metadata.
- Configure study timezone.
- Configure Turkish/English availability.
- Generate unique enrollment code/link.
- Generate/display study QR code.

### Questionnaire Builder

Implement a Google Forms-inspired but original researcher workflow for:

- creating questionnaire sets;
- adding questions;
- editing question labels/descriptions;
- reordering questions;
- deleting draft questions;
- marking questions required/optional;
- grouping questions into manageable sections/pages.

Initial question types:

- Likert scale;
- single choice;
- multiple choice;
- numeric;
- short text.

Do not add real psychological instrument content. Use neutral fixtures only.

### Versioning

Define the transition between editable draft definitions and immutable/versioned definitions used for data collection.

## Tests

- CRUD and ordering for questions.
- Required flag behavior.
- Validation for question configuration.
- Historical questionnaire version remains unchanged after a new version is created.

## Exit Criteria

A researcher can build a complete placeholder questionnaire from the dashboard and persist it as a stable version.

---

# Phase 3 — Enrollment, Consent, and Participant Continuity

## Goals

Create the first real participant flow.

## Tasks

- Public study enrollment page.
- QR/link enrollment path.
- Study information screen.
- Versioned consent display.
- Explicit consent acceptance.
- Stable pseudonymous participant ID generation.
- Secure participant continuity mechanism.
- Participant home/current-status page.
- Prevent questionnaire access before required consent.
- Record consent timestamp/version.

## Security Review

Verify that:

- raw participant IDs are not sufficient authorization secrets;
- participant data cannot be enumerated;
- researcher authentication is not reused as participant authentication;
- consent state is server-authoritative.

## Tests

- Join study.
- Decline/no consent blocks questionnaire.
- Consent creates immutable acceptance record.
- Returning participant retains identity.
- Another browser/device cannot trivially impersonate participant by guessing an ID.

## Exit Criteria

A participant can open a study link, consent, receive a pseudonymous identity, close the browser, return, and remain associated with the same enrollment.

---

# Phase 4 — Questionnaire Runtime, Autosave, and Completion

## Goals

Deliver a robust participant questionnaire experience.

## Tasks

- Render all MVP question types.
- Support question pages/sections.
- Display progress.
- Validate required questions.
- Save responses incrementally.
- Retry safe/idempotent response writes.
- Resume partial sessions.
- Enforce server-side availability windows.
- Implement completion transaction.
- Show completion confirmation.
- Lock or appropriately handle completed sessions.

## Important State Rules

The backend must control whether a session is:

```text
SCHEDULED
AVAILABLE
STARTED
COMPLETED
MISSED
```

The client must not be able to extend an expired response window by changing local time.

## Tests

- Each supported question type.
- Required question validation.
- Refresh after partial completion.
- Duplicate autosave request.
- Completion idempotency.
- Expired session rejection.
- Already-completed session behavior.

## Exit Criteria

A participant can reliably complete a baseline questionnaire, including closing/reopening midway without losing successfully saved responses.

---

# Phase 5 — Protocol Engine and Durable Scheduling

## Goals

Implement the feature that turns the product from a normal form system into a longitudinal research platform.

## Tasks

### Protocol Builder

Researchers can configure protocol steps with:

- questionnaire version;
- trigger type;
- relative delay;
- availability window;
- reminder policy.

Initial trigger support should include at least:

- enrollment-relative;
- previous/baseline session completion-relative.

### Scheduler

- Persist future participant sessions.
- Use a durable queue/worker.
- Make jobs idempotent.
- Add retry handling.
- Add reconciliation for due sessions if jobs are delayed/lost.
- Mark expired incomplete sessions `MISSED`.

### Time Handling

- UTC persistence.
- Explicit study timezone.
- Server-authoritative calculations.

## Tests

Use fake/deterministic clocks.

Test:

- `baseline complete + 48h`;
- independent schedules for participants joining on different dates;
- delayed worker execution;
- duplicate worker job;
- process restart/reconciliation behavior;
- correct expiration to `MISSED`;
- protocol version association.

## Exit Criteria

Completing one configured questionnaire reliably creates/activates the correct future questionnaire at the researcher-defined participant-relative time without manual intervention.

---

# Phase 6 — PWA and Push Notifications

## Goals

Make reminders reliable enough for pilot use on compatible iOS and Android devices.

## Tasks

### PWA

- Web App Manifest.
- Service worker.
- Installable PWA configuration.
- App icons/metadata.
- Safe service-worker update behavior.
- iOS Home Screen guidance where required.

### Push Onboarding

- Explain why study notifications matter before permission request.
- Request permission through a user gesture.
- Register/store push subscription.
- Record subscription status.
- Allow retry when permission/subscription is not active.

### Notification Worker

- Initial notification on questionnaire availability.
- Researcher-configurable reminder cadence.
- Re-check session state immediately before each send.
- Stop reminders after completion.
- Track send attempts/outcomes.
- Remove/invalidate dead subscriptions.
- Notification click opens the relevant participant flow.

## Validation Matrix

Manually test at minimum:

- Android Chrome-compatible flow;
- iPhone/iOS supported Home Screen PWA flow;
- permission denied;
- permission revoked;
- expired subscription;
- participant completes between reminder scheduling and send time.

## Important Constraint

Never claim guaranteed notification delivery. The system should record what it can verify and distinguish scheduled/sent/clicked/completed states.

## Exit Criteria

A compatible participant receives an initial notification and configured reminders while a session remains incomplete, and no further reminder is sent after completion.

---

# Phase 7 — Researcher Monitoring and Compliance Dashboard

## Goals

Give researchers operational visibility into study participation.

## Tasks

### Overview Metrics

- total participants;
- active participants;
- full-protocol completers;
- today's completed sessions;
- today's incomplete sessions;
- missed sessions;
- average compliance.

### Participant Table

Show:

- participant ID;
- current status;
- session history summary;
- compliance percentage.

### Participant Detail

Show timeline such as:

```text
Baseline      Completed
Follow-up     Completed
Daily 1       Missed
Daily 2       Completed
```

### Response Inspector

Allow authorized researchers to view responses across time and distinguish:

- missing answer;
- partial questionnaire;
- missed session.

### Compliance Definition

Document the compliance formula used. Do not hide denominator rules.

## Tests

- Metrics calculated from canonical records.
- Missing is not zero.
- Partial vs missed distinctions.
- Authorization for participant-level response inspection.

## Exit Criteria

A researcher can identify who completed today's work, who did not, and inspect one participant's longitudinal history accurately.

---

# Phase 8 — Descriptive Analytics and Export

## Goals

Provide research-useful summaries and analysis-ready datasets.

## Tasks

### Dashboard Analytics

Generic visualizations should support configured questionnaire data, including:

- age distributions where collected;
- gender distributions where collected;
- option counts and percentages;
- response matrices/distributions;
- completion trends;
- compliance trends.

Do not assume a demographic variable exists unless the researcher configured it.

### Long CSV Export

Include stable identifiers such as:

```text
participant_id
session_id
measurement/protocol_step
question_id/question_version_id
response
answered_at
session_status
```

### Wide CSV Export

Generate a reproducible wide representation suitable for common statistical workflows.

### Export Audit

Record sensitive data export events in the audit log.

## Tests

- Long export accuracy.
- Wide transform accuracy.
- Missing values preserved.
- Historical question/version metadata remains interpretable.
- Unauthorized export rejected.

## Exit Criteria

The researcher can download an analysis-ready CSV whose values reconcile with the dashboard and canonical responses.

---

# Phase 9 — Hardening for Pilot Study

## Goals

Make the MVP suitable for controlled pilot deployment.

## Tasks

### Security

- Dependency/security review.
- Rate limiting.
- CSRF review where cookie auth is used.
- XSS testing for researcher-entered study/question content.
- Authorization coverage review.
- Secret/config review.
- Sensitive logging review.

### Reliability

- Database backup strategy.
- Worker/job monitoring.
- Failed-job handling.
- Notification failure visibility.
- Scheduler reconciliation job.
- Health/readiness endpoints.

### Performance

Test realistic loads for several hundred active participants, especially:

- simultaneous response saves;
- dashboard queries;
- reminder bursts;
- CSV exports.

### Accessibility / UX

- Mobile usability review.
- Keyboard and label checks.
- Required-field error clarity.
- Turkish/English layout review.

### Research Data QA

Create deterministic test studies and reconcile:

- displayed response;
- database record;
- dashboard metric;
- CSV output.

## Exit Criteria

No known critical security/research-integrity defects remain, backup/recovery is defined, monitoring is active, and the full acceptance scenario has passed in staging.

---

# Phase 10 — Pilot and MVP Release

## Pilot Strategy

Before a real research launch:

1. Run an internal developer test with accelerated protocol timing.
2. Run a small closed participant pilot.
3. Test iOS and Android notification onboarding in real-world conditions.
4. Measure missed notifications vs missed questionnaires separately.
5. Collect participant UX feedback.
6. Validate every exported pilot record against source responses.
7. Fix critical issues before researcher recruitment begins.

## MVP Release Gate

Release only when:

- the full `REQUIREMENTS.md` MVP acceptance scenario passes;
- scheduling survives service restarts;
- autosave/resume is reliable;
- reminder cancellation is reliable;
- research data is access-controlled;
- versioning preserves historic interpretation;
- Turkish and English UI paths work;
- CSV export is validated;
- audit logs cover critical administrative operations.

---

# Post-MVP Roadmap

Only after MVP stability, consider:

## P1

- email/SMS fallback reminders;
- richer analytics;
- additional researcher roles;
- more question presentation types;
- study templates;
- improved participant recovery across devices.

## P2

- randomized ESM notification windows;
- conditional branching;
- richer protocol conditions;
- SPSS-oriented export tooling;
- R integration;
- multi-center administration.

## P3

- native mobile applications if research evidence shows PWA push limitations materially affect study compliance;
- advanced offline support with explicit conflict resolution.

AI-based clinical or psychological interpretation is not a default roadmap objective and requires separate research, ethics, and safety review.

---

# Engineering Priority Order

When trade-offs are required, prioritize in this order:

1. Research data integrity.
2. Participant privacy/security.
3. Correct scheduling and reminders.
4. Response autosave/recovery.
5. Participant mobile usability.
6. Researcher compliance visibility.
7. Export correctness.
8. Visual polish.
9. Advanced/non-MVP functionality.

---

# Recommended Initial Milestones

A practical milestone sequence is:

### M0 — Foundation
Repository, CI, database, auth skeleton, ADRs.

### M1 — Form System
Study + questionnaire builder and versioning.

### M2 — Participant Baseline
Enrollment + consent + participant continuity + questionnaire completion.

### M3 — Longitudinal Engine
Protocol configuration + durable scheduling + future sessions.

### M4 — Compliance
PWA push + repeated reminders + reminder cancellation.

### M5 — Research Operations
Dashboard + participant timeline + longitudinal response inspection.

### M6 — Data Delivery
Descriptive analytics + long/wide CSV export.

### M7 — Pilot Ready
Security, reliability, load testing, mobile QA, staging acceptance test.

---

# Definition of Done

A feature is not complete merely because its UI exists.

For research-critical work, "done" means:

- required behavior is implemented end to end;
- canonical state is persisted correctly;
- authorization is enforced;
- failure/retry behavior is considered;
- automated tests cover critical logic;
- mobile behavior is verified when participant-facing;
- documentation is updated where behavior/architecture changed;
- the feature does not violate the invariants in `AGENT.md`.
