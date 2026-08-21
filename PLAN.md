# PLAN.md

## 1. Objective

This plan defines the path from an empty repository to a reliable MVP suitable for pilot research use.

The project prioritises research integrity, participant compliance, privacy, durable scheduling, and mobile usability. The first release must prove the full longitudinal workflow before adding advanced analytics or nonessential features.

**This document is the single roadmap.** An earlier draft contained two overlapping schemes; the milestone labels are retained only as a mapping table in §4 for anyone who prefers that vocabulary.

---

## 2. Delivery Strategy

Development proceeds in vertical slices rather than building isolated technical layers.

A useful vertical slice connects:

```text
Researcher configuration
→ persisted backend model
→ participant behavior
→ background scheduling
→ dashboard result
→ automated test
```

The MVP is complete only when the end-to-end acceptance scenario in `REQUIREMENTS.md` §11 works reliably.

**Each phase ends at a human review boundary.** Do not begin a phase until the previous phase's acceptance criteria are met and reviewed. Every phase carries an explicit "what NOT to build yet" list; treat it as binding.

---

## 3. Phase Sequence

```text
Phase D    Documentation consolidation          (Markdown only — no code)   done
────────── READINESS GATE ──────────────────────────────────────────────
Phase 0    Foundation and architecture records                             done
Phase 1    Core domain and database                                        done
Phase 2    Researcher authentication, studies, audit                       done
Phase 3    Questionnaire builder and versioning                            done
Phase 4    Protocol builder and versioning                                 done
Phase 5    Participant enrollment, consent, continuity                     done
Phase 6    Questionnaire runtime: autosave, resume, completion            done
Phase 7    Longitudinal protocol and scheduling engine                     done
Phase 8    PWA and push subscription lifecycle                             done
Phase 9    Notification and reminder engine                             ← next
Phase 10   Researcher monitoring and compliance dashboard
Phase 11   Descriptive analytics and data export
Phase 12   Hardening: security, observability, i18n completion
Phase 13   Pilot validation and MVP release gate
```

**Out of sequence.** ADR-004's job queue and ADR-005's reconciliation loop were
built ahead of the phase that consumes them, because their *shape* is what the
scheduling engine's design depends on. Phase 7 registered `sweep.activate_due`
and `sweep.expire_due` against that machinery, which is what it was for, and
Phase 8 added `sweep.expire_subscriptions` and `sweep.prune_subscriptions`.
`sweep.notifications_due` and every job handler remain unregistered until Phase
9 — nothing before it sends anything at all.

**One deviation, recorded.** Phase 8's background-job impact is written below as
"the daily subscription-pruning job only". It shipped as a sweeper in the
existing reconciliation loop instead. A cron job would have required switching
on pg-boss scheduling, a queue, a definition and a handler — infrastructure
Phase 7 deliberately did not build and Phase 9 will design properly around
sends — while pruning needs none of it: the work is defined entirely by what is
in the table, it is idempotent by construction, and after the first pass on any
day the claim returns nothing. "Daily" described how often the work needs
doing, not the mechanism. See `apps/worker/src/sweepers/push-sweepers.ts`.

**Ordering rationale.** Documentation is consolidated first, because every later phase reads these files as its contract. The questionnaire runtime (6) precedes the scheduling engine (7) because the engine's most important trigger is session completion, which must exist first. Subscriptions (8) precede sending (9). Protocol *definition* (4) is separated from protocol *execution* (7) so the highest-risk subsystem is built against a stable, already-tested data model.

---

## 4. Milestone Mapping

| Milestone | Phases |
|---|---|
| M0 — Foundation | D, 0, 1 |
| M1 — Form System | 2, 3 |
| M2 — Participant Baseline | 4, 5, 6 |
| M3 — Longitudinal Engine | 7 |
| M4 — Compliance | 8, 9 |
| M5 — Research Operations | 10 |
| M6 — Data Delivery | 11 |
| M7 — Pilot Ready | 12, 13 |

---

# Phase D — Documentation Consolidation

**Markdown and `docs/` only. No code of any kind.**

## Objective

Collapse duplicated and contradictory prose into one authoritative source per topic, and write down every architectural decision, so Phase 0 begins against a clean contract.

## Why this is a phase

`AGENT.md` instructs every agent to read `REQUIREMENTS.md`, `STRUCTURE.md`, and `PLAN.md` before changing code. If those documents disagree with each other, agents produce contradictory code. Consolidating first removes the ambiguity at its source rather than re-litigating it in every later phase.

## Technical work

- `README.md` reduced to an overview and documentation map.
- `REQUIREMENTS.md` becomes the sole normative source, gaining a glossary, the twelve gap resolutions (FR-38 to FR-44, NFR-17, NFR-18, and amendments to FR-14, FR-32, NFR-06), and the open research-team decisions.
- `STRUCTURE.md` rewritten as the decided architecture: stack, domain model, state machine, scheduling design, notification guard chain, privacy architecture, API boundaries, missingness contract.
- `AGENT.md` trimmed of duplicated entity and scope lists; three rules added.
- `PLAN.md` reduced to one roadmap.
- `CLAUDE.md` unchanged.
- New: `docs/adr/ADR-001` … `ADR-010`, `docs/compliance-formula.md`, `docs/export-codebook.md`, `docs/runbooks/`.

## Acceptance criteria

- `git status` shows changes only to `*.md` and new files under `docs/`.
- `README.md` drops by roughly 85%, retaining only overview and navigation.
- Each previously duplicated topic — out-of-scope list, acceptance scenario, session states, non-negotiables, export formats, entity model — appears in exactly one authoritative file, with pointers elsewhere.
- All twelve documented gaps have a requirement in `REQUIREMENTS.md` or a design in `STRUCTURE.md`.
- Rejected technologies appear only in `docs/adr/` and in `STRUCTURE.md` §1's rejected-alternatives line, never as an undecided option.
- Ten ADR files exist, each naming what it rejected and why.
- A reader given only the root documents can state the backend framework, the queue, and the push provider without ambiguity.

**Note on total size.** Removing duplication reduces the documents; writing down the twelve previously-missing specifications increases them. Expect the total to stay roughly flat or grow slightly. Line count is not the goal — single-sourcing is. Do not delete substantive specification to hit a number.

## What NOT to do

No `pnpm init`. No dependency installation. No source files. No schema. No Docker. No CI configuration.

---

# READINESS GATE

Phase 0 is the first phase that writes code. Do not start it until every line below is true.

| # | Check | Verified by |
|---|---|---|
| G1 | Phase D complete; all acceptance criteria met | Human review of the diff |
| G2 | No contradiction remains between the root documents | Search checks from Phase D |
| G3 | Ten ADRs written, each with rejected alternatives | `ls docs/adr/` |
| G4 | `docs/compliance-formula.md` denominator rule is unambiguous | Human review |
| G5 | `docs/export-codebook.md` defines all seven response statuses | Human review |
| G6 | All twelve gaps resolved, or explicitly deferred in writing | Checklist walkthrough |
| G7 | The four questions in `REQUIREMENTS.md` §10 have been sent to the research team | They need not be answered yet |
| G8 | Hosting region confirmed acceptable in principle | Changes only ADR-010 if it differs |
| G9 | A domain name exists, or its deferral is recorded | Web Push needs HTTPS on a real domain by Phase 8 |
| G10 | Human has read and approved phases 0–13 | Explicit sign-off |

**If G1–G6 are not all green, Phase 0 does not start.** G7–G10 may carry a written deferral, since none blocks writing Phase 0's code.

---

# Phase 0 — Foundation and Architecture Records

## Objective

A monorepo that boots, tests, lints, and deploys a trivial application, with all ten architectural decisions recorded.

## Dependencies

Readiness gate green.

## Technical work

pnpm workspace and Turborepo · the four apps and six packages as skeletons · shared tsconfig, eslint, prettier, and vitest configuration in `packages/config` · **the ESLint import-boundary rule enforcing the dependency direction in `STRUCTURE.md` §3** · `.gitignore` and `.env.example` with placeholders only · Docker Compose with PostgreSQL for local development · CI running lint, typecheck, unit, integration, and build · Sentry wiring · `next-intl` scaffolding with `en.json` and `tr.json` containing only the strings the health pages use · `render.yaml` for four services and a database, not yet deployed.

## Data-model impact

None. Migration tooling is configured; zero migrations are authored.

## API impact

`/health` and `/ready` only.

## Frontend impact

Both applications render one localised page in English and Turkish.

## Background-job impact

pg-boss installed and connecting. Zero handlers.

## Security considerations

Secret scanning in CI. `.env.example` contains no real values.

## Testing

One trivial unit test and one Testcontainers test proving the harness works.

## Acceptance criteria

- `pnpm install && pnpm build && pnpm test && pnpm lint` pass from a clean clone.
- CI is green.
- Both frontends serve `/en` and `/tr`.
- `/health` and `/ready` return 200; `/ready` returns 503 with PostgreSQL stopped.
- A deliberate import of `packages/db` from `apps/participant` **fails lint**.
- No secrets are present in the repository.

## What NOT to build yet

No domain tables. No authentication. No business logic. No live deployment. No UI beyond health pages.

---

# Phase 1 — Core Domain and Database

## Objective

The complete canonical schema and the pure domain logic, with no HTTP surface. Research integrity is won or lost here.

## Dependencies

Phase 0.

## Technical work

The full Drizzle schema for both schemas per `STRUCTURE.md` §6 · migration 0001 creating `research` and `identity`, both database roles, and all tables · every constraint: the uniqueness rules in `STRUCTURE.md` §8.6, foreign-key integrity across the version graph, enum checks, and immutability triggers on published version rows · `packages/domain` implemented in full: scheduling in both timing modes with daylight-saving handling and recurrence expansion, the eight-state transition function, compliance, missingness, and the question-type registry · `packages/contracts` Zod schemas for every entity and question type · seed and factory helpers using neutral placeholder content.

## Data-model impact

Everything in `STRUCTURE.md` §6.

## API impact

None.

## Frontend impact

None.

## Background-job impact

None.

## Security considerations

The `app_analytics` role is created and verified to lack `SELECT` on `identity`.

## Testing

The heaviest unit phase — roughly 250 tests in `packages/domain`. Exhaustive state-transition table covering every legal and illegal transition. Named tests for daylight-saving spring-forward and fall-back. Recurrence expansion. Compliance with the worked examples from `docs/compliance-formula.md`. All seven missingness statuses.

Integration: migrations on a clean database; every constraint verified by an attempted violation; a test asserting `app_analytics` cannot read `identity.push_subscriptions`.

## Acceptance criteria

- Migrations run clean from an empty database and are idempotent on re-run.
- `packages/domain` has zero imports from `db` or NestJS, verified by lint.
- No `new Date()` or `Date.now()` anywhere in `packages/domain`, verified by lint.
- Every transition in `STRUCTURE.md` §7 has a passing test; every forbidden transition has a test asserting rejection.
- Both daylight-saving anomaly tests pass.
- `app_analytics` is provably denied on `identity`.
- Every formula in `docs/compliance-formula.md` has a corresponding test.

## What NOT to build yet

No controllers, no HTTP services, no authentication, no jobs, no UI.

---

# Phase 2 — Researcher Authentication, Studies, Audit

## Objective

A researcher can authenticate and manage studies, with authorization enforced server-side and audited.

## Dependencies

Phase 1.

## Technical work

`auth` module with argon2id, database-backed sessions, cookie handling, login, logout, and password change · role guard with a study-role decorator · CSRF via origin check and double-submit token · rate limiting on login · `study` module: CRUD, lifecycle, timezone, locales, enrollment code, QR generation · study membership and role management · `audit` module and interceptor · researcher UI for login, study list, study settings, and members.

## Data-model impact

`researcher_users`, `researcher_sessions`, `studies`, `study_members`, `audit_events` go live.

## API impact

`/api/auth/*`, `/api/studies`, `/api/studies/:id/members`.

## Frontend impact

Researcher application: login, study list, study create and edit, member management. Participant application unchanged.

## Security considerations

The authorization model is established here and everything later inherits it. Every study-scoped query must filter by study in the query itself, never by trusting a checked path parameter. Sessions regenerate on login to prevent fixation. Failed login returns a uniform response and timing.

## Testing

Integration: the full role × endpoint authorization matrix, including a member of study A attempting every operation on study B. Session revocation takes effect on the next request. CSRF rejection without a valid origin. Rate limiting triggers. Audit rows written for every mutating operation.

## Acceptance criteria

- A researcher logs in, creates a study, and sees only their own studies.
- The cross-study authorization matrix passes with zero leaks.
- Logout invalidates the session server-side immediately.
- Every study mutation produced an audit event.
- The QR code resolves to the enrollment URL.

## What NOT to build yet

No password reset email — that is Phase 12. No permission matrix beyond the four roles. No participant-facing functionality.

---

# Phase 3 — Questionnaire Builder and Versioning

## Objective

A researcher builds a questionnaire from scratch and publishes it as an immutable version.

## Dependencies

Phase 2.

## Technical work

`questionnaire` module: questionnaire CRUD, draft version management, question CRUD, reordering within a single transaction, option management, page grouping · the five MVP question types through the `packages/domain` registry · the publish operation, deep-copying a draft into immutable rows · `question_key` assignment and stability across versions · translation rows for question text and option labels · researcher UI with drag-reorder, per-type configuration panels, required toggles, page grouping, mobile preview, and an explicit "this becomes immutable" confirmation at publish.

## Data-model impact

`questionnaires`, `questionnaire_versions`, `question_versions`, `question_options`, and the translation tables go live.

## API impact

`/api/studies/:id/questionnaires/**` including publish.

## Frontend impact

The largest researcher surface so far, including a preview showing exactly what the participant will see.

## Security considerations

Question text and option labels are stored and rendered as plain text. A test asserts that a script payload entered as question text renders as literal text in the builder preview and, later, in the participant runtime.

## Testing

Unit: configuration validation per type, reorder correctness. Integration: publish deep-copies correctly; a published version is unchanged after the draft is edited further; `question_key` survives a version bump; a published row cannot be updated; translations attach to the correct version.

## Acceptance criteria

- A researcher builds a multi-page questionnaire of at least ten questions covering all five types and publishes version 1.
- Editing the draft afterwards and publishing version 2 leaves version 1 provably unchanged.
- The XSS payload test passes.
- Reordering twenty questions persists correctly and is idempotent.
- Turkish and English question text both persist and render.
- **A ~100-item, ~10-page questionnaire — the reference design's `core` instrument (`docs/reference-protocol.md`) — is built, reordered, previewed on a phone viewport, and published in one transaction.** This is the size the platform is actually for; a builder that is pleasant with twelve questions and unusable with a hundred has not met the requirement (FR-21, NFR-11).

## What NOT to build yet

No conditional branching. No question bank or templates. No file-upload, date, matrix, or slider types. No participant rendering.

---

# Phase 4 — Protocol Builder and Versioning

## Objective

A researcher expresses a longitudinal protocol as data. **Definition only — nothing executes.**

## Dependencies

Phase 3.

## Technical work

`protocol` module: protocol CRUD, draft version, step CRUD and ordering · all five trigger types · duration and wall-clock timing modes · window duration · recurrence · reminder policies including the reminder cap and quiet hours · the compliance-exclusion flag · validation that the trigger graph is acyclic with no dangling references · **the FR-48 trigger rules: `trigger_occurrence_index` required against a recurring step, `STEP_COMPLETED` against a recurring step rejected, and the derived unconditional/conditional classification** · publish to an immutable version · researcher UI with a step list, per-step editor, reminder policy editor, and a **timeline preview** that renders the protocol for a hypothetical participant using the real domain timing functions and labels which steps depend on participant compliance.

Reusing one questionnaire version at two steps (FR-47) must work through the ordinary path — no special case in the builder, no warning, no duplication prompt.

## Data-model impact

`protocols`, `protocol_versions`, `protocol_steps`, `reminder_policies` go live.

## API impact

`/api/studies/:id/protocols/**` including publish and preview.

## Frontend impact

Protocol builder and timeline preview. The preview is the researcher's only defence against misconfiguring a study, so it must call the same functions the engine will.

## Background-job impact

None. The engine does not exist yet and must not be started here.

## Security considerations

Protocol publication is audited. Reminder cadence is validated against a minimum interval so a typo cannot create a notification storm.

## Testing

Unit: cycle and dangling-reference rejection; unqualified and completion-based triggers against a recurring step are rejected; the unconditional/conditional classification is correct for both reference anchor modes; the preview matches hand-computed times for a fixture protocol including a recurring step and a daylight-saving-crossing wall-clock step. Integration: publish immutability; a step cannot reference a draft questionnaire version; two steps referencing one published questionnaire version publish cleanly.

## Acceptance criteria

- A researcher builds and publishes **the reference protocol** (`docs/reference-protocol.md`): baseline at enrollment; a thirty-occurrence daily block at daily intervals anchored to a local wall-clock time; an endline anchored on the block's own origin, administering the same questionnaire version as the baseline.
- The preview shows exactly the instants tabulated in that document, verified against the hand-computed fixture, for both the fixed-date and participant-relative anchor modes.
- A step triggered by the *completion* of the recurring daily step is rejected at publish, with an error that names the step and says why (FR-48c).
- A step triggered by a recurring step without an occurrence index is rejected (FR-48a).
- The preview labels each step unconditional or conditional, and names what a conditional step depends on.
- A cyclic protocol is rejected with a clear error.
- A reminder interval below the minimum is rejected.

## What NOT to build yet

**No session materialisation. No jobs. No sweepers. No notifications.** This phase writes protocol rows and stops.

---

# Phase 5 — Participant Enrollment, Consent, Continuity

## Objective

The first real participant flow: join, read, consent, and receive an identity that survives closing the browser.

## Dependencies

Phase 4.

## Technical work

`consent` module with versioned documents, translations, and publishing · `participant` module: `public_code` generation, enrollment, consent recording with locale, timezone capture and IANA validation, withdrawal · continuity per `STRUCTURE.md` §11.3: hashed token credential, cookie delivery, rotation with grace period, recovery code · rate limiting on enrollment and recovery · a valid credential resumes rather than creating a second enrollment · participant UI: study information, consent with explicit affirmative action, identity confirmation showing the recovery code once, and a home screen that correctly reports nothing available yet.

## Data-model impact

`participants`, `enrollments`, `consent_versions`, and the identity tables go live. **`participant_sessions` are still not created** — that is Phase 7.

## API impact

Public study, enroll, and recover endpoints; participant me, consent, and withdraw.

## Frontend impact

The participant application becomes real: mobile-first, large touch targets, Turkish and English, minimal navigation.

## Security considerations

The most security-sensitive phase. The credential token must never appear in a URL, a log, `localStorage`, or any client-readable variable. `public_code` must be non-sequential. A request for a nonexistent study code and a nonexistent recovery code must be indistinguishable from valid ones in body and timing. Consent is server-authoritative.

## Testing

Integration: enroll, close the browser context, return, same participant. Recovery redeems exactly once. Rotation preserves identity and honours the grace period. An enumeration test comparing responses and timing across valid and invalid codes. The consent gate blocks with zero response rows written.

E2E: the consent gate and the Turkish locale path.

## Acceptance criteria

- Open link, consent, receive a code, close the browser entirely, reopen, same participant with no re-consent.
- The credential token appears in no log, URL, or client-readable storage, asserted by a test scanning captured logs.
- Recovery works exactly once, then fails.
- Declining consent blocks all session endpoints.
- The full flow works in Turkish.

## What NOT to build yet

No sessions, no questionnaire rendering, no push, no PWA install, no scheduling. The home screen legitimately shows an empty state.

---

# Phase 6 — Questionnaire Runtime: Autosave, Resume, Completion

## Objective

A participant reliably answers a questionnaire and cannot lose meaningful progress.

## Dependencies

Phase 5. Sessions are created manually via test fixtures in this phase; the engine arrives in Phase 7.

## Technical work

`session` module: fetch session with questionnaire version and saved answers, start, server-side window enforcement · `response` module: autosave upsert gated on a monotonic client revision, append to response history, per-type value validation against the exact question version shown · the completion transaction: row lock, server-side required-question validation, submission record with content hash, transition to completed, with repeat calls returning the existing submission · participant UI: renderers for all five types, pagination, progress indicator, required-question validation with clear errors, completion screen · the client autosave engine: debounce per question, flush on blur, navigation, visibility change and page hide, an IndexedDB outbox replaying on reconnect, and a visible save-state indicator.

## Data-model impact

`participant_sessions`, `responses`, `response_option_selections`, `response_history`, `session_submissions` go live.

## API impact

Participant session, answer, and completion endpoints.

## Frontend impact

The core participant experience.

## Security considerations

Every session endpoint derives the participant from the credential and verifies session ownership. A client cannot extend an expired window: all window checks use server time exclusively. Required-question validation is server-side; client validation is a convenience.

## Testing

Unit: value validation per type, required-completeness computation.

Integration: a duplicate autosave with the same revision is a no-op; a lower revision is rejected and both are recorded in history; completion is idempotent under ten concurrent calls, producing exactly one submission; completing with a required question unanswered is rejected; writes to an expired session are rejected regardless of client clock; a completed session rejects further writes.

E2E: answer part of a questionnaire, kill the browser context, reopen, and assert exactly the saved answers are restored.

## Acceptance criteria

- All five question types render and persist correctly on a phone viewport.
- The progress indicator is accurate across pages.
- Killing the browser mid-questionnaire loses zero server-acknowledged answers.
- Answers written offline queue and replay on reconnect.
- Ten concurrent completion calls produce exactly one submission.
- An expired session refuses writes regardless of client clock.

## What NOT to build yet

No scheduling, no notifications, no PWA install, no offline completion. The outbox is resilience, not offline mode.

---

# Phase 7 — Longitudinal Protocol and Scheduling Engine

## Objective

The system that makes this a longitudinal platform. **Highest-risk phase — expect it to take longest and be reviewed most carefully.**

## Dependencies

Phases 4 and 6.

## Technical work

Materialisation: on enrollment, expand every step and occurrence into sessions, scheduled where computable and pending-trigger otherwise · trigger propagation: on completion, within the same transaction, move dependent sessions to scheduled with computed times and enqueue activations · activation and expiry handlers · **the four reconciliation sweepers** · pg-boss configuration with singleton keys, retry policy, and dead-letter handling · the injected clock wired throughout · cascade cancellation when a trigger becomes unreachable · withdrawal cancels non-terminal sessions · the participant home screen shows the real available session and next expected activity.

## Data-model impact

`system_heartbeats` added; the pgboss schema goes live. No new domain tables — Phase 1 anticipated all of them.

## API impact

The participant sessions endpoint returns genuinely scheduled sessions.

## Frontend impact

The participant home screen becomes real.

## Background-job impact

This phase is the background-job impact. The worker becomes essential infrastructure.

## Security considerations

All timing is server-computed. A participant cannot influence availability or expiry by any input.

## Testing

The most demanding test phase.

- With a fake clock: enroll on the reference protocol, materialise, and verify the exact expected session set — 32 sessions at the instants tabulated in `docs/reference-protocol.md`; complete baseline and verify the dependent session moves to scheduled at the correct instant; advance the clock across the full 36 days and verify each activation and expiry.
- Enrolling into a fixed-date block after it has started materialises the already-closed occurrences as `CANCELLED` with reason `ENROLLED_AFTER_WINDOW`, the currently-open one as `AVAILABLE`, and the rest as `SCHEDULED` — and the cancelled ones stay out of the compliance denominator.
- Two participants enrolling on different dates get independent, correct timelines.
- **Recovery tests, non-negotiable:** delete every pending job, run sweepers, assert full convergence · stop the worker for a simulated six hours, restart, assert convergence with no duplicate side effects · deliver the same job twice, assert one effect · kill a handler mid-transaction, assert no partial state.
- A wall-clock step crossing both daylight-saving transitions produces the documented instants.
- Withdrawal cancels exactly the non-terminal sessions.

## Acceptance criteria

- Completing baseline causes the dependent step to become available at exactly the configured participant-relative instant, with no manual intervention.
- Enrolling on the reference protocol materialises exactly 32 sessions in one transaction, and the thirty-occurrence daily block lands on the correct local times.
- A participant who misses every daily occurrence still receives the endline at the correct instant. This is the acceptance criterion the FR-48c prohibition exists for.
- **Wiping the job queue entirely and running the sweepers restores fully correct state.**
- A six-hour worker outage self-heals on restart with no duplicates.
- Two participants enrolling five days apart have correct independent timelines.
- Expired sessions land in the correct one of the two expiry states.

## What NOT to build yet

**No notifications.** Sessions become available silently. Resisting this is what keeps the phase reviewable.

---

# Phase 8 — PWA and Push Subscription Lifecycle

## Objective

The participant application installs on iOS and Android and holds a valid push subscription. **Subscription management only — no sending.**

## Dependencies

Phase 6.

## Technical work

Web App Manifest with standalone display, icons, theme, and localised names · service worker with install, activate, safe update behaviour that never activates silently mid-questionnaire, and push and click handlers registered but only logging · push onboarding that explains the value first and requests permission on an explicit user gesture · VAPID key generation and secret handling · subscription registration storing the endpoint and keys in the identity schema · permission-state tracking and a persistent, non-nagging re-enable path · **iOS install guidance and the one-time handoff flow from `STRUCTURE.md` §11.4 — the highest-value item in this phase** · graceful degradation so everything works without push.

## Data-model impact

`identity.push_subscriptions` and the credential-context field go live.

## API impact

Push subscription registration and deletion; handoff code minting and redemption.

## Frontend impact

Platform-detected install guidance, notification onboarding, and a notification settings screen.

## Background-job impact

The daily subscription-pruning job only.

## Security considerations

The VAPID private key is a secret and never reaches the client. Push endpoints live in the identity schema and are never exposed to the researcher UI or exports. The handoff code is single-use, short-lived, and rate-limited. Permission is never requested on page load.

## Testing

Integration: subscription registration and replacement, where re-registering the same endpoint updates rather than duplicates; handoff code redeems once and binds to the same participant.

E2E: onboarding UI across default, granted, and denied permission states.

**Manual matrix:** Android install, permission, and receipt · iOS 16.4+ Safari to Home Screen, permission, and receipt · **the Safari-to-installed handoff on a real iPhone** · permission denied · permission revoked after granting · expired subscription · notification click from a cold start · device offline at send time then reconnecting.

## Acceptance criteria

- Installs to the Home Screen on iOS 16.4+ and to the app drawer on Android.
- Permission is requested only after an explanatory screen and an explicit tap.
- A valid subscription is stored and visible in participant settings.
- **The Safari-to-install handoff preserves participant identity on a real iOS device.**
- With permission denied, every questionnaire flow still works end to end.
- Re-registering the same endpoint does not create a duplicate row.

## What NOT to build yet

**No sending.** No reminder logic. No notification analytics.

---

# Phase 9 — Notification and Reminder Engine

## Objective

Participants receive an initial notification and configured reminders, and reminders stop the instant a session is completed.

## Dependencies

Phases 7 and 8.

## Technical work

`notification` module with a real push transport and a fake one for tests · the send handler implementing **the full eight-guard chain of `STRUCTURE.md` §9.1 in order** · self-chaining reminders · committing the attempt row before the network call · outcome recording including suppression reasons · deactivating subscriptions on gone responses · quiet-hours skip and defer · the reminder cap · the staleness guard preventing a post-outage burst · the notifications-due sweeper · the service worker push handler rendering a localised notification carrying no research content · click routing to the specific session, handling both cold start and an already-open application · best-effort client event reporting.

## Data-model impact

`notification_attempts` goes live with its unique constraint.

## API impact

The participant events endpoint; notification history on the participant profile.

## Frontend impact

Service worker handlers become functional; a notification history view in participant settings.

## Background-job impact

The second-largest job surface after Phase 7.

## Security considerations

**Push payloads contain no research content** — title and body are generic, localised, configurable strings. Payloads pass through third-party services. Deep links carry a session identifier only, and the endpoint re-authorises via the credential.

## Testing

Unit: each guard in isolation and the chain in order.

Integration: **completion racing an in-flight reminder, asserting zero post-completion sends** · the reminder chain stops at the cap · quiet-hours skip versus defer · a gone response deactivates the subscription and stops that chain · the staleness guard suppresses a burst after a simulated eight-hour outage · duplicate job delivery produces one attempt row.

E2E: reminder cancellation on completion.

## Acceptance criteria

- A session becoming available produces exactly one initial attempt.
- Reminders fire at the configured interval and stop at the cap.
- The cap holds per session across a thirty-occurrence daily block: a participant who ignores the block entirely receives at most `max_reminders` per occurrence and no accumulation across occurrences.
- **Completing mid-chain stops all further reminders, with a suppression record proving the guard fired.**
- No duplicate notification is produced under duplicate jobs or concurrent workers.
- An eight-hour outage does not produce a notification burst on recovery.
- Clicking a notification opens the correct session from a cold start on a real device.
- No code path or interface string claims guaranteed delivery.

## What NOT to build yet

No email or SMS fallback. No notification experiments. No randomised ESM windows.

---

# Phase 10 — Researcher Monitoring and Compliance Dashboard

## Objective

Researchers can see who is participating, who is not, and what any individual did.

## Dependencies

Phase 9.

## Technical work

`analytics` module using the analytics database role and **the compliance functions from `packages/domain` — no formula is re-implemented in the frontend** · overview metrics including withdrawn participants · the daily compliance breakdown · a participant list with per-participant compliance and cursor pagination · the participant timeline including recurring occurrences and states not yet reached · a longitudinal response inspector rendering all seven response statuses distinctly, **never as zero** · **the compliance denominator displayed rather than hidden** · the admin operations page showing dead-lettered jobs, push failure rates, sweeper heartbeats, and subscription attrition.

## Data-model impact

None. Covering indexes for dashboard queries, added by measurement rather than by guess.

## API impact

Analytics, participants, sessions, and operations endpoints.

## Frontend impact

The main researcher surface: overview, compliance table, participant list, participant detail, response inspector.

## Background-job impact

None. **All metrics are computed dynamically.** Several hundred participants does not justify precomputation, and cached aggregates are a correctness risk in a research context. Revisit only if a query exceeds roughly 500 ms with realistic data; the first remedy is an index, the second a materialised view with an explicit refresh, never an application-level cache.

## Security considerations

Response-level inspection requires the analyst role or above and is audited. The dashboard never displays contact details or push endpoints — the analytics database role makes this structurally impossible.

## Testing

Unit: compliance across edge cases including a zero denominator, all-withdrawn, and partial-only.

Integration: metrics reconcile exactly against hand-counted fixture data; missing is never rendered or serialised as zero; a viewer cannot reach response inspection; an analytics query attempting to join identity data fails.

## Acceptance criteria

- A researcher can answer all four daily-compliance questions.
- A participant timeline shows every step with its correct state, including all thirty occurrences of a recurring block and any cancelled by late enrollment, which read as not applicable rather than as missed.
- **Compliance is readable per step as well as overall** (FR-44): for a reference-protocol participant the dashboard shows daily-block adherence separately from baseline and endline completion, since one figure covering thirty occurrences and two anchors hides the number that matters most.
- The response inspector visually distinguishes all seven statuses.
- Dashboard numbers reconcile exactly with a hand-counted fixture study.
- The displayed denominator matches `docs/compliance-formula.md`.
- The operations page shows sweeper heartbeats and any dead-lettered jobs.

## What NOT to build yet

No charts — that is Phase 11. No custom report builder. No data editing from the dashboard.

---

# Phase 11 — Descriptive Analytics and Data Export

## Objective

Researchers get analysis-ready data whose missingness is unambiguous.

## Dependencies

Phase 10.

## Technical work

Descriptive analytics derived from the researcher's actual configuration, **never assuming a demographic variable exists**: option counts and percentages, numeric distributions, completion over time, and compliance trends · charts in the researcher application · **long-format CSV** streamed via a database cursor · **wide-format CSV** with columns keyed on the stable step, occurrence, and question keys, each paired with a status column · **the auto-generated codebook** making the export self-describing · export auditing.

The full column specification and the missingness contract are in `docs/export-codebook.md` and must be implemented exactly as written.

## Data-model impact

None.

## API impact

Analytics distributions and the three export endpoints.

## Frontend impact

An analytics page with charts and an export page with format selection, scope, and a plain-language explanation of missingness.

## Background-job impact

None for MVP — exports stream synchronously with bounded memory. If a study exceeds roughly 500,000 response rows, promote to a job producing a downloadable artefact; the streaming interface makes that a contained change.

## Security considerations

Export requires the analyst role or above, is rate-limited, and writes an audit event with row count and scope. Exports contain the public code only, guaranteed structurally by the analytics database role.

## Testing

Unit: long-format shaping across all seven statuses; wide-format column naming with a thirty-occurrence recurring step; two steps sharing one questionnaire version producing distinct column groups with identical question keys; codebook generation including the step section.

Integration: **the export reconciles row-for-row against the source responses** for a fixture study containing every missingness case; a missed session appears with the correct status and an empty value in both formats; wide columns stay stable across a questionnaire version bump; an unauthorised export is rejected and audited.

## Acceptance criteria

- The long export reconciles exactly with the dashboard and the underlying tables.
- All seven missingness situations appear correctly in a fixture export.
- No cell anywhere contains zero for a missing value.
- Wide export column names are stable across a version bump.
- **A reference-protocol export is produced and inspected**: ~1 000 wide columns, thirty daily occurrence groups, and the baseline and endline column groups carrying identical `question_key`s so a pre/post comparison is a direct join (FR-47).
- The codebook fully describes every column, code, and missingness value, **including the step section that identifies which column groups are the same instrument administered twice**.
- Every export produced an audit event.

## What NOT to build yet

No SPSS export, no R integration, no inferential statistics, no scheduled or emailed exports.

---

# Phase 12 — Hardening: Security, Observability, i18n Completion

## Objective

Make the MVP fit for a controlled pilot with real participants.

## Dependencies

Phases 0 through 11.

## Technical work

**Security:** dependency audit · full authorization-coverage review against the endpoint list · XSS sweep of every researcher-entered field rendered in the participant application · rate-limit verification · secret and log review · a security review of the accumulated changes.

**Reliability:** verified point-in-time backups plus a **documented and executed restore drill** · sweeper heartbeat alerting · a dead-letter triage runbook · push-failure alerting · readiness covering the database and the job system.

**Performance:** load test at 500 concurrent participants covering simultaneous autosave, a reminder burst, dashboard queries, and concurrent exports; add indexes where measured.

**Internationalization:** a full Turkish and English sweep, a CI check that both catalogs have identical key sets, and a layout review for Turkish string lengths.

**Accessibility:** semantic HTML, labels, focus order, touch-target sizes, contrast, and a screen-reader pass on the participant flow.

Plus: password reset by email, deferred from Phase 2 · the data retention and erasure procedure · runbooks in `docs/runbooks/`.

## Data-model impact

Only measured indexes and any retention-related columns.

## API impact

Password reset endpoints.

## Frontend impact

Accessibility and localisation fixes. No new features.

## Testing

Load test at target scale. Restore drill executed and timed. Automated accessibility checks on both applications. Internationalization key-parity check in CI. Full regression.

## Acceptance criteria

- Zero high or critical findings open from the security review.
- A backup restored into a clean environment and verified, with the runbook updated with real timings.
- The 500-participant load test passes with 95th-percentile answer writes under 300 ms and no dropped notifications.
- Turkish and English key sets are identical, with no untranslated string in either application.
- No critical accessibility violations on participant flows.
- Every runbook has been walked through once.

## What NOT to build yet

No new features. Anything discovered here that is not a defect goes to the post-MVP backlog.

---

# Phase 13 — Pilot Validation and MVP Release Gate

## Objective

Prove the system works with real people and real devices before a study depends on it.

## Dependencies

Phase 12.

## Technical work

Deploy to staging with **accelerated protocol timings** and run the full acceptance scenario against the reference protocol (`docs/reference-protocol.md`), compressing its 36 days into minutes · an internal dry run with five to ten team members on real iPhones and Androids across that compressed protocol · a **closed participant pilot** of ten to twenty participants at real timings for at least a week, long enough to exercise the daily block rather than only the baseline · instrument and **measure missed notifications separately from missed questionnaires**, because conflating them would misattribute a technical failure to participant behaviour · reconcile every pilot record end to end, from displayed value to database row to dashboard metric to CSV cell · collect participant feedback · triage and fix critical issues.

## Data-model impact

None expected. Any change discovered here is a genuine architectural finding and must be reviewed as such.

## MVP release gate

Release only when:

- the complete acceptance scenario passes in staging **and** in the pilot;
- scheduling survived at least one deliberate service restart during the pilot with no missed or duplicated session;
- no participant reported a lost answer;
- zero post-completion reminders occurred across the entire pilot;
- notification receipt rate is measured and documented per platform, with the iOS Home Screen path explicitly validated;
- every pilot participant's export reconciles with their source responses;
- Turkish and English paths were both exercised by real users;
- the audit log covers every administrative operation performed during the pilot;
- data retention and erasure procedures are documented and were demonstrated once.

## What NOT to build

Nothing. This phase only fixes defects. Feature requests from the pilot go to the post-MVP backlog.

---

# Post-MVP Roadmap

Only after MVP stability, consider:

## P1

- email and SMS fallback reminders;
- richer analytics;
- additional researcher roles;
- more question presentation types;
- study templates;
- improved participant recovery across devices;
- migrating enrolled participants between protocol versions.

## P2

- randomized ESM notification windows;
- conditional branching;
- richer protocol conditions;
- SPSS-oriented export tooling;
- R integration;
- multi-center administration.

## P3

- native mobile applications, if pilot evidence shows PWA push limitations materially affect study compliance;
- advanced offline support with explicit conflict resolution.

AI-based clinical or psychological interpretation is not a default roadmap objective and requires separate research, ethics, and safety review.

---

# Engineering Priority Order

When trade-offs are required, prioritize in this order:

1. Research data integrity.
2. Participant privacy and security.
3. Correct scheduling and reminders.
4. Response autosave and recovery.
5. Participant mobile usability.
6. Researcher compliance visibility.
7. Export correctness.
8. Visual polish.
9. Advanced and non-MVP functionality.

---

# Definition of Done

A feature is not complete merely because its UI exists.

For research-critical work, done means:

- the required behavior is implemented end to end;
- canonical state is persisted correctly;
- authorization is enforced server-side;
- failure and retry behavior is considered;
- automated tests cover the critical logic;
- mobile behavior is verified when participant-facing;
- documentation is updated where behavior or architecture changed;
- the change does not violate any invariant in `AGENT.md`;
- the phase's "what NOT to build yet" list was respected.
