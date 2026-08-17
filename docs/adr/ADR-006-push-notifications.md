# ADR-006 — Push Notification Transport

**Status:** Accepted
**Date:** 2026-08-17

## Context

Reminders are a first-class requirement, not a convenience feature: missed sessions directly reduce the quality of longitudinal data. Earlier documentation proposed "Web Push or Firebase Cloud Messaging where appropriate" without deciding.

The participant application is a PWA targeting Android browsers and iOS 16.4+ Home Screen installations.

## Decision

**Standard Web Push with VAPID, sent via the `web-push` library. No Firebase, no third-party notification provider.**

## Rationale

**The standard already covers the target platforms.** The W3C Push API with VAPID is natively supported by Chrome, Edge, and Firefox on Android and desktop, and by Safari 16.4+ on iOS for Home-Screen-installed PWAs. That is exactly the FR-15 target.

**Firebase adds a data processor for no capability.** FCM's web offering is a wrapper over the same standard. Adopting it would introduce a Google dependency, a service-account key to protect, and a data-processor relationship to declare in the ethics submission — while providing nothing the standard does not.

**Push endpoints are re-identifying data.** Sending directly with VAPID keeps them inside our `identity` schema, under our access controls and our backup policy, rather than in a third party's system.

## Alternatives considered

**Firebase Cloud Messaging.** Rejected: third-party processor, an extra secret to manage, no added capability for PWA push.

**OneSignal or a similar notification platform.** Rejected more firmly: these hold participant endpoints and engagement data on the vendor's infrastructure. Unacceptable for this data class.

**Native mobile applications for reliable push.** Out of MVP scope. Reconsidered only if pilot evidence (Phase 13) shows PWA push limitations materially affect compliance.

**Email or SMS as the primary channel.** Rejected for MVP: both require collecting contact details from every participant, increasing the re-identification surface for a population where minimal data collection is the goal. Email fallback is the designated post-MVP remedy if push receipt proves inadequate.

## Consequences

**Delivery cannot be guaranteed, and the system must never claim otherwise.** The strongest observable server-side signal is that a push service *accepted* the message — not that it was delivered, displayed, or seen. `STRUCTURE.md` §9.3 records exactly which events are reliable, which are best-effort, and which are unobservable. No interface string, metric, or export column may imply guaranteed delivery.

**iOS carries specific constraints** that shape Phase 8: Safari 16.4+ required; the application must be installed to the Home Screen; permission must be requested from a user gesture inside the installed application; and the installed application may not inherit the browser's stored credentials — which is why ADR-007 specifies an install handoff.

**The VAPID private key is a secret** that never reaches the client and is never committed.

**Subscriptions expire and must be cleaned up.** A 404 or 410 response marks the subscription inactive immediately and stops that reminder chain; a daily pruning job removes long-dead rows.

**Push payloads carry no research content.** Titles and bodies are generic, localised, configurable strings. Payloads pass through third-party push services, so question text and answers must never appear in them.

**The product must work without push.** A participant with notifications denied can still open the study URL, see their status, and complete every available session. Push improves compliance; it is not a prerequisite for participation.
