# 009 GitLab support

dsh-superagent runs against one GitHub repository: its Source polls the repository's notifications, the deployment resolves one GitHub account, workers call `gh`, and a reported pull request binds to the Ticket. This document states what it takes to make a GitLab deployment work, in the order the work has to happen. It is an assessment, not a design decided here: the open questions are listed at the end.

## The short answer

The Source contract is already provider-neutral: `SourceKind` (`src/sources/kind.ts`), `SourceRegistry`, `SourceContext`, the Trigger/Thread/Ticket model, the Policy's admission rows, the settings card generated from `fields`, the declared worker variables and the health entries. A new `gitlab` kind is, in principle, the recipe in [008 Cookbook](008-cookbook.md).

GitHub is hard-wired in four places the Source contract does not cover:

1. **The deployment account** — one `repository` and one `gh` login (`src/deployment.ts`, `src/setup.ts`, `src/infra/environment.ts`).
2. **The worker's environment** — `gh` as the only repository CLI, git credentials and URL rewriting for `github.com` only, `GH_TOKEN`/`GITHUB_TOKEN` stripped, `WORKER_COMMANDS` fixed.
3. **The change (pull request) lifecycle** — `claimPull`/`readPull`/`pullsOf`/`pullEndNotices`, `orchestrator_report`'s `pr_number`, the `github/` resources, and the Ticket card's `pullOf`.
4. **The prompts, skills and panel text** — `skill/github`, `sourceSkills.github`, `prompts/cli.md` ("Use gh for every GitHub call"), `prompts/orchestrator.md` ("Act only as the deployment's GitHub account"), and the locale keys that name GitHub.

A GitLab Source alone would listen and reply, but its merge requests would never bind to a Ticket, a worker could not commit as the deployment's account, and the agents would still be told to run `gh`. The real change is to extract a **code-host layer** that GitHub and GitLab both implement, then add the `gitlab` Source on top of it.

## What a Source already gives you

| Contract | Where | Reused by GitLab as is |
| --- | --- | --- |
| Kind definition: schema, form fields, title, health, environment declarations, policy rows | `src/sources/kind.ts` | yes |
| Registration, health routing, `context(kind)` | `src/sources/registry.ts`, `src/sources/host.ts` | yes |
| Trigger intake, thread binding, subscriptions, `threadClosed` outcomes | `src/core/engine.ts`, `src/core/ports.ts` | yes |
| Settings card rendered from `fields` | `src/client/source.tsx` | yes |
| Worker environment section generated from declarations | `src/app/context.ts`, `src/sources/host.ts` | yes |
| Admission table rows from the kind's `policy` part | `src/app/views/settings.ts`, `src/admission.ts` | yes |

## What names GitHub today

| Area | Files | What is fixed |
| --- | --- | --- |
| Deployment and setup | `src/deployment.ts` (`GithubAccountsSchema`, `Deployment.repository`, `Deployment.github`), `src/app/setup.ts` (`resolveDeployment`, `checkAccounts`), `src/setup.ts` (`SetupPlace`, problem codes), `src/app/http.ts` (`accounts`) | One repository, one `gh` account, a push probe, GitHub-shaped setup checks |
| Worker environment | `src/infra/environment.ts` (`WORKER_COMMANDS`, the `gh` shim, `credential.https://github.com` helper, `url.*.insteadOf`, stripped token variables, `gitTooOld`) | Workers may only call `gh`; git credentials exist for `github.com` only |
| API transport | `src/infra/commands.ts` (`gh`, `api`, `pages`) | `repos/<repository>/` prefix, `gh api --paginate --slurp`, a restriction message that says GitHub |
| Source | `src/sources/github*.ts` | Thread key `github:<n>`, `github.com` URL parsing, `gh` comment sending, `github/` resources, `KV.github.*` cursors |
| Change lifecycle | `src/sources/github-pull.ts`, `src/app/runtime.ts` (`pullEndNotices`), `src/app/tools/executor.ts` (`pr_number`), `src/app/cards.ts` (`pullOf`) | A Ticket binds a pull request by number, and merge/close notices are GitHub notices |
| Prompts and skills | `src/app/context.ts` (`sourceSkills`), `src/app/prompts.ts` (`PART_KEYS`, `skill/github`), `src/app/sessions.ts` (bundled skills), `src/app/skill-files.ts`, `prompts/*.md` | Agents are told `gh`, GitHub, PR, and the deployment's GitHub account |
| Panel and locale | `src/client/locales.ts` (`source.github`, `health.github`, `problemSetupFix.github`, `setup.gitTooOld`, `promptPart.skill/github`), `src/client/marks.ts` | Setup and settings pages name GitHub |
| State, migration, tests, docs | `src/kv.ts`, `src/app/migration.ts` (legacy `github-issue`), `tests/sources.spec.ts`, `tests/runtime.spec.ts`, `tests/github-read.spec.ts`, `tests/tools.spec.ts`, `docs/006`, `docs/007` | Fixtures, cursors and the architecture tables assume GitHub |

## GitLab mapping

| dsh-superagent concept | GitHub today | GitLab |
| --- | --- | --- |
| repository | `owner/name` | project full path `group/subgroup/project` (URL-encoding differs; project id is the stable key) |
| issue | number | iid |
| pull request | number, `pull` | merge request, iid, `merge_request` |
| review comment / thread | review comment, review thread | discussion / note in a merge request |
| resolve a review thread | GraphQL `resolveReviewThread` | `PUT .../merge_requests/:iid/discussions/:id?resolved=true` |
| CI | check runs, commit statuses | pipelines, jobs, `head_pipeline` |
| approvals | reviews | approval rules and approvals (tier-dependent) |
| notifications | notifications API | to-dos API, project events, or webhooks; coverage must be verified against the target version |
| bot account | login ending in `[bot]` | `*_bot` usernames, project/group access-token users, service accounts; the `bot` user flag (version-dependent) |
| commit identity | the account's noreply address | the account's commit email setting |
| CLI | `gh` | `glab`; or direct REST with a token (breaks the "the CLI owns the credential" model) |
| web URL | `github.com/<repo>/...` | `<base-url>/<project>/-/issues/:iid`, `/-/merge_requests/:iid`; self-hosted base URL is configurable |

Two consequences for the model:

- **Thread keys.** `github:<number>` is the thread key for the repository this deployment watches. GitLab needs the project in the key, for example `gitlab:<project-id>:<iid>`, because the same iid exists in every project. Existing `github:` keys stay as they are.
- **Change id.** `pr_number` becomes a per-host change number (iid). The resource family, the report field description and the panel card must say "merge request" for GitLab deployments.

## Shape of the change

### 1. A code-host layer

Introduce `src/hosts/` with a `CodeHost` contract and one implementation per provider:

- `kind` (`github` | `gitlab`), `title`, config schema, `fields`, `health` id;
- `repository` parsing and validation (GitLab allows nested groups, GitHub exactly two segments);
- `cli` resolution and the worker-command shim (`gh` or `glab`);
- git credentials and URL rewriting for the host's own domain (including a self-hosted base URL);
- account resolution: login, push permission probe, commit email;
- REST/GraphQL transport: path building (`repos/<repo>/...` vs `projects/<encoded>/...`), pagination, error mapping;
- change operations: `readChange`, `claimChange`, `changesOf`, `endNotice`, and the change part of thread context;
- resources for the host's originals (`github/...` vs `gitlab/...`), channel links, bot detection and sender labels.

`Deployment` becomes a host-neutral shape: `{ repository, codeHost: { kind, cli, login, commitEmail, webUrl, apiBase? } }`. `resolveDeployment` dispatches on the configured Source kind; `SETUP_FIELDS` and `SetupPlace` gain the `gitlab` member; `Commands` loses its GitHub-only `gh`/`api`/`pages` surface in favour of the host's transport.

The worker environment needs neutral variables. Today the declared variables are `DSH_SUPERAGENT_GITHUB_REPOSITORY`, `_ACCOUNT`, `_COMMIT_EMAIL`, `_NUMBER`, `_PR_HEAD`. For a host-neutral prompt, declare `DSH_SUPERAGENT_REPOSITORY`, `_REPOSITORY_HOST`, `_ACCOUNT`, `_COMMIT_EMAIL`, `_NUMBER`, `_CHANGE_HEAD`, and keep the GitHub names as aliases until the next major version, because deployment-saved prompts and repository instructions already reference them.

### 2. The `gitlab` Source

The Source files mirror the GitHub ones: `gitlab-trigger.ts`, `gitlab-poll.ts`, `gitlab-read.ts`, `gitlab-channel.ts`, `gitlab-change.ts`. The kind's config needs at least `project`, `cli` (a `glab` wrapper signed in to the bot, as `gh` is today), `url` for self-hosted instances, and the polling knobs the GitHub kind has.

Polling is the part that needs a decision. The GitHub Source relies on the notifications API filtered to the repository. GitLab's to-do API covers mentions and review requests but not everything the notifications API does, and project events have their own retention and latency. The alternatives are webhooks (the panel's HTTP server already exists, but it is not a public endpoint in the documented deployment) or `updated_after` sweeps over issues and merge requests plus their notes. The first implementation should pick one and state its coverage honestly; the to-do API plus `updated_after` sweeps is the least new infrastructure.

Reply and channel work is straightforward: notes on issues and merge requests, `glab mr note`/`glab issue note` or REST `POST .../notes`.

### 3. The change lifecycle

`claimPull` and `readPull` become host-provided `claimChange`/`readChange`; `pullEndNotices` becomes a host method that renders "merge request !12 merged" instead of "PR #12 merged"; `orchestrator_report` still receives `pr_number` (kept for compatibility) and interprets it as the host's change number; the Ticket card and the `gitlab/` resources follow.

`pullEndNotices` currently skips channels whose `source !== 'github'`; that check becomes the deployment's host kind, so a Feishu-only ticket still gets the notice.

### 4. Prompts, skills, panel

- Add a `skill/gitlab` built-in part and `skills/dsh-superagent-gitlab/SKILL.md`, and register the bundled skill the way GitHub's is registered.
- `prompts/cli.md` must stop naming `gh`; either make the CLI section a placeholder filled from the host (`{cli}`), or accept that a GitLab deployment overrides that part. The same holds for `prompts/orchestrator.md` ("Act only as the deployment's GitHub account") and the PR wording in `prompts/dispatch.md`, `prompts/work.md` and `prompts/handoff.md`.
- Locale keys gain `source.gitlab`, `health.gitlab`, `problemSetupFix.gitlab`, `promptPart.skill/gitlab`, and setup problem texts; the setup page lists the GitLab account checks in place of GitHub's.

## Migration and compatibility

- A deployment keeps exactly one code host. The `github` block keeps its schema and meaning; the `gitlab` block is new. No settings migration is needed for existing deployments, and the `github-issue` → `github` legacy rename in `src/app/migration.ts` stays.
- Prompt overrides are user data. Deployments that saved prompts naming `gh` keep them; the built-in text is what changes. The upgrade notes must say which parts a GitLab deployment has to re-author.
- KV gains `gitlab-*` families; no cursor is shared with GitHub.
- `docs/006-deployment.md`, `docs/007-architecture.md` (the Source-specific dependencies section and the module/test tables) and `SETUP.md` need the GitLab paths; `tests/docs.spec.ts` enforces the tables, so the new files must be listed.

## Phased plan

Estimates are rough dev-days for one engineer who knows this codebase; they are not commitments.

| Phase | Deliverable | Exit criteria | Estimate |
| --- | --- | --- | --- |
| A. Code-host extraction | `src/hosts/` shape, `Deployment` refactor, transport and environment parameterisation, neutral worker variables with GitHub aliases | GitHub behaves exactly as today; the full test suite passes unchanged | 8–10 |
| B. GitLab Source, read and reply | `gitlab` kind, config and fields, polling, triggers and thread keys, scope, channel replies, resources | A GitLab project's issues and merge request notes reach Tickets, and replies arrive; a decision on polling coverage is documented | 8–10 |
| C. Change lifecycle | MR binding, `pr_number` interpretation, end notices, pipeline/job facts, bot detection | A worker's reported MR binds to its Ticket; merge/close ends the Ticket and notifies; CI facts render | 5–7 |
| D. Prompts, panel, docs, tests | `skill/gitlab`, prompt parts and placeholders, locale, setup page, docs 006/007/008, specs | `pnpm check` passes; a manual GitLab deployment listens, works and delivers end to end | 5–7 |

Total: roughly 26–34 dev-days, about six to eight weeks. A faster, non-upstream path exists: fork the prototype, replace the GitHub files with GitLab equivalents and skip the host abstraction. That is about two to three weeks, but it doubles the maintenance and throws away the GitHub deployment.

## Decisions the owner has to make

1. GitLab.com, self-hosted, or both — and which version. This decides the API surface, URL shapes and whether webhooks are viable.
2. One project per deployment, or a group; how nested groups map onto the `repository` field.
3. Authentication: a `glab` wrapper like `gh` today, or REST with a token; personal, project or group access token, or an OAuth application.
4. Polling or webhooks, and the accepted coverage gap for mentions, review requests and CI.
5. Whether a deployment may run both GitHub and GitLab at once. The recommendation is one code host per deployment for now; multiple hosts would put the host on the Ticket.
6. What counts as a blocking check: pipelines or jobs, and whether approvals gate a Ticket.
7. The agent identity on GitLab: service account or access-token user, and its commit email.
8. Where the review-bot list comes from: a policy list, or detection.

## Risks

- GitLab's event coverage through polling is weaker and less uniform than GitHub notifications; a naive implementation will miss mentions or MR updates, and this is the first thing to verify on the real instance.
- `glab` versions differ in `api` pagination and path encoding; a wrapper must pin a minimum version, or the transport must call REST directly.
- Discussion resolution and inline notes have no exact GitHub analogue; the review workflow that resolves threads needs a separate mapping.
- Self-hosted instances bring base URLs, TLS and proxies, and a bot account may not be allowed to read all projects.
- The prompts are part of the product; a deployment whose saved prompts say `gh` keeps saying `gh` after the upgrade unless re-authored.
- The GitHub path must not regress while the abstraction lands; Phase A is cheap only if it is done as a pure refactor with the existing suite as the gate.
