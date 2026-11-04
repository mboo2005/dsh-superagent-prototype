# 010 Multi-project support on a self-hosted GitLab

The owner wants one deployment to manage four or five projects at the same time, and those projects live on the company's self-hosted GitLab. The chosen implementation is not a generic multi-host layer: **add a `gitlab` Source kind whose base URL is configured**, then let one deployment hold several GitLab projects. This document is the design for that change. It is a review document: it changes no production code. [009 GitLab support](009-gitlab-support.md) assesses what a GitLab deployment needs in general; this one fixes the shape the owner asked for and adds the multi-project part on top.

## Decision

- The projects are GitLab projects on a self-hosted instance. The instance address is deployment configuration (`url`), never a compiled-in `gitlab.com`.
- Implement GitLab as a **`gitlab` Source kind**, next to `github` and `feishu`, rather than making the GitHub kind host-configurable: GitLab has its own REST API v4, its own resource model (project-local `iid`, notes, merge requests, approvals, pipelines) and its own CLI and token handling.
- **Several projects = several GitLab project instances** in one deployment. The deployment holds the server facts once, and every project adds one Source instance.
- The GitHub kind's behavior is untouched. An existing single-repository GitHub deployment keeps working, and a deployment may hold both kinds. (Phase A extracts its change hooks so a second transport can implement them; that is a refactor without a behavior change.)
- Workspace auto-discovery stays out of the core: the deployment's project list is explicit configuration. An import helper that fills the list from local clones is optional and described below.

The rest of this document is the concrete shape, the mapping to GitLab, the work per area, the order it has to happen in, and the cost.

## The shape

Server facts and project instances share one config schema. A field left out of a project instance is taken from the `gitlab` instance, so the URL and account are written once.

```jsonc
{
  "sources": {
    // Server facts: URL, CLI, account, token. It also owns a project when the
    // deployment manages exactly one; it produces no Threads without one.
    "gitlab": { "enabled": true, "kind": "gitlab", "config": {
      "url": "https://git.corp.example",          // required for the kind instance, no default
      "cli": "glab",
      "account": "dsh-agent",
      "noreply": "dsh-agent@users.noreply.git.corp.example",
      "tokenFile": "~/.config/dsh-superagent/gitlab-token",
      "pollSeconds": 120
    }},
    // One instance per project; inherits everything above.
    "gitlab-web": { "enabled": true, "kind": "gitlab", "config": { "project": "web/frontend" } },
    "gitlab-api": { "enabled": true, "kind": "gitlab", "config": { "project": "svc/api" } }
  },
  "policy": {
    "sources": { "gitlab-web": { "allowed": [] }, "gitlab-api": { "allowed": [] } }
  }
}
```

- **The instance id is the project key.** Thread keys become `<instance>:<iid>` (`gitlab-web:42`), so two projects can each have issue 42. This is the same `<source>:<id>` convention the GitHub kind uses today, only keyed by instance instead of kind.
- **The URL is one value for the deployment**; a project instance may override it (`url` in its own config) for a second GitLab instance or gitlab.com. The kind has no default URL — a deployment with GitLab but no `url` fails validation, which is clearer than silently pointing at gitlab.com.
- **Project identity**: `<project>` is the full namespace path (`web/frontend`), so `webUrl = <url>/<project>`, clone URL = `<url>/<project>.git`, and the API base = `<url>/api/v4/projects/<url-encoded project>`.
- **A new project starts with an empty Policy part**, exactly like a new source today: it accepts nothing until its allowed senders are configured. The panel says so instead of showing an empty overview.

## What has to change

The instance model, the deployment and the change lifecycle are the same body of work [009](009-gitlab-support.md) describes; the table names what is GitLab-specific or touched twice.

| Area | Files | Change |
| --- | --- | --- |
| Kind registration | `src/sources/gitlab.ts` (new), `src/app/runtime.ts` | A new kind plugin: schema (`url`, `project`, `cli`, `account`, `noreply`, `tokenFile`, `pollSeconds`), fields, policy part, health, threads, environment variables |
| API transport | `src/infra/commands.ts` (new `gitlab` client or a sibling) | REST v4: project lookup, issues, notes, merge requests, users, pipelines; per-call timeout, pagination, ETag/`updated_after` polling |
| Web URLs | `src/sources/gitlab.ts` (`link`), panel cards | Issue/MR/commit links under `<url>/<project>/-/…`; no github.com fallback |
| Instance resolution | `src/sources/registry.ts` (`instances`, `instance`, `resolve`, `channelAllowed`, `environments`, `scope`, `policyPart`, `send`, `find`) | Stored instances carry `kind`; lookups resolve by `kind` instead of `kinds.get(id)`; a GitLab project instance declares `kind: "gitlab"` |
| Health | `src/sources/registry.ts` (`healthEntries`), `src/sources/host.ts` (`health`) | Health entries are keyed per instance (`gitlab-web`), not per kind; two project instances no longer overwrite each other |
| Deployment | `src/deployment.ts` (`Deployment`, `SETUP_FIELDS`, `workerProbe`), `src/app/setup.ts` (`checkAccounts`), `src/setup.ts` | **No `Deployment.projects` map**: the stored Source instance is already the project record, so there is one place to add, remove and read a project. `gitlabProject(config)` reads the project's URL and path from that instance's config; the single-repository `deployment.github` and its setup probes keep working |
| Worker environment | `src/infra/environment.ts` (`writeEnvironment`, `WORKER_COMMANDS`, credential helpers), `src/app/execution-environment.ts` (`environmentOf`), `src/sources/registry.ts` (`environments`), `src/sources/gitlab.ts` (`environment.values`) | Helper for `credential.https://<gitlab host>` (the GitHub one stays), `glab` shim when the CLI is used, variables `DSH_SUPERAGENT_PROJECT`, `DSH_SUPERAGENT_GITLAB_URL`, `_ACCOUNT`, `_COMMIT_EMAIL`; a ticket's environment is built from its own project instance (its trigger's source), not from every enabled project |
| Change lifecycle | `src/sources/change.ts` (new), `src/sources/github-pull.ts`, `src/kv.ts` (`github-*` keys) | Kind-neutral `claimChange`/`observeChange`/`endNotices` behind a `ChangeHost`: a GitLab project claims by `source_branch` + author and stores the MR `iid` where a Ticket already stores `pr_number`; cursors and link caches become per instance. The kind's `change(deployment, config, instance)` runs per instance, so each project's adapter has its own repository, thread prefix and links |
| Orchestrator tools and prompts | `src/app/resources.ts` (`github/…` reader via `src/sources/github-read.ts`), `skills/dsh-superagent-gitlab` (new), `prompts/*` | The resource reader picks the project's host instead of always calling `readGithub`; a GitLab project gets issue/MR/note resources and a matching skill; the GitHub wording in the orchestrator and worker prompts becomes host-neutral with a short per-kind note |
| Policy | `src/policy.ts`, `src/app/views/*` | Policy parts keyed by instance id; form fields from the kind; a GitLab project's admission table is the same shape |
| Panel | `src/client/source.tsx`, `src/app/views/settings.ts` | Server card edits the `gitlab` instance; project cards add/remove with `project` and are gated on a token; per-project health and last-poll rows. **Add/remove is phase E and still missing**: today an instance must already exist in settings (`PUT settings/source:<id>` rejects an unknown block), so the panel shows one card per stored instance but cannot create one |
| Documentation | `SETUP.md`, `docs/006-deployment.md`, `docs/003-execution.md`, `docs/008-cookbook.md` | A GitLab deployment walkthrough, project/env variables, and the credential/token model |

## Mapping GitHub to GitLab

| GitHub today | GitLab |
| --- | --- |
| `gh` CLI (`deployment.github.cli`) | `glab` when installed; otherwise REST v4 through the deployment's token |
| Token: `gh auth login` on the host | Personal/project access token (scopes `api`, `read_repository`, `write_repository`) from `tokenFile` or the host environment; no interactive login from the agent |
| Issue: `number`, `body`, `user.login` | Issue: project-local `iid`, `description`, `author.username` |
| Comment: `gh issue comment` | Note: `POST /projects/:id/issues/:iid/notes`; MR notes for MR threads |
| Pull request: `agentPull` matches head branch, stores `pr_number` | Merge request: match `source_branch` + `author_id`, store the MR `iid`; `web_url` for the card |
| PR state (`open`/`merged`/`closed`) | MR `state` (`opened`/`merged`/`closed`) + `merged_at`/`closed_at` |
| `pullEndNotices` watches a PR's end | Same hook watching the MR's end; the `channel.source !== 'github'` filter in `src/sources/github-pull.ts` becomes a host check |
| Review comments, approvals, CI checks | MR discussions, approvals (`/approvals`), pipelines (`/pipelines`) — the review and CI surface is smaller than GitHub's, so v1 covers discussions and pipeline status only |
| `credential.https://github.com` helper | `credential.https://<gitlab host>` helper installed at setup; verified like the GitHub one |
| The `dsh-superagent-github` skill and `github/…` resources | A `dsh-superagent-gitlab` skill and GitLab resource reader in the orchestrator session |

Two things do not carry over one-to-one: GitLab has no review-bot ecosystem, so the review policy (human reviewers, automated rounds) is a GitHub-shaped rule set; and GitLab CI is pipeline-based, so the CI poller that watches GitHub check runs has no direct equivalent in v1.

## The instance model (multi-project)

This is the part that makes 4–5 projects one deployment rather than 4–5 deployments.

1. **Stored instances gain `kind`.** `SourceInstanceSchema` becomes `{ enabled, kind?, config }`; a stored instance without `kind` keeps today's meaning (its id is the kind id), so `github` and `feishu` settings stay valid. `SourceRegistry.resolve(kind, stored)` stops forcing `id: kind.kind` and keeps the stored id.
2. **Health, policy, state and variables key on the instance id**, never on the kind: `health` entries are claimed per instance; `policy.sources[instanceId]`; `github-since:<instance>` / `github-stream:<instance>` / `github-cursor:<instance>` style state keys; environment values come from the project's host.
3. **The stored instance is the project.** There is no second project table: `SourceRegistry.instance(id)` returns the project (its config merged over the kind's base config), thread keys are `<instance>:<threadId>`, and a ticket's change host comes from `change(trigger.source, deployment)`, which passes that instance's config and id to `kind.change`. The kind instance (`gitlab`) still holds server facts and may own one project itself; it produces no threads without a `project`.
4. **The panel lists projects**, not kinds: one card per stored instance, already the case for the Sources settings and status views. Add/remove of a project instance is phase E; removing a project should pause its threads instead of deleting them, and its stored Policy part is kept, like other uninstalled sources.
5. **Setup probes run per project.** Each project reports its own token/push/API check, so one unreachable project does not hide the other four.

## Workspace question

The owner asked whether they can prepare a local workspace and have the deployment take over "all projects in the current directory". Today nothing scans a directory: a project's identity comes only from a configured Source (a GitHub repository, and after this change a GitLab project). Two options were considered:

- **Option A — explicit list (recommended).** The operator lists five GitLab projects in settings; each becomes an instance. It is already the deployment's source of truth, survives restarts, and cannot pick up a half-cloned or unrelated repository.
- **Option B — discovery as an import helper.** A "scan workspace" button in the panel walks the configured workspace root, reads `git remote get-url origin` and lists matching GitLab remotes as candidates; the operator confirms the imported projects, which then become ordinary instances. Discovery is not a runtime mode: nothing is auto-managed, and removing a project from settings does not delete anything on disk.

Both are compatible with this design; A is the default, and B can be added later as a panel helper without touching the instance model.

## Phases and cost

Estimates are for one engineer who knows this codebase, in dev-days. The GitHub transport stays behaviorally untouched, so the work is additive first and refactoring second.

| Phase | Deliverable | Done when | Est. |
| --- | --- | --- | --- |
| A | Kind-neutral change hooks: `claimChange`/`readChange`/`endNotice` extracted from the GitHub path, no behavior change | Existing GitHub tests and setup pass | 3–5 |
| B | `gitlab` kind, single project: schema/fields, REST client, issue and note polling, replies, links, policy part, health, cursors, panel card | One real GitLab project can receive a request and reply in its thread | 9–12 |
| C | Merge-request lifecycle, worker environment, tools and skills: MR binding, end notices, token/credential setup, `glab`/REST shim, worker variables, orchestrator GitLab tools and skill, prompt wording | A worker can clone, commit, push and open an MR on one GitLab project end to end | 8–11 |
| D | Instance model: `kind` on stored instances, per-instance health/policy/env/state, thread keys, project-aware change lookup, one poll loop per enabled instance | Five GitLab projects in one deployment, each with its own thread keys and Policy | 8–10 |
| E | Panel add/remove and per-project setup, docs, migration notes, soak on the real instance | Two weeks of a four-five-project deployment without a per-project mix-up | 4–6 |

**Total: about 32–44 dev-days**, or five to seven weeks for one engineer. [009](009-gitlab-support.md) estimates 26–34 dev-days for GitLab support alone; the first three phases overlap with it by roughly a week to ten days, so doing both as one program costs about 40–50 dev-days rather than the sum. A useful cut is A+B+C first: one GitLab project working end to end, soaked on the real instance, before D turns it into five.

## Decisions (settled 2026-11-04)

The owner approved this direction and answered the token question; the rest take the recommended defaults, recorded here as the assumptions this work proceeds on.

1. **Token: a token file.** A file readable only by the deployment account is the source of truth; setup checks its scopes and refuses a world-readable file. `glab` is used when present and never required. The token needs `api`, `read_repository` and `write_repository`.
2. **`glab` is optional.** Every operation has a REST path, so a host without `glab` loses no behavior; the worker's git credentials come from the token file through the credential helper.
3. **Internal CA is configurable.** Setup accepts a CA bundle path and exports `GIT_SSL_CAINFO`/`SSL_CERT_FILE` for git and the REST client; disabling verification is not offered.
4. **One token may serve several projects.** The v1 assumption is one group-level token with Developer access on the four-five projects; per-project tokens are a later option, so configuration keeps the token per server, not per project.
5. **v1 GitLab surface**: issues, merge requests and MR discussions. Pipelines, approvals and approval rules wait for the soak.
6. **A GitLab-only deployment is the first target.** The kinds can be mixed, but prompts and skills get GitLab wording when the kind is active rather than one shared compromise.
7. **Review is human-only on GitLab** until an equivalent reviewer exists; the three-round rule becomes a GitHub-only rule, documented per kind.
8. **Four-five projects.** Polling is one interval per project; that scales to a few dozen, and the instance rate limit is the floor.

## Implementation status

Phase A (the kind-neutral change hooks) is implemented on this branch:

- `src/sources/change.ts` owns what was GitHub-specific: `changesOf`/`changeOf`, `claimChange`, `observeChange`, and `endNotices`. A kind supplies a `ChangeHost` (its thread prefix, the word it uses for a change, its account, its repository, its Thread facts, and its link).
- `SourceKind.change` and `SourceRegistry.change(source, deployment)` expose that adapter, and the runtime's end-of-ticket notice loop asks the registry instead of calling GitHub helpers, so a second code host needs no runtime change.
- `src/sources/github-pull.ts` is now the GitHub adapter of the same lifecycle and keeps its external helpers and notice IDs.

Phase B has started with the parts that do not depend on the rest of the kind:

- `src/sources/gitlab-api.ts` is the REST transport: the token is read from a file (alone, or as a `NAME=value` line of an existing credential file), calls carry `PRIVATE-TOKEN`, failures keep the HTTP status, and `gitlabPages` follows `X-Next-Page`. It is verified against a company self-hosted instance: `/projects/:id` for a nested group project, a paged merge request list, and a token file read from the deployment's existing credentials.
- `src/sources/gitlab-trigger.ts` turns notes, issues and merge requests into Triggers (mentions, GitLab's own `_bot` accounts, an edited note re-ingested under its `updated_at`) and a merge request into the generic `Change`.

Still missing in phase B: the GitLab kind itself (`src/sources/gitlab.ts`: configuration, health, poll round, Channel and Thread context), its plugin entry and `cordis.patch.yml` registration, the GitLab git credential helper in `src/infra/environment.ts`, and setup verification. Phase C's tool and prompt work (a `gitlab()` reader tool instead of `gh`, MR claiming in the executor's `orchestrator_report`) is untouched, so a GitLab deployment can be configured and read but cannot yet end a ticket through a merge request.

Remaining phases touch `src/app/setup.ts`, `src/deployment.ts`, `src/infra/environment.ts` and the panel, and their setup checks are keyed to `github` and `feishu` today; the instance and token file that B verifies against are available.

## Risks

- **Prompt and tool re-authoring is the largest hidden cost**, as [009](009-gitlab-support.md) notes: the agent's tools, skills and prompt text are GitHub-shaped (`gh`, "PR", `github:<n>` resources). A GitLab deployment needs its own reader tools and skill, and the prompt sections need per-kind wording — this is in phase C, not free.
- **The REST surface differs where it matters**: project-local `iid` versus global `id`, note ordering and pagination, rate limits (lower than GitHub's), and ETag support that is not uniform. Polling four-five projects must batch per project, not per issue.
- **Self-hosted network and TLS**: the deployment host must reach the instance (VPN, SSO, internal CA). A failure here looks like "no projects" rather than a configuration error, so setup must probe reachability explicitly per project.
- **Credentials are per host, not per repository.** The worker environment writes one git config for every project; a GitLab host and github.com must both get helpers, and the setup verification that checks `credential.https://github.com.helper` has to grow a second host. A token must never be written into a ticket directory.
- **The instance model touches persisted state** (Thread keys, Policy keys, KV keys). Keeping today's default ids (`github`, `feishu`) and today's `<source>:<id>` keys is the compatibility line; any key that gains an instance segment needs a read-side fallback or a one-time migration.
- **Knowledge and accounts are split across hosts**: node_modules, the `gh` CLI and the GitHub account are per deployment today; the GitLab side needs its own account, token and docs, and the README's "one GitHub repository" framing (and [006](006-deployment.md)) becomes false.
- **A new project starts with no allowed senders**, so it looks broken until Policy is configured; the panel should say so explicitly instead of reporting an empty overview.
