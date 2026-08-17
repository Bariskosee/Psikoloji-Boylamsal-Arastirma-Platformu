# ADR-002 — Backend Framework

**Status:** Accepted
**Date:** 2026-08-17

## Context

Earlier project documentation proposed "FastAPI or NestJS" without deciding. The choice determines the language of the worker, the ORM options, how API contracts reach the frontends, and how testable the scheduling logic is.

The requirements that bear on this decision:

- ten distinct domains that must not bleed into each other;
- a background worker running multi-day schedules, which must share domain logic with the API rather than reimplement it;
- multi-day scheduling behaviour that has to be tested deterministically, which requires injecting a clock;
- shared question-type and export definitions between server and two browser clients.

## Decision

**NestJS 11 on Node.js 22 LTS, TypeScript, structured as a modular monolith.**

The worker is the **same codebase**, bootstrapped as a NestJS standalone application context and deployed as a separate always-on process. It imports the same modules and the same domain services as the API.

## Why NestJS specifically

**Module boundaries survive agent-driven development.** The requirements name ten domains. NestJS modules make each one an explicit unit with declared imports and providers. In a plain Express or Fastify application these boundaries are conventions that erode; here a violation is a compile error.

**Dependency injection is what makes the risky logic testable.** `ClockService`, `PushTransport`, and `JobScheduler` are injected interfaces. A test of a 30-day protocol with seven daily occurrences and two daylight-saving transitions runs in milliseconds with a fake clock and a fake push transport. Without DI, that test either does not exist or depends on real time.

**One language end to end.** The Zod schemas in `packages/contracts` are the same objects used for NestJS request validation and for form validation in both frontends. A question-type definition or an export column cannot drift between server and client, because there is only one definition.

## Alternatives considered

**FastAPI with Python.** A strong framework with excellent validation, and Celery is the most battle-tested delayed-job system in this space. Rejected on integration cost: two toolchains, two CI configurations, and an OpenAPI-generated TypeScript client that is a genuine drift vector for exactly the types where drift corrupts data. The usual Python advantage — analysis tooling near the data — does not apply, because statistical analysis is explicitly out of scope; researchers export CSV and analyse in R or SPSS.

**Next.js route handlers only, no separate API.** Cheapest to start. Rejected for two reasons: multi-day background work does not fit request-scoped serverless execution, and a service worker registered at the origin root would intercept authenticated dashboard routes. See ADR-009.

**Bare Express or Fastify.** Saves boilerplate. Rejected because it forfeits the module boundaries and DI-based testability that motivated the choice.

## Consequences

- More boilerplate than FastAPI. Accepted as the price of enforced boundaries.
- The worker and API cannot drift, because they are one codebase.
- `packages/domain` must remain framework-free, so its logic stays portable and instantly testable. This is enforced by the boundary lint rule from ADR-001.
- Node.js 22 LTS is pinned; the runtime version is part of the deployment configuration.
- Every service that touches time must take an injected clock. Direct wall-clock access inside `packages/domain` is a lint error.
