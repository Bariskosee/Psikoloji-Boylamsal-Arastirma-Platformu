# Runbook — a participant lost their device

**Goal:** get one participant back into their existing enrollment, without creating a duplicate and without handing their data to the wrong person.

**Why this needs a procedure.** Participants are pseudonymous by design: the platform holds no email, no phone number, no name (FR-08, AGENT.md §5). That is a privacy property worth having, and its direct cost is that **there is no automated way to prove who somebody is**. Every relink is a human judgement, and the failure mode is not inconvenience — it is giving one participant access to another's psychological responses.

---

## 1. Try the self-service paths first, in this order

1. **Recovery code.** If they still have it: `/recover` in the participant app. No researcher involvement, no judgement call. Always ask for this first.
2. **Install handoff.** If the old device still works and the problem is moving to a new one, the handoff code transfers continuity directly (ADR-007). Single use, 24-hour expiry.

Neither available → §2.

## 2. Establish identity — before touching anything

The participant knows their **public code** if they were shown it, but a public code is an identifier, **not a secret**. It is printed on recruitment material and visible to research staff. It is not on its own sufficient.

Require the public code **plus** at least two facts an impostor would not have:

- The approximate enrollment date.
- The device and browser previously used.
- Details of the study procedure as *they* experienced it — how many sessions so far, roughly when in the day they were prompted.

**Do not** use answers to questionnaire items as identity checks. Those are the data being protected, and reading them out to establish identity discloses them to whoever is on the line.

If it does not add up, **stop**. A participant who has genuinely lost everything can be re-enrolled as a new participant (§4). Nobody is harmed by that; a wrong relink is unrecoverable.

## 3. Relink

There is no self-service path once the recovery code is gone, and this is intentional: an automated one would be an account-takeover mechanism against a population that cannot defend itself with a password.

1. Confirm the participant exists and is `ACTIVE`:

   ```sql
   SELECT id, public_code, status, enrolled_at, timezone
     FROM research.participants
    WHERE public_code = :public_code AND study_id = :study_id;
   ```

2. Issue a fresh recovery code through the researcher interface for that participant. **Never** read the existing credential out of the database — credentials are stored hashed, and anything that made them readable would be a defect.
3. Deliver it over the channel the recruitment protocol specifies, not over whatever channel they contacted you on.
4. Record an audit event: who authorised it, what identity evidence was accepted, when. The audit trail carries the justification and **not** the code.

## 4. If identity cannot be established

Enroll them as a **new** participant. Say plainly what this means:

- Their previous responses remain in the study, attached to the old pseudonymous participant, and are not deleted.
- Their new enrollment starts the protocol from the beginning.
- The two cannot be linked later. If the researcher wants them linked for analysis, that is a decision they must record now, in the study's operational log, with the reasoning — not something to reconstruct afterwards.

**Never** merge participant rows by hand to "join them up". Longitudinal identity is the study's core claim; a merge based on a phone call is a fabricated linkage.

## 5. If the old device may be in someone else's hands

Withdrawal is not the right tool — it ends participation. Instead, issue the new recovery code (§3), which rotates continuity and invalidates the credentials the lost device holds. Confirm afterwards:

```sql
SELECT count(*) FROM identity.push_subscriptions
 WHERE participant_id = :id AND is_active;
```

Anything the old device still held should no longer be active.

## 6. Related

- `docs/adr/ADR-007-participant-continuity.md` — recovery codes, handoff, and rotation.
- `data-erasure.md` — if they want their data removed rather than restored.
