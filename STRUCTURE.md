# STRUCTURE.md

## Purpose

This document defines the target architecture for the **Longitudinal Psychology Research Platform**. It is a design target, not a claim that these modules already exist.

## High-Level Architecture

```text
Participant PWA ───────┐
                       │ HTTPS
Researcher Dashboard ──┼────► Backend API ─────► PostgreSQL
                       │           │
                       │           └────────────► Background Worker / Queue
                       │                                │
                       └────────────────────────────────► Web Push provider
```

The system should separate participant UX, researcher administration, canonical research data, and durable background processing.

## Recommended Repository Layout

A monorepo is recommended:

```text
/
├── README.md
├── CLAUDE.md
├── AGENT.md
├── REQUIREMENTS.md
├── STRUCTURE.md
├── PLAN.md
├── .env.example
│
├── apps/
│   ├── web/                 # Participant PWA + researcher dashboard
│   ├── api/                 # Backend API
│   └── worker/              # Scheduling/reminder jobs
│
├── packages/
│   ├── contracts/           # Shared API/event contracts
│   ├── validation/
│   ├── i18n/
│   ├── ui/
│   └── config/
│
├── database/
│   ├── migrations/
│   ├── schema/
│   └── seeds/
│
├── tests/
│   ├── e2e/
│   └── fixtures/
│
└── docs/
    └── adr/
```

The exact folder names may evolve, but domain boundaries should remain explicit.

## Frontend Boundaries

### Participant PWA

Suggested participant routes:

```text
/join/:studyCode
/p/consent
/p/home
/p/session/:sessionId
/p/session/:sessionId/complete
/p/notifications
```

Core participant modules:

- enrollment;
- consent;
- participant continuity;
- current-session/status view;
- questionnaire renderer;
- autosave/resume;
- completion flow;
- push onboarding;
- PWA install guidance;
- Turkish/English localization.

Do not use a raw participant database ID as the only authorization mechanism in public URLs.

### Researcher Dashboard

Suggested researcher routes:

```text
/researcher/login
/researcher/studies
/researcher/studies/:studyId
/researcher/studies/:studyId/questionnaires
/researcher/studies/:studyId/protocol
/researcher/studies/:studyId/participants
/researcher/studies/:studyId/analytics
/researcher/studies/:studyId/export
```

Core modules:

- authentication;
- study builder;
- questionnaire builder;
- question editor/reordering;
- protocol editor;
- reminder settings;
- participant table;
- participant timeline;
- longitudinal response inspector;
- compliance dashboard;
- descriptive analytics;
- exports.

## Backend Domains

### Auth

Researcher authentication, sessions/tokens, server-side authorization, and role checks.

Participant continuity should use a separate lightweight model rather than researcher credentials.

### Study

Study metadata, lifecycle, enrollment code/link, timezone, languages, ownership, and study membership.

Possible lifecycle:

```text
DRAFT → ACTIVE → PAUSED → CLOSED → ARCHIVED
```

### Consent

Versioned consent documents and participant acceptance records.

### Questionnaire

Questionnaires, questionnaire versions, question versions, options, ordering, required flags, and page/section grouping.

Historical versions must remain interpretable after data collection starts.

### Protocol

Protocol versions, steps, timing triggers, delays, availability windows, and reminder rules.

A protocol step should reference a questionnaire version rather than only a mutable questionnaire record.

### Participant

Pseudonymous participant identity, enrollment, study status, continuity credentials/device binding, and withdrawal state where supported.

### Participant Session

A `ParticipantSession` represents one concrete questionnaire assignment for one participant.

Conceptual fields:

```text
id
participant_id
study_id
protocol_version_id
protocol_step_id
questionnaire_version_id
scheduled_at
available_from
available_until
started_at
completed_at
missed_at
status
created_at
updated_at
```

### Response

Canonical answers should be normalized records, not study-specific database columns.

Conceptual fields:

```text
id
participant_session_id
participant_id
question_version_id
value_json
answered_at
created_at
updated_at
```

Wide formats such as `Q1_DAY1` should be generated only during export.

### Notification

Push subscriptions, scheduled reminders, send attempts, click/open events where measurable, and invalid-subscription cleanup.

Do not equate `sent` with delivered/read/completed unless the provider supplies that exact guarantee.

### Analytics

Server-side calculations for participant counts, session-state distributions, compliance, demographic summaries, and answer distributions.

Business logic such as compliance formulas should not be duplicated independently in dashboard components.

### Export

At minimum:

- long-format CSV;
- wide-format CSV.

### Audit

Critical administrative operations should create audit records without logging secrets or full sensitive response payloads.

## Core Data Relationships

```text
Researcher
   └── StudyMember ─── Study
                       ├── ConsentVersion
                       ├── Questionnaire
                       │      └── QuestionnaireVersion
                       │              └── QuestionVersion(s)
                       ├── Protocol
                       │      └── ProtocolVersion
                       │              └── ProtocolStep(s)
                       └── Enrollment
                              └── Participant
                                     ├── ParticipantSession(s)
                                     │       └── Response(s)
                                     └── PushSubscription(s)
```

## Durable Scheduling

The database must be the source of truth. A queue/worker is only the execution mechanism.

Recommended flow:

```text
Participant completes trigger session
→ backend records completion
→ scheduler evaluates next protocol step
→ future ParticipantSession is persisted
→ durable job is scheduled
→ worker wakes at/after availability time
→ worker re-checks canonical database state
→ session becomes AVAILABLE
→ initial notification is scheduled/sent
→ reminder jobs are scheduled
```

Every reminder must re-check:

```text
Is the session still open?
Is it incomplete?
Has this reminder already been sent?
Does a valid push subscription still exist?
```

All jobs must be idempotent and restart-safe. Do not use browser timers or in-memory `setTimeout` as the primary mechanism for multi-day scheduling.

## Time Strategy

- Persist timestamps in UTC.
- Store an explicit study timezone.
- Never use the participant browser clock as the authority for availability.
- Use timezone-aware date libraries.
- Test daylight-saving transitions where applicable.

Prefer explicit timing semantics such as:

```text
trigger = PREVIOUS_SESSION_COMPLETED
relative_delay = PT72H
window_duration = PT24H
```

or an equivalent structured representation.

## API Boundary Examples

```text
POST   /api/auth/login
POST   /api/studies
POST   /api/studies/:studyId/questionnaires
POST   /api/studies/:studyId/protocols

POST   /api/public/studies/:studyCode/enroll
POST   /api/public/participants/consent
GET    /api/public/participant/current-session
PUT    /api/public/sessions/:sessionId/responses/:questionId
POST   /api/public/sessions/:sessionId/complete
POST   /api/public/push-subscriptions

GET    /api/studies/:studyId/participants
GET    /api/studies/:studyId/analytics/compliance
GET    /api/studies/:studyId/exports/long.csv
GET    /api/studies/:studyId/exports/wide.csv
```

These endpoints are illustrative; preserve domain separation even if exact routes change.

## PWA Structure

The participant application should include:

- Web App Manifest;
- service worker;
- installability metadata;
- notification click handling;
- safe update behavior;
- push subscription management.

Full offline questionnaire completion is not an MVP requirement.

## Internationalization

Use a central i18n layer from the beginning, for example:

```text
locales/
├── en.json
└── tr.json
```

Researcher-entered questionnaire content is application data and should remain separate from interface translations.

## Testing Layers

```text
Unit
├── protocol calculations
├── state transitions
├── compliance formulas
├── notification eligibility
└── export transforms

Integration
├── API + database
├── enrollment + consent
├── autosave + resume
├── scheduler + worker
└── auth/authorization

E2E
└── researcher → participant → dashboard → export
```

Use deterministic/fake clocks for time-dependent tests.

## Suggested Deployment Model

A practical MVP deployment may use:

```text
Web frontend   → Vercel or equivalent
Backend API    → managed/container host
Worker         → persistent worker service
PostgreSQL     → managed database
Redis          → managed queue/cache
Push           → Web Push / FCM-compatible infrastructure
```

Specific vendors are not fixed by this document.

## Architecture Decision Records

Record major choices under `docs/adr/`, for example:

```text
0001-monorepo-structure.md
0002-backend-framework.md
0003-authentication-strategy.md
0004-participant-continuity.md
0005-job-queue.md
0006-push-provider.md
0007-versioning-model.md
```

## Architectural Non-Negotiables

The implementation must not:

- depend on in-memory timers for multi-day protocols;
- mutate historical questionnaire definitions after responses exist;
- mutate historical protocol definitions after they have been applied;
- expose participant answers through unauthenticated researcher endpoints;
- use email/phone as the canonical research participant key;
- hard-code study-specific question counts or timing intervals;
- treat push sending as proof of engagement;
- use the browser clock as the authority for session access.
