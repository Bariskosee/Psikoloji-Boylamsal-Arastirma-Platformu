# Contributing

## Prerequisites

- **Node.js 22 LTS** (pinned in `package.json` → `engines`)
- **pnpm 11** — via corepack, see below
- **Docker** — for local PostgreSQL only; applications run natively

### Getting pnpm

pnpm is managed by corepack, which ships with Node. If `corepack enable pnpm` fails
with a permissions error on `/usr/local/bin`, install the shim into your own bin
directory instead:

```bash
corepack enable --install-directory ~/.local/bin pnpm
export PATH="$HOME/.local/bin:$PATH"     # add to ~/.zshrc to persist
```

Alternatively, run pnpm through corepack without installing a shim:
`corepack pnpm <command>`.

## First-time setup

```bash
cp .env.example .env        # placeholders are fine for local work
pnpm install
pnpm db:up                  # starts PostgreSQL 16 in Docker
pnpm build
pnpm test
```

## Everyday commands

| Command | Does |
|---|---|
| `pnpm dev` | Runs every app in watch mode |
| `pnpm build` | Builds all packages and apps |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | Integration tests (needs PostgreSQL running) |
| `pnpm lint` | ESLint, including the architectural boundary rules |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm format` | Prettier |
| `pnpm db:up` / `db:down` | Start / stop local PostgreSQL |

Ports: participant `3000`, API `3001`, researcher `3002`, PostgreSQL `5432`.

## Before you write code

Read `AGENT.md` in full. It is the engineering contract, and it applies to human
and AI contributors alike. Then read the phase you are working in, in `PLAN.md` —
each phase has an explicit **"what NOT to build yet"** list, and it is binding.

Decisions that look arbitrary usually are not: check `docs/adr/` before changing
the stack, the job system, the versioning model, or the deployment target.

## Architectural boundaries are enforced, not suggested

`pnpm lint` fails on any violation of the one-way dependency direction in
`STRUCTURE.md` §3:

- frontends must not import `@lpr/db` or `@lpr/domain`
- `packages/domain` may import `@lpr/contracts` and nothing else
- `packages/domain` must not read the wall clock — accept an injected `Clock`
- `packages/contracts` must not import any workspace package
- `apps/api` and `apps/worker` must not import each other

If a rule blocks something you believe is legitimate, that is a design
conversation and an ADR — not a lint-rule edit.

## Two things that will bite you

**NestJS injection needs value imports.** Never convert an injected class to
`import type`. `emitDecoratorMetadata` needs the class at runtime, and a
type-only import erases it, producing a confusing "Nest can't resolve
dependencies" error at startup. `consistent-type-imports` is disabled under
`apps/api` and `apps/worker` for exactly this reason.

**The worker must run always-on.** It hosts the reconciliation sweepers that
guarantee scheduling correctness (ADR-005). On any host that spins services down
when idle, scheduling silently stops with no error anywhere. If scheduling ever
looks wrong, check the worker and `system_heartbeats` first.

## Research data rules

These are not style preferences — violating them corrupts research data:

- A missing response is never `0`, never `NA`, never an empty string standing in
  for a value. See `docs/export-codebook.md`.
- This data is **pseudonymous, never anonymous**. Do not describe it otherwise
  in code, comments, interface strings, or documentation.
- Never commit real questionnaire instruments. Test fixtures use neutral
  placeholders (`Sample question 1`).
- Never commit secrets. `.env.example` holds placeholders; CI scans for leaks.

## Commits

Keep changes within one phase. A pull request that spans phases cannot be
reviewed against that phase's acceptance criteria, which is the point of the
phase boundary.
