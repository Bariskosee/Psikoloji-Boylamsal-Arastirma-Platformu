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

---

## 6. Study-level aggregates

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

## 7. Daily compliance view (FR-28)

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

## 8. Worked examples

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

---

## 9. Required tests

Each of these must exist as a named test in `packages/domain`:

- every state's bucket assignment matches the table in §2;
- zero denominator returns "not applicable", not zero;
- `counts_toward_compliance = false` removes a session from both terms;
- `CANCELLED` removes a session from both terms;
- worked examples A–D reproduce exactly the numbers above;
- study average excludes withdrawn participants and zero-denominator participants;
- daily view categories sum to the window totals as shown in §7;
- elapsed and strict converge once every session is terminal.
