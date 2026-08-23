# Runbook — push notifications are failing

**Alert codes:** `PUSH_FAILURE_RATE`, `PUSH_ATTRITION`
**Severity:** warning

**The distinction this runbook exists to make.** Push subscriptions die constantly and normally — a participant uninstalls, resets their phone, or clears site data, and the push service returns `404`/`410 Gone`. That is attrition, it is expected, and the platform handles it by deactivating the subscription. It is **not** a failure.

A *failure* is different: the platform tried and the transport or the credentials refused. Telling the two apart is the whole job here, because the remedies are opposite — attrition is fixed by asking participants to re-enable notifications, and failure is fixed by fixing the server.

**And the one thing that must never happen:** telling a researcher that a notification was *delivered*. This platform records that a push service **accepted** a message. Nothing downstream of that is observable (ADR-006, FR-33). If someone asks for a delivery rate, the honest answer is that it does not exist.

---

## 1. Which alert fired

### `PUSH_FAILURE_RATE` — attempts are being refused

```sql
SELECT outcome, suppression_reason, count(*)
  FROM research.notification_attempts
 WHERE scheduled_for > now() - interval '24 hours'
 GROUP BY outcome, suppression_reason
 ORDER BY count(*) DESC;
```

`FAILED` rows carry the transport status.

| Status | Meaning | Action |
|---|---|---|
| `401` / `403` | VAPID credentials rejected | §2 — the most damaging case. |
| `404` / `410` | Subscription gone | Not a failure; the platform deactivates these automatically. If they are showing as `FAILED`, that is a bug — file it. |
| `413` | Payload too large | A notification body grew past the push service limit. Shorten it. |
| `429` | Rate-limited by the push service | Usually a burst after an outage. The staleness guard should have prevented it; check `sweeper-stall.md` §4. |
| `5xx` / timeout | The push service itself | Wait. Do not retry manually — at-most-once is deliberate. |

### `PUSH_ATTRITION` — the subscriber base is disappearing

Ordinary attrition is slow. A quarter of subscribers lost in a week is not participants changing their minds simultaneously; it is almost always §2.

```sql
SELECT date_trunc('day', deactivated_at) AS day, count(*)
  FROM identity.push_subscriptions
 WHERE deactivated_at > now() - interval '14 days'
 GROUP BY 1 ORDER BY 1;
```

A **cliff** — one day carrying nearly all of it — means a server-side change. A **slope** is real attrition; go to §3.

## 2. If the VAPID keys were rotated

This is the failure mode with the worst ratio of ease-to-cause against cost-to-repair.

A push subscription is bound to the public key it was created with. Change the key pair and **every existing subscription becomes permanently unusable**. There is no server-side repair: each participant must re-subscribe from their own device, which for an installed PWA on iOS means opening the app and granting permission again.

1. **Confirm it.** Compare `VAPID_PUBLIC_KEY` in the deployed environment against the value the current subscriptions were created with. If they differ, stop and read step 2 before doing anything else.
2. **If you still have the old key pair, restore it.** Every subscription starts working again immediately. This is the only cheap outcome and it is only available before the old keys are lost.
3. If the old pair is gone, the subscriber base must be rebuilt. Do not do this silently: the participants will be asked to re-enable notifications, they are entitled to know why, and the study's operational log needs the date so a compliance dip in that window is not misread as disengagement.

**Prevention:** VAPID keys are long-lived credentials that must survive redeployment. Treat them as study data, not as configuration.

## 3. If it is genuine attrition

Some is unavoidable and the platform is built for it — sessions remain available in the app whether or not a reminder arrives, and compliance is measured on sessions, not on notifications.

Worth checking:

- **Is it one platform?** iOS requires the app to be installed to the Home Screen before push works at all, and a participant who removes it loses the subscription. See STRUCTURE.md §11.4 and `docs/adr/ADR-007-participant-continuity.md`.
- **Is the reminder cadence irritating people into turning it off?** Look at reminder counts per participant per day against the protocol. This is a research-design conversation, not an engineering one — raise it with the researcher.

## 4. What to tell the researcher

Say: *"the push service accepted N of M attempts in the last 24 hours; K subscriptions have lapsed."*

Do not say: *"N notifications were delivered."* We do not know that, we cannot know that, and a delivery figure that gets into a methods section is a claim the platform cannot support.

## 5. Related

- `docs/adr/ADR-006-push-notifications.md` — VAPID, and why delivery is never claimed.
- `docs/adr/ADR-007-participant-continuity.md` — the iOS install requirement.
- `packages/domain/src/notification/guards.ts` — the eight guards, in order.
