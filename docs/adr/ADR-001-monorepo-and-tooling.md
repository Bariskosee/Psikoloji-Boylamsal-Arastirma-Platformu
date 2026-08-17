# ADR-001 — Monorepo Structure and Tooling

**Status:** Accepted
**Date:** 2026-08-17

## Context

The platform has four deployable units — a participant PWA, a researcher dashboard, an API, and a background worker — that share a substantial amount of logic: validation schemas, question-type definitions, protocol timing rules, compliance formulas, and export shaping.

That shared logic is exactly the logic that must not drift. If the server and the client disagree about what a Likert answer looks like, or if the dashboard and the export disagree about what "missing" means, the result is corrupted research data rather than a visible crash.

## Decision

A single repository using **pnpm workspaces with Turborepo**.

```text
apps/       participant, researcher, api, worker
packages/   domain, contracts, db, i18n, ui, config
```

**Dependency direction is one-way and enforced by an ESLint import-boundary rule in CI:**

```text
apps/participant ─┐
apps/researcher  ─┼──▶ contracts ──▶ (nothing)
                  └──▶ i18n, ui

apps/api    ─┬──▶ domain ──▶ contracts
apps/worker ─┘└──▶ db     ──▶ contracts
```

`packages/domain` is the load-bearing package. It contains pure functions only: no database, no framework, no I/O, and no clock access. Timing, state transitions, compliance, missingness, and export shaping all live there, which makes the highest-risk logic exhaustively testable in milliseconds without a database or time travel.

## Alternatives considered

**Separate repositories per deployable.** Rejected. Shared contracts would have to be published as versioned packages, which introduces a release cycle between changing a question type and using it. In a two-to-four person project this is pure overhead, and version skew between repositories is precisely the drift we are trying to prevent.

**Monorepo without a task runner (plain pnpm scripts).** Rejected. Turborepo's content-hash caching keeps CI fast enough that the full unit and integration suite can run on every push, which the testing strategy depends on.

**Nx.** Rejected. More capable than Turborepo, and correspondingly more configuration surface. Nothing in this project needs its generators or its dependency-graph tooling.

**A `utils` or `shared` catch-all package.** Rejected explicitly. A package without a boundary becomes a dumping ground and eventually creates the circular dependencies the boundary rule exists to prevent. Every package here has a stated single responsibility.

## Consequences

- One `pnpm install`, one lint configuration, one test runner, one CI pipeline.
- A change to a question type updates the server validator, both client forms, and the export shaper in a single commit, and CI fails if any of them disagrees.
- The boundary lint rule must be configured in Phase 0 and must be part of CI from the first commit, otherwise violations accumulate faster than they can be removed.
- Frontends cannot import `packages/db`, so a database credential can never reach a browser bundle by accident.
- Developers must understand workspace tooling. This is a mild onboarding cost, accepted.
