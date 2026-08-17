# ADR-007 — Participant Identity and Continuity

**Status:** Accepted
**Date:** 2026-08-17

## Context

Participants have no username or password (NFR-09), yet must be recognised across days or weeks so their responses form one longitudinal record (FR-06). Losing continuity does not merely inconvenience a participant — it silently ends their contribution to the study and creates a phantom "new participant" in the data.

One platform behaviour makes this materially harder. On iOS, a Home-Screen-installed PWA can hold a **different storage container** than the Safari tab used to enroll. A participant who enrolls in Safari and then installs the application — exactly the flow required for iOS push — can arrive in the installed application with no credential, appearing as a new person. This happens at the highest-stakes moment in the participant journey.

## Decision

A layered mechanism: a hashed token credential, an explicit install handoff, and a recovery code.

### 1. Credential

- Enrollment mints a 256-bit token from a cryptographically secure source.
- `identity.participant_credentials` stores a SHA-256 hash plus a lookup prefix. **The token itself is never stored.**
- Delivered as an **HttpOnly, Secure, SameSite=Lax** cookie on the participant origin, one-year lifetime.
- The token never appears in a URL, in `localStorage`, in client-readable JavaScript, or in any log.
- **Rotation:** a credential older than 30 days is replaced on use; the previous one stays valid for a 7-day grace period so concurrent requests never fail.

### 2. Install handoff

```text
Safari tab: consent completes
  → server mints a ONE-TIME handoff code
      (128-bit, single-use, 24h TTL, rate-limited)
  → install screen shows Add-to-Home-Screen guidance
      plus a tappable link  https://app…/r/<code>
  → participant installs, opens the PWA, taps the link INSIDE it
  → server redeems the code, mints a credential in the installed
      context, binds it to the SAME participant, invalidates the code
  → records credential_context = 'INSTALLED'
```

The dashboard surfaces participants whose only credential context is `BROWSER` as an at-risk cohort, so a researcher can intervene before the participant is lost.

### 3. Recovery

An 8-character human-readable recovery code is shown exactly once at enrollment, with an instruction to save it. Redemption is rate-limited to 5 attempts per hour per IP and 10 per day per study, and mints a new credential. Where a study collects an email address, it is stored in `identity.participant_contacts` and provides a second recovery path.

### Identifier

`public_code` is `P-` plus six uppercase Crockford base-32 characters, from a CSPRNG, excluding visually ambiguous characters. **Never sequential** — a sequential code leaks enrollment order and total sample size.

## Why a one-time code may appear in a URL when the token may not

The handoff code is single-use, expires in 24 hours, is rate-limited, and grants nothing after redemption. The long-lived credential is none of those things. URLs end up in browser history, in referrer headers, and in server logs, which is survivable for the former and unacceptable for the latter.

## Alternatives considered

**Participant accounts with a password.** Solves continuity completely. Rejected: NFR-09 forbids it, and it adds friction at the exact point where drop-out is highest.

**Magic-link email at every return.** Requires collecting an email from every participant, expanding the re-identification surface, and depends on email deliverability for daily use. Rejected as the primary mechanism; retained as optional recovery.

**Device fingerprinting.** Rejected outright. Unreliable, and covertly identifying participants in a study built on informed consent is indefensible.

**`localStorage` instead of a cookie.** Rejected: readable by any injected script, and subject to more aggressive eviction than an HttpOnly cookie.

**Ignoring the iOS install problem.** Rejected. It is the single most likely cause of silent participant loss in the entire system.

## Consequences

- **This data is pseudonymous, not anonymous.** The credential, push endpoints, and optional contact details make re-identification possible, so it remains personal data under GDPR and KVKK. No document, comment, interface string, or export may describe it as anonymous.
- Clearing browser data without the recovery code loses continuity. This is inherent to a no-account design and must be stated plainly in participant onboarding.
- The handoff flow must be validated on a **real iOS device** in Phase 8. A simulator does not reproduce the storage-container behaviour.
- Enrollment presenting a valid existing credential resumes rather than creating a second enrollment (FR-42).
- Researchers get a documented manual re-link procedure for participants who contact them after losing everything.
