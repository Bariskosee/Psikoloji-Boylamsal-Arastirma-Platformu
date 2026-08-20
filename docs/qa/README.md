# QA evidence

Screenshots, snapshots, and logs captured while driving a running system by hand.

CI proves the code compiles and the suites pass. It cannot tell you that a probe answers 401
to every caller, that a link leads somewhere a role cannot go, or that a page scrolls sideways
on a phone — those are only visible by starting the stack and using it. This directory is
where that evidence is kept, so a finding can be re-read later without re-running the session.

Each session lives in `evidence/<phase-or-topic>-<date>/`, with `screenshots/`, `snapshots/`
(accessibility trees), and `logs/` (console and network output).

Scratch output from the Playwright MCP server lands in `.playwright-mcp/` at the repository
root and is gitignored. Anything worth keeping is copied in here deliberately.

---

## evidence/phase-3-system-audit-2026-08-20

The first end-to-end run of the system: researcher authentication, studies, members, and the
questionnaire builder, in both locales, at desktop and phone widths.

**Every defect below has since been fixed.** The evidence is kept because it is the clearest
statement of what each bug looked like from the outside, and because these are the screens to
re-check when the surrounding code changes.

| Evidence | What it showed | Status |
|---|---|---|
| `logs/qa-health-ready-network.txt` | `GET /ready` returning `401 Unauthorized` — the probes sat behind the global auth guard, so no orchestrator could ever mark the API ready | fixed |
| `screenshots/qa-viewer-questionnaires-dead-end.png` | A VIEWER reaching an error banner and a spinner at the same time, permanently, from a link that was never gated by role | fixed |
| `screenshots/qa-studies-tr-raw-enums.png` | Turkish column headers filled with `DRAFT`, `CLOSED`, `OWNER` — the database values rendered straight through | fixed |
| `screenshots/qa-anonymous-new-study-form.png` | The whole "New study" form served to a signed-out visitor, because the page fetches nothing on mount and auth was enforced only via a 401 on first fetch | fixed |
| `screenshots/qa-members-mobile-overflow-390.png` | The members table pushing its last column past a 390px viewport and scrolling the entire page sideways | fixed |
| `screenshots/qa-builder-mobile-overflow-320.png` | The builder at 320px, where a `minmax(340px, …)` grid track could not collapse | fixed |
| `screenshots/qa-split-host-csrf-failure.png`, `qa-split-host-login.png` | CSRF and CORS refusing requests after the API was moved to a non-default port without updating `RESEARCHER_ORIGIN` / `PARTICIPANT_ORIGIN` / `NEXT_PUBLIC_API_URL` | not a defect — the guards working as designed |
| `logs/qa-builder-publish-console.log` | A `409` on publish | not a defect — the server's typed refusal for a draft that is not publishable yet |
| `snapshots/qa-builder-initial-snapshot.md` | The builder's accessibility tree with an empty draft: the five question types, the disabled publish button, and the participant preview's locale selector | reference |
| `screenshots/qa-studies-list-en.png`, `qa-study-owner-detail.png`, `qa-questionnaire-builder-desktop.png`, `qa-baseline-login-en.png`, `qa-participant-en.png`, `qa-participant-tr.png` | Baseline appearance of each screen | reference |
