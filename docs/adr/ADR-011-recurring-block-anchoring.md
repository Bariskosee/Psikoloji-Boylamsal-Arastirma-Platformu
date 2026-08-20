# ADR-011 — Anchoring Steps Around a Recurring Block

**Status:** Accepted
**Date:** 2026-08-20

## Context

The first study this platform serves is a baseline of ~100 items, a thirty-day block of the
same ten items every day, and an endline that repeats the baseline instrument
(`docs/reference-protocol.md`). It is the first design in which a step must be placed **after a
recurring step**, and it exposed three questions the documents had never answered.

**What does a trigger against a recurring step mean?** `protocol_steps.trigger_step_id`
identifies a step, but a step with `occurrence_count = 30` produces thirty sessions reaching
`COMPLETED` at thirty different instants. "After the daily step" has thirty possible readings
and the schema expressed none of them.

**What happens if the participant misses the occurrence a later step waits on?** Under the
natural reading — trigger on the last occurrence — a participant who skips one evening report
never receives the endline at all: the dependent session sits in `PENDING_TRIGGER` until the
trigger becomes unreachable and is then `CANCELLED`. The study's primary outcome measurement
is destroyed by a minor compliance event, silently, and unrecoverably.

**What happens to occurrences that are already over when someone enrolls?** A block anchored to
a fixed cohort date has past occurrences for any late enrollment. Materialising them as
`EXPIRED_UNSTARTED` — the state a missed session normally lands in — would put measurements
that were never offered into the participant's compliance denominator.

## Decision

### 1. A trigger against a recurring step must name the occurrence

`protocol_steps` gains a nullable `trigger_occurrence_index`. It is **required** when
`trigger_step_id` references a step with `occurrence_count > 1`, and must be absent otherwise.
Publishing a protocol that violates either half is rejected with a validation error naming the
step.

### 2. A step may not be triggered by the *completion* of a recurring step

`trigger_type = STEP_COMPLETED` against a step with `occurrence_count > 1` is rejected at
publish, whatever occurrence is named. Two ways to express "after the block" remain:

- **anchor on the block's own origin plus a duration** — what the reference protocol does, and
  the recommended form;
- **`STEP_AVAILABLE` with an explicit `trigger_occurrence_index`** — permitted, because
  availability is computed by the server from the schedule and does not depend on participant
  behaviour.

### 3. Every step is classified by its dependency on participant behaviour

At publish, and in the protocol builder's timeline preview, each step's anchor chain is
resolved to one of two labels:

```text
UNCONDITIONAL   the chain reaches ENROLLMENT, CONSENT, or FIXED_DATETIME
                through offsets and wall-clock anchors only
CONDITIONAL     the chain contains at least one STEP_COMPLETED link
```

`CONDITIONAL` steps are labelled in the preview together with the steps they depend on and a
plain statement that missing those steps makes this one unreachable. The label is
informational, not a prohibition — conditioning on a baseline is legitimate and common. It
exists so a researcher cannot build a compliance-dependent outcome measurement without seeing
that they did.

### 4. Occurrences already closed at enrollment are cancelled, not expired

Materialisation creates them as `CANCELLED` with
`cancellation_reason = 'ENROLLED_AFTER_WINDOW'`. An occurrence whose window is open at that
moment materialises as `AVAILABLE` as usual; only fully-closed windows are cancelled.

## Alternatives rejected

**Defaulting an unqualified trigger to the last occurrence.** The single most likely intent,
and therefore the most dangerous default: it is the exact configuration that destroys the
endline, and it would be chosen by the researcher who thought least about it. A rejected
publish costs one minute; this costs a study arm.

**Allowing `STEP_COMPLETED` on a recurring step with a warning.** A warning is dismissed. The
failure it warns about is invisible for thirty days and unrecoverable when it surfaces — the
window has passed and there is no way to re-ask a participant "how did you feel on day 31".
Where the consequence cannot be undone, the guard belongs at publish.

**Chaining occurrence *n* from occurrence *n−1*'s completion.** Already rejected by FR-38 for
the same family of reasons: one missed evening would shift the entire remaining block, so
participants' measurement days would silently diverge from the study calendar.

**Materialising past occurrences as `EXPIRED_UNSTARTED`.** Reuses an existing state and needs
no new reason code, but it makes compliance depend on enrollment date. Two participants with
identical behaviour would report different adherence purely because one joined later, and the
figure would be wrong in a direction that flatters no one.

**Not materialising past occurrences at all.** Leaves no trace that the participant was absent
for the first part of the block. The timeline would show a thirty-day block starting at
occurrence 13 with no explanation, and reconstructing why would require re-deriving the
schedule from the protocol version by hand.

## Consequences

- The protocol builder needs trigger validation before it is usable, not after: rules 1 and 2
  are publish-time rejections and belong in `packages/domain` alongside the existing acyclicity
  and dangling-reference checks (Phase 4).
- `participant_sessions.cancellation_reason` carries `ENROLLED_AFTER_WINDOW` in addition to the
  withdrawal, study-closure, and unreachable-trigger reasons. Any interface that renders a
  cancelled session must handle it, and it must not read as a participant failure.
- Compliance is unaffected in its arithmetic — `CANCELLED` was already excluded from both terms
  (FR-44) — but the participant timeline gains a visibly distinct kind of non-session.
- A study that genuinely wants a compliance-gated follow-up can still build one against a
  non-recurring step. Nothing here restricts the single-occurrence case.
- The `UNCONDITIONAL` / `CONDITIONAL` classification is derived, never stored: it is a pure
  function of the step graph and must be computed by the same domain code the preview and the
  publish validator both call.
