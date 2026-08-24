# ADR-010 — Deployment Platform

> **Amended by [ADR-012](ADR-012-self-hosted-deployment.md) (2026-08-24).** The research
> team has no hosting budget, and no free tier of any managed platform can run the
> always-on worker this ADR identifies as its most important operational fact. The
> platform now deploys with Docker Compose on a single always-free VM. Everything
> below still holds for a funded deployment, and the blueprints remain in the tree.

**Status:** Accepted
**Date:** 2026-08-17

## Context

The platform needs four running services (two Next.js applications, an API, and a background worker) plus managed PostgreSQL. It processes sensitive psychological research data belonging to identifiable-in-principle individuals, so hosting location must be defensible to an ethics committee.

Two requirements narrow the field sharply:

- **An always-on background worker.** ADR-005 makes reconciliation sweepers the correctness guarantee for all scheduling. A platform that only offers request-scoped compute or scheduled cron cannot host this.
- **A single, simple data-residency answer.** "All participant data resides in one EU datacentre" is one sentence in an ethics submission. A multi-region or multi-provider arrangement requires documenting transfers.

## Decision

**Render, Frankfurt (EU Central).** All four services and the database in one region.

```text
research.example.org  → researcher   Next.js service
app.example.org       → participant  Next.js service
api.example.org       → api          always-on web service
                        worker       always-on background worker
                        postgres     managed, PITR, daily backup
```

Infrastructure is declared in `render.yaml`. Migrations run as a pre-deploy command.

## Rationale

Render provides managed PostgreSQL with point-in-time recovery, **first-class always-on background workers** rather than cron-only compute, a Frankfurt region, automatic HTTPS, infrastructure-as-code, and pre-deploy hooks. Keeping everything with one provider in one region gives the simplest possible residency answer and one backup and access-control story.

No Redis is required (ADR-004), which removes an entire managed service from the deployment.

## Alternatives considered

**Railway.** Equivalent capability, EU region available, slightly simpler interface. A fine substitute and the recommended fallback if Render proves unsuitable. Chosen against only on the maturity of managed PostgreSQL backups.

**Fly.io.** Best regional control and attractive pricing, but PostgreSQL is self-managed unless using their managed offering, adding operational burden — backups, failover, upgrades — that a small research team should not carry.

**Vercel for everything.** Excellent for the two Next.js applications, but **cannot host an always-on worker**, which is disqualifying. A hybrid (frontends on Vercel, stateful services on Render) is workable and was seriously considered; rejected because two providers means two dashboards, two billing relationships, and a residency answer that needs a paragraph instead of a sentence.

**AWS or GCP.** Unjustifiable complexity for several hundred participants. Would consume implementation time that belongs in the scheduling engine.

**Self-hosted VPS or university infrastructure.** Required only if data must remain in Türkiye or on institutional hardware. In that case the application is unchanged — only `infrastructure/` changes, to a provider-neutral Docker Compose deployment with the institution supplying TLS, public DNS, and backups. This is flagged as an open question for the ethics committee in `REQUIREMENTS.md` §10.

## Consequences

- **The worker must run on a paid always-on instance.** A free tier that spins down when idle stops the sweepers and silently disables all scheduling. This is the single most important operational fact about this deployment and belongs in the runbook.
- Public HTTPS on real domains is required before Phase 8, since Web Push does not work otherwise. Checked at readiness gate G9.
- Environments: `local` (Docker Compose, PostgreSQL only), `test` (ephemeral Testcontainers in CI), `staging` (full mirror, seeded, with accelerated protocol timings so multi-day flows validate in minutes), `production`.
- Migrations are always backward-compatible with the previous release, so a rollback never strands the schema.
- Provider lock-in is deliberately limited to `render.yaml`. No provider-specific API appears in application code, so moving to Railway, Fly.io, or self-hosted containers is an infrastructure change only.
- Monitoring baseline: Sentry on all four services, heartbeat alerting if sweepers go stale beyond five minutes, and an admin operations page for dead-lettered jobs and push failure rates.
- A restore drill is scheduled and documented. An untested backup is not a backup.
