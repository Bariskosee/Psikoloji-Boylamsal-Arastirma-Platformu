# REQUIREMENTS.md

## 1. Purpose

This document defines the normative product requirements for the **Longitudinal Psychology Research Platform**.

The platform supports longitudinal psychology studies in which participants complete different questionnaire sets at configurable intervals over days or weeks. It combines a familiar online survey workflow with participant-relative scheduling, push reminders, response continuity, compliance monitoring, longitudinal analytics, and research-ready export.

The participant experience should remain simple and mobile-first. The researcher experience should provide a Google Forms-like questionnaire builder plus protocol scheduling and longitudinal monitoring.

**This document is the sole authoritative source for product behaviour and acceptance criteria.** Technical design lives in `STRUCTURE.md`; engineering rules live in `AGENT.md`; sequencing lives in `PLAN.md`.

---

## 2. Glossary

Terminology is fixed here. These terms are used consistently across all repository documents, the database schema, the API, and the user interface.

| Term | Meaning |
|---|---|
| **Study** | A research project owned by one or more researchers. The top-level container. |
| **Participant** | A person enrolled in a study, identified only by a `public_code`. |
| **`public_code`** | The pseudonymous participant identifier. Format: `P-` followed by six uppercase Crockford base-32 characters, e.g. `P-A82F91`. Randomly generated, never sequential. |
| **Enrollment** | The binding of a participant to a study, a protocol version, and a consent version. Created once, at join time. |
| **Questionnaire** | A named set of questions, e.g. "Baseline". A container that owns versions. |
| **Questionnaire Version** | An immutable snapshot of a questionnaire's full content, created by publishing. |
| **Question** | One item within a questionnaire version. |
| **`question_key`** | A stable, researcher-visible identifier for a question that persists across versions, e.g. `mood_1`. Used as the export column key. |
| **Protocol** | The schedule that determines which questionnaire a participant receives and when. |
| **Protocol Version** | An immutable snapshot of a protocol, created by publishing. |
| **Protocol Step** | One entry in a protocol: a questionnaire version plus its trigger, delay, window, recurrence, and reminder policy. |
| **Occurrence** | One instance of a recurring protocol step. A step with `occurrence_count = 7` has occurrences 0 through 6. |
| **ParticipantSession** | One concrete questionnaire assignment for one participant: the combination of a participant, a protocol step, and an occurrence. **The word "session" alone is never used for this** — it is reserved for authentication sessions. |
| **Response** | One participant's answer to one question within one ParticipantSession. |
| **Response Window** | The period between `available_from` and `available_until` during which a ParticipantSession may be answered. |
| **Trigger** | The event that starts a protocol step's timing: enrollment, consent, or another step reaching a state. |
| **Compliance** | Completed ParticipantSessions divided by due ParticipantSessions. Defined precisely in FR-44 and `docs/compliance-formula.md`. |
| **Pseudonymous** | Identifying data is replaced by a code, but re-identification remains possible through other retained data. **This platform's data is pseudonymous, never anonymous.** |

**Deprecated terms.** The following appeared in earlier drafts and must not be used: "measurement", "day", "timepoint", "wave" as a data field. Use **protocol step** and **occurrence**.

---

## 3. Product Goals

Researchers must be able to:

- create studies and questionnaire sets;
- create, edit, remove, and reorder questions;
- mark questions required or optional;
- configure when questionnaire sets become available;
- schedule steps relative to enrollment or previous session completion;
- configure response windows and reminders;
- monitor completion and compliance;
- inspect pseudonymous participant responses over time;
- view demographic and response distributions;
- export analysis-ready data.

Participants must be able to:

- join by link or QR code;
- read and accept informed consent;
- receive a stable pseudonymous participant ID;
- complete scheduled questionnaires;
- resume partial questionnaires while the response window remains open;
- receive reminders for incomplete scheduled work;
- use the platform comfortably on compatible iOS and Android devices.

---

## 4. Target Study Types

The platform should support:

- longitudinal psychological research;
- repeated-measures studies;
- Experience Sampling Method (ESM);
- Ecological Momentary Assessment (EMA);
- daily diary studies;
- baseline + follow-up studies;
- multi-wave questionnaire studies.

Randomized ESM scheduling is not required for the first MVP. Fixed-time recurring steps (FR-38) are required, because daily diary and multi-wave designs depend on them.

---

## 5. User Roles

### 5.1 Participant

A participant joins a study and completes assigned ParticipantSessions.

- Research responses must not use the participant's real name as the primary identifier.
- Each participant receives a unique opaque `public_code` in the format defined in §2.
- The participant must be recognizable when returning from the enrolled device or browser.
- Traditional username/password registration is not required for participants in the MVP.

### 5.2 Researcher / Administrator

A researcher creates and manages studies.

Four roles exist in the MVP, scoped per study:

| Role | May |
|---|---|
| `OWNER` | Everything, including member management and audit access |
| `EDITOR` | Build questionnaires and protocols, manage participants |
| `ANALYST` | View data, inspect responses, run exports |
| `VIEWER` | View aggregate monitoring only; no response-level access |

A global `is_admin` flag grants access to operational health endpoints only, not to research data.

Future roles (Principal Investigator, Research Assistant, Data Analyst) map onto these four without schema change. A finer-grained permission matrix is out of MVP scope.

---

# 6. Functional Requirements

## FR-01 — Study Enrollment Link

Each study must have a unique enrollment URL.

```text
https://app.example.org/join/ABC123
```

## FR-02 — Study QR Code

The system must provide a QR code that resolves to the study enrollment URL.

## FR-03 — Informed Consent

Before questionnaire data is collected, the participant must see a configurable study information / consent page and explicitly confirm participation.

The final consent wording will be supplied by the research team later.

The system must record:

- participant ID;
- consent status;
- consent timestamp;
- consent version;
- the locale in which consent was displayed and accepted.

No questionnaire responses may be collected before required consent is accepted.

## FR-04 — Consent Versioning

Consent content must be versioned. Updating consent text must not alter the historical version accepted by existing participants.

## FR-05 — Pseudonymous Participant ID

Every participant must receive a stable opaque `public_code` in the format defined in §2 (`P-A82F91`). Psychological response records must reference this ID rather than a real name.

The code must be generated from a cryptographically secure random source and must not be sequential, because a sequential identifier leaks enrollment order and total sample size.

## FR-06 — Participant Continuity

A returning enrolled participant must continue under the same participant ID through a secure device/session continuity mechanism.

Continuity must survive: closing the browser, restarting the device, and returning days later. See FR-41 for the PWA installation case.

## FR-07 — Questionnaire Creation

Researchers must be able to create multiple questionnaire sets within a study, such as Baseline, Follow-up, Daily, and Final questionnaires.

Questionnaire content must be researcher-controlled and must not be hard-coded.

## FR-08 — Question Creation

The MVP must support at minimum:

- Likert scale;
- single choice;
- multiple choice;
- numeric input;
- short text input.

Researchers must be able to add, edit, remove, and reorder questions subject to versioning and data-integrity constraints once collection begins.

The architecture must permit adding further question types without redesigning the schema.

## FR-09 — Required Questions

Researchers must be able to mark each question as required or optional. Required questions must be validated server-side before a ParticipantSession may be completed.

## FR-10 — No Hard-Coded Research Instruments

The application must not ship real psychology questionnaire items unless explicitly supplied and authorized by the research team. Development fixtures may use neutral placeholder questions only.

## FR-11 — Protocol Creation

Researchers must be able to define the order and timing of questionnaire sets. Timing must be configuration-driven, not hard-coded.

Example only:

| Step | Questionnaire | Trigger |
|---|---|---|
| 1 | Baseline | enrollment |
| 2 | Follow-up | step 1 completed + 72h |
| 3 | Daily Set | step 2 completed + 24h, ×7 daily |

## FR-12 — Participant-Relative Timing

The system must support rules such as:

- `enrollment + 3 days`;
- `baseline completion + 48 hours`;
- `previous session completion + 24 hours`.

Participants therefore receive the same protocol on different calendar dates.

## FR-13 — Availability Windows

Researchers must be able to configure when each ParticipantSession opens and expires. A 24-hour window may be common, but must not be hard-coded.

## FR-14 — ParticipantSession States

Each ParticipantSession must have an explicit, persisted state. The required states are:

```text
PENDING_TRIGGER      timing not yet computable (trigger step incomplete)
SCHEDULED            timing known, window not yet open
AVAILABLE            window open, no answers yet
STARTED              window open, at least one answer saved
COMPLETED            terminal — submitted and validated
EXPIRED_UNSTARTED    terminal — window closed, never opened
EXPIRED_PARTIAL      terminal — window closed, started but not completed
CANCELLED            terminal — withdrawal, study closure, or unreachable trigger
```

`PENDING_TRIGGER` is required because a step triggered by another step's completion has no computable time at enrollment, yet the ParticipantSession must exist so that the participant's full expected protocol is known for compliance and timeline purposes.

`MISSED` is a display label covering `EXPIRED_UNSTARTED` and `EXPIRED_PARTIAL`. It is not a stored state.

State transitions are defined in `STRUCTURE.md`. All transitions are server-authoritative.

## FR-15 — Push Notification

When a ParticipantSession becomes available, the system must be capable of sending push notifications to participants who have granted permission and have a valid subscription.

The MVP targets compatible Android browsers and iOS 16.4+ Home Screen PWA installations.

The system must never claim or imply guaranteed delivery.

## FR-16 — Notification Permission

The participant application must request notification permission through browser and OS-supported flows, in response to an explicit user action and only after explaining why notifications matter.

The system must record permission and subscription state where observable, and provide a clear, non-nagging path to enable notifications later when they are denied or unavailable.

The system must not attempt to bypass browser or OS permission rules.

## FR-17 — Reminder Notifications

While an open ParticipantSession remains incomplete, the system must be able to send repeated reminders at researcher-configurable intervals. A common cadence may be every 3–4 hours, but this must remain configurable.

Reminder intervals are subject to the safety limits in FR-40.

## FR-18 — Stop Reminders After Completion

All pending and future reminders for a ParticipantSession must stop once it reaches `COMPLETED`.

This must hold even when a reminder is already in flight at the moment of completion.

## FR-19 — Notification and Study Event Tracking

The system must record timestamped events, and must distinguish reliably observable events from best-effort ones.

**Reliably observable (server-side):**

- notification scheduled;
- notification attempted;
- notification accepted by the push service — *acceptance is not delivery*;
- notification failed, with the failure reason;
- questionnaire opened, started, completed.

**Best-effort (client-side, may be lost):**

- notification displayed;
- notification clicked.

**Not observable at all:** actual delivery to the device, whether the participant saw the notification, and OS-level suppression. No metric, export column, or interface string may imply otherwise.

## FR-20 — Mobile-First Participant UI

Participant screens must be responsive, simple, readable, low-friction, and suitable for repeated use on phones.

## FR-21 — Manageable Questionnaire Steps

Large questionnaires must be splittable into pages or sections rather than forcing long-page scrolling.

## FR-22 — Progress Indicator

Participants must see progress, for example `18 / 60` or `30% completed`.

## FR-23 — Autosave

Responses must be saved progressively. Successfully persisted answers must survive refresh, accidental navigation, browser closure, and temporary network interruption.

A server acknowledgement of an answer write is a durability guarantee (NFR-12).

## FR-24 — Resume Partial Session

A participant returning while the response window is still open must resume the saved partial questionnaire rather than restart.

## FR-25 — Completion Screen

After completion, the participant must receive clear confirmation. The UI may display the next expected activity when known.

## FR-26 — Current Status Screen

When the participant opens the application, the system must indicate whether a ParticipantSession is currently available, and if not, what is expected next.

## FR-27 — Research Overview Dashboard

The dashboard must show at least:

- total participants;
- active participants;
- protocol completers;
- withdrawn participants;
- today's completed ParticipantSessions;
- today's incomplete ParticipantSessions;
- average compliance, with its denominator visible.

## FR-28 — Daily Compliance View

Researchers must be able to determine how many participants completed, did not start, started but did not finish, or missed the response window.

## FR-29 — Participant List

Researchers must be able to view participants by `public_code` with session and compliance status.

## FR-30 — Participant Timeline

Researchers must be able to open a participant detail page and inspect the full longitudinal history, including recurring step occurrences and states not yet reached.

## FR-31 — Longitudinal Response Inspection

Authorized researchers (`ANALYST` or above) must be able to inspect participant answers across measurement points while preserving missing values explicitly.

## FR-32 — Missing Data States

The system must distinguish six mutually exclusive situations for every (participant, question, occurrence) cell:

| Situation | Meaning |
|---|---|
| `NOT_YET_DUE` | The step has not been triggered or the window has not opened |
| `IN_PROGRESS` | The window is open right now |
| `MISSED_SESSION` | Window closed, participant never opened it |
| `MISSED_ITEM_PARTIAL` | Window closed, participant started but did not answer this item |
| `SKIPPED_OPTIONAL` | Completed, but this optional item was left blank |
| `ANSWERED` | A value exists |
| `NOT_APPLICABLE` | Withdrawn or cancelled |

These are seven values in total; `ANSWERED` is the only one that carries data. Conflating any of them is a data-integrity defect.

**A missing value must never be represented as zero, as an empty string that could be confused with a text answer, or as any sentinel number.** See `docs/export-codebook.md`.

## FR-33 — Descriptive Dashboard Statistics

The dashboard must support generic descriptive views derived from the configured study, including:

- answer-option counts and percentages;
- numeric response distributions;
- questionnaire completion over time;
- compliance trends;
- demographic distributions **where the researcher has configured such questions**.

The system must not assume that any particular demographic variable exists.

## FR-34 — CSV Export

Researchers must be able to export study data as CSV. Every export must be audit-logged.

## FR-35 — Long-Format Export

The system must support longitudinal long-format data, one row per (participant, protocol step, occurrence, question), including the response status from FR-32.

## FR-36 — Wide-Format Export

The platform must also support wide-format CSV export, one row per participant, with columns keyed on `{step_key}_{occurrence}__{question_key}`.

Column stability depends on `question_key` (FR-43).

## FR-37 — Turkish and English

The platform must support Turkish and English interfaces. User-visible application strings must use an internationalization layer rather than being scattered as hard-coded strings.

Interface translations, researcher-defined questionnaire content, and consent content are three separate concerns and must be modelled separately.

## FR-38 — Recurring Protocol Steps

A protocol step must be able to produce more than one ParticipantSession.

Researchers must be able to configure:

- an occurrence count (e.g. 7);
- a recurrence interval (e.g. one day);
- optionally, a local wall-clock anchor time (e.g. 18:00).

Each occurrence is anchored on the step's own trigger plus *n* × interval, not chained from the previous occurrence, so that a missed occurrence does not delay the ones after it.

This requirement exists because daily diary and multi-wave designs — two of the seven target study types in §4 — cannot be expressed without it.

## FR-39 — Participant Withdrawal

A participant must be able to withdraw, and a researcher must be able to record a withdrawal.

On withdrawal:

- the participant's status becomes `WITHDRAWN`;
- all non-terminal ParticipantSessions become `CANCELLED`;
- all future notifications stop;
- **already-collected responses are retained** unless erasure is separately requested.

Erasure is a distinct, explicit, audit-logged operation. The retention and erasure policy is a research-team decision (§9).

## FR-40 — Notification Safety Limits

Every reminder policy must specify:

- a maximum number of reminders per ParticipantSession (required, not optional);
- an optional quiet-hours window in the participant's local time;
- quiet-hours behaviour: skip the reminder, or defer it to the end of quiet hours.

The system must enforce a minimum reminder interval so that a configuration error cannot produce a notification storm.

After a service outage, the system must not send a burst of accumulated overdue reminders.

## FR-41 — Continuity Across PWA Installation

Installing the participant application to the device Home Screen must not create a new participant identity.

On platforms where the installed application does not inherit the browser's stored credentials, the system must provide an explicit one-time handoff so the installed application binds to the existing participant. The handoff artefact must be single-use, short-lived, and rate-limited.

The system must also provide a recovery mechanism (a code shown once at enrollment, and optionally an email address where the study collects one) so that a participant who loses their device or clears browser data can be reconnected to their existing record.

Researchers must be able to identify participants whose continuity is at risk.

## FR-42 — Enrollment Integrity

- A device or browser presenting a valid existing credential for a study must resume that enrollment rather than create a second one.
- Enrollment endpoints must be rate-limited.
- A study must be able to specify an enrollment capacity, after which further enrollment is refused.
- Enrollment endpoints must not reveal whether a given study code or participant exists through differing responses or timing.

## FR-43 — Stable Question Identity

Every question must carry a `question_key` that is stable across questionnaire versions and unique within a questionnaire.

The key identifies "the same question" for longitudinal comparison and wide-format export columns. The question version identifies the exact wording a participant saw.

Changing a `question_key` after data collection begins is prohibited.

## FR-44 — Compliance Definition

The system must compute compliance using a documented, tested formula whose denominator is visible in the interface.

**Default (elapsed) compliance:**

```text
compliance = completed ÷ due

due      = ParticipantSessions that reached AVAILABLE and whose window has closed,
           plus those currently in a terminal state,
           excluding CANCELLED,
           excluding steps flagged as not counting toward compliance
completed = of those, the ones in state COMPLETED
```

ParticipantSessions in `PENDING_TRIGGER`, `SCHEDULED`, or a currently-open window are **excluded from the denominator**, because a participant cannot be non-compliant with work that is not yet due.

A **strict** variant using every step in the protocol as the denominator must also be available, clearly labelled.

When the denominator is zero, the system must display "not yet applicable", never 0%.

Full rules and worked examples are in `docs/compliance-formula.md`.

---

# 7. Non-Functional Requirements

## NFR-01 — HTTPS

All production client-server communication must use HTTPS. Web Push requires it.

## NFR-02 — Sensitive Data Protection

Psychological responses must be treated as sensitive research data and protected from unauthorized access.

## NFR-03 — Separation of Contact and Response Data

Email, phone, push subscription endpoints, and continuity credentials must be stored separately from psychological response records, and the separation must be technically enforced rather than maintained by convention.

Code paths that produce analytics and exports must be structurally unable to read identity data.

## NFR-04 — Server-Side Authorization

Researcher permissions must be enforced server-side. Hiding a control in the interface is not authorization.

Every study-scoped query must filter by study in the query itself, never by trusting a checked path parameter.

## NFR-05 — Audit Logging

Critical operations must be auditable, including: authentication, study creation and lifecycle changes, questionnaire and protocol version publication, participant withdrawal and erasure, role changes, and **every data export**.

Audit records must never contain response payloads or secrets.

## NFR-06 — UTC Persistence and Timezone Precedence

Critical timestamps must be stored in UTC.

Timezone precedence for scheduling:

1. Duration-based offsets (e.g. 72 hours) are computed in UTC and are unaffected by timezone or daylight saving.
2. Wall-clock anchors (e.g. "18:00 local") are computed in an explicit IANA timezone, chosen per protocol step as either the study timezone or the participant timezone.
3. Where a step specifies the participant timezone and none is recorded, the study timezone is used.
4. The participant's browser-reported timezone must be validated server-side against the IANA database and is used only to interpret wall-clock anchors. **It is never authoritative for whether a window is open.**

Daylight-saving transitions must be handled explicitly: a non-existent local time shifts forward to the first valid instant; an ambiguous local time resolves to the first occurrence.

## NFR-07 — Protocol Versioning

Protocol edits after enrollment begins must not destroy or alter historical protocol definitions.

## NFR-08 — Question Versioning

Question edits after responses exist must not retroactively change the content associated with historical responses.

## NFR-09 — Minimal Participant Friction

The MVP must not require traditional participant account registration.

## NFR-10 — Responsive Design

The platform must support iPhone, Android phones, tablets, and desktop browsers.

## NFR-11 — Initial Scale

The MVP must support at least several hundred active participants without architectural redesign.

## NFR-12 — Durable Response Storage

Once the server acknowledges an answer write as successful, it must be durably persisted.

## NFR-13 — Idempotency / Duplicate Protection

Retries and duplicate requests must not create duplicate answers, completions, enrollments, or notification events.

Uniqueness must be enforced by database constraints, not only by application logic.

## NFR-14 — Durable Scheduling

Multi-day scheduling and reminder execution must not depend on a browser tab or a single application process remaining alive.

The system must recover automatically and without duplicate side effects from: process restarts, worker outages of arbitrary length, loss of queued jobs, and database restoration from backup.

## NFR-15 — Accessibility Basics

Interfaces must use semantic HTML, appropriate labels, readable validation messages, keyboard-accessible controls, sufficient contrast, and adequately large touch targets.

## NFR-16 — Secret Management

Secrets must not be committed to Git. Production secrets must use secure environment or configuration mechanisms. The repository must provide an example environment file containing placeholders only.

## NFR-17 — Protocol Version Binding

Each enrollment is permanently bound to the protocol version that was active when the participant joined.

Publishing a new protocol version affects only participants enrolling afterwards. Existing participants continue on their bound version for the life of their enrollment.

Migrating an existing enrollment to a newer protocol version is an explicit, audit-logged operation and is **out of MVP scope**.

## NFR-18 — Data Retention and Backup Verification

The system must support a configurable data-retention policy and a documented erasure procedure.

Database backups must support point-in-time recovery, and the restore procedure must be tested — an untested backup is not a backup. The restore drill must be documented and repeated at a defined interval.

---

# 8. MVP Scope

## Participant

Enrollment link · QR code · configurable consent content · `public_code` generation · device continuity including PWA install handoff · baseline questionnaire · scheduled questionnaires · recurring steps · PWA installation · compatible iOS/Android push notifications · reminder notifications · autosave and resume · completion flow · withdrawal · Turkish/English UI.

## Researcher

Login · study creation and lifecycle · questionnaire and question creation · question reordering · required/optional configuration · questionnaire publishing and versioning · protocol and step configuration including recurrence · reminder policy configuration · protocol timeline preview · participant list · daily completion and compliance view · participant timeline · response inspection · descriptive dashboard · long/wide/codebook CSV export.

## Backend

Participant management · study, questionnaire, and protocol management with versioning · durable protocol scheduler · notification scheduler with reminder cancellation · response persistence including partial responses · compliance calculation · authentication and authorization · audit logging · operational health visibility.

---

# 9. Out of Scope for Initial MVP

Unless a maintainer explicitly changes scope:

- native iOS application;
- native Android application;
- SMS and email reminders;
- advanced statistical modelling inside the application;
- SPSS `.sav` export;
- automated R analysis;
- AI-based psychological interpretation;
- multi-center administration;
- randomized ESM notification windows;
- advanced conditional branching;
- full offline questionnaire completion;
- migrating enrolled participants between protocol versions;
- a fine-grained role/permission matrix beyond the four roles in §5.2.

---

# 10. Open Research-Team Decisions

The following are intentionally configurable and must never be hard-coded. The software must work without knowing them.

**Configurable study content and timing:** questionnaire content and item counts · consent wording and versioning cadence · number of protocol steps and their triggers · exact delays between steps · response window lengths · reminder cadence, cap, and quiet hours · which steps count toward compliance · study and default participant timezone · whether email is collected · recurrence counts for daily/ESM steps · enrollment capacity · target sample size.

**Decisions required before the pilot (not before implementation begins):**

1. **Data retention period**, and whether responses are retained after withdrawal. Required for the ethics submission and for NFR-18 and FR-39.
2. **Consent scope on change** — does a mid-study consent revision require re-consent, or does the version bound at enrollment suffice?
3. **Is an email address collected?** If yes, it materially strengthens participant recovery (FR-41). If no, the recovery code is the only backstop and participants must be instructed to save it.
4. **Hosting region acceptability** — the architecture assumes a single EU region. A requirement to keep data within Türkiye changes only the deployment target, not the application.

---

# 11. MVP Acceptance Scenario

The MVP is functionally successful when this complete flow works reliably:

```text
Researcher logs in
→ creates a study
→ builds a baseline questionnaire and publishes it
→ builds a second questionnaire and publishes it
→ defines a protocol: baseline at enrollment,
    follow-up opening a configured interval after baseline completion,
    with a configured response window and reminder cadence
→ publishes the protocol
→ participant joins through link or QR code
→ participant accepts consent
→ participant receives a stable public_code
→ participant completes baseline
→ baseline answers are durably stored
→ the follow-up remains unavailable until its scheduled time
→ the follow-up becomes available automatically at the correct
    participant-relative time, without manual intervention
→ an eligible participant receives a push notification
→ reminders continue while the session remains incomplete
→ participant completes the session
→ all remaining reminders stop
→ dashboard reflects correct completion and compliance state
→ researcher inspects responses across both measurement points
→ researcher exports the data as CSV, and the export reconciles
    exactly with the dashboard and the underlying records
```

All timing, question counts, intervals, and reminder values in this scenario must be configuration-driven.

Additionally, the following must hold for the MVP to be released:

- scheduling recovers correctly from a deliberate service restart;
- no reminder is ever sent after completion;
- no participant loses a server-acknowledged answer;
- every missing value is distinguishable by reason in the export;
- Turkish and English paths both work end to end.
