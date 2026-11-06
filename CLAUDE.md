# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dsh-superagent` is a DeepSeek Harness (DSH) bundle: a proactive coding agent for one GitHub repository, with a self-hosted GitLab project as an interchangeable second Source and Feishu as an optional chat Source. Sources produce Triggers, a Policy decides whether they authorize work, accepted work becomes a Ticket, and each Ticket runs in its own DSH Session. A React panel is served on loopback.

`README.md` carries the research-prototype disclaimer; `docs/` is the specification and is the authority on behavior. Read `docs/001-domain.md` (concepts), `docs/002-authorization.md` (who may ask), `docs/003-execution.md` (Ticket lifecycle), `docs/004-prompts.md` (what the agents read), `docs/007-architecture.md` (developer guide with file-by-file tables).

## Commands

```sh
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run, all 63 spec files
pnpm build          # tsdown → lib/ (node ESM entries + a browser CJS client)
pnpm check          # all three, in that order
```

Single file / single test:

```sh
npx vitest run tests/gitlab.spec.ts
npx vitest run tests/gitlab.spec.ts -t "does not treat the agent's own notes"
npx vitest run -t "some test name"      # across all files
```

Running the live service (a `superagent` DSH profile in tmux, port 3082):

```sh
scripts/dsh-superagent --profile superagent status    # exit 0 ok, 1 restart may fix, 2 a part errors, 3 setup waits
scripts/dsh-superagent --profile superagent restart
scripts/dsh-superagent --profile superagent --respect-stop restart
```

`lib/` is git-ignored; the running profile loads the checkout through a `link:` dependency, so **code changes need a `pnpm build` and a restart before the service sees them**.

There is no lint step; the tests are the gate.

## Architecture

`Runtime` (`src/app/runtime.ts`) is the composition root: it locks the state dir, opens the SQLite Store, and builds every component, passing itself only behind narrow `Pick`-based host interfaces. `Engine` (`src/core/engine.ts`) is the only writer of Triggers, Threads, Decisions, Tickets and Assignments; all its methods are synchronous and each command is one transaction.

Request flow: **Source → Trigger → Thread → Eval → (accept) Ticket + Mandate → Assignment → Executor Session → Channel reply**.

| Layer | Path | Rule |
| --- | --- | --- |
| Domain core | `src/core/` | Imports nothing outside itself but Node hashing; no I/O. `Intake` / `Evals` / `Tickets` / `Assignments` / `Replies` are parts of `Engine`, depending in that direction only |
| Source plugins | `src/sources/` | Implements `SourceKind` and injects the `orchestrator` service as a `SourceHost`; sees only its own `SourceContext`. Never imports from `src/app` |
| Application | `src/app/` | Runtime, Engine adapters (assessor, executor, sessions, outbox, settings, prompts), HTTP routes, cards, views |
| Executor | `src/executor/` | DSH Session creation and background-job waiting |
| Panel | `src/client/` | React; imports only *types* from the host side plus a few plain-value modules (`src/admission.ts`, `src/limits.ts`, `src/setup.ts`, `src/navigation.ts`, `src/sources/host.ts`, `src/core/errors.ts`, `src/core/reasons.ts`) |
| Infra | `src/infra/` | CLI runners (`gh`/`glab`/`lark-cli`), worker environment, health board, paths |

Other invariants worth knowing before touching state:

- **One writer per state.** The Engine owns domain aggregates; a Source owns only its read cursors and its Thread `meta`; Settings owns settings; Effects owns the effect rows; the Outbox owns receipts; each health entry is claimed by exactly one part (`src/infra/health.ts` refuses a second claim). A Source changes a Ticket only via `SourceContext.tickets.bindThread` / `threadClosed`.
- **Persistence** is one SQLite file, `<stateDir>/orchestrator.sqlite`. Every key is spelled once in `src/kv.ts`. Triggers store `at` as `Date#toISOString` text so times sort as text.
- **Typed refusals.** User-facing errors are `UserError(code, values)` from `USER_ERRORS` (`src/core/errors.ts`); setup problems are `SetupError` codes (`src/setup.ts`); health texts are `HealthCode`s (`src/sources/host.ts`). The panel and locale files word each code; don't inline English strings for these.
- **GitHub and GitLab are deliberately asymmetric.** Setup, worker environment, the change (pull/MR) lifecycle and prompts resolve GitHub as the deployment; GitLab is additive. `docs/009-gitlab-support.md` lists what is still hard-wired to GitHub.
- **The GitLab Source may share the operator's account.** It tells its own notes apart from the person's by the `[aibot]` prefix (shared with the GitHub Source) or the hidden `<!-- dsh-superagent:<id> -->` marker — never by account name alone, since that would drop every follow-up the person writes.

## Editing prompts and skills

This is the layer a team is expected to customize; it never changes what is *enforced*.

- `prompts/*.md` — built-in system-prompt parts. `prompts/team/*.md` — the three team-editable sections (Communication, Ticket scope, Delivery requirements). `skills/dsh-superagent-*/SKILL.md` — bundled Source skills. `src/app/context.ts` and `src/app/skill-files.ts` load them; a prompt file is one sentence per line and lines are joined per paragraph.
- Everything is overridable at runtime through the Prompts settings group (`src/app/prompts.ts`), versioned per save. Overrides are keyed by part: `runtime/shared`, `runtime/orchestrator`, `runtime/worker`, `runtime/subscriptions`, `runtime/replies`, `runtime/dispatch`, `runtime/work`, `runtime/admission`, `runtime/handoff/{orchestrator,worker}`, `runtime/environment`, `runtime/policy`, `runtime/policy/none`, `skill/{feishu,github,gitlab}`, plus arbitrary team skills.
- Precedence, strongest first: tool/host enforcement → built-in and generated sections (as overridden) → a proactive Ticket's matched rule text → team sections and team skills → quoted outside text. Prompt text cannot loosen the gate, tool checks or account wrappers.
- Assembly order is in `docs/004-prompts.md`; the Policy section is regenerated per request and must stay last.
- Executors additionally inherit DSH's coding prompt and the repository's `AGENTS.md`; the main Session does not. That is how a per-repo SOP reaches workers without touching this package.
- Per-Ticket workflow requirements belong in a Policy rule's `instruction` (it reaches that Ticket's Executor and overrides defaults for it); requirements that apply to every Ticket belong in the team sections.

## Tests that constrain how you may write code

Several specs fail on structure, not on assertions. Read these before a refactor:

- `tests/class-docs.spec.ts` — every `class` in `src` must have a `/** … */` block immediately before it.
- `tests/docs.spec.ts` — `docs/007-architecture.md` must list **every** file in `src/` in its Modules table and **every** `tests/*.spec.ts(x)` in its Tests table; numbered docs may link only to lower-numbered ones; all local links must resolve.
- `tests/model-surface.spec.ts` — character budget for the assembled prompt + tool schemas per role (`orchestrator: 63_000`, `worker: 43_600`), plus banned words/phrases and legacy terminology in model-facing text.
- `tests/cards.spec.ts` — required and forbidden exact phrases per prompt/skill section; changing built-in wording usually means changing this table too.
- `tests/bundle-patch.spec.ts` — `cordis.patch.yml` as DSH loads it, including the `dsh-superagent-worker` / `dsh-superagent-router` presets.

Source files also carry `--- @ty.aicoding@<timestamp> ---` markers in their JSDoc; when editing tagged code, refresh the timestamp in place rather than adding a second tag.

## Notes on the running install

- State and DB: `~/.dsh/state/superagent/`. Startup logs: `.artifacts/dsh-superagent-superagent-<date>-<pid>.log` (rarely more than the `dsh web:` URL — the DSH logger is in-memory). Runtime state lives in the SQLite tables, not in logs.
- Management API is loopback, same-origin only: any request needs `Host: 127.0.0.1:3082` and header `x-orchestrator-request: 1`, e.g. `curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/sources`.
- **Skill catalog cost.** Every model-invocable skill's name and description joins the prompt as a durable catalog on each Session, so a large shared root is paid for on every request. This machine therefore exports `DSH_AGENTS_HOME="$HOME/.dsh"` from `~/.zshrc`, which makes DSH scan only `~/.dsh/skills` instead of also scanning `~/.agents/skills` (119 skills, about 19k characters). A skill from `~/.agents/skills` reaches DSH by symlinking it into `~/.dsh/skills`. DSH rejects this variable from a `.env` file — it must come from the launching shell, so start the service from a shell that has it, as `scripts/dsh-superagent` inherits its own environment.
