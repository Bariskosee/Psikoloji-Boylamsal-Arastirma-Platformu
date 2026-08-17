# ADR-008 — Questionnaire and Protocol Versioning

**Status:** Accepted
**Date:** 2026-08-17

## Context

Researchers will edit studies while data collection is running. A typo gets fixed, a response option is added, a follow-up interval is adjusted. NFR-07 and NFR-08 require that none of this retroactively change the meaning of already-collected data.

Earlier documentation required "immutable or versioned definitions" but did not specify the editing model, and — more consequentially — did not say what happens to **already-enrolled participants** when a new version is published. That is the most likely mid-study operation and it had no defined behaviour.

## Decision

### Draft and publish

Every questionnaire and protocol has at most one `DRAFT` version and any number of `PUBLISHED` ones.

- Editing happens only on the draft.
- Publishing deep-copies the draft into immutable rows and marks them `PUBLISHED`.
- Published rows are protected by a `BEFORE UPDATE` database trigger. Immutability is enforced by the database, not by application convention.
- A protocol step may only reference a `PUBLISHED` questionnaire version.

### Binding

- A `ParticipantSession` pins `questionnaire_version_id`, so the exact wording a participant saw is permanently recoverable.
- An `enrollment` pins `protocol_version_id` **for the life of the enrollment**.

### The mid-study edit rule

**Publishing a new version affects only participants who enroll afterwards.** Existing participants continue on their bound version until their protocol ends.

Migrating an enrolled participant to a newer protocol version is a distinct, explicit, audit-logged operation, and it is **out of MVP scope**.

### Stable question identity

Each question carries a `question_key` that is stable across versions and unique within a questionnaire. The key identifies "the same question" for longitudinal comparison and wide-format export columns; the version identifies the exact wording. Changing a key after data collection begins is prohibited.

## Rationale

**Pinning at enrollment is the only rule that is both safe and explainable.** The alternatives fail:

- *Auto-migrating everyone to the newest version* changes the protocol out from under participants mid-study. A participant could have their follow-up interval silently altered after baseline, producing data that no methods section can honestly describe.
- *Asking per participant at publish time* is an operational burden and an error source, and it produces a study where the applied protocol varies for reasons nobody recorded.

Pinning gives one sentence a researcher can write in a paper: participants received the protocol version active when they enrolled, and the version is recorded on every session.

**The database trigger matters more than it appears.** "Do not update published rows" as a code convention survives until the first agent that writes a convenient upsert. As a trigger, the violation fails loudly in tests.

## Consequences

- A study running for months may have several concurrent protocol versions in flight. Exports include `protocol_version` on every row, and the participant timeline shows which version applies.
- Fixing a typo in a live questionnaire requires publishing a new version, which existing participants will not see. This is correct — but it is surprising, so the publish dialog must state it explicitly.
- Deep-copying on publish duplicates rows. At this scale the storage cost is irrelevant, and the alternative — a shared mutable question referenced by versions — reintroduces exactly the mutation risk being prevented.
- Wide-format export column stability depends on `question_key` discipline. A study that reuses a key for a semantically different question before its first response can still produce a misleading wide file; long format remains authoritative.
- Tests must assert that a published version is unchanged after further draft edits, and that a published row cannot be updated.
