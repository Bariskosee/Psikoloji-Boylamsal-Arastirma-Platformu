# ADR-012 — Self-hosted single-VM deployment

**Status:** Accepted — 2026-08-24. Amends ADR-010; does not replace it.

## Context

ADR-010 chose managed hosting on Render: four services and a managed PostgreSQL
with point-in-time recovery, in one EU region. It is still the right answer for
a funded deployment, and the blueprints for it remain in `infrastructure/`.

The research team running this platform has no hosting budget. That is not a
temporary inconvenience to design around later — it decides where the software
can run at all, and therefore whether the study happens.

The binding constraint is ADR-005. The reconciliation sweepers are the
scheduling correctness guarantee: they ask the database what is true rather
than what a queue remembers, and they must run continuously. ADR-010 calls a
hosting tier that idles the process out "the single most important operational
fact about this deployment" — the sweepers stop, sessions never open, reminders
never fire, and **nothing reports an error**.

No free tier of any managed platform provides an always-on process. Render's
free web services spin down after fifteen minutes idle; its background workers
are not offered free at all. That is the whole difficulty.

## Decision

Run the entire platform with Docker Compose on a single always-free virtual
machine, with Caddy terminating TLS and PostgreSQL in a container alongside the
application.

The target is Oracle Cloud's Always Free Ampere A1 allowance, in an EU region
close to Türkiye. Nothing in the deployment is specific to Oracle: it is a
Linux VM with Docker, and `infrastructure/compose/` would run unchanged on any
other.

Concretely, `infrastructure/compose/` holds a `docker-compose.yml` for six
services, two Dockerfiles, a Caddyfile, a first-run SQL script that creates the
two group roles, and a nightly backup script.

## Why this rather than the alternatives

**A free managed platform with an externally-triggered sweep.** The sweep loop
would become an authenticated HTTP endpoint called by a free scheduler, so no
process needs to stay up. This was designed and partly built before being
rejected. It adds a second mode to the most correctness-critical subsystem in
the platform, and exposes an endpoint whose effect is sending notifications to
participants' phones — real risk taken on purely to fit a hosting constraint.
It also spreads participant data across three or more vendors' free tiers, each
with its own terms, which makes the single data-residency sentence ADR-010
wanted for the ethics committee much harder to write honestly. And no free
managed PostgreSQL offers point-in-time recovery, which NFR-18 requires.

**Azure for Students.** Considered, and briefly chosen. Rejected because the
$100 credit expires: a longitudinal study runs for weeks, and a credit that
runs out mid-study stops the VM — which is precisely the silent scheduling
death this ADR exists to avoid. A deployment whose funding has an expiry date
needs a calendar reminder to be part of the architecture, and "always free" is
a better property than "free for now".

**Render's free tier for everything.** The worker cannot run, and two free web
services cannot both stay awake inside one workspace's monthly instance-hour
allowance.

## Consequences

**The always-on requirement is satisfied natively, not worked around.** The
worker runs as a normal container with `restart: unless-stopped`. ADR-005 is
untouched, ADR-009's separate origins are preserved by three hostnames on one
proxy, and ADR-003's two-schema privilege split works better here than on a
managed provider — we own the superuser, so the two NOLOGIN group roles are
created automatically on first run rather than by hand.

**The operator inherits what a provider used to do.** Patching, TLS renewal
(automated by Caddy, but its failure is now ours), uptime, and above all
backups. `infrastructure/compose/backup.sh` takes a nightly dump with the
roles — the restore drill found that `pg_dump` omits them, so a naive restore
silently loses the analytics boundary while every row arrives intact.

**NFR-18 is only partly met.** A nightly logical dump is not point-in-time
recovery: up to twenty-four hours of responses would be lost. If the ethics
approval requires tighter recovery, WAL archiving to off-site storage has to be
added. This is recorded as an open item rather than presented as satisfied.

**One machine is one point of failure.** There is no failover. For a pilot and
a first study this is an acceptable and honest trade; for a platform several
studies depend on, it is not.

**The images are ARM64.** Ampere A1 is aarch64. Every base image used is
multi-architecture, and the runbook builds on the VM itself, so this is
invisible in practice — but an image built on an x86 laptop and pushed will not
run.

**Both deployments stay in the tree.** `infrastructure/render.yaml` and
`render.staging.yaml` remain the managed path, and `blueprints.test.ts` still
keeps them honest. Moving to managed hosting later is a deployment change, not
an application change, which is the property ADR-010 was protecting.
