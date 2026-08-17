# ADR-009 — Two Frontend Applications on Separate Origins

**Status:** Accepted
**Date:** 2026-08-17

## Context

The platform serves two audiences with almost nothing in common:

- **Participants** — public entry, credential-cookie authentication, mobile phones on cellular networks, a service worker for push, and a strong interest in the smallest possible bundle.
- **Researchers** — authenticated, session-cookie authentication, desktop browsers, dense tables and charts, and no bundle-size pressure.

Earlier documentation suggested a single `apps/web` containing both.

## Decision

**Two Next.js 15 applications on two origins.**

```text
app.example.org       apps/participant   public, credential auth, service worker
research.example.org  apps/researcher    authenticated, session auth, dashboard
```

Shared code lives in `packages/ui`, `packages/i18n`, and `packages/contracts`.

## Rationale

**Service worker scope is origin-wide, and this is the decisive argument.** A service worker registered at the root of a combined application would sit in front of *every* route on that origin, including authenticated researcher pages. That means participant-oriented caching and fetch interception applied to pages displaying participant-level response data — a correctness and privacy hazard, and a notoriously difficult bug class to reason about. Scoping the worker to a subpath is possible but fragile, and one misconfigured registration re-creates the problem silently.

**The public/authenticated boundary becomes structural rather than conventional.** In a combined application, dashboard components, charting libraries, and researcher authentication logic are all present in the build served to anonymous visitors, kept apart only by routing discipline. Two applications make it impossible for researcher code to reach the public bundle.

**Bundle size matters asymmetrically.** Participants open the application repeatedly, often on cellular, sometimes daily for weeks. Every kilobyte of charting library they never use is a real cost to compliance. Researchers open a dashboard on a desktop and do not care.

**Independent deploy cadence.** A dashboard fix should not risk the participant runtime during an active data-collection window.

## Alternatives considered

**One Next.js application with route groups.** Fewer deployments, less duplicated layout code, one build. Rejected on the service-worker scope problem and the softened security boundary. The duplication it avoids is bounded and already addressed by shared packages.

**Different frameworks for each application** — for example a lighter framework for the participant PWA. Rejected: two frontend toolchains for marginal bundle savings, forfeiting shared components and shared i18n.

**Participant application as a static SPA.** Rejected: the enrollment and consent landing benefits from server rendering for fast first paint on mobile networks and for correct locale on first render.

## Consequences

- Two deploy targets and two sets of environment configuration.
- Some layout and styling duplication, bounded by `packages/ui`.
- Cross-origin API calls require correct CORS configuration and cookies scoped per origin. Credential cookies are set on the participant origin; researcher session cookies on the researcher origin. Neither is visible to the other, which is a benefit rather than a cost.
- Two domains or subdomains must exist before Phase 8, since Web Push requires HTTPS on a real origin. This is checked at the readiness gate (G9).
- End-to-end tests spanning both applications must drive two origins in one Playwright scenario. Supported, but the test setup must account for it.
