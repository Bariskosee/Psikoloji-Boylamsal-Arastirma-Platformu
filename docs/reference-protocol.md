# Reference Protocol

The study design the platform is being built to serve first, expressed entirely as
configuration.

This document exists so that every phase from the questionnaire builder to the pilot has one
concrete, hand-computed target to build and test against. It is a **worked example, not a
specification of platform behaviour**. Nothing here may become a default, a constant, an
enum value, or a fixture assumption in application code. A different study must be able to
express a seven-day diary, a three-wave design, or an event-contingent protocol by changing
these rows and nothing else.

Related: `REQUIREMENTS.md` FR-11, FR-12, FR-38, FR-47, FR-48 · `STRUCTURE.md` §8 ·
`docs/adr/ADR-011-recurring-block-anchoring.md` · `docs/compliance-formula.md` §6.

---

## 1. The design

```text
Day 0                  baseline assessment          ~100 items
designated start day   daily set, unchanged          10 items × 30 consecutive days
Day 31                 endline assessment            the same ~100 items as Day 0
                       total elapsed ≈ 35–36 days including the endline window
```

Two properties of this design drive most of the rules below:

1. **The daily set never changes.** The same ten items are asked on all thirty days, so all
   thirty occurrences pin one immutable questionnaire version. Variation across days must come
   from the participant, never from the instrument.
2. **The endline repeats the baseline instrument.** Day 0 and Day 31 are the same ~100 items,
   which is what makes the study a pre/post design. They are therefore **one questionnaire
   referenced by two protocol steps** (FR-47) — not two questionnaires whose content has to be
   kept in sync by hand.

---

## 2. Questionnaires

| Key | Items | Pages | Used by | Notes |
|---|---|---|---|---|
| `core` | ~100 | ~10 | `baseline` **and** `endline` steps | One published version, referenced twice |
| `daily` | 10 | 1 | `daily` step, all 30 occurrences | One published version, pinned by every occurrence |

Both are published before the protocol is published; a protocol step may only reference a
`PUBLISHED` questionnaire version (ADR-008).

Item content is supplied by the research team. Repository fixtures use neutral placeholders
(`Sample question 1`) exclusively — see `AGENT.md` §16 and FR-10.

---

## 3. Protocol steps

Protocol `main`, version 1, three steps. Anchor mode A (fixed cohort date) shown; mode B in §5.

| # | `step_key` | Questionnaire version | `trigger_type` | Offset | `occurrence_count` | `recurrence_interval_iso` | `anchor_local_time` | `window_duration_iso` | Compliance |
|---|---|---|---|---|---|---|---|---|---|
| 0 | `baseline` | `core` v1 | `ENROLLMENT` | `PT0S` | 1 | — | — | `P3D` | counts |
| 1 | `daily` | `daily` v1 | `FIXED_DATETIME` | `PT0S` | 30 | `P1D` | `20:00`, participant zone | `PT12H` | counts |
| 2 | `endline` | `core` v1 *(same version id as step 0)* | `FIXED_DATETIME` | `P30D` | 1 | — | `20:00`, participant zone | `P3D` | counts |

Steps 1 and 2 share one `FIXED_DATETIME` origin: the designated start day at 20:00 in the
study timezone. The endline is therefore **anchored to the block, not chained to it** — see §4.

Reminder policy for all three steps is configured per FR-40 with an explicit
`max_reminders`; the cadence for a thirty-day block is an open decision
(`REQUIREMENTS.md` §10) and no value is assumed here.

### What each column is doing

- **`baseline` uses `ENROLLMENT`, not a wall-clock anchor.** The participant should be able to
  start immediately after consenting, whatever time of day they enrolled. Duration mode from
  the enrollment instant is DST-immune and needs no timezone at all.
- **`daily` uses a wall-clock anchor.** "Every evening" is a wall-clock concept; a pure
  duration offset would drift relative to the participant's day. `PT12H` (20:00 → 08:00 local)
  keeps each report attached to one calendar day; a `P1D` window would let two consecutive
  occurrences overlap, which makes "which day is this report about?" unanswerable.
- **`endline` gets a `P3D` window.** Re-answering ~100 items is a much larger ask than a
  ten-item daily report, and it is the study's primary outcome measurement. A wide window is
  the cheapest available protection against losing it.

---

## 4. The endline is anchored, never chained

The obvious way to express "after the thirty days, ask the baseline again" is to trigger the
endline on completion of the last daily occurrence. **That is prohibited** (FR-48c), and this
design is the reason the rule exists.

```text
prohibited                                   required
──────────                                   ────────
endline.trigger = STEP_COMPLETED(daily #29)  endline.trigger = the daily block's own
                                             origin + P30D

a participant who misses one daily report    a participant who misses every daily report
loses the primary outcome measurement:       still receives the endline at the correct
PENDING_TRIGGER → CANCELLED, permanently     instant
```

Missing an intermediate measurement is a compliance event. Losing the outcome measurement
because of it is data loss, and it is unrecoverable — the window passes and the participant is
never asked. The two must not be coupled.

The general rule: **anchor outcome steps on time, not on behaviour.** Where a step genuinely
must follow another step's occurrence, `STEP_AVAILABLE` with an explicit
`trigger_occurrence_index` is permitted, because availability is computed by the server and
does not depend on what the participant did.

---

## 5. Anchor mode B — participant-relative

Some studies want each participant on their own timeline instead of a shared cohort calendar.
The same design expressed relatively:

| # | `step_key` | `trigger_type` | `trigger_step_id` | Offset | Rest |
|---|---|---|---|---|---|
| 0 | `baseline` | `ENROLLMENT` | — | `PT0S` | unchanged |
| 1 | `daily` | `STEP_COMPLETED` | `baseline` | `P1D` | unchanged |
| 2 | `endline` | `STEP_COMPLETED` | `baseline` | `P31D` | unchanged |

Both recurring and outcome steps hang off **the same trigger** — baseline completion — so the
endline is still independent of daily adherence. Step 2 does not reference step 1.

This mode makes both steps *compliance-conditional* on the baseline (FR-48b): a participant who
never completes the baseline receives nothing. That is acceptable and unavoidable, because the
baseline is the study's entry point; the protocol builder labels it so the researcher sees it.
Conditioning on the *daily block* would not be acceptable, and is rejected at publish.

Mode A and mode B are both first-class. The pilot's choice is an open decision
(`REQUIREMENTS.md` §10).

---

## 6. Worked instants

Study timezone `Europe/Istanbul` (UTC+3, no DST since 2016). Designated start day
`2026-09-07`, anchored at `20:00` local. Participant `P-A82F91`, timezone `Europe/Istanbul`,
enrolls `2026-09-04T09:12Z` and completes the baseline at `2026-09-04T14:40Z`.

**Mode A — fixed cohort date**

| Session | `available_from` (UTC) | `available_until` (UTC) | Local start | State at enrollment |
|---|---|---|---|---|
| `baseline` #0 | `2026-09-04T09:12Z` | `2026-09-07T09:12Z` | 04 Sep 12:12 | `AVAILABLE` |
| `daily` #0 | `2026-09-07T17:00Z` | `2026-09-08T05:00Z` | 07 Sep 20:00 | `SCHEDULED` |
| `daily` #1 | `2026-09-08T17:00Z` | `2026-09-09T05:00Z` | 08 Sep 20:00 | `SCHEDULED` |
| … | *origin + n × `P1D`* | *+ `PT12H`* | | `SCHEDULED` |
| `daily` #29 | `2026-10-06T17:00Z` | `2026-10-07T05:00Z` | 06 Oct 20:00 | `SCHEDULED` |
| `endline` #0 | `2026-10-07T17:00Z` | `2026-10-10T17:00Z` | 07 Oct 20:00 | `SCHEDULED` |

Elapsed from enrollment to the endline window closing: **36 days**. Sessions materialised at
enrollment: **32** (1 + 30 + 1).

Note that the "Day 0 / Day 31" numbering in §1 is relative to the **block origin**, not to
enrollment. Under mode A the two coincide only for a participant who enrolls on the designated
start day; anyone enrolling earlier sits further from their baseline, which is the deliberate
trade of a shared cohort calendar. Under mode B they always coincide.

**Mode B — participant-relative**, same participant: `daily` #0 opens `2026-09-05T17:00Z`
(baseline completion + `P1D`, set to 20:00 local), `daily` #29 opens `2026-10-04T17:00Z`, and
`endline` #0 opens `2026-10-05T17:00Z` and closes `2026-10-08T17:00Z`.

Occurrence *n* is computed from the step's own origin plus *n* × `P1D`, never chained from
occurrence *n−1* (FR-38). A participant who misses day 4 still gets day 5 on time.

These instants are the assertion target for the Phase 4 timeline preview and the Phase 7
fake-clock materialisation test. If the implementation disagrees with this table, one of the
two is wrong and the discrepancy must be resolved before the phase closes.

---

## 7. Enrolling after the block has started

Mode A admits a case mode B cannot produce: a participant enrolling on `2026-09-20` when
occurrences #0–#12 (07–19 Sep) have already closed.

Those occurrences are materialised as **`CANCELLED`** with
`cancellation_reason = 'ENROLLED_AFTER_WINDOW'` — never `EXPIRED_UNSTARTED`.

```text
daily #0 … #12   CANCELLED  (ENROLLED_AFTER_WINDOW)   window closed before enrollment
daily #13        SCHEDULED                            opens 20 Sep 20:00 local
daily #14 … #29  SCHEDULED
```

`EXPIRED_UNSTARTED` means "was offered and not done" and lands in the compliance denominator.
Charging a participant for measurements that were never offered to them would corrupt the
metric and, in a published paper, misdescribe the sample. `CANCELLED` is excluded from both
compliance terms (FR-44), stays visible on the participant timeline, and exports as
`NOT_APPLICABLE` rather than as missing data.

The occurrence whose window is open at the moment of enrollment materialises as `AVAILABLE`,
not `CANCELLED`; only fully-closed windows are cancelled.

---

## 8. Volume

Per participant, for this design:

| Quantity | Count |
|---|---|
| ParticipantSessions materialised at enrollment, in one transaction | 32 |
| Responses at full compliance | ~500 (100 + 30 × 10 + 100) |
| Availability notifications, at most | 32 |
| Reminders | bounded by `max_reminders` per session (FR-40) |
| Wide-export column groups | 500 → ~1 000 columns with status columns |

At 500 participants that is ~16 000 sessions and ~250 000 responses — comfortably inside
NFR-11, but far enough from a toy protocol that the builder, the timeline, the dashboard, and
the wide export must all be exercised at this size rather than at the size of a three-step
demo.

---

## 9. What is configuration and what is not

**Configuration — every value in this document.** Item counts, page counts, occurrence count,
interval, anchor time, window lengths, the designated start day, day 31 versus day 32, the
choice of anchor mode, reminder cadence. None of it may appear as a literal in application
code, a default in a schema, or an assumption in a domain function. `AGENT.md` §3.4 and §17.

**Platform rules — the constraints this design exposed, which apply to every study.** They live
in the normative documents, not here:

- a step triggered by a recurring step's occurrence must name the occurrence, and may not
  depend on its *completion* — FR-48;
- one questionnaire version may be referenced by any number of steps — FR-47;
- occurrences already closed at enrollment are cancelled, not expired — FR-38;
- compliance is reportable per step, not only overall — FR-44.
