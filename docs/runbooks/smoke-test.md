# Runbook — end-to-end smoke test on a real device

**When:** after any deployment to a new host, a new hostname, or a new VAPID pair — and before `study-launch-checklist.md` is worked through with the researcher. **Time:** about forty minutes, most of it waiting for windows to close.

This proves the loop that no test suite can prove: that a real phone, on a real network, receives a real push notification from this deployment and that the answer comes back. `study-launch-checklist.md` §4 and §6 require it; this is how it is done.

---

## 1. Why the test protocol is not the study protocol

The obvious way to smoke-test is to build the study you actually intend to run. Do not: `docs/reference-protocol.md` describes a design whose first daily occurrence opens at 20:00 and whose endline lands thirty-one days later. Verifying it end to end means waiting a month, and a smoke test that takes a month is a smoke test nobody runs.

The protocol below compresses the same **mechanisms** into about twenty minutes. It is deliberately not a plausible study — it exists to make each mechanism fail loudly and quickly if it is broken:

| Mechanism | Failure it catches |
|---|---|
| A session that is `AVAILABLE` at enrollment | Enrollment, consent binding, materialisation |
| A session that opens *later* | The sweeper is not activating anything — the silent killer |
| A session that closes unanswered | `EXPIRED_UNSTARTED` reaching the compliance denominator |
| A reminder after the first notification | Reminder cadence, `max_reminders`, quiet-hours suppression |

Windows are minutes rather than hours because the platform enforces no minimum — a window is duration arithmetic (`packages/domain/src/protocol/timing.ts`), and nothing about a five-minute window is a special case.

> **The compressed protocol must never be used for real participants.** Its windows are far too short to be answerable, which is exactly what `study-launch-checklist.md` §1 warns about. It is a diagnostic instrument, not a study design.

---

## 2. The test study

Create it through the researcher dashboard, as a researcher would.

| Field | Value |
|---|---|
| Name | `SMOKE TEST — delete me` |
| Description | Deployment verification. Not a study. |
| Capacity | 2 |
| Timezone | the study's real timezone |
| Locales | the study's real locales, real default |

Name it so that nobody mistakes it for data. §7 exists because a test enrollment counted as a real one contaminates the study's N from the first day.

## 3. The questionnaire

One page, three items. Instrument content is study data and the repository supplies none (`AGENT.md` §16, FR-10) — use placeholders and mean it:

| Item | Type | Notes |
|---|---|---|
| `Sample question 1` | single choice, 1–5 | the value you will look for in the export |
| `Sample question 2` | free text | type a Turkish string: `şçöğüıİ` |
| `Sample question 3` | single choice, 1–5 | left blank, to prove empty cells carry a status column |

The Turkish string is not decoration. Encoding damage in `long.csv` surfaces only when someone opens it in the tool the researcher actually uses, and it is far cheaper to find here than in analysis.

Publish it. A protocol step may only reference a `PUBLISHED` questionnaire version (ADR-008).

## 4. The protocol

Three steps, one questionnaire version referenced by all of them (FR-47), `occurrence_count` 1 throughout so no recurrence rules apply.

| # | `step_key` | `trigger_type` | Offset | `window_duration_iso` | What it proves |
|---|---|---|---|---|---|
| 0 | `now` | `ENROLLMENT` | `PT0S` | `PT30M` | Available the moment consent is given |
| 1 | `expires` | `ENROLLMENT` | `PT0S` | `PT5M` | Closes unanswered while you watch |
| 2 | `later` | `ENROLLMENT` | `PT3M` | `PT30M` | The sweeper activates it, not the enrollment |

**Step 2 is the one that matters most.** Steps 0 and 1 are materialised at enrollment and would appear even if the worker were dead. Only step 2 requires `sweep.activate_due` to have run — and a worker that is not activating is a platform where no session ever opens and nothing reports an error. If step 2 never becomes available, stop and read `sweeper-stall.md`.

**Reminder policy** for steps 0 and 2:

| Field | Value |
|---|---|
| `initial_delay_iso` | `PT1M` |
| `interval_iso` | `PT3M` |
| `max_reminders` | `2` |
| quiet hours | **none** |

Quiet hours are left unset on purpose: with them configured, a smoke test run in the evening suppresses the very notification it exists to verify, and the run looks like a push failure. The real study sets them (`study-launch-checklist.md` §2).

Publish the protocol, then activate the study.

---

## 5. The run

Do this on a physical phone. Not a simulator: iOS delivers Web Push only to a PWA installed to the Home Screen, and a simulator cannot verify receipt.

1. **Enroll** by the route real participants will use — the enrollment link or QR code, opened on the phone.
2. **Consent.** Read the consent screen as a participant would; this is the last cheap moment to notice wording problems.
3. **Install to the Home Screen**, then grant notification permission *inside the installed application*. On iOS the permission prompt must come from a user gesture in the installed app, and the installed app may not inherit the browser's credentials — ADR-007's install handoff is what carries them across. If it does not, that is the bug.
4. **Confirm the subscription arrived**: the operations page should show one active push subscription. Zero here means the rest of the run will prove nothing.
5. **Wait for the first notification** on step 0 (about a minute), then **one reminder** (about three more).
6. **Complete step 0.** Confirm it appears in the inspector as `ANSWERED`.
7. **Ignore step 1** and let its five minutes pass. Confirm it becomes `EXPIRED_UNSTARTED` — *not* missing, *not* cancelled — and that compliance counts it in the denominator. `CANCELLED` here would be a bug: that status means "never offered" (`docs/reference-protocol.md` §7).
8. **Wait for step 2 to open** at three minutes and confirm a notification arrives for it. This is the worker's activation path.
9. **Export** `long.csv` and `codebook.csv`. Open them in the tool the researcher actually uses. Confirm `şçöğüıİ` survived, and that `Sample question 3`'s empty cell carries a status column rather than being silently blank.
10. **Withdraw** the test participant. Confirm no further notification arrives — step 2's remaining reminders must stop.

## 6. What a pass looks like

- One active push subscription, then zero after withdrawal.
- Step 0 `ANSWERED`, step 1 `EXPIRED_UNSTARTED`, step 2 activated by the sweeper.
- At least one notification and one reminder received on the physical device.
- `long.csv` opens with Turkish characters intact and status columns present.
- Operations page: sweeper heartbeat fresh, consecutive failures 0, dead-lettered jobs 0.

Anything else is a finding. Record it before moving on — a smoke test whose failures are explained away is worse than none, because it converts an unknown into a false assurance.

## 7. Cleanup, which is not optional

- [ ] Withdraw and remove the test participant, or record explicitly that it exists and must be excluded from every analysis.
- [ ] Delete or clearly archive the smoke-test study. Its name should have made this obvious; confirm it anyway.
- [ ] **Do not rotate the VAPID pair afterwards.** The test created a real push subscription against the current keys. Rotating them is a permanent, unrepairable unsubscribe for every device — including the real participants who come later (`push-failure-triage.md` §2).
- [ ] Re-run the backup and the restore drill now that non-zero rows have existed. `restore-drill.md`'s guarantee is weaker against an empty database, and this is the first moment it can be tested properly.
