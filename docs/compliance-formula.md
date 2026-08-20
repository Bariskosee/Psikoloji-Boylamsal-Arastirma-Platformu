# Compliance Formula

Normative definition of every participation metric the platform reports. Implements **FR-44** and **FR-28**.

This document exists because a compliance percentage published in a paper must be reproducible and defensible. The denominator rule is the part most often left implicit, and it is the part that changes the number most. Nothing here may be re-implemented in dashboard components — the single implementation lives in `packages/domain/src/compliance/`.

---

## 1. Unit of analysis

Compliance is computed over **ParticipantSessions**, never over questions and never over calendar days.

One ParticipantSession is one (participant, protocol step, occurrence) triple. A protocol step with `occurrence_count = 7` contributes seven ParticipantSessions per participant.

---

## 2. Session classification

Every ParticipantSession falls into exactly one bucket at query time.

| State | Bucket | In denominator? | In numerator? |
|---|---|---|---|
| `PENDING_TRIGGER` | Not yet due | No | No |
| `SCHEDULED` | Not yet due | No | No |
| `AVAILABLE` | Currently open | No | No |
| `STARTED` | Currently open | No | No |
| `COMPLETED` | Due and met | **Yes** | **Yes** |
| `EXPIRED_UNSTARTED` | Due and missed | **Yes** | No |
| `EXPIRED_PARTIAL` | Due and missed | **Yes** | No |
| `CANCELLED` | Excluded entirely | No | No |

Additionally, a ParticipantSession is excluded from both numerator and denominator when its protocol step has `counts_toward_compliance = false`.

---

## 3. Default metric — elapsed compliance

```text
elapsed_compliance(participant) =
      count(sessions in COMPLETED)
    ÷ count(sessions in COMPLETED ∪ EXPIRED_UNSTARTED ∪ EXPIRED_PARTIAL)

    … restricted to steps where counts_toward_compliance = true
```

**Rationale for excluding open and future sessions.** A participant who enrolled yesterday in a 30-day protocol has completed 1 of 30 possible sessions. Reporting 3% would be wrong: they are not non-compliant with 29 sessions that do not yet exist for them. Elapsed compliance answers "of the work that has actually come due, how much did they do?", which is the question researchers ask when monitoring an ongoing study.

**Currently-open sessions are also excluded** because the participant still has time. Including them would make every participant's score dip whenever a window opens and recover when they answer, producing a metric that oscillates for reasons unrelated to behaviour.

This is the default shown everywhere in the interface unless explicitly labelled otherwise.

---

## 4. Secondary metric — strict compliance

```text
strict_compliance(participant) =
      count(sessions in COMPLETED)
    ÷ count(all sessions except CANCELLED)

    … restricted to steps where counts_toward_compliance = true
```

Strict compliance uses the full protocol as the denominator regardless of elapsed time. It is meaningful only **after a participant's protocol has finished**, where it equals elapsed compliance.

It is provided because final per-protocol completion rates are usually what gets reported in a methods section. It must always be labelled "strict" in the interface and in exports.

---

## 5. Zero denominator

When the denominator is zero — a participant enrolled minutes ago, or a study where nothing has come due yet — the system must display **"not yet applicable"** and export an empty value.

It must never display or export `0%`. Zero percent means "had opportunities and took none", which is a materially different claim about a participant.

Sessions cancelled because the participant enrolled after an occurrence's window had already closed (`ENROLLED_AFTER_WINDOW`, `STRUCTURE.md` §8.2) are `CANCELLED` and therefore leave both terms by the §2 rule. No special case is needed here — but it is the reason the state was chosen, so it is worth stating: those measurements were never offered, and charging them as missed would make compliance depend on enrollment date rather than on behaviour.

---

## 6. Per-step compliance

Both metrics above are also computed **restricted to a single protocol step**, over that step's occurrences:

```text
step_compliance(participant, step_key) =
      count(sessions of that step in COMPLETED)
    ÷ count(sessions of that step in COMPLETED ∪ EXPIRED_UNSTARTED ∪ EXPIRED_PARTIAL)
```

The same exclusions apply unchanged: cancelled sessions, not-yet-due sessions, open windows, and steps flagged `counts_toward_compliance = false`.

**Why this is required and not merely nice** (FR-44). A protocol that mixes a long recurring block with a small number of anchor measurements produces an overall figure dominated by the block. In the reference design — a baseline, thirty daily occurrences, an endline — these two participants report the same overall compliance:

| | Baseline | Daily (30) | Endline | Overall | Usable for the primary analysis? |
|---|---|---|---|---|---|
| P-AAA111 | completed | 14 / 30 | completed | 16/32 = 50% | **Yes** |
| P-BBB222 | missed | 16 / 30 | missed | 16/32 = 50% | **No** |

One number, two entirely different research situations. The dashboard, the participant list, and the exports must therefore report per-step figures alongside the overall one, and a protocol's anchor measurements should be legible at a glance.

Naming in the interface distinguishes the two kinds of question a researcher is asking: **adherence** for a recurring block ("how many of the daily reports did they file?") and **completion** for a single-occurrence step ("did they do the endline, yes or no?"). A percentage is a poor rendering of a one-in-one measurement and must not be used for it — a step with `occurrence_count = 1` displays completed or missed, never 100% or 0%.

---

## 7. Study-level aggregates

**Average compliance** is the unweighted mean of participants' elapsed compliance, over participants with a non-zero denominator:

```text
study_average_compliance =
      mean( elapsed_compliance(p) for p in participants
            where p.status ≠ WITHDRAWN
              and denominator(p) > 0 )
```

Two deliberate choices:

- **Unweighted by participant, not pooled over sessions.** A pooled ratio lets a participant with many occurrences dominate the study average. The per-participant mean treats each person as one observation, which matches how compliance is normally reported.
- **Withdrawn participants are excluded from the average** but are reported separately as a count (FR-27). Their partial compliance is not deleted; it is simply not averaged in, because withdrawal is a different phenomenon from non-compliance.

The interface must display the participant count behind any average.

---

## 8. Daily compliance view (FR-28)

For a given calendar date in the **study timezone**, over ParticipantSessions whose response window overlapped that date:

| Category | Definition |
|---|---|
| Completed | `COMPLETED` with `completed_at` on that date |
| Started, not finished | `STARTED` now, or `EXPIRED_PARTIAL` whose window closed on that date |
| Not started | `AVAILABLE` now with zero responses, or `EXPIRED_UNSTARTED` whose window closed on that date |
| Missed | `EXPIRED_UNSTARTED` ∪ `EXPIRED_PARTIAL` whose window closed on that date |

Note that "not started" and "missed" overlap by construction: a session that expired unstarted is both. The interface must show these as a breakdown that sums correctly, not as four independent counts that appear to double-count. The canonical presentation is:

```text
Windows closing today:  N
  ├─ Completed              a
  ├─ Missed — never opened  b
  └─ Missed — partial       c        where a + b + c = N

Windows still open:     M
  ├─ Not started            d
  └─ In progress            e        where d + e = M
```

---

## 9. Worked examples

**Example A — mid-study participant**

Protocol: baseline, follow-up, and a daily step with 7 occurrences (9 sessions total). Participant enrolled 4 days ago.

| Session | State |
|---|---|
| Baseline | `COMPLETED` |
| Follow-up | `COMPLETED` |
| Daily 0 | `COMPLETED` |
| Daily 1 | `EXPIRED_UNSTARTED` |
| Daily 2 | `EXPIRED_PARTIAL` |
| Daily 3 | `AVAILABLE` |
| Daily 4–6 | `SCHEDULED` |

```text
Denominator = 5   (3 completed + 1 expired_unstarted + 1 expired_partial)
Numerator   = 3
elapsed_compliance = 3/5 = 60%
strict_compliance  = 3/9 = 33%      ← misleading mid-study; not the default
```

**Example B — just enrolled**

Baseline is `AVAILABLE`, everything else `SCHEDULED` or `PENDING_TRIGGER`.

```text
Denominator = 0
elapsed_compliance = not yet applicable      ← never 0%
```

**Example C — withdrawal**

Participant completed 2 of 3 due sessions, then withdrew with 5 sessions remaining.

```text
The 5 remaining sessions become CANCELLED and leave both terms.
Denominator = 3, Numerator = 2 → elapsed_compliance = 67%
The participant is excluded from the study average and counted
as withdrawn in the overview.
```

**Example D — step excluded from compliance**

A protocol includes an optional exit-interview step with `counts_toward_compliance = false`. Whether the participant completes it never affects either metric, though it still appears in the timeline and the export.

**Example E — the reference design, mid-block**

Protocol: `baseline` ×1, `daily` ×30, `endline` ×1 — 32 sessions (`docs/reference-protocol.md`). The participant enrolled 12 days ago into a fixed-date block that had already run for 2 days when they joined, and today's daily window is still open.

| Sessions | State | Count |
|---|---|---|
| `baseline` | `COMPLETED` | 1 |
| `daily` #0–#1 | `CANCELLED` (`ENROLLED_AFTER_WINDOW`) | 2 |
| `daily` #2–#10 | `COMPLETED` 7, `EXPIRED_UNSTARTED` 1, `EXPIRED_PARTIAL` 1 | 9 |
| `daily` #11 | `AVAILABLE`, window open | 1 |
| `daily` #12–#29 | `SCHEDULED` | 18 |
| `endline` | `SCHEDULED` | 1 |

```text
Denominator = 10   (1 baseline + 7 completed + 1 unstarted + 1 partial dailies)
Numerator   =  8
elapsed_compliance      = 8/10 = 80%
strict_compliance       = 8/30 = 27%      ← the 2 cancelled leave the denominator
daily adherence         = 7/9  = 78%
baseline completion     = completed
endline completion      = not yet due
```

Three things this example is here to pin down: the two `ENROLLED_AFTER_WINDOW` sessions are absent from every denominator, including the strict one, so a late enrollment is not penalised; the open window is excluded; and the endline reports "not yet due" rather than a percentage, per §6.

---

## 10. Required tests

Each of these must exist as a named test in `packages/domain`:

- every state's bucket assignment matches the table in §2;
- zero denominator returns "not applicable", not zero;
- `counts_toward_compliance = false` removes a session from both terms;
- `CANCELLED` removes a session from both terms, whatever the cancellation reason;
- `ENROLLED_AFTER_WINDOW` sessions leave the strict denominator too, so late enrollment does not depress strict compliance;
- worked examples A–E reproduce exactly the numbers above;
- per-step compliance over a recurring block matches a hand-counted fixture, and the two participants in §6 with equal overall compliance produce different per-step figures;
- a single-occurrence step reports completed or missed, never a percentage;
- study average excludes withdrawn participants and zero-denominator participants;
- daily view categories sum to the window totals as shown in §8;
- elapsed and strict converge once every session is terminal.
