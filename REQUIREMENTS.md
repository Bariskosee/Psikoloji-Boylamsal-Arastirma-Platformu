# REQUIREMENTS.md

## 1. Purpose

This document defines the normative product requirements for the **Longitudinal Psychology Research Platform**.

The platform supports longitudinal psychology studies in which participants complete different questionnaire sets at configurable intervals over days or weeks. It combines a familiar online survey workflow with participant-relative scheduling, push reminders, response continuity, compliance monitoring, longitudinal analytics, and research-ready export.

The participant experience should remain simple and mobile-first. The researcher experience should provide a Google Forms-like questionnaire builder plus protocol scheduling and longitudinal monitoring.

---

## 2. Product Goals

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
- resume partial questionnaires while the session remains open;
- receive reminders for incomplete scheduled work;
- use the platform comfortably on compatible iOS and Android devices.

---

## 3. Target Study Types

The platform should support:

- longitudinal psychological research;
- repeated-measures studies;
- Experience Sampling Method (ESM);
- Ecological Momentary Assessment (EMA);
- daily diary studies;
- baseline + follow-up studies;
- multi-wave questionnaire studies.

Randomized ESM scheduling is not required for the first MVP.

---

# 4. User Roles

## 4.1 Participant

A participant joins a study and completes assigned questionnaire sessions.

Requirements:

- Research responses must not use the participant's real name as the primary identifier.
- Each participant must receive a unique opaque `participant_id`, for example `P-A82F91`.
- The participant must be recognizable when returning from the enrolled device/session.
- Traditional username/password registration is not required for participants in the MVP.

## 4.2 Researcher / Administrator

A researcher creates and manages studies.

The researcher must be able to authenticate, create studies and questionnaires, define protocol timing, configure reminders, view participants and responses, monitor compliance, view descriptive statistics, and export data.

---

# 5. Functional Requirements

## FR-01 — Study Enrollment Link

Each study must have a unique enrollment URL.

Example:

```text
https://research.example.com/join/ABC123
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
- consent version.

No questionnaire responses may be collected before required consent is accepted.

## FR-04 — Consent Versioning

Consent content must be versioned. Updating consent text must not alter the historical version accepted by existing participants.

## FR-05 — Pseudonymous Participant ID

Every participant must receive a stable opaque participant ID, for example `P-20384`. Psychological response records must reference this ID rather than a real name.

## FR-06 — Participant Continuity

A returning enrolled participant must continue under the same participant ID through a secure device/session continuity mechanism.

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

Researchers must be able to add, edit, remove, and reorder questions subject to versioning/data-integrity constraints once collection begins.

## FR-09 — Required Questions

Researchers must be able to mark each question as required or optional. Required questions must be validated before final completion.

## FR-10 — No Hard-Coded Research Instruments

The application must not ship real psychology questionnaire items unless explicitly supplied and authorized by the research team. Development fixtures may use neutral placeholder questions only.

## FR-11 — Protocol Creation

Researchers must be able to define the order and timing of questionnaire sets. Timing must be configuration-driven, not hard-coded.

Example only:

| Relative Day | Questionnaire |
|---|---|
| Day 0 | Baseline |
| Day 3 | Follow-up |
| Day 4 | Daily Set |

## FR-12 — Participant-Relative Timing

The system must support rules such as:

- `enrollment + 3 days`;
- `baseline completion + 48 hours`;
- `previous session completion + 24 hours`.

Participants may therefore receive the same protocol on different calendar dates.

## FR-13 — Availability Windows

Researchers must be able to configure when each session opens and expires. A 24-hour window may be common, but it must not be hard-coded.

## FR-14 — Session States

Each assigned questionnaire session must have an explicit state. Minimum states:

```text
SCHEDULED
AVAILABLE
STARTED
COMPLETED
MISSED
```

Partial/incomplete participation must be distinguishable when relevant.

## FR-15 — Push Notification

When a questionnaire becomes available, the system must be capable of sending push notifications to participants who have granted permission and have a valid subscription.

The MVP targets compatible Android and iOS PWA users.

## FR-16 — Notification Permission

The participant application must request notification permission through browser/OS-supported flows, record permission/subscription state where possible, and provide a clear later action to enable notifications when they are denied or unavailable.

The system must not attempt to bypass browser or OS permission rules.

## FR-17 — Reminder Notifications

While an active questionnaire remains incomplete, the system must be able to send repeated reminders at researcher-configurable intervals. A common cadence may be every 3–4 hours, but this must remain configurable.

## FR-18 — Stop Reminders After Completion

All pending/future reminders for a session must stop once that session reaches `COMPLETED`.

## FR-19 — Notification and Study Event Tracking

Where technically available, the system should record timestamped events including:

- notification scheduled;
- notification sent;
- notification clicked;
- questionnaire opened;
- questionnaire started;
- questionnaire completed.

## FR-20 — Mobile-First Participant UI

Participant screens must be responsive, simple, readable, low-friction, and suitable for repeated use on phones.

## FR-21 — Manageable Questionnaire Steps

Large questionnaires should be split into manageable pages, sections, or groups rather than forcing unnecessary long-page scrolling.

## FR-22 — Progress Indicator

Participants must see progress, for example `18 / 60` or `30% completed`.

## FR-23 — Autosave

Responses must be saved progressively. Successfully persisted answers must survive refresh, accidental navigation, browser/app closure, and temporary network interruption.

## FR-24 — Resume Partial Session

A participant returning while the response window is still active must resume the saved partial questionnaire rather than restart from zero.

## FR-25 — Completion Screen

After completion, the participant must receive clear confirmation. The UI may display the next expected activity when appropriate.

## FR-26 — Current Status Screen

When the participant opens the application, the system must indicate whether there is a currently available questionnaire.

## FR-27 — Research Overview Dashboard

The dashboard must show at least:

- total participants;
- active participants;
- protocol completers;
- withdrawn participants where supported;
- today's completed sessions;
- today's incomplete sessions;
- average compliance.

## FR-28 — Daily Compliance View

Researchers must be able to determine how many participants completed, did not start, started but did not finish, or missed the response window.

## FR-29 — Participant List

Researchers must be able to view participants by pseudonymous ID with session/compliance status.

## FR-30 — Participant Timeline

Researchers must be able to open a participant detail page and inspect longitudinal session history.

## FR-31 — Longitudinal Response Inspection

Authorized researchers must be able to inspect participant answers across measurement points while preserving missing values explicitly.

## FR-32 — Missing Data States

The system must distinguish at minimum:

- missing answer;
- partial response;
- missed session.

## FR-33 — Descriptive Dashboard Statistics

The dashboard should support generic descriptive views derived from the configured study, including:

- age distribution;
- gender distribution;
- answer-option counts and percentages;
- response distributions/matrices;
- questionnaire completion over time;
- compliance trends.

## FR-34 — CSV Export

Researchers must be able to export study data as CSV.

## FR-35 — Long-Format Export

The system must support longitudinal long-format data such as:

| participant_id | measurement | question_id | response |
|---|---:|---|---|
| P001 | 1 | Q1 | 3 |
| P001 | 2 | Q1 | 4 |

## FR-36 — Wide-Format Export

Where appropriate, the platform should also support wide-format CSV export.

## FR-37 — Turkish and English

The platform must support Turkish and English interfaces. User-visible application strings must use an internationalization layer rather than being scattered as hard-coded strings.

---

# 6. Non-Functional Requirements

## NFR-01 — HTTPS

All production client-server communication must use HTTPS.

## NFR-02 — Sensitive Data Protection

Psychological responses must be treated as sensitive research data and protected from unauthorized access.

## NFR-03 — Separation of Contact and Response Data

If email, phone, push subscription, or other re-identification data is collected, it should be logically separated from psychological response records whenever possible.

## NFR-04 — Server-Side Authorization

Researcher permissions must be enforced server-side.

## NFR-05 — Audit Logging

Critical operations must be auditable, including study creation, protocol changes, questionnaire/version changes, exports, and participant removal/withdrawal operations where supported.

## NFR-06 — UTC Persistence

Critical timestamps must be stored in UTC. Display conversion must use explicit timezone rules.

## NFR-07 — Protocol Versioning

Protocol edits after enrollment/data collection starts must not destroy historical protocol definitions used by existing sessions.

## NFR-08 — Question Versioning

Question edits after responses exist must not retroactively change the content associated with historical responses.

## NFR-09 — Minimal Participant Friction

The MVP must not require traditional participant account registration unless later requirements explicitly introduce it.

## NFR-10 — Responsive Design

The platform must support iPhone, Android phones, tablets, and desktop browsers.

## NFR-11 — Initial Scale

The MVP must support at least several hundred active participants without requiring architectural redesign.

## NFR-12 — Durable Response Storage

Once the server acknowledges an answer write as successful, it must be durably persisted.

## NFR-13 — Idempotency / Duplicate Protection

Retries and duplicate requests must not create duplicate answers, completions, or notification events where uniqueness is expected.

## NFR-14 — Durable Scheduling

Multi-day scheduling and reminder execution must not depend on a browser tab or a single application process remaining alive.

## NFR-15 — Accessibility Basics

Interfaces should use semantic HTML, appropriate labels, readable validation, keyboard-accessible controls where relevant, and sufficiently large touch targets.

## NFR-16 — Secret Management

Secrets must not be committed to Git. Production secrets must use secure environment/configuration mechanisms.

---

# 7. MVP Scope

## Participant

- enrollment link;
- QR code;
- configurable consent content/placeholder;
- participant ID generation;
- participant-device/session continuity;
- baseline questionnaire;
- scheduled questionnaires;
- PWA behavior;
- compatible iOS/Android push notifications;
- reminder notifications;
- autosave/resume;
- completion flow;
- Turkish/English UI.

## Researcher

- login;
- study creation;
- questionnaire/question creation;
- question reordering;
- required/optional configuration;
- protocol/scheduling configuration;
- reminder configuration;
- participant list;
- daily completion/compliance view;
- participant timeline;
- response inspection;
- basic descriptive dashboard;
- CSV export.

## Backend

- participant management;
- study/questionnaire management;
- protocol scheduler;
- notification scheduler;
- response persistence;
- partial-response persistence;
- compliance calculation;
- authentication/authorization;
- audit logging;
- research-definition versioning.

---

# 8. Out of Scope for Initial MVP

Unless a maintainer explicitly changes scope:

- native iOS app;
- native Android app;
- SMS notifications;
- advanced statistical modeling;
- SPSS `.sav` export;
- automatic R analysis;
- AI-based psychological interpretation;
- multi-center administration;
- randomized ESM notification windows;
- advanced conditional branching;
- full offline questionnaire completion.

---

# 9. MVP Acceptance Scenario

The MVP is functionally successful when this complete flow works reliably:

```text
Researcher logs in
→ creates a study
→ creates an X-question baseline questionnaire
→ creates another questionnaire
→ configures that questionnaire to open Y time after baseline completion
→ configures a response window and reminder cadence
→ participant joins through link or QR code
→ participant accepts consent
→ participant receives a stable pseudonymous ID
→ participant completes baseline
→ baseline answers are durably stored
→ future questionnaire remains unavailable until scheduled
→ next session becomes available automatically at the correct participant-relative time
→ eligible participant receives a push notification
→ reminders continue while the session remains incomplete
→ participant completes the session
→ remaining reminders stop
→ dashboard reflects correct completion/compliance state
→ researcher can inspect responses across measurement points
→ researcher exports collected data as CSV
```

All timing, question counts, intervals, and reminder values in this scenario must be configuration-driven rather than hard-coded assumptions.
