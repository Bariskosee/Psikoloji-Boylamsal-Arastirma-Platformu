# Longitudinal Psychology Research Platform

A web-based research platform for longitudinal psychology studies, repeated-measures research, Experience Sampling Method (ESM), Ecological Momentary Assessment (EMA), and daily diary studies.

The platform is intended to provide a more flexible alternative to conventional one-time survey tools when a study requires participants to complete different questionnaires at different time points over several days or weeks.

The core goals are:

- schedule different questionnaire sets relative to each participant's own timeline,
- send repeated reminders when a participant has not completed an assigned questionnaire,
- preserve longitudinal responses under pseudonymous participant IDs,
- give researchers a dashboard for compliance and response monitoring,
- export clean longitudinal datasets for statistical analysis.

> **Project status:** Phases 0–6 are implemented — the core domain and database, researcher authentication, studies and the audit trail, the questionnaire builder, the protocol builder with a timeline preview, participant enrollment with versioned consent and a continuity credential, and the questionnaire runtime with autosave, resume and completion — along with the background job queue (ADR-004) and the reconciliation sweepers (ADR-005). A participant can join a study and answer a questionnaire without losing work. What is still missing is the part that decides **when** they are asked: sessions are created by hand today, and the engine that materialises them from a protocol is Phase 7. See `PLAN.md` for the phased roadmap and `CONTRIBUTING.md` to run it locally.

---

## Why This Project Exists

Traditional survey tools work well for one-time questionnaires, but they become difficult to manage when a study needs a workflow such as:

```text
Enrollment
        ↓
Baseline questionnaire
        ↓
Wait a configured interval
        ↓
Follow-up questionnaire
        ↓
Daily or scheduled questionnaires
        ↓
Repeated reminders for incomplete sessions
        ↓
Final questionnaire
```

For longitudinal psychological research, missing sessions substantially reduce data quality. **Participant compliance and notification reliability are therefore first-class requirements of this project**, not optional features.

The participant experience should remain as simple as a conventional online questionnaire. The researcher gains protocol scheduling, notifications, longitudinal tracking, and reporting.

---

## Intended Research Use Cases

- Longitudinal psychological research
- Repeated-measures studies
- Experience Sampling Method (ESM)
- Ecological Momentary Assessment (EMA)
- Daily diary studies
- Baseline + follow-up designs
- Multi-wave questionnaire studies

The first study the platform serves combines several of these: a baseline assessment of roughly a hundred items, the same ten-item set every day for thirty days, and the baseline instrument administered again at the end — around 35–36 days in total. It is worked through as configuration in `docs/reference-protocol.md` and is the shape the implementation is tested against. Every value in it is researcher-configurable; a different study changes the configuration, not the code.

---

## User Roles

**Participant.** Joins a study through a link or QR code and completes questionnaires assigned by the study protocol. No username or password is required. Each participant is represented by a pseudonymous identifier such as `P-A82F91`, and the platform recognises them across sessions so the same individual can be followed throughout the study without their identity appearing in the research dataset.

**Researcher.** Configures and monitors studies through an authenticated dashboard: builds questionnaires, defines the protocol schedule and reminder policy, monitors participation and compliance, inspects responses across time, and exports datasets.

---

## Technical Direction

The architecture is decided and recorded. In brief: a **TypeScript modular monolith** (NestJS) with a **dedicated always-on background worker**, backed by **PostgreSQL**, serving two **Next.js** applications — a participant PWA and a researcher dashboard. Background scheduling runs on **PostgreSQL-backed jobs with reconciliation sweepers**, and reminders use **standard Web Push with VAPID**.

The reasoning behind each choice, and the alternatives that were rejected, is in **`docs/adr/`**.

---

## Documentation Map

Each document is the single authority for its topic. Where they appear to conflict, `CLAUDE.md` defines the resolution order.

| Document | Authority for |
|---|---|
| `REQUIREMENTS.md` | Product requirements, glossary, MVP scope, acceptance criteria |
| `STRUCTURE.md` | Technical architecture, domain model, scheduling design, API boundaries |
| `AGENT.md` | Engineering rules and constraints for AI-assisted development |
| `PLAN.md` | Phased implementation roadmap and definition of done |
| `CLAUDE.md` | Entry instructions and document priority order |
| `docs/adr/` | Architecture decisions, with rejected alternatives |
| `docs/compliance-formula.md` | How every participation metric is computed |
| `docs/export-codebook.md` | Export structure and the missingness contract |
| `docs/runbooks/` | Operational procedures |

**Start here:** read `REQUIREMENTS.md` for what the product does, then `STRUCTURE.md` for how it is built, then `PLAN.md` for what happens next.

---

## Contributing

The project is at the start of implementation. Local setup instructions, development conventions, branching strategy, and contribution guidelines will be added during Phase 0 of `PLAN.md`, once the repository structure exists.

Development fixtures use neutral placeholder questions only. Real psychological instruments are never committed to this repository unless explicitly supplied and authorized by the research team.

---

## Disclaimer

This software supports research data collection. It does not replace ethics committee approval, informed-consent requirements, institutional data-governance procedures, clinical judgment, or compliance with applicable privacy and research regulations.

The data this platform collects is **pseudonymous, not anonymous**. Participant identity remains recoverable through retained continuity credentials, notification endpoints, and optional contact details, and the data therefore remains personal data under GDPR and KVKK.
