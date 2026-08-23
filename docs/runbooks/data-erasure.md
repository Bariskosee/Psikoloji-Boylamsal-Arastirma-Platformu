# Runbook — data retention and erasure

**Applies to:** a participant asks for their data to be deleted, or a study reaches the end of its retention period.

**Read this first: withdrawal is not erasure.** They are different requests with different outcomes, and conflating them either destroys research data that was lawfully given or fails to honour a deletion request. Establish which one is being asked for before doing anything.

| | Withdrawal (FR-30) | Erasure |
|---|---|---|
| What the participant is asking | "Stop asking me things." | "Remove what I already gave you." |
| Implemented | **Yes** — `POST /participants/withdraw`, self-service | **No automated path.** Manual, §3. |
| Effect on future sessions | Cancelled | Cancelled |
| Effect on credentials | All revoked | All revoked |
| Effect on push subscriptions | All deactivated, same transaction | Deleted |
| Effect on answers already given | **Kept.** They are data the participant gave. | Removed or irreversibly de-identified |

Most requests phrased as "delete my account" are withdrawal. Ask.

---

## 1. Withdrawal — the ordinary case

The participant does it themselves in the app. One transaction sets `WITHDRAWN`, revokes every credential across every device, cancels non-terminal sessions, and deactivates every push subscription — atomically, so no state exists in which a withdrawn participant can still be reminded.

No runbook needed. Verify if asked:

```sql
SELECT status, withdrawn_at FROM research.participants WHERE id = :id;
SELECT count(*) FROM identity.push_subscriptions WHERE participant_id = :id AND is_active;  -- 0
SELECT status, count(*) FROM research.participant_sessions WHERE participant_id = :id GROUP BY status;
```

Terminal sessions — completed, expired — are deliberately untouched.

## 2. Before erasing anything

Erasure destroys research data. It is irreversible, it changes the study's denominators, and it can invalidate an analysis already under way. It requires, in writing, **before** execution:

1. **The request itself,** recorded — what was asked, by whom, when, and how identity was established (`participant-relink.md` §2; the same standard applies, because erasing the wrong participant is the same failure).
2. **The researcher's and the ethics committee's position.** Consent documents and the ethics approval govern what must be erased and what must be retained. Some approvals *require* retention of already-collected data; some jurisdictions override that. This platform cannot resolve that conflict and must not pretend to — the research team decides, and records the decision.
3. **A backup taken immediately beforehand,** retained for the period the ethics protocol specifies. Note that this means the data still exists in backups; if the request requires backup erasure too, that is a separate, provider-specific procedure with its own timeline, and the participant should be told what it is.

**No automated erasure endpoint exists.** This is deliberate. An irreversible destruction of research data behind a button is a defect, not a feature; every erasure passes through a human who has read this page.

## 3. Executing an erasure

Inside **one transaction**, so a half-erased participant cannot exist:

```sql
BEGIN;

-- 1. The answers. Deleting responses cascades to option selections.
DELETE FROM research.responses
 WHERE session_id IN (SELECT id FROM research.participant_sessions WHERE participant_id = :id);

-- 2. The sessions.
DELETE FROM research.participant_sessions WHERE participant_id = :id;

-- 3. Everything in `identity` for this participant: credentials, push
--    subscriptions, handoff codes.
DELETE FROM identity.push_subscriptions WHERE participant_id = :id;
-- …and the continuity credentials, per the identity schema.

-- 4. The participant row itself.
DELETE FROM research.participants WHERE id = :id;

-- Verify inside the transaction, before committing.
COMMIT;
```

**What is NOT erased, and why the participant must be told:**

- **The audit trail.** It records that a participant existed and that an erasure happened. Erasing the record of erasure would make the erasure unprovable, and the audit trail deliberately contains no responses (AGENT.md §5).
- **Exports already downloaded.** A CSV on a researcher's machine is outside this database. Part of executing an erasure is asking the research team, in writing, to destroy their copies — the export audit rows tell you who has one.
- **Aggregate figures already published.** Not recoverable, and generally not personal data. Say so honestly rather than implying otherwise.

## 4. After

- Record completion in the audit trail: what was erased, who authorised it, when.
- Tell the researcher the denominators changed. A study whose N silently drops between two analyses produces two irreconcilable results and no explanation.
- Confirm to the participant what was done **and what was not** (§3). A vaguer answer is not a kinder one.

## 5. End-of-study retention

Retention periods come from the ethics approval, not from this platform, and the platform imposes none of its own. When one expires:

1. Confirm the analysis is complete and the archival copy — if the approval requires one — is held wherever the approval says.
2. Prefer **de-identification** to deletion where the approval allows it: the research value survives and the personal data does not. In this platform that means erasing `identity` entirely while retaining `research` rows keyed only by their pseudonymous ids.
3. Record what was done, by whom, and under which approval.

## 6. Related

- `docs/adr/ADR-003-database-and-data-access.md` — the `research` / `identity` split that makes §5.2 possible.
- `participant-relink.md` — identity verification, at the same standard.
