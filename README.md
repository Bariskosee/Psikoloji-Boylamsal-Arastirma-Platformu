# Longitudinal Psychology Research Platform

A web-based research platform for longitudinal psychology studies, repeated-measures research, Experience Sampling Method (ESM), Ecological Momentary Assessment (EMA), and daily diary studies.

The platform is intended to provide a more flexible alternative to conventional one-time survey tools such as Google Forms when a study requires participants to complete different questionnaires at different time points over several days or weeks.

The core goals are:

- schedule different questionnaire sets relative to each participant's enrollment time,
- send repeated reminders when a participant has not completed an assigned questionnaire,
- preserve longitudinal responses under pseudonymous participant IDs,
- provide researchers with a dashboard for compliance and response monitoring,
- export clean longitudinal datasets for statistical analysis.

> **Project status:** Initial specification / MVP planning stage. The repository currently defines the intended product behavior and first implementation scope. Technical choices may evolve during development.

---

## Why This Project Exists

Traditional survey tools work well for one-time questionnaires, but they become difficult to manage when a study needs workflows such as:

```text
Enrollment / Day 0
        ↓
Baseline questionnaire
        ↓
Wait 48–72 hours
        ↓
Follow-up questionnaire
        ↓
Daily or scheduled questionnaires
        ↓
Repeated reminders for incomplete sessions
        ↓
Final questionnaire
```

For longitudinal psychological research, missing sessions can substantially reduce data quality. Therefore, **participant compliance and notification reliability are first-class requirements of this project**.

The participant experience should remain as simple as a conventional online questionnaire, while the researcher should gain protocol scheduling, notification, longitudinal tracking, and reporting capabilities.

---

## Intended Research Use Cases

The platform is designed for studies such as:

- Longitudinal psychological research
- Repeated-measures studies
- Experience Sampling Method (ESM)
- Ecological Momentary Assessment (EMA)
- Daily diary studies
- Baseline + follow-up designs
- Multi-wave questionnaire studies

---

## User Roles

### Participant

A participant joins a study through a unique link or QR code and completes questionnaires assigned according to the study protocol.

Participants should not need a traditional username/password account for the MVP. Each participant is represented by a unique pseudonymous identifier, for example:

```text
P-A82F91
```

The platform should recognize the participant across sessions so the same individual can be followed throughout the study without exposing their identity in the research response dataset.

### Researcher / Administrator

Researchers configure and monitor studies through an authenticated dashboard.

Researchers should be able to:

- create studies,
- build questionnaires in a Google Forms-like interface,
- create and edit questions,
- mark questions as required or optional,
- define questionnaire schedules,
- define completion windows,
- configure reminder timing,
- monitor participants by pseudonymous ID,
- inspect responses across time,
- view participation and demographic summaries,
- monitor compliance and missing data,
- export datasets.

---

# Core Participant Flow

A typical participant flow should look like this:

```text
Study Link / QR Code
        ↓
Study Information
        ↓
Informed Consent
        ↓
Notification Permission
        ↓
Participant ID Created
        ↓
Baseline Questionnaire
        ↓
Protocol Scheduler
        ↓
Scheduled Questionnaire Becomes Available
        ↓
Push Notification
        ↓
Reminder Notifications if Incomplete
        ↓
Questionnaire Completion
        ↓
Next Scheduled Session
```

The interface must be mobile-first, simple, low-friction, and suitable for repeated use over many days.

---

# Functional Requirements

## 1. Study Enrollment

Each study must have a unique enrollment URL, for example:

```text
https://research.example.com/join/ABC123
```

A QR code should also be available so researchers can easily distribute the study.

---

## 2. Informed Consent

Before accessing any research questions, participants must be shown an information and consent page.

The exact consent text will be determined by the research team later. The platform must support configurable and versioned consent content.

Participants must explicitly confirm that they:

- have read the participant information,
- voluntarily agree to participate.

The system should record:

- participant ID,
- consent status,
- consent timestamp,
- consent document/version used.

Participants who do not provide consent must not access the study questionnaires.

---

## 3. Pseudonymous Participant Identification

Every participant must receive a unique participant ID.

Example:

```text
P-20384
```

Psychological response data must be associated with this ID instead of a real name.

The participant ID should be securely associated with the participant's device/session so the user can return later and continue the same longitudinal study.

Any contact or notification data that could identify or re-identify a participant should be stored separately from psychological response data whenever possible.

---

## 4. Questionnaire Builder

Researchers must be able to create multiple independent questionnaire sets within the same study.

Example:

```text
Baseline Questionnaire
Follow-up Questionnaire
Daily Questionnaire
Final Questionnaire
```

The researcher determines how many questions each questionnaire contains and when each set is administered.

The application must not hard-code questionnaire content or timing.

### Initial Question Types

The MVP should support at least:

- Likert scale
- Single choice
- Multiple choice
- Numeric input
- Short text input

Researchers must be able to mark individual questions as **required** or **optional**, similarly to Google Forms.

No real research questionnaire items should be preloaded into the application unless supplied by the psychology research team. Development/testing may use placeholder questions only.

---

# Research Protocol and Scheduling

The most important difference between this platform and a conventional survey system is the ability to define a longitudinal research protocol.

Researchers must be able to determine when questionnaire sets become available.

Example only:

| Relative Day | Questionnaire |
|---|---|
| Day 0 | Baseline |
| Day 1 | None |
| Day 2 | None |
| Day 3 | Follow-up |
| Day 4 | Daily Set |
| Day 5 | Daily Set |
| Day 10 | Final Set |

The schedule must be configurable through the researcher dashboard and must not be hard-coded into application logic.

## Participant-Relative Scheduling

Scheduling should normally be relative to each participant's enrollment or completion time.

Example:

```text
Participant A joins on September 1 → Day 0 = September 1
Participant B joins on September 5 → Day 0 = September 5
```

If Questionnaire 2 opens three days after baseline completion, it must open independently for each participant based on their own timeline.

## Availability Windows

Each scheduled questionnaire should have configurable:

- availability start,
- availability end,
- duration/window.

For example, a questionnaire may remain available for 24 hours, although the research team may choose a different window.

## Session States

At minimum, scheduled questionnaire sessions should support the following states:

```text
SCHEDULED
AVAILABLE
STARTED
COMPLETED
MISSED
```

Partial/incomplete states should also be distinguishable where necessary.

---

# Notification System

Notification delivery is a critical requirement because consistent participation is necessary for valid longitudinal data.

## Push Notifications

When a questionnaire becomes available, the participant should receive a push notification such as:

> Today's research questionnaire is ready. Tap to continue.

The MVP is planned as a **Progressive Web App (PWA)** supporting push notifications on compatible Android and iOS devices.

For iOS, the participant may need to install/add the PWA to the Home Screen and explicitly enable notifications depending on platform/browser requirements.

## Reminder Notifications

If a participant has not completed the questionnaire, the system should automatically send reminders during the active response window.

Example only:

```text
18:00  Questionnaire opens + initial notification
21:00  Reminder if incomplete
00:00  Additional reminder if still incomplete and window remains open
```

The actual reminder interval must be configurable by the researcher. A typical study may use reminders every 3–4 hours while the questionnaire is available.

Reminders must stop immediately after the questionnaire is completed.

## Notification Permission

The platform must request notification permission from participants.

If permission has not been granted, the application should clearly indicate that notifications are important for study participation and provide a way to retry/enable them.

The application should not attempt to bypass browser or operating-system permission rules.

## Notification and Study Events

Where technically possible, the platform should record events such as:

```text
notification_scheduled_at
notification_sent_at
notification_clicked_at
survey_opened_at
survey_started_at
survey_completed_at
```

All important events should include timestamps.

---

# Participant Interface Requirements

The participant-facing application should resemble a clean modern survey experience rather than a complex research dashboard.

## Mobile-First PWA

The participant application should:

- work on iPhone and Android,
- be responsive on tablets and desktop browsers,
- be installable as a PWA where supported,
- minimize visual clutter,
- minimize the number of actions required to answer questions,
- avoid displaying a very large number of questions in one long scrolling page.

Questions should be split into manageable pages/steps where appropriate.

## Progress Indicator

Participants should see progress such as:

```text
18 / 60
```

or:

```text
30% completed
```

## Autosave and Resume

Responses should be saved progressively.

If the participant:

- closes the browser,
- temporarily loses internet access,
- leaves the questionnaire,
- accidentally refreshes the page,

previously saved progress should not be lost.

When the participant returns within the active response window, the questionnaire should resume from the saved state.

## Daily Status

When opening the application, participants should see whether they currently have an available questionnaire.

Example:

```text
Today's questionnaire is ready
15 questions
[Start]
```

or:

```text
There is nothing to complete right now.
```

---

# Researcher Dashboard

The researcher dashboard should provide both operational monitoring and basic descriptive summaries.

## Study Overview

The dashboard should display at least:

- total participants,
- active participants,
- participants who completed the full protocol,
- withdrawn participants,
- today's completed sessions,
- today's incomplete sessions,
- average compliance rate.

## Compliance Monitoring

Researchers should be able to answer questions such as:

- How many participants completed today's questionnaire?
- How many have not started?
- How many started but did not finish?
- How many missed the response window?

Example:

| Participant | Day 3 | Day 4 | Day 5 | Compliance |
|---|---|---|---|---|
| P001 | ✓ | ✓ | ✓ | 100% |
| P002 | ✓ | ✕ | ✓ | 66% |
| P003 | ✕ | ✕ | ✓ | 33% |

## Participant Timeline

Researchers should be able to open a pseudonymous participant profile and view the person's study history.

Example:

```text
P-1042

Day 0   Baseline      Completed
Day 3   Follow-up     Completed
Day 4   Daily         Missed
Day 5   Daily         Completed
Day 6   Daily         Completed
```

## Longitudinal Response Inspection

Where researcher permissions allow it, individual question responses should be inspectable across time.

Example:

```text
Question 12

Day 3 → 2
Day 4 → 4
Day 5 → Missing
Day 6 → 5
Day 7 → 3
```

## Descriptive Dashboard Visualizations

The dashboard should support useful descriptive summaries such as:

- age distribution,
- gender distribution,
- response distribution per question,
- number/percentage selecting each answer option,
- questionnaire completion over time,
- compliance trends,
- missing-data patterns.

Visualizations should reflect the actual questionnaire structure configured by the researcher.

---

# Data Export

Researchers must be able to export study data as CSV.

## Long Format

Long format is especially important for repeated-measures and longitudinal analysis.

Example:

| participant_id | day | question_id | response |
|---|---:|---|---:|
| P001 | 1 | Q1 | 3 |
| P001 | 2 | Q1 | 4 |
| P001 | 3 | Q1 | 5 |
| P002 | 1 | Q1 | 2 |

## Wide Format

Where appropriate, the system should also support wide-format exports.

Example:

| participant | Q1_D1 | Q1_D2 | Q1_D3 |
|---|---:|---:|---:|
| P001 | 3 | 4 | 5 |
| P002 | 2 | 3 | 4 |

---

# Data Protection and Security

Psychological research data should be treated as sensitive research data.

The implementation should follow privacy-by-design principles and the requirements imposed by the relevant institution, ethics committee, and applicable data-protection law.

## Core Security Requirements

- HTTPS for all client/server communication
- Authenticated researcher dashboard
- Role-based access control where required
- Secure storage of research responses
- Separation of participant contact/notification information from research responses where possible
- Audit logging for critical administrative actions
- Prevention of duplicate/accidental response writes
- Protection against unauthorized access to participant-level data

## Example Separation

Contact / notification information:

```text
ParticipantContact

participant_id
email (optional)
notification_subscription
```

Research responses:

```text
ParticipantResponse

participant_id
question_id
response
timestamp
```

The researcher-facing dataset should primarily operate on `participant_id`, not directly identifying information.

---

# Data Integrity

## Timestamps

Important study events should be timestamped, preferably using UTC internally and converted to the study/participant timezone for display.

Examples:

- questionnaire available,
- questionnaire opened,
- question answered,
- questionnaire completed,
- notification sent.

## Protocol Versioning

Changes to a live study protocol must not silently alter the historical meaning of previously collected data.

Example:

```text
Protocol v1
Day 3 → Questionnaire A
```

Later:

```text
Protocol v2
Day 3 → Questionnaire B
```

The system must preserve which protocol version applied to each participant/session.

## Question Versioning

If a question is edited after data collection begins, old responses must remain associated with the exact version of the question that participants originally saw.

---

# Language Support

The application should support at least:

- Turkish
- English

Both participant-facing content and researcher-facing interface text should be designed with internationalization in mind.

---

# Proposed Technical Direction

The first implementation is expected to use a web-first architecture.

A possible architecture is:

```text
Participant PWA
        │
        ▼
Web Frontend
        │
        ▼
Backend API
        │
        ├── Study / Questionnaire Service
        ├── Protocol Scheduler
        ├── Notification Scheduler
        ├── Compliance Service
        └── Authentication / Authorization
        │
        ▼
Relational Database

Researcher Dashboard ───────────────► Backend API
```

Potential technologies include:

- **Frontend / Dashboard:** Next.js + TypeScript
- **Participant client:** Progressive Web App (PWA)
- **Backend:** FastAPI or NestJS
- **Database:** PostgreSQL
- **Background jobs / scheduling:** Redis + Celery or Redis + BullMQ
- **Push notifications:** Web Push / Firebase Cloud Messaging where appropriate

These technologies are **proposed, not yet final architectural decisions**.

---

# MVP Scope

## Participant

The first usable version should include:

- study enrollment URL,
- study QR code,
- configurable informed consent page,
- participant ID generation,
- participant/device continuity,
- baseline questionnaire support,
- scheduled questionnaires,
- configurable availability windows,
- push notifications,
- reminder notifications,
- autosave/resume,
- questionnaire completion flow,
- iOS/Android-friendly PWA,
- Turkish and English support.

## Researcher

The MVP researcher interface should include:

- authentication/login,
- study creation,
- questionnaire creation,
- question creation/editing,
- required/optional question configuration,
- protocol scheduling,
- reminder configuration,
- participant list,
- daily completion monitoring,
- compliance monitoring,
- participant timeline,
- response inspection,
- basic demographic/response visualizations,
- CSV export.

## Backend

The MVP backend should provide:

- participant management,
- study management,
- questionnaire management,
- protocol scheduling,
- notification scheduling,
- response storage,
- partial-response persistence,
- compliance calculation,
- authentication/authorization,
- protocol/question versioning,
- audit logging.

---

# Out of Scope for the First MVP

The following features are not required for the initial release:

- Native iOS application
- Native Android application
- SMS reminders
- Advanced statistical analysis inside the application
- SPSS `.sav` export
- Automated R analysis
- AI-based psychological analysis
- Multi-center research administration
- Random ESM prompts
- Advanced conditional branching
- Full offline questionnaire completion

These may be added in later versions.

---

# MVP Acceptance Scenario

The MVP can be considered successful when the following end-to-end scenario works reliably:

```text
Researcher creates a study
        ↓
Researcher creates an X-question baseline questionnaire
        ↓
Researcher configures a second questionnaire to open Y days later
        ↓
Participant joins through a link or QR code
        ↓
Participant reads and accepts informed consent
        ↓
Participant receives a pseudonymous Participant ID
        ↓
Participant completes the baseline questionnaire
        ↓
The system waits according to the configured protocol
        ↓
The next questionnaire automatically becomes available
        ↓
A push notification is sent
        ↓
If the questionnaire remains incomplete, reminders continue at configured intervals
        ↓
Participant completes the questionnaire
        ↓
Reminders stop
        ↓
Researcher sees completion/compliance status in the dashboard
        ↓
Researcher can inspect responses across time using Participant ID
        ↓
Researcher exports the dataset as CSV
```

If this workflow operates correctly and reliably, the core longitudinal research infrastructure is considered functional.

---

# Design Principles

The project should follow several principles throughout development:

1. **Compliance first** — missed measurements must be visible and reminders must be reliable.
2. **Researcher-configurable protocols** — schedules and questionnaires must not be hard-coded.
3. **Low participant friction** — joining and answering should require as few steps as possible.
4. **Privacy by design** — participant identity and psychological responses should be separated where possible.
5. **Longitudinal data integrity** — timestamps, protocol versions, question versions, and missingness must remain traceable.
6. **Mobile-first UX** — most participants are expected to answer from mobile devices.
7. **Exportability** — researchers must retain access to analysis-ready data outside the platform.

---

# Future Possibilities

Potential later additions include:

- randomized ESM notification windows,
- conditional question branching,
- email/SMS fallback reminders,
- richer adherence analytics,
- researcher roles such as Principal Investigator, Research Assistant, and Data Analyst,
- SPSS/R-compatible exports,
- study templates,
- multi-study organizations,
- native mobile applications if Web Push proves insufficient for a particular study design.

---

# Contributing

The project is currently in the requirements and early implementation stage. Development conventions, issue templates, branching strategy, local setup instructions, and contribution guidelines will be added once the initial architecture and repository structure are established.

---

# Disclaimer

This software is intended to support research data collection. It does not replace ethics committee approval, informed-consent requirements, institutional data-governance procedures, clinical judgment, or compliance with applicable privacy and research regulations.
