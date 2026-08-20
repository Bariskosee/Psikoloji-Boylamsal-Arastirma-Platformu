# AGENT.md

## 1. Purpose

This file is the primary engineering contract for AI coding agents working on the **Longitudinal Psychology Research Platform**.

The platform supports privacy-sensitive longitudinal psychology studies in which participants complete different questionnaire sets at researcher-defined times over days or weeks. The system includes participant-facing PWA flows, scheduling, reminders, longitudinal response storage, compliance tracking, dashboards, and export tooling.

The application is not a clinical decision system and must not infer diagnoses, generate clinical conclusions, or alter validated research instruments unless explicitly instructed by the research team.

---

## 2. Required Reading Before Work

Before changing code, review the relevant project documents:

1. `REQUIREMENTS.md` — normative product requirements and glossary.
2. `STRUCTURE.md` — decided architecture, domain model, and module boundaries.
3. `PLAN.md` — implementation sequence and current phase.
4. `README.md` — product overview and intended use cases.

When working on a specific area, also read:

- `docs/adr/` — why each technical choice was made, and what was rejected. Do not re-open a decided question without reading its ADR.
- `docs/reference-protocol.md` — before touching protocols, scheduling, or anything that consumes them. It is the study design the platform is being built for, worked through as configuration, and it is the shared fixture for tests. It is an example, never a default.
- `docs/compliance-formula.md` — before touching any participation metric.
- `docs/export-codebook.md` — before touching export or missingness handling.

When a human maintainer supplies newer requirements, those instructions override repository documents.

---

## 3. Core Engineering Principles

### 3.1 Research integrity over convenience

Do not implement shortcuts that can silently corrupt longitudinal data. Scheduling, timestamps, answer persistence, protocol versions, question versions, missingness, and completion state must be explicit and auditable.

### 3.2 Privacy by design

Psychological responses are sensitive research data. Design every feature under the assumption that participant-level data requires strong access control and data minimization.

Do not expose directly identifying information in response tables, analytics endpoints, logs, URLs, client-side state, or exports unless a requirement explicitly requires it.

### 3.3 Pseudonymization, not false anonymity claims

The application should use pseudonymous `participant_id` values for research records. If a device identifier, email address, notification endpoint, or other re-identification mechanism exists, never describe the data model as technically anonymous in code comments or documentation.

### 3.4 Configuration over hard-coding

Do not hard-code:

- questionnaire content,
- number of questions,
- study day counts,
- occurrence counts and recurrence intervals,
- which questionnaire a protocol step administers, including reuse of one instrument at several steps,
- delay between questionnaire sets,
- reminder intervals,
- response windows,
- consent text,
- study-specific demographics,
- language strings.

These must be researcher-configurable or centrally configurable according to scope.

`docs/reference-protocol.md` describes the first study the platform serves — ~100 items at baseline, ten items daily for thirty days, the baseline instrument again at the end. **Every number in it is configuration.** It exists so that tests, previews, and acceptance criteria have one realistic target; it is not a default, a constant, an enum value, or a shape any code may assume.

### 3.5 Mobile-first participant experience

Participant flows are expected to run primarily on phones. Every participant-facing feature must be usable on iPhone and Android form factors before it is considered complete.

### 3.6 Minimal participant friction

Do not add participant passwords, unnecessary registration steps, profile screens, marketing screens, or complex navigation unless explicitly required.

A preferred participant path is:

```text
Study link / QR
→ study information
→ consent
→ notification onboarding
→ questionnaire
→ completion
```

### 3.7 Server-authoritative state

Security-sensitive and research-critical state must be decided by the server, including:

- whether a questionnaire is currently available,
- whether a response window has expired,
- which protocol version applies,
- whether a session is completed,
- whether reminders should continue,
- researcher authorization.

Never trust client clocks for protocol enforcement.

---

## 4. Product Invariants

The following invariants must remain true unless requirements explicitly change.

### Participant identity

- Every enrolled participant has a stable, opaque, pseudonymous ID.
- Research responses reference the participant by this ID.
- A participant can return and resume the same study without creating a new identity unintentionally.
- Device continuity must not depend on exposing participant identifiers in insecure URLs or local data unnecessarily.

### Consent

- No questionnaire answers may be collected before required consent is accepted.
- Consent acceptance must record timestamp and consent version.
- Historic consent records must not be overwritten when consent text changes.

### Questionnaires

- Researchers control question content.
- Do not ship real psychological instruments or copyrighted questionnaire items unless explicitly supplied and authorized.
- Placeholder data is acceptable for tests and development.
- Required and optional questions must be represented explicitly.

### Scheduling

- Questionnaire schedules are participant-relative when configured that way.
- Example: `baseline completed + 72 hours`, not simply a globally fixed calendar date.
- Time windows are server-enforced.
- All persistence timestamps should be stored in UTC.
- Display times should be converted using study or participant timezone rules.

### Session lifecycle

A `ParticipantSession` has eight explicit, persisted lifecycle states:

```text
PENDING_TRIGGER  SCHEDULED  AVAILABLE  STARTED
COMPLETED  EXPIRED_UNSTARTED  EXPIRED_PARTIAL  CANCELLED
```

`MISSED` is a display label covering the two expiry states, not a stored value. Transitions and guards are defined in `STRUCTURE.md` §7.

Do not infer state from timestamps at presentation time. Persisted state is required for auditability, and the two expiry states must remain distinguishable because they mean different things in a missing-data analysis.

### Response persistence

- Answers should be saved incrementally.
- Refreshing or temporarily leaving the PWA should not erase saved progress.
- A participant returning within an active window should resume their partial session.
- Completion must be idempotent.
- Duplicate network requests must not produce duplicate answers.

### Notifications

- Notifications are a central feature, not decorative functionality.
- Initial notification and reminder rules must be configurable.
- A completed session must no longer receive reminders.
- Notification permission status should be tracked.
- The UI should clearly instruct users when notifications are unavailable or denied.
- Respect browser and OS permission requirements; never attempt to circumvent them.

### Analytics

- Dashboard metrics must derive from persisted canonical data.
- Distinguish `not started`, `partial`, `completed`, and `missed`.
- Do not treat missing answers as numeric zero.
- Compliance formulas must be documented and tested.

---

## 5. Security Requirements

### Authentication and authorization

Researcher routes and APIs require authentication.

Authorization must be enforced server-side. UI hiding is not authorization.

Where roles exist, prefer least privilege. Potential future roles include:

- Admin
- Principal Investigator
- Research Assistant
- Data Analyst

### Secrets

Never commit:

- database passwords,
- session secrets,
- VAPID private keys,
- API keys,
- production connection strings.

Provide `.env.example` with placeholders instead.

### Logging

Never log complete psychological response payloads by default.

Never log authentication secrets, session tokens, notification private keys, or unnecessary identifying information.

### Input validation

Validate all external input at API boundaries.

Treat questionnaire definitions as untrusted structured input. Prevent stored XSS from researcher-entered titles, descriptions, consent text, or questions.

### CSRF / sessions

If cookie-based researcher authentication is used, implement appropriate CSRF protections and secure cookie settings.

### Rate limiting

Apply sensible rate limits to authentication, enrollment, participant recovery, push subscription registration, and other abuse-sensitive endpoints.

---

## 6. Data Modeling Guidance

Use normalized relational modeling for canonical research data.

**The authoritative entity model is `STRUCTURE.md` §6.** Do not introduce entities, rename them, or change their relationships without updating that document in the same change.

Rules that apply regardless of entity:

- Do not model longitudinal answers as study-specific columns such as `Q1_DAY1`, `Q1_DAY2`. Use normalized records and generate wide format only during export.
- Definitions become immutable once published. Do not add an update path to a published questionnaire or protocol version.
- Store values in typed columns, not in an untyped JSON blob, wherever the value is filtered, joined, or aggregated.
- Enforce uniqueness with database constraints, not only with application logic. Application-level checks lose races.

---

## 7. API Design Rules

Use predictable resource-oriented APIs.

Examples of domains:

```text
/api/auth/*
/api/studies/*
/api/studies/:studyId/questionnaires/*
/api/studies/:studyId/protocols/*
/api/studies/:studyId/participants/*
/api/participant/sessions/*
/api/participant/responses/*
/api/participant/push-subscriptions/*
/api/analytics/*
/api/exports/*
```

Requirements:

- Validate request and response schemas.
- Return stable error codes/messages.
- Use idempotency where retries are plausible.
- Do not leak whether unrelated participant IDs exist.
- Paginate large participant and audit datasets.
- Keep researcher APIs logically separate from participant APIs.

---

## 8. Scheduling and Background Jobs

Scheduling is a high-risk subsystem.

The scheduling implementation must tolerate:

- process restarts,
- duplicate job delivery,
- delayed jobs,
- retries,
- multiple worker instances,
- participants in different timezones,
- protocol version changes.

Never rely exclusively on in-memory timers such as `setTimeout` for multi-day research scheduling.

Persist the intended schedule in the database and use a durable worker/job system.

All background tasks must be idempotent.

Before sending a reminder, re-check canonical state:

```text
Is the session still open?
Is the session incomplete?
Does the participant still have a valid push subscription?
Has this reminder already been sent?
```

---

## 9. PWA and Push Notification Rules

The participant application should be designed as an installable PWA where supported.

Support must include the expected Web App Manifest and service worker behavior.

Do not request notification permission immediately on page load without context. First explain why notifications matter, then request permission in response to a user interaction compatible with browser requirements.

For Apple/iOS flows, explicitly account for Home Screen installation requirements where applicable.

The product must degrade safely when push is unavailable. The participant must still be able to open the study URL and complete currently available sessions.

Push delivery success is not equivalent to questionnaire completion. Maintain independent event types.

---

## 10. Frontend UX Rules

### Participant UI

Prioritize:

- large touch targets,
- clear progress,
- readable typography,
- minimal navigation,
- explicit required-question validation,
- recovery from refresh/network interruptions,
- clear completion confirmation,
- Turkish and English localization readiness.

Avoid rendering dozens of questions in a single overwhelming page. Use configurable sections/pages or sensible question grouping.

### Researcher UI

The questionnaire builder may take conceptual inspiration from Google Forms, but do not clone proprietary branding or copyrighted interface assets.

Researchers need clear workflows for:

- creating a study,
- adding questionnaire sets,
- adding/reordering questions,
- marking questions required,
- scheduling protocol steps,
- configuring response windows/reminders,
- monitoring participants,
- inspecting longitudinal answers,
- exporting data.

For dashboards, favor information density and clarity over ornamental visualization.

---

## 11. Internationalization

The MVP must be designed for Turkish and English.

Do not scatter user-visible strings throughout components. Use an internationalization layer from the beginning.

Researcher-entered study content may itself contain multiple language variants in future versions; avoid data models that make that impossible.

---

## 12. Testing Expectations

Changes to research-critical logic require automated tests.

### Unit tests

Cover at minimum:

- protocol timing calculations,
- availability windows,
- lifecycle state transitions,
- compliance calculations,
- required-question validation,
- export transformations,
- notification eligibility.

### Integration tests

Cover:

- enrollment + consent,
- participant continuity,
- response autosave,
- session completion,
- scheduler → session availability,
- completion → reminder cancellation,
- researcher authorization,
- CSV export.

### End-to-end tests

At least one end-to-end MVP path should verify:

```text
researcher creates study
→ creates questionnaire
→ creates protocol
→ participant enrolls
→ consents
→ completes baseline
→ later session becomes available
→ participant completes it
→ dashboard reflects completion
→ export contains both waves
```

Use deterministic clocks/fake time where possible for multi-day scheduling tests.

---

## 13. Database Migrations

All schema changes must use version-controlled migrations.

Never manually modify production schema as the primary deployment mechanism.

A migration that affects collected response semantics requires special care and should preserve historical interpretability.

---

## 14. Definition of Done for Code Changes

Before considering a task complete:

- relevant requirements are satisfied,
- types/schema validation pass,
- tests covering new critical logic exist,
- lint/format checks pass,
- no secrets are introduced,
- migrations are included if required,
- mobile behavior has been considered for participant features,
- accessibility basics are respected,
- documentation is updated if architecture or behavior changed.

Do not mark placeholder implementations, mock persistence, or fake notification sends as production-complete.

---

## 15. Scope Discipline

**The authoritative out-of-scope list is `REQUIREMENTS.md` §9.** Read it before proposing any feature not named in the current phase.

Two rules govern scope:

1. Do not spend implementation time on excluded features ahead of MVP-critical work.
2. Do not exceed the current phase in `PLAN.md`. Each phase ends with an explicit "what NOT to build yet" list; treat it as binding. Building ahead makes a phase unreviewable and is the most common way agent-driven work goes wrong here.

---

## 16. Agent Workflow

When asked to implement a feature:

1. Identify the relevant requirement IDs in `REQUIREMENTS.md`.
2. Inspect existing code before proposing new architecture.
3. Keep changes within existing architectural boundaries unless there is a concrete reason to change them.
4. Implement the smallest complete vertical slice.
5. Add/update tests.
6. Run the relevant validation commands.
7. Update documentation when assumptions or interfaces change.
8. Report what changed, how it was validated, and any known limitations.

When requirements are ambiguous, prefer configurable behavior rather than encoding a research-specific assumption.

Do not invent participant-facing psychological content. Use neutral placeholders such as `Sample question` in development fixtures.

---

## 17. Non-Negotiable Red Flags

This is the single canonical list. `STRUCTURE.md` references it rather than repeating it.

Stop and reconsider an implementation if it would:

- overwrite historical questions after responses exist,
- overwrite historical protocol definitions,
- expose participant answers publicly,
- use raw email/phone as the primary research identifier,
- send reminders after completion,
- depend on a browser tab or an in-memory timer for multi-day scheduling,
- silently drop partial answers,
- calculate schedules using only client-side clocks,
- store secrets in Git,
- claim guaranteed push delivery, or treat push acceptance as engagement,
- treat missing values as zero,
- introduce clinical diagnosis or scoring without explicit research-team requirements,
- **emit a numeric default, sentinel, or empty string in place of a typed missing-value status** — see `docs/export-codebook.md`,
- **describe the data as anonymous** in code, comments, interface strings, exports, or documentation. It is pseudonymous; continuity credentials, push endpoints, and contact details keep re-identification possible,
- **read the wall clock inside `packages/domain`** via `new Date()`, `Date.now()`, or equivalent. A `Clock` is injected, so that multi-day and daylight-saving behaviour stays testable,
- **trigger a step on the completion of a recurring step** — one missed daily report then silently destroys the study's outcome measurement thirty days later, unrecoverably. Anchor a step that follows a recurring block on the block's own origin plus a duration, or on a named occurrence becoming *available*. Conditioning on a single-occurrence step such as a baseline remains legitimate. See FR-48 and `docs/adr/ADR-011-recurring-block-anchoring.md`,
- **hard-code any parameter of the reference protocol** — item counts, occurrence counts, intervals, windows, anchor times, or the step layout — as a default, constant, or assumption anywhere in application code.

These are architectural or research-integrity defects, not minor implementation details.
