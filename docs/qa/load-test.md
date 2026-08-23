# Load test — results

PLAN.md Phase 12: *"load test at 500 concurrent participants covering simultaneous autosave, a reminder burst, dashboard queries, and concurrent exports; add indexes where measured."*

Run it with:

```bash
pnpm --filter=@lpr/api test:load                       # 500 participants
LOAD_PARTICIPANTS=25 pnpm --filter=@lpr/api test:load  # a quick check of the harness
```

Never in CI. It is a throughput measurement, not an assertion about behaviour, and a timing threshold on a shared runner is a flaky test with extra steps.

---

## What the numbers do and do not mean

**Read this before quoting anything below.**

The test drives the real Nest application against a real PostgreSQL, in one process, over loopback. Everything the *server* does is real: guards, validation, transactions, every query, every index. What is absent is the network, TLS, the load balancer, and the fact that production runs more than one process on hardware that is not a laptop.

So these are a **lower bound on server-side work**, not a production figure. PLAN.md's acceptance criterion — 95th-percentile answer writes under 300 ms — **cannot honestly be signed off from here**, and is not claimed to be. What the run does measure faithfully is the shape of the work per request, which is what "add indexes where measured" needs: a query that scans a table scans it in-process too.

## Run of 2026-08-23

500 participants, 50 requests in flight, PostgreSQL 16 in Docker on a developer machine.

| Operation | n | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| Enrollment | 500 | 78.5 ms | 118.3 ms | 170.5 ms | 175.0 ms |
| Autosave, 10 answers | 1500 | 183.5 ms | 201.8 ms | 209.5 ms | 234.2 ms |
| Autosave, during dashboard reads | 500 | 92.5 ms | 101.6 ms | 109.8 ms | 114.6 ms |
| Dashboard, during the write storm | 40 | 6.6 ms | 58.7 ms | 99.1 ms | 99.1 ms |
| Export, 3 concurrent | 3 | 163.4 ms | 164.1 ms | 164.1 ms | 164.1 ms |

Autosave writes ten answers per request, which is a realistic ESM page rather than the single-question case a test fixture would use; the per-answer cost is roughly 18 ms.

Dashboard queries stayed responsive while five hundred participants wrote — p95 of 59 ms against a p95 of 102 ms for the writes happening at the same time. That is the number that matters for "can a researcher watch a study during a reminder wave", and contention is not visible at this scale.

## Indexes

**Nothing to add, and the evidence is weaker than it looks.**

Statistics were reset immediately before an isolated run. Across the whole 500-participant run, `pg_stat_user_tables` recorded **no sequential scan reading more than a thousand rows** in either schema.

That rules out a hot-path query with no usable index. It does **not** rule out an index that only matters at scale: 500 participants with one session each is a small dataset, and PostgreSQL correctly prefers a sequential scan on a small table whatever indexes exist. An index deficiency that appears at fifty thousand sessions would be invisible here.

**What would actually settle it:** re-run against a database seeded to the size of a finished study — the reference protocol is 36 days of daily blocks, so a 200-participant study is on the order of tens of thousands of sessions and hundreds of thousands of responses — and re-read the same statistics. That belongs to Phase 13's pilot, against real data volume, and is recorded here as outstanding rather than done.

## Not covered

- **The reminder burst.** PLAN.md lists it. The send path is at-most-once and is exercised by the worker's integration tests; driving a realistic burst needs the worker and a push endpoint to answer, and a fake endpoint would measure the fake. Outstanding.
- **Anything about the network.** See the first section.
- **Multi-process behaviour.** Connection-pool exhaustion and cross-process lock contention are the two things a single in-process run is structurally unable to show.
