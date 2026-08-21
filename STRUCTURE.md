# STRUCTURE.md

## Purpose

This document defines the **decided technical architecture** for the Longitudinal Psychology Research Platform.

Earlier drafts of this file described alternatives. They no longer do. Every choice below is settled and recorded as an Architecture Decision Record in `docs/adr/`. Where a decision is later revisited, the ADR is superseded and this document is updated — the two must never disagree.

This document is the authority for technical design. Product behaviour is defined in `REQUIREMENTS.md`; engineering rules in `AGENT.md`; sequencing in `PLAN.md`.

---

## 1. Technology Stack

| Layer | Decision | ADR |
|---|---|---|
| Language | TypeScript on Node.js 22 LTS, across all four deployables | ADR-002 |
| Backend | NestJS 11, modular monolith | ADR-002 |
| Worker | Same NestJS codebase, bootstrapped as a standalone context, deployed as a separate always-on process | ADR-002 |
| Database | PostgreSQL 16, two schemas (`research`, `identity`), two roles | ADR-003 |
| Data access | Drizzle ORM, migrations via drizzle-kit | ADR-003 |
| Background jobs | **pg-boss on PostgreSQL. No Redis.** | ADR-004 |
| Scheduling guarantee | **Reconciliation sweepers are authoritative; jobs are an optimisation** | ADR-005 |
| Push | **Web Push with VAPID via `web-push`. No Firebase.** | ADR-006 |
| Participant continuity | Hashed token cookie + one-time install handoff + recovery code | ADR-007 |
| Versioning | Draft → published immutable; pinned at enrollment | ADR-008 |
| Frontend | **Two** Next.js 15 applications on separate origins | ADR-009 |
| Deployment | Render, Frankfurt, single EU region | ADR-010 |
| Validation | Zod, shared between server and both clients | ADR-001 |
| Time | Luxon, IANA-aware | ADR-005 |
| Testing | Vitest, Testcontainers, Playwright | ADR-001 |
| Monorepo | pnpm workspaces + Turborepo | ADR-001 |

**Explicitly rejected**, with reasoning in the referenced ADRs: FastAPI/Python (ADR-002) · Prisma (ADR-003) · Redis with BullMQ or Celery (ADR-004) · Firebase Cloud Messaging (ADR-006) · a single combined frontend application (ADR-009) · Vercel-only and AWS/GCP deployment (ADR-010).

---

## 2. High-Level Architecture

```text
                          ┌──────────────────── EU region (Frankfurt) ───────────────────┐
                          │                                                              │
  ┌──────────────┐        │   ┌──────────────────────────────────────────────────────┐   │
  │  Participant │        │   │             apps/api  —  NestJS monolith             │   │
  │   phone      │        │   │                                                      │   │
  │              │        │   │  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │   │
  │ ┌──────────┐ │ HTTPS  │   │  │ participant│  │ researcher │  │  shared domain │  │   │
  │ │   PWA    │─┼────────┼──▶│  │   API      │  │    API     │  │    services    │  │   │
  │ │ +Service │ │        │   │  │ (token)    │  │  (session) │  │  protocol/     │  │   │
  │ │  Worker  │ │        │   │  └────────────┘  └────────────┘  │  compliance/   │  │   │
  │ └────┬─────┘ │        │   │         │              │         │  export        │  │   │
  └──────┼───────┘        │   └─────────┼──────────────┼─────────┴────────┬───────┘   │   │
         │                │             │              │                  │           │
         │ Push API       │             ▼              ▼                  ▼           │
         │ (VAPID)        │   ┌──────────────────────────────────────────────────┐    │
         │                │   │            PostgreSQL 16  (managed, PITR)        │    │
  ┌──────┴───────┐        │   │                                                  │    │
  │ Browser push │        │   │  schema: research          schema: identity      │    │
  │   service    │◀───────┼───┤  ├ studies                 ├ participant_        │    │
  │ (FCM/APNs/   │  send  │   │  ├ questionnaire_versions   │   credentials      │    │
  │  Mozilla)    │        │   │  ├ protocol_versions        ├ push_subscriptions │    │
  └──────────────┘        │   │  ├ participants (pseudo)    ├ participant_       │    │
                          │   │  ├ participant_sessions     │   contacts         │    │
  ┌──────────────┐        │   │  ├ responses                └ recovery_codes     │    │
  │  Researcher  │ HTTPS  │   │  ├ notification_attempts                         │    │
  │   browser    │────────┼──▶│  ├ audit_events        schema: pgboss            │    │
  │  (dashboard) │        │   │  └ …                   └ job queues              │    │
  └──────────────┘        │   └──────────────────────▲───────────────────────────┘    │
                          │                          │                                │
                          │   ┌──────────────────────┴───────────────────────────┐    │
                          │   │        apps/worker  —  same NestJS codebase      │    │
                          │   │                                                  │    │
                          │   │   job handlers          reconciliation sweepers  │    │
                          │   │   ├ session.activate    ├ sweep.activate_due     │    │
                          │   │   ├ session.expire      ├ sweep.expire_due       │    │
                          │   │   ├ notification.send   ├ sweep.notifications_due│    │
                          │   │   └ protocol.materialize└ sweep.heartbeat        │    │
                          │   │                              (every 60s)         │    │
                          │   └──────────────────────────────────────────────────┘    │
                          └──────────────────────────────────────────────────────────┘
```

### Component responsibilities

| Component | Owns | Explicitly does not |
|---|---|---|
| `apps/participant` | Enrollment, consent, questionnaire runtime, autosave outbox, push onboarding, service worker | Decide availability, expiry, or completion validity |
| `apps/researcher` | Builders, monitoring, analytics views, export triggers | Contain compliance or missingness logic |
| `apps/api` | HTTP boundary, authn/authz, validation, transaction boundaries | Long-running work, sending push |
| `apps/worker` | Job execution, sweepers, push transport | Serve HTTP other than `/health` |
| PostgreSQL | Canonical research state **and** job state | — |
| Push services | Best-effort transport | Any delivery guarantee |

---

## 3. Repository Layout

```text
/
├── apps/
│   ├── participant/          Next.js 15 — participant PWA (public origin)
│   │   ├── app/[locale]/     join, consent, home, session, notifications, install
│   │   ├── public/           manifest.webmanifest, icons
│   │   └── worker/           service worker source (push, notificationclick, update)
│   ├── researcher/           Next.js 15 — dashboard (authenticated origin)
│   │   └── app/[locale]/     login, studies, questionnaires, protocol,
│   │                         participants, analytics, export, ops
│   ├── api/                  NestJS — HTTP boundary
│   │   └── src/modules/      auth, study, consent, questionnaire, protocol,
│   │                         participant, session, response, notification,
│   │                         analytics, export, audit, health
│   └── worker/               NestJS standalone — jobs + sweepers
│       └── src/              handlers/, sweepers/, push/
│
├── packages/
│   ├── domain/               PURE logic. Zero I/O, zero framework, zero DB.
│   │   └── src/              scheduling/, state-machine/, compliance/,
│   │                         missingness/, export/, question-types/
│   ├── contracts/            Zod schemas + inferred types (API, jobs, question configs)
│   ├── db/                   Drizzle schema, migrations, seeds, test factories
│   │   └── src/jobs/         pg-boss queue + transactional enqueue (ADR-004)
│   ├── i18n/                 en.json, tr.json, locale negotiation
│   ├── ui/                   Shared primitives + design tokens
│   └── config/               tsconfig / eslint / vitest base configs
│
├── docs/
│   ├── adr/                  ADR-001 … ADR-011
│   ├── reference-protocol.md
│   ├── compliance-formula.md
│   ├── export-codebook.md
│   └── runbooks/
│
├── tests/e2e/                Playwright — cross-app critical journeys
├── infrastructure/           render.yaml, migration entrypoint
└── *.md                      the six root documents
```

### Dependency direction

Strictly one-way, enforced by an ESLint import-boundary rule in CI.

```text
apps/participant ─┐
apps/researcher  ─┼──▶ contracts ──▶ (nothing)
                  └──▶ i18n, ui

apps/api    ─┬──▶ domain ──▶ contracts
apps/worker ─┘└──▶ db     ──▶ contracts
```

**Rules:**

- `packages/domain` imports **nothing but `contracts`**. No Drizzle, no NestJS, no database, and **no direct clock access** — a `Clock` is always passed in.
- Frontends must never import `packages/db`.
- `apps/api` and `apps/worker` never import each other. They share through `domain` and `db`.

**Why `packages/domain` is the most important package.** The logic most capable of silently corrupting research data — timing arithmetic, state transitions, compliance denominators, missingness classification, export shaping — lives there as pure functions with injected clocks. It is exhaustively unit-testable in milliseconds, including daylight-saving transitions and multi-week protocols, with no database and no time travel. Everything else is plumbing around it.

**Packages deliberately not created:** no `utils`, no `types` separate from `contracts`, no `logger`. Each would be a bucket without a boundary.

---

## 4. Frontend Boundaries

Two applications on two origins. A service worker's scope is origin-wide: in a single application the participant service worker would sit in front of authenticated dashboard routes, and dashboard code would ship in the public bundle. See ADR-009.

### Participant PWA — `app.example.org`

```text
/join/:studyCode          study information
/consent                  versioned consent, explicit acceptance
/home                     current status, next expected activity
/session/:id              questionnaire runtime
/session/:id/complete     confirmation
/install                  Home Screen guidance + handoff link
/notifications            permission state and re-enable path
/r/:code                  one-time continuity handoff redemption
```

Modules: enrollment · consent · continuity · status view · questionnaire renderer · autosave outbox · completion · push onboarding · install guidance · localisation.

**A participant identifier in a URL is never an authorization mechanism.** All participant endpoints derive identity from the credential cookie. The only identifier-bearing URL is `/r/:code`, whose code is single-use, short-lived, and rate-limited.

### Researcher Dashboard — `research.example.org`

```text
/login
/studies
/studies/:id
/studies/:id/questionnaires
/studies/:id/protocol
/studies/:id/participants
/studies/:id/participants/:participantId
/studies/:id/analytics
/studies/:id/export
/ops                      admin only — job and notification health
```

Modules: authentication · study builder · questionnaire builder · protocol editor with timeline preview · participant table · participant timeline · response inspector · compliance dashboard · descriptive analytics · exports · operational health.

---

## 5. Backend Modules

| Module | Responsibility |
|---|---|
| `auth` | Researcher authentication, DB-backed sessions, role guards, CSRF |
| `study` | Study metadata, lifecycle, enrollment code, QR, membership |
| `consent` | Versioned consent documents and acceptance records |
| `questionnaire` | Questionnaires, versions, questions, options, publishing |
| `protocol` | Protocols, versions, steps, reminder policies, trigger-graph validation, preview |
| `participant` | Pseudonymous identity, enrollment, continuity, withdrawal |
| `session` | ParticipantSession lifecycle and availability enforcement |
| `response` | Autosave, validation, completion transaction |
| `notification` | Subscriptions, attempts, guard chain, push transport |
| `analytics` | Compliance, distributions, monitoring queries |
| `export` | Long, wide, and codebook CSV generation |
| `audit` | Audit event recording |
| `health` | Liveness, readiness, operational metrics |

Study lifecycle: `DRAFT → ACTIVE → PAUSED → CLOSED → ARCHIVED`.

---

## 6. Domain Model

```text
researcher_users ──< study_members >── studies ──┬─< consent_versions
                                                 ├─< study_groups          (FR-45)
                                                 │
                                                 ├─< questionnaires ─< questionnaire_versions
                                                 │                        └─< question_versions ─< question_options
                                                 │                                                (+ *_translations)
                                                 ├─< protocols ─< protocol_versions ─< protocol_steps
                                                 │                                        │ → questionnaire_version_id
                                                 │                                        └─< reminder_policies
                                                 └─< enrollments ─── participants
                                                         │  (binds protocol_version + consent_version)
                                                         │
                                                         ├─< participant_sessions ─┬─< responses ─< response_option_selections
                                                         │   (one per step         │      └─< response_history (append-only)
                                                         │    occurrence)          ├─── session_submissions (1:1, on complete)
                                                         │                         └─< notification_attempts
                                                         │
                                                         └─ [identity schema] participant_credentials
                                                                               push_subscriptions
                                                                               participant_contacts
                                                                               recovery_codes
studies ──< audit_events

system_heartbeats          (standalone: operational, no relationships)
```

### Key entities

**`participants`** *(research schema)* — `id`, `public_code`, `study_id`, `enrolled_at`, `timezone` (IANA, nullable), `locale`, `status ∈ {ACTIVE, COMPLETED, WITHDRAWN}`, `withdrawn_at`, `withdrawal_reason`. Contains **no directly identifying field**.

`public_code` is `P-` plus six uppercase Crockford base-32 characters, from a CSPRNG, unique per study, excluding visually ambiguous characters (I, L, O, U). Never sequential — a sequential code leaks enrollment order and sample size.

**`enrollments`** — binds participant ↔ study ↔ `protocol_version_id` ↔ `consent_version_id` ↔ `consented_at` ↔ `consent_locale` ↔ `group_id`. **This is where protocol version pinning and group assignment happen** (NFR-17, FR-45). Both are decided once, at enrollment, and never change: an enrolled participant remains on their bound version and in their assigned group for life. Re-assigning a group mid-study would invalidate that participant's data.

**`study_groups`** — `study_id`, `key`, `label`, `allocation_weight`, `is_active`. A study with no groups behaves as a single-group study; nothing about that case becomes harder. The participant never sees a group label (FR-45).

**`questionnaire_versions`** — `status ∈ {DRAFT, PUBLISHED, RETIRED}`. One draft per questionnaire. Publishing deep-copies the draft into immutable rows. Published rows are protected by a `BEFORE UPDATE` trigger, not merely by convention.

**`question_versions`** — `questionnaire_version_id`, `question_key`, `display_order`, `type`, `is_required`, `page_index`, `config` (jsonb).

`question_key` is stable across versions and is the export column key (FR-43). `question_version_id` identifies the exact wording shown.

On `config`: everything queried relationally — order, type, required flag, page, key — is a real column. `config` holds only type-specific presentation parameters (Likert anchor labels, numeric bounds, text length limits) that are never filtered or joined on, and each type has a registered Zod schema validated on write. Adding a question type requires one enum value, one Zod schema, and one renderer — **no migration**.

**`question_options`** — `question_version_id`, `option_key`, `display_order`, `value_number`, `is_exclusive`. Normalised rather than embedded in jsonb, because option distributions are `GROUP BY` queries and responses need referential integrity to the exact option shown.

**`protocol_steps`** — the heart of the protocol engine:

| Field | Purpose |
|---|---|
| `protocol_version_id`, `step_index`, `step_key` | Identity; `step_key` is the stable export column prefix |
| `questionnaire_version_id` | Pinned to an immutable version |
| `trigger_type` | `ENROLLMENT` \| `CONSENT` \| `STEP_COMPLETED` \| `STEP_AVAILABLE` \| `FIXED_DATETIME` |
| `trigger_step_id` | Required when the trigger references another step |
| `trigger_occurrence_index` | Required when `trigger_step_id` names a recurring step, forbidden otherwise (FR-48a) |
| `trigger_fixed_date` | The designated day for a `FIXED_DATETIME` step. A **date**, not a timestamp — see below |
| `offset_iso` | ISO-8601 duration, e.g. `PT72H`. DST-immune |
| `anchor_local_time`, `anchor_timezone_source` | Wall-clock steps. `STUDY` \| `PARTICIPANT` |
| `window_duration_iso` | e.g. `PT24H` |
| `occurrence_count`, `recurrence_interval_iso` | `30` × `P1D` = daily for a month (FR-38) |
| `reminder_policy_id` | FK |
| `counts_toward_compliance` | Excludes exploratory steps from the denominator |
| `step_kind` | `SCHEDULED` \| `PARTICIPANT_INITIATED` (FR-46) |
| `min_interval_iso`, `max_per_day`, `max_total` | Rate limits, participant-initiated steps only |
| `allowed_group_ids` | Empty means all groups; otherwise restricts the step (FR-45) |

**Why `trigger_fixed_date` is a date.** A researcher picks a day on a calendar — "the cohort starts on the 7th" — and the instant that denotes is only fixed once the step's wall-clock anchor and the zone that anchor names are both known. Storing a timestamp would force the builder to choose a time and a zone at the moment of picking, invisibly. Worse, `anchor_timezone_source = PARTICIPANT` means the zone differs per participant: resolving the day to an instant up front in the study's zone makes a participant further west read it as the *previous* day, shifting their entire schedule by one day, silently, and only for some of the cohort. The date is therefore resolved per participant, in the anchor zone, at materialisation.

`questionnaire_version_id` is deliberately **not** unique across steps. A pre/post design pins one published version at two steps, so the two administrations are guaranteed to be the same instrument rather than two copies that drift (FR-47). Steps are distinguished everywhere by `step_key`, never by which questionnaire they administer.

Two publish-time validations live on this table beyond acyclicity and dangling references (FR-48, ADR-011): a trigger naming a recurring step must carry `trigger_occurrence_index`, and `trigger_type = STEP_COMPLETED` against a recurring step is rejected outright — an outcome measurement must not become unreachable because an intermediate occurrence was missed. The derived `unconditional` / `conditional` classification the builder displays is computed from this graph and never stored.

**`reminder_policies`** — `initial_delay_iso`, `interval_iso`, `max_reminders` (NOT NULL), `quiet_hours_start`, `quiet_hours_end`, `quiet_hours_behavior ∈ {SKIP, DEFER}` (FR-40).

**`participant_sessions`** — one row per (participant, protocol step, occurrence). Unique on that triple.

```text
id
participant_id
study_id
protocol_version_id
protocol_step_id
occurrence_index
questionnaire_version_id
status
trigger_fired_at
scheduled_at
available_from
available_until
started_at
completed_at
expired_at
cancelled_at
cancellation_reason
created_at
updated_at
```

**`responses`** — `session_id`, `participant_id`, `question_version_id`, `value_kind`, `value_number`, `value_text`, `value_boolean`, `answered_at`, `client_revision`. Unique on `(session_id, question_version_id)`. Plus `response_option_selections(response_id, question_option_id)`.

Typed columns rather than a single `value_json`: every analytics query and every export row is an aggregate over these values. Typed columns index and aggregate directly; jsonb requires casting on every read with no type guarantee and cannot enforce that a selected option exists in the version shown.

**`response_history`** — append-only record of every write. Cheap, and provides full forensics for autosave conflicts and any data-integrity question a reviewer raises.

**`session_submissions`** — 1:1 with a completed session: `completed_at`, `answered_count`, `required_count`, `content_hash`, `idempotency_key`. Draft responses are distinguished from a final submission by this row's existence plus the `COMPLETED` status — the answers themselves are never duplicated.

**`notification_attempts`** — `session_id`, `kind ∈ {INITIAL, REMINDER}`, `occurrence_index`, `push_subscription_id`, `scheduled_for`, `attempted_at`, `outcome`, `push_status_code`, `error_detail`. **Unique on `(session_id, kind, occurrence_index)`** — the primary duplicate-reminder guard.

**`system_heartbeats`** *(research schema)* — `worker_id` (PK), `started_at`, `swept_at`, `sweep_interval_seconds`, `consecutive_failures`, `last_error`. Operational evidence that the reconciliation loop in §8.4 is running (ADR-005).

Every other table records something that happened; this one exists so that something *not* happening becomes visible — a stopped sweep loop is indistinguishable from a loop with nothing to do. Two signals, deliberately separate: `swept_at` going stale means the loop stopped, while `consecutive_failures` rising means it runs and the work inside it fails. A worker whose sweepers all throw still completes its cycles, so a liveness-only heartbeat would read as healthy while nothing was reconciled.

Contains no participant data and no secret. Rows are never pruned automatically: a decommissioned worker leaves a permanently stale row, and removing it is an operator's deliberate act, because code that tidies away stale heartbeats is code that deletes the evidence of an outage.

**`audit_events`** — `actor_type`, `actor_id`, `study_id`, `action`, `entity_type`, `entity_id`, `metadata` (redacted jsonb), `ip_hash`, `occurred_at`. Never contains response payloads.

**`push_subscriptions`** *(identity schema)* — `participant_id`, `endpoint` (UNIQUE), `p256dh_key`, `auth_key`, `expiration_time`, `credential_context`, `is_active`, `deactivated_at`, `deactivation_reason ∈ {UNSUBSCRIBED, WITHDRAWN, EXPIRED, REJECTED_BY_SERVICE}`, `last_seen_at`.

Unique on the **endpoint**, not on the participant. A browser re-subscribes routinely — on every service-worker update, and whenever the client is unsure of its own state — so registration is an upsert on that key, enforced by the database rather than by the service checking first. The consequence worth stating: a device previously registered to another participant MOVES to the new one, because a shared or handed-on phone must never deliver one person's reminders to another.

Rows are deactivated, never deleted on the spot. "When did this participant stop receiving reminders?" is an operational question that surfaces weeks later, and a deleted row answers it with silence. The retention rule in `packages/domain/src/push/retention.ts` deletes them once the window has run, applied by `sweep.prune_subscriptions` — the only sweeper in the system that deletes anything, because an endpoint is a device identifier rather than research evidence.

No user agent, no device name, no IP: those would be re-identifying data collected for operator convenience.

**`participant_handoff_codes`** *(identity schema)* — `participant_id`, `code_hash`, `issued_at`, `expires_at`, `redeemed_at`. The install handoff of §11.4: 128 bits, hashed at rest, single-use by conditional UPDATE, and a stored `expires_at` rather than a derived one so that the TTL a code was minted under travels with the row.

**`participant_credentials.credential_context`** — `BROWSER` | `INSTALLED`. Rotation carries the value forward: a credential replaced on its thirtieth day must not silently revert an installed participant to looking at-risk.

**`researcher_users`, `researcher_sessions`** *(identity schema)* — researcher accounts and their server-side sessions.

These live in `identity`, not `research`, even though the domain-model diagram above draws `researcher_users` alongside the study graph. `app_analytics` holds `SELECT` on the whole of `research` (§11.2), so a researcher's email address and argon2id password hash would otherwise sit one accidental join away from an export code path. The privacy boundary is drawn around re-identifying and secret data, and these tables are both.

`researcher_users` — `email` (unique, lowercase-enforced), `password_hash`, `display_name`, `locale`, `is_admin`, `is_active`, `password_changed_at`, `last_login_at`. Accounts are deactivated, never deleted, so the audit trail stays interpretable.

`researcher_sessions` — `token_hash` (SHA-256; the token itself is never stored), `csrf_token_hash`, `user_id`, `expires_at` (absolute), `last_seen_at` (idle timeout), `revoked_at`, `ip_hash`, `user_agent`. Server-side rather than stateless, because revocation must take effect on the next request.

---

## 7. ParticipantSession State Machine

```text
                    ┌──────────────────┐
   enrollment ─────▶│ PENDING_TRIGGER  │  timing not yet computable
                    └────────┬─────────┘
                             │ trigger fires → compute scheduled_at
                             ▼
   enrollment ─────▶┌──────────────────┐
   (computable) ───▶│    SCHEDULED     │
                    └────────┬─────────┘
                             │ now ≥ available_from
                             ▼
                    ┌──────────────────┐──────────────┐
                    │    AVAILABLE     │              │ now > available_until
                    └────────┬─────────┘              ▼
                             │ first answer   ┌──────────────────────┐
                             │ persisted      │  EXPIRED_UNSTARTED   │
                             ▼                └──────────────────────┘
                    ┌──────────────────┐──────────────┐
                    │     STARTED      │              │ now > available_until
                    └────────┬─────────┘              ▼
                             │ complete()     ┌──────────────────────┐
                             │ validated      │   EXPIRED_PARTIAL    │
                             ▼                └──────────────────────┘
                    ┌──────────────────┐
                    │    COMPLETED     │
                    └──────────────────┘

   any non-terminal ───────▶ ┌──────────────────┐
                             │    CANCELLED     │
                             └──────────────────┘
```

### Transitions

| From | To | Trigger | Guard |
|---|---|---|---|
| `PENDING_TRIGGER` | `SCHEDULED` | Referenced step reaches `COMPLETED`/`AVAILABLE` | Same enrollment |
| `PENDING_TRIGGER` | `CANCELLED` | Trigger step terminal without completing | Cascades to dependents |
| `SCHEDULED` | `AVAILABLE` | Activation job or sweeper | `now ≥ available_from`, server clock |
| `SCHEDULED` | `CANCELLED` | Withdrawal, study closure | — |
| `AVAILABLE` | `STARTED` | First response persisted | Window open |
| `AVAILABLE` | `EXPIRED_UNSTARTED` | Expiry job or sweeper | `now > available_until`, zero responses |
| `STARTED` | `COMPLETED` | `POST /complete` | All required answered, window open, row locked |
| `STARTED` | `EXPIRED_PARTIAL` | Expiry job or sweeper | `now > available_until`, ≥1 response |
| `AVAILABLE`/`STARTED` | `CANCELLED` | Withdrawal | — |

**Forbidden and tested as such:** any transition out of a terminal state · any backwards transition · `SCHEDULED → COMPLETED` directly · any transition driven by a client-supplied timestamp.

**Cancellation reasons.** `cancellation_reason` records why a session left the protocol: `WITHDRAWAL`, `STUDY_CLOSED`, `TRIGGER_UNREACHABLE`, and `ENROLLED_AFTER_WINDOW` — the last being a recurring occurrence whose window had already closed when the participant enrolled (§8.2). It is a terminal state at materialisation rather than a transition, and it is the one cancellation that reflects nothing about the participant, so no interface may render it as a missed or failed session.

---

## 8. Scheduling Architecture

### 8.1 The governing principle

**The database is the schedule. The queue only executes.**

Every scheduling outcome is derivable from `participant_sessions` and `notification_attempts` alone. If the job system lost every pending job, the reconciliation sweepers in §8.4 would restore correct behaviour within one minute. Jobs make the system *prompt*; sweepers make it *correct*. See ADR-005.

### 8.2 Materialisation

At enrollment, all ParticipantSessions for every step of the bound protocol version are created immediately, expanded across `occurrence_count`. Steps whose time is computable start in `SCHEDULED`; the rest start in `PENDING_TRIGGER`.

Materialising upfront rather than lazily is what makes the compliance denominator and the participant timeline knowable, and pins the protocol version at one well-defined moment.

The whole expansion happens in **one transaction**. For the reference protocol that is 32 rows per enrollment — one baseline, thirty daily occurrences, one endline — and NFR-11 requires headroom to 40. A partially materialised enrollment would be a participant with a silently truncated protocol, which no sweeper can detect, because the sweepers reconcile the sessions that exist against the clock, not against the protocol version.

**Occurrences that are already over.** A step anchored to a `FIXED_DATETIME` can have occurrences whose window closed before this participant enrolled. They are materialised as `CANCELLED` with `cancellation_reason = 'ENROLLED_AFTER_WINDOW'` — never `EXPIRED_UNSTARTED`, which means "offered and not done" and would put measurements the participant was never offered into their compliance denominator (FR-38, FR-44). An occurrence whose window is open at that instant materialises normally and activates as usual. See ADR-011.

Two exceptions (FR-45, FR-46). Steps whose `allowed_group_ids` excludes the participant's group are not materialised at all. **Participant-initiated steps are not materialised either** — they have no computable time, so a ParticipantSession is created on demand when the participant starts one, after the server re-checks `min_interval_iso`, `max_per_day` and `max_total` against existing sessions. Those limits are enforced server-side; the client may hide the button, but hiding is not enforcement.

### 8.3 Timing computation

```text
Duration mode   (offset_iso set)
  available_from = anchor_utc + offset_iso        ← pure UTC, DST-immune
  Use for: "baseline completion + 72h", "enrollment + 48h"

Wall-clock mode (anchor_local_time set)
  zone   = anchor_timezone_source == PARTICIPANT
             ? participant.timezone ?? study.timezone
             : study.timezone
  local  = (anchor_utc in zone).plus(day_offset).set{ anchor_local_time }
  available_from = local.toUTC()
  Use for: "every day at 18:00 local"

available_until = available_from + window_duration_iso   (always duration arithmetic)
```

**Daylight saving.** Duration mode is inherently safe. Wall-clock mode must handle two anomalies explicitly, each with a named unit test:

- **Spring-forward gap** — a local time that does not exist. Shift forward to the first valid instant.
- **Fall-back ambiguity** — a local time occurring twice. Take the first occurrence, maximising the response window.

Türkiye has been permanently UTC+3 with no DST since 2016, which limits exposure for an initial Turkish study — but participants may travel or be recruited elsewhere, so the logic is required regardless.

**Recurrence.** Occurrence *n* is anchored on the step's own trigger plus *n* × `recurrence_interval_iso`, never chained from occurrence *n−1*. A missed occurrence therefore does not delay the ones after it.

**Worked example — the reference protocol.** Study zone `Europe/Istanbul`, block origin `2026-09-07` at `20:00` local, participant enrolled `2026-09-04T09:12Z`:

```text
baseline   ENROLLMENT + PT0S,  window P3D     → 2026-09-04T09:12Z … 2026-09-07T09:12Z
daily #n   FIXED_DATETIME origin + n × P1D,
           wall-clock 20:00 participant zone,
           window PT12H                       → #0  2026-09-07T17:00Z … 2026-09-08T05:00Z
                                                #29 2026-10-06T17:00Z … 2026-10-07T05:00Z
endline    same origin + P30D, window P3D     → 2026-10-07T17:00Z … 2026-10-10T17:00Z
```

The endline shares the block's origin instead of chaining off its last occurrence, so daily adherence cannot make the study's primary outcome measurement unreachable (FR-48c). The full table, the participant-relative variant, and the late-enrollment case are in `docs/reference-protocol.md`; the protocol builder's preview and the materialisation tests both assert against it.

### 8.4 Reconciliation sweepers

Sweepers on a 60-second loop, each holding a cross-replica advisory lock on its own name so only one instance runs at a time. Registered today: `sweep.activate_due`, `sweep.expire_due`, `sweep.expire_subscriptions`, `sweep.prune_subscriptions`, and `sweep.heartbeat`. `sweep.notifications_due` arrives with Phase 9, when `notification_attempts` exists.

```sql
-- sweep.activate_due
SELECT id FROM research.participant_sessions
WHERE status = 'SCHEDULED' AND available_from <= now()
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.expire_due
SELECT id FROM research.participant_sessions
WHERE status IN ('AVAILABLE','STARTED') AND available_until <= now()
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.expire_subscriptions
SELECT id FROM identity.push_subscriptions
WHERE is_active AND expiration_time IS NOT NULL AND expiration_time <= now()
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.prune_subscriptions   (the only sweeper that DELETES; see §6)
SELECT id FROM identity.push_subscriptions
WHERE NOT is_active AND deactivated_at <= now() - INTERVAL '30 days'
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.notifications_due   (Phase 9)
--   sessions in AVAILABLE/STARTED, window open, active subscription,
--   whose next due notification has no notification_attempts row
FOR UPDATE SKIP LOCKED LIMIT 500;

-- sweep.heartbeat
--   write system_heartbeats(worker_id, swept_at); alert if stale > 5 min
```

These four queries mean the system converges on correct state from any starting condition: queue wiped, worker down for hours, database restored from backup, jobs duplicated. Recovery requires no manual intervention.
**Exclusion is a PostgreSQL advisory lock, not a job `singletonKey`** (ADR-005 implementation notes). A singleton key collapses duplicate *enqueues*; the property wanted here is that overlapping *execution* is excluded. It also holds for the configurable `SWEEP_INTERVAL_SECONDS`, which cron's one-minute granularity cannot express, and it is released by the database when the session ends however it ends — so a worker killed mid-sweep leaves nothing behind, where a lock row would survive and be indistinguishable from a sweep still in progress.

The exclusion is an efficiency measure, not a correctness one. Correctness comes from `SKIP LOCKED` plus re-deriving every decision under a row lock, so replicas sweeping simultaneously duplicate work and still produce correct results. Any sweeper that would misbehave when two run at once is a broken sweeper.

`sweep.heartbeat` and the loop itself are built (`apps/worker/src/sweepers/`). The three session sweepers are registered once `participant_sessions` and `notification_attempts` exist; each supplies four functions — `claim`, `lock`, `decide`, `apply` — to the shared `reconcile()` that implements the §8.5 handler contract.


### 8.5 Jobs

| Job | Enqueued | Handler |
|---|---|---|
| `session.activate` | On materialisation or trigger firing, delayed to `available_from` | Lock row; `SCHEDULED` → `AVAILABLE`; enqueue expiry and initial notification |
| `session.expire` | On activation, delayed to `available_until` | Lock row; `AVAILABLE`→`EXPIRED_UNSTARTED`, `STARTED`→`EXPIRED_PARTIAL`; no-op if completed |
| `notification.send` | Self-chaining, see §9 | Guard chain, send, record, chain next |
| `protocol.materialize` | On completion, in the completion transaction | Move dependent sessions to `SCHEDULED`; enqueue activations |
| `subscription.prune` | Daily | Remove subscriptions long marked gone |

**Universal handler contract.** Every handler, without exception:

1. Opens a transaction and takes `SELECT … FOR UPDATE` on the session row.
2. Re-reads canonical state and re-derives the decision. It never trusts the job payload beyond identifiers.
3. Is a no-op when the decision is no longer valid, recording *why* when research-relevant.
4. Is safe to run twice, out of order, or a week late.

Retries use exponential backoff with a limit of 5. Exhausted jobs land in the dead-letter queue and surface on the ops page. Because sweepers are authoritative, a dead-lettered job degrades timing, not correctness.

### 8.6 Idempotency

| Risk | Mechanism |
|---|---|
| Duplicate reminder | Unique `(session_id, kind, occurrence_index)` |
| Duplicate materialisation | Unique `(participant_id, protocol_step_id, occurrence_index)` |
| Duplicate answer | Unique `(session_id, question_version_id)` + upsert gated on `client_revision` |
| Duplicate completion | Unique `session_id` on `session_submissions`; conditional update returning zero rows returns the existing submission with 200 |
| Duplicate enrollment | Valid existing credential resumes rather than creates |
| Concurrent jobs | Row-level `FOR UPDATE` + `singletonKey` |
| Concurrent sweepers | `FOR UPDATE SKIP LOCKED` + cron `singletonKey` |

---

## 9. Notification Architecture

### 9.1 Reminder chain

Reminders are **self-chaining, not pre-scheduled**. Reminder *n*'s handler schedules reminder *n+1*. There is no fan-out of jobs that must later be cancelled.

```text
session becomes AVAILABLE
  └─ enqueue notification.send(kind=INITIAL, occurrence=0)
        delay = reminder_policy.initial_delay_iso

  handler(session, kind, occurrence):
    BEGIN; SELECT … FOR UPDATE on session
    ── guard chain, in order ──────────────────────────────────────────
    1. status ∉ {AVAILABLE, STARTED}        → SUPPRESSED_STATE;     STOP
    2. now > available_until                → SUPPRESSED_EXPIRED;   STOP
    3. participant.status ≠ ACTIVE          → SUPPRESSED_WITHDRAWN; STOP
    4. occurrence > policy.max_reminders    → SUPPRESSED_CAP;       STOP
    5. attempt row already exists           → STOP  (idempotency)
    6. no active push subscription          → SUPPRESSED_NO_SUB;    STOP
    7. inside quiet hours →
         SKIP  → SUPPRESSED_QUIET; chain next; STOP
         DEFER → re-enqueue at quiet_hours_end; STOP
    8. scheduled_for older than one interval→ SUPPRESSED_STALE;     STOP
                                    (no burst after an outage)
    ── send ───────────────────────────────────────────────────────────
    INSERT notification_attempts (…, outcome='ATTEMPTED')
    COMMIT                          ← committed BEFORE the network call
    send via web-push
    UPDATE attempt SET outcome = SENT_ACCEPTED | FAILED, status_code
      404/410 → mark subscription inactive, do not retry this occurrence
    if occurrence < max_reminders:
      enqueue notification.send(occurrence+1) delayed by policy.interval_iso
```

**Committing the attempt row before the network call** guarantees at-most-once send per (session, kind, occurrence) even if the process dies mid-send. Losing a reminder is acceptable; repeatedly double-notifying a participant is not — it is both an annoyance and a compliance-data artefact.

### 9.2 Completion cancels reminders through state

`POST /complete` sets `COMPLETED` while holding the session row lock. Any in-flight reminder handler blocks on that same lock, then fails guard 1.

**This is why the completion-versus-reminder race cannot produce a post-completion notification** (FR-18): the two paths serialise on one row. No job-cancellation API is needed or trusted.

### 9.3 Observable events

| Event | Observable? | Source |
|---|---|---|
| `notification_scheduled` | Reliable | Server, on enqueue |
| `notification_attempted` | Reliable | Server, before send |
| `notification_accepted` | Reliable — **push service accepted it, not delivered it** | Push service 201 |
| `notification_failed` | Reliable | Non-2xx; 404/410 means the subscription is gone |
| `notification_displayed` | Best-effort | Service worker `push`; lost if killed or offline |
| `notification_clicked` | Best-effort | Service worker `notificationclick` |
| `notification_dismissed` | Unreliable | `notificationclose` is inconsistent on iOS |
| `session_opened` / `started` / `completed` | Reliable | Server-side |

**Actual delivery, whether the participant saw it, and OS-level suppression are not observable.** Compliance analysis compares `notification_accepted` against `session_completed` and treats the gap as *unattributed*, never as "the participant ignored it".

### 9.4 Push payloads

Push payloads pass through third-party services. They therefore **contain no research content** — title and body are generic, localised, configurable strings. Deep links carry a session identifier only, and the endpoint re-authorises via the credential.

---

## 10. Time Strategy

- All timestamps persisted in UTC.
- Every study stores an explicit IANA timezone.
- Participant timezone is captured from the browser, validated server-side against the IANA database, and used **only** to interpret wall-clock anchors. It is never authoritative for whether a window is open.
- Availability is decided by the server clock exclusively. The browser clock is never consulted for protocol enforcement.
- All timing arithmetic uses Luxon and lives in `packages/domain`, where `Date.now()` is prohibited by lint rule and a `Clock` is injected.

Timing semantics are expressed structurally, not as free text:

```text
trigger            = STEP_COMPLETED(step_key='baseline')
offset_iso         = PT72H
window_duration_iso= PT24H
occurrence_count   = 1
```

---

## 11. Privacy Architecture

### 11.1 Pseudonymous, not anonymous

Push endpoints, continuity credentials, optional contact details, and response timing patterns are all re-identification vectors. Under GDPR Article 4(5) and KVKK this remains personal data.

**No interface string, export header, code comment, or generated document may describe this data as anonymous.**

### 11.2 Schema and role separation

```text
role app_readwrite   → CRUD on research, identity, pgboss      (api, worker)
role app_analytics   → SELECT on research ONLY
                       NO privileges on identity
                       ↑ used by every analytics and export code path
```

`identity` holds participant credentials, push subscriptions, contacts and recovery codes — and also `researcher_users` and `researcher_sessions`, so that no analytics or export path can reach a password hash or a session token either.

`research.audit_events` additionally has `UPDATE` and `DELETE` revoked from `app_readwrite` and a row trigger that rejects both. The trigger is the load-bearing control: migration and maintenance connections are superusers, and superusers bypass `GRANT`.

This makes NFR-03 enforceable rather than aspirational: an export query that accidentally joins a push endpoint fails at the database, in CI, before review.

### 11.3 Participant continuity

1. Enrollment mints a 256-bit CSPRNG token. `identity.participant_credentials` stores a SHA-256 hash and a lookup prefix — never the token.
2. Delivered as an HttpOnly, Secure, SameSite=Lax cookie, one-year lifetime. The token never appears in a URL, in `localStorage`, or in any log.
3. **Rotation:** on use, a credential older than 30 days is replaced; the old one stays valid for a 7-day grace period so concurrent requests never fail.
4. **Recovery:** an 8-character code displayed once at enrollment, rate-limited on redemption, mints a new credential. Optional email where the study collects one.
5. **Install handoff** — see below.

### 11.4 The PWA install handoff

On iOS, a Home-Screen-installed PWA can hold a different storage container than the Safari tab used to enroll. Enrolling in Safari and then installing would otherwise present the participant as a new person — a silent, total loss of their longitudinal chain at the highest-stakes moment.

```text
Safari tab: consent completes
  → server mints a ONE-TIME handoff code
      (128-bit, single-use, 24h TTL, rate-limited)
  → install screen shows Add-to-Home-Screen guidance
      + a tappable link  https://app…/r/<code>
  → participant installs, opens the PWA, taps the link INSIDE it
  → server redeems the code, mints a credential in the installed
      context, binds it to the SAME participant, invalidates the code
  → records credential_context = 'INSTALLED'
```

The dashboard surfaces participants whose only credential context is `BROWSER` as an at-risk cohort.

### 11.5 Application security controls

| Threat | Control |
|---|---|
| SQL injection | Drizzle parameterisation; raw SQL only via `sql` template placeholders — string concatenation of input is a CI-blocked lint rule |
| Stored XSS | Researcher-entered titles, question text, and consent bodies are plain text, rendered as text. No HTML, no `dangerouslySetInnerHTML` |
| Participant enumeration | Random `public_code`; uniform response bodies and timing regardless of existence |
| Rate limiting | Login 5/15min · enrollment 10/h/IP · recovery 5/h/IP · push registration 20/h · answer writes 300/min/session · export 10/h/user |
| Input validation | Zod at every boundary; answers validated against the schema of the exact question version shown |
| CSRF | SameSite=Lax + mandatory `Origin`/`Referer` check on state-changing requests + double-submit token |
| Secrets | Example env file with placeholders only; secret scanning in CI |
| Logging | pino redaction on cookies, authorization, tokens, endpoints, keys. Response payloads never logged at any level |
| Transport | HTTPS only, HSTS, secure cookies |
| At rest | Provider-managed volume encryption. Column-level encryption of responses is **not** used — it would break every analytics and export query for a threat better handled by access control and audit |
| Backups | Managed PITR, tested by a scheduled restore drill |

---

## 12. API Boundaries

Participant endpoints are **authenticated by the participant credential**. They are `/api/participant/*`, not `/api/public/*`. Only enrollment bootstrap is genuinely public.

```text
PUBLIC (unauthenticated, strictly rate-limited)
  GET  /api/participant/studies/:code            study info + consent for display
  POST /api/participant/studies/:code/enroll     → participant + credential cookie
  POST /api/participant/recover                  redeem recovery code
  POST /api/participant/handoff/redeem           redeem one-time install code

PARTICIPANT (credential cookie; identity always derived from the credential)
  GET  /api/participant/me
  POST /api/participant/consent
  GET  /api/participant/sessions
  GET  /api/participant/sessions/:id
  POST /api/participant/sessions/:id/start
  PUT  /api/participant/sessions/:id/answers/:questionVersionId
  POST /api/participant/sessions/:id/complete          Idempotency-Key
  GET  /api/participant/push/config                   VAPID PUBLIC key only
  GET  /api/participant/push/subscriptions
  POST /api/participant/push/subscriptions            upsert on endpoint
  DEL  /api/participant/push/subscriptions            endpoint in the BODY
  POST /api/participant/handoff                       mint one-time install code
  POST /api/participant/events
  POST /api/participant/withdraw

RESEARCHER (session cookie + role guard; every query scoped by study_id)
  /api/auth/*
  /api/studies                        CRUD, lifecycle, enrollment code, QR
  /api/studies/:id/members            OWNER
  /api/studies/:id/consent-versions   EDITOR
  /api/studies/:id/questionnaires     EDITOR   + /versions /questions /publish
  /api/studies/:id/protocols          EDITOR   + /versions /steps /publish /preview
  /api/studies/:id/participants       VIEWER+
  /api/studies/:id/sessions           VIEWER+
  /api/studies/:id/analytics/*        VIEWER+  (aggregate monitoring only)
  /api/studies/:id/exports/*          ANALYST+
  /api/studies/:id/audit              OWNER
  /api/ops/*                          admin

INTERNAL
  GET /health   GET /ready
```

**On the analytics line.** REQUIREMENTS.md §5.2 defines VIEWER as "view aggregate monitoring only; no response-level access", and aggregate monitoring is exactly what the compliance dashboard shows (FR-27, FR-28). The line VIEWER must not cross is individual responses and exports, which stay ANALYST+. The authoritative table is `PERMISSION_MINIMUM_ROLE` in `packages/domain/src/authz/permissions.ts`, asserted exhaustively in its tests.

**On the four public routes sharing the `/api/participant` prefix.** They are unauthenticated and marked as such in code, but they are the participant application's routes and are grouped with the rest of them rather than under a second prefix. The security property that matters is stated by the guard, not by the path.

**On `DEL …/push/subscriptions` taking a body.** Unusual, and deliberate: it names a push endpoint, which is itself a capability URL. In the path or a query string it would be written into browser history, referrer headers, and every access log in between (AGENT.md §5).

**Conventions:** Zod validation on every request and response · stable machine-readable error codes (`SESSION_EXPIRED`, `CONSENT_REQUIRED`, `REQUIRED_QUESTIONS_MISSING`) rather than raw messages · cursor pagination on participants, sessions, and audit · `Idempotency-Key` accepted on completion and enrollment · uniform responses on participant lookup regardless of existence.

---

## 13. Missingness Contract

**Specified in full in `docs/export-codebook.md`.** It is not repeated here, because a status table that drifts between two documents is worse than one that lives in a single place.

The architectural constraint it imposes on every component:

- Each cell carries a `response_status` drawn from seven values.
- The `value` column is populated **only** when that status is `ANSWERED`.
- **No sentinel numbers, no `NA` strings, never zero.** A zero that means "missed" is the single most damaging silent failure this product can ship.
- Classification is computed by `packages/domain/src/missingness/` and by nothing else. The dashboard, the response inspector, and both export formats all call the same function.

---

## 14. PWA Structure

The participant application provides a Web App Manifest with `display: standalone`, localised names, and a full icon set; a service worker handling `push`, `notificationclick`, and safe updates; installability metadata; and push subscription management.

Service worker updates never activate silently mid-questionnaire — the user is prompted.

Push permission is requested only after an explanatory screen and in response to an explicit user gesture, per browser requirements.

**The application must degrade safely when push is unavailable.** A participant with notifications denied can still open the study URL, see their current status, and complete every available session.

Full offline questionnaire completion is not an MVP requirement. The autosave outbox provides resilience against transient connectivity loss, which is a different and narrower guarantee.

---

## 15. Internationalization

`next-intl` in both applications, with catalogs in `packages/i18n`:

```text
packages/i18n/
├── en.json
└── tr.json
```

Three separate concerns, modelled separately:

1. **Interface strings** — the catalogs above. A CI check asserts both files have identical key sets.
2. **Researcher-entered content** — application data in `*_translations` tables keyed by (entity version, locale).
3. **Consent content** — versioned documents with per-locale bodies. The locale in which consent was accepted is recorded on the enrollment.

Participant locale resolution: URL parameter → participant preference → study default.

---

## 16. Testing Layers

```text
Unit  (Vitest, ~400)          all of packages/domain, pure and sub-second
├── protocol timing, both modes, incl. DST anomalies
├── recurrence expansion
├── state transitions — exhaustive over the 8×8 matrix
├── compliance formulas with worked denominators
├── missingness classification, all seven statuses
├── notification eligibility guard chain
└── export shaping, long and wide

Integration  (Vitest + Testcontainers, ~120)   real PostgreSQL
├── migrations on a clean database
├── every constraint verified by attempted violation
├── enrollment, consent, credential rotation
├── autosave idempotency and revision ordering
├── completion under concurrency
├── completion racing an in-flight reminder
├── sweeper recovery after simulated outage
├── duplicate job delivery
├── authorization matrix, role × endpoint
├── app_analytics provably cannot read identity
└── export reconciliation against source rows

E2E  (Playwright, 6 journeys)
└── researcher → participant → scheduling → notification → dashboard → export
```

A real PostgreSQL instance is required for integration tests: `SKIP LOCKED`, partial unique indexes, and transactional enqueue have no faithful in-memory equivalent, so a fake would test the wrong thing.

Time-dependent tests use an injected `Clock`. Push tests use a fake transport that records sends and simulates 201/404/410/500.

Test fixtures use neutral placeholder content (`Sample question 1`) exclusively. Real psychological instruments are never committed.

**The shared multi-step fixture is the reference protocol** (`docs/reference-protocol.md`): a ~100-item instrument administered at two steps, a thirty-occurrence daily block between them, 32 sessions per participant. Timing, materialisation, compliance, dashboard, and export tests all build on it, so a change that breaks the design breaks visibly in one place instead of subtly in twenty hand-written mini-protocols. Its computed instants are the assertion target — if the implementation disagrees with the table, one of the two is wrong and it is resolved before the phase closes. Smaller ad-hoc protocols remain appropriate for testing a single rule in isolation.

---

## 17. Deployment

Single EU region, one provider. See ADR-010.

```text
research.example.org  → researcher   Next.js
app.example.org       → participant  Next.js
api.example.org       → api          NestJS, always-on web service
                        worker       NestJS, always-on background worker
                        postgres     managed, PITR, daily backup
```

**The worker must run on an always-on instance.** A tier that spins down when idle stops the sweepers and silently disables the entire scheduling guarantee.

Environments: `local` (Docker Compose with PostgreSQL only) · `test` (ephemeral Testcontainers) · `staging` (full mirror, seeded, with **accelerated protocol timings** so multi-day flows validate in minutes) · `production`.

Deploy flow: push → CI (lint, typecheck, unit, integration) → build → pre-deploy migration → api and worker → frontends. Migrations are always backward-compatible with the previous release, so a rollback never strands the schema.

Operational baseline: `/health` and `/ready` · Sentry on all four services · heartbeat alerting if sweepers go stale beyond 5 minutes · an admin ops page showing dead-lettered jobs, push failure rates by status code, subscription attrition, and last sweep times · a scheduled restore drill.

---

## 18. Architecture Decision Records

```text
docs/adr/
├── ADR-001-monorepo-and-tooling.md
├── ADR-002-backend-framework.md
├── ADR-003-database-and-data-access.md
├── ADR-004-background-jobs.md
├── ADR-005-scheduling-guarantee.md
├── ADR-006-push-notifications.md
├── ADR-007-participant-continuity.md
├── ADR-008-versioning-model.md
├── ADR-009-frontend-application-split.md
├── ADR-010-deployment-platform.md
└── ADR-011-recurring-block-anchoring.md
```

Each records context, decision, alternatives rejected with reasons, and consequences.

---

## 19. Architectural Constraints

The canonical list of prohibited implementations is **`AGENT.md` §17 — Non-Negotiable Red Flags**. It is not repeated here.

Architecturally, the constraints with the widest blast radius are:

- multi-day scheduling must never depend on an in-memory timer or an open browser tab;
- published questionnaire and protocol versions must never be mutated;
- the browser clock must never decide availability;
- a missing response must never be represented as zero;
- push acceptance must never be treated as delivery or as engagement.
