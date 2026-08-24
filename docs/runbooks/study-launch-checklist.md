# Runbook — pre-launch checklist for a new study

Run this **before the first participant enrolls**. Every item here is something that is cheap to fix now and either expensive or impossible to fix once real data exists — a published protocol is immutable (ADR-008), and a timing mistake discovered in week three has already produced three weeks of data collected under the wrong design.

Work through it with the researcher present. Several items are research decisions, not engineering ones.

---

## 1. The protocol

- [ ] **Preview the timeline** in the protocol builder and read it out loud with the researcher. The preview shows the actual occurrences the platform will create. If it does not match what the study protocol document says, the study protocol document wins and the configuration is wrong.
- [ ] **Windows are long enough to be answerable.** A 30-minute window on a working adult produces missingness that looks like non-compliance and is really a design fault.
- [ ] **The anchor mode is the intended one.** Fixed-clock and elapsed-time anchoring diverge across a daylight-saving boundary, and a longitudinal study will cross one (ADR-011).
- [ ] **Trigger graph reviewed.** No unreachable steps; the preview flags them.
- [ ] **Every value came from the researcher.** Nothing in `docs/reference-protocol.md` is a default — it is a worked example. Occurrence counts, windows, reminder cadence, and quiet hours are all study-specific.

## 2. Time and language

- [ ] **The study timezone is correct**, and matches how participants will actually be recruited. Everything a participant sees is rendered in their own zone; the study zone governs the protocol.
- [ ] **Quiet hours set, and sane.** They are enforced in the participant's zone, and they wrap overnight correctly. A study that has not set them will send reminders at 03:00.
- [ ] **Both locales reviewed by someone who reads them.** Turkish and English catalogs are key-complete by CI, which proves nothing about whether the wording is right. Have a Turkish speaker read the participant screens.
- [ ] **Questionnaire content translated.** Instrument text is study data, not platform text — CI does not check it, and a missing translation surfaces as an empty question.

## 3. Consent and ethics

- [ ] Consent text published, and its version recorded.
- [ ] The withdrawal path has been walked through end to end, on a test participant, by someone who is not the person who built the study.
- [ ] Participants are told what notifications they will receive and roughly how often.
- [ ] The research team has read `data-erasure.md` §2 and knows an erasure request is a human process.

## 4. Notifications

- [ ] **VAPID keys configured, and backed up somewhere that survives redeployment.** Losing them silently unsubscribes every participant, permanently, and cannot be repaired server-side (`push-failure-triage.md` §2). Treat them as study data.
- [ ] **Tested on real iOS hardware** — not a simulator. iOS delivers web push only to a PWA installed to the Home Screen, the simulator cannot verify actual receipt, and this is the single most common way a study discovers on day one that half its participants get nothing.
- [ ] Reminder cadence reviewed against the burden it places on the participant. This is a research-design decision.
- [ ] End-to-end test: enroll a test participant, receive an initial notification and one reminder, on a real phone.

## 5. Operations

- [ ] **The worker is on an always-on tier.** ADR-010. A host that idles it out stops all scheduling silently. This is the failure mode most likely to ruin a study.
- [ ] **Origins are participant-stable.** `DEPLOYMENT_MODE=participant`; use registered hostnames or a public IP verified as reserved. Ephemeral-IP `sslip.io` is smoke-only because an origin change permanently invalidates continuity cookies and push subscriptions.
- [ ] `GET /ready` returns 200 with **both** checks passing.
- [ ] Sweeper heartbeats are fresh on the operations page, and someone is actually watching the alerts.
- [ ] **Bounded health recovery is active.** On the Oracle path, both `lpr-health-recovery.timer` and `lpr-backup.timer` are enabled and active; PostgreSQL remains monitor-only.
- [ ] **A fresh client-side encrypted off-VM backup exists.** Its repository-file SHA-256 matches the approved destination, and the live provider/account has an enforced no-billable-overage control (not merely an alert); current `$0` cost/quota and residency have been checked, and the Restic password also exists in an independent secure location.
- [ ] **The restore drill has been executed against the off-site snapshot**, not merely read. `restore-drill.md`.
- [ ] On the Oracle path, `infrastructure/oracle/participant-readiness.sh` exits 0 and its output is attached to the launch record.
- [ ] Someone specific is named as on call, and knows `docs/runbooks/` exists.

## 6. A dry run with a real device

Not optional, and not replaceable by tests.

- [ ] Enroll a test participant by the same route real participants will use — QR code or enrollment link, on a phone.
- [ ] Install the PWA, grant notifications, receive one.
- [ ] Complete a session. Confirm the response appears in the inspector with status `ANSWERED`.
- [ ] Let one session expire deliberately. Confirm it shows as expired rather than missing, and that compliance counts it in the denominator.
- [ ] Download `long.csv` and `codebook.csv` and open them in whatever the researcher actually uses. Confirm the Turkish characters are intact and that empty cells carry a status column.
- [ ] Withdraw the test participant. Confirm no further notification arrives.

## 7. Finally

- [ ] Remove the test participants, or record clearly that they exist and must be excluded. A test enrollment counted as a real one contaminates the study's N from the first day.
- [ ] Record the launch date and the exact protocol version in the study's operational log.
