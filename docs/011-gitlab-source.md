# 011 GitLab Source

The GitLab Source watches one project on a company-hosted GitLab instance and turns its to-dos and discussion into Tickets. It is a peer of the GitHub Source: both implement `SourceKind`, both register with the same `SourceRegistry`, and an installation may enable either or both. Each instance keeps its own project path, so a GitLab Source and a GitHub Source can run side by side.

## What it receives

- **To-dos** assigned to the agent account, by assignment or a mention. A to-do is addressed to the agent directly, and must name an Issue or Merge Request.
- **Notes** on an Issue or Merge Request whose Thread has a Ticket subscribed. A note is addressed when its text mentions the agent's username; every other note is context. Notes written by the agent and system notes are never received.

A thread key is `gitlab:issue:<iid>` or `gitlab:mr:<iid>`. Issues and Merge Requests have separate IID sequences, so the kind is part of the key. `find` accepts `12`, `#12`, `!12`, and an Issue or Merge Request URL from any project.

The first poll of a subscribed thread records its newest note id and receives no history. Later polls receive only notes with a newer id. Replies go to the same Issue or Merge Request through the Source Channel, which embeds `<!-- dsh-superagent:<message id> -->` so a repeated delivery is not posted twice.

## Configuration

Add a **GitLab** Source in the panel, or insert a settings block with kind `gitlab`:

| Field | Meaning |
| --- | --- |
| `url` | The instance URL, such as `https://gitlab.example.com`. Its host also selects the GitLab CLI hostname. |
| `project` | The project to watch, as `group/project`; nested groups are allowed. |
| `cli` | Command or absolute path of the agent's GitLab CLI, by default `glab`. |
| `account` | The agent's GitLab username, used to recognize its own notes and mentions. |
| `email` | Commit email for the agent, shown to Executors as `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`; empty uses `account@users.noreply.<host>`. |
| `pollSeconds` | Polling interval, 60 to 3600 seconds; default 60. |
| `failuresBeforeError` | Consecutive failed polls before reporting an error; default 3. |
| `observeTodos`, `observeNotes` | Whether to receive to-dos and new notes; both default on. |

Every field has a default because a disabled Source is still resolved from its stored settings. A Source with no URL, project, account or CLI stays paused and reports `setupPending`; it does not fail startup.

The CLI must be signed in only as the agent account. Keep its credentials out of the settings, as with `gh`:

```sh
GLAB_CONFIG_DIR=/home/me/.config/glab-agent glab auth login --hostname gitlab.example.com
```

If the CLI is a wrapper, point `cli` at the wrapper. The host calls `glab api --hostname <host> <path>` and expects JSON. A token in the wrapper's environment is not read or stored by dsh-superagent.

The execution environment exposes `DSH_SUPERAGENT_GITLAB_URL`, `DSH_SUPERAGENT_GITLAB_HOST`, `DSH_SUPERAGENT_GITLAB_PROJECT`, `DSH_SUPERAGENT_GITLAB_ACCOUNT`, `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`, and, for a GitLab Ticket, `DSH_SUPERAGENT_GITLAB_KIND` and `DSH_SUPERAGENT_GITLAB_IID`.

## Endpoints used

| Purpose | Call |
| --- | --- |
| Pending to-dos | `GET todos?state=pending&per_page=100` |
| Read an Issue or MR | `GET projects/<encoded project>/issues/<iid>` or `merge_requests/<iid>` |
| Notes | `GET projects/<encoded project>/(issues\|merge_requests)/<iid>/notes?sort=asc&order_by=created_at&per_page=100` for context; polling asks for `sort=desc` so the newest notes are never behind an old page |
| Reply | `POST projects/<encoded project>/(issues\|merge_requests)/<iid>/notes` with `body` |

All calls use the configured CLI and hostname, and only the Source's project. To-dos whose target names another project, or has no URL to check, are ignored.

## Worker delivery

A worker decides per project which CLI to use: `gh` for a GitHub repository and `glab` for a GitLab project, as the worker prompt and the GitLab skill say. `DSH_SUPERAGENT_GITLAB_HOST` is the value `glab --hostname` takes; the project path is `DSH_SUPERAGENT_GITLAB_PROJECT`. When the deployment names a GitLab project, the execution environment writes a `glab` shim that runs the project's configured `cli` and clears any inherited `GITLAB_TOKEN`, so a worker uses exactly the agent's `glab` login. It also configures the deployment's GitLab host in the worker gitconfig with that CLI as the credential helper, the way it configures `github.com` with `gh`.

A worker reports an open Merge Request with the same `pr_number` argument as a pull request. The Executor reads that number through the ticket's Source candidates, most likely first, and claims the first change that accepts it, so an MR opened from a GitLab ticket is bound even when the ticket started on Feishu or GitHub. A ticket that follows `gitlab:mr:<iid>` shows the MR's IID as `pr_number`, and the GitLab poll observes the MRs of open tickets so a merge or close ends the ticket even when no note arrives.

## Limitations of this slice

The Source covers ingestion, admission context, replies, health, merge request lifecycle and worker delivery. Remaining limitations:

- Setup resolves the deployment from the GitHub Source; a GitLab-only installation does not start yet. Enabling both works because the GitHub setup remains the deployment, and the GitLab Source then adds the GitLab project to it.
- `orchestrator_read` has no `gitlab/…` pages; discussion reaches assessments through the Source's Thread context instead.
- The Source reads one page of 100 to-dos or notes per poll. It does not follow pagination, observe pipelines, or read images and attachment contents.
- A merge request whose source project differs from the watched project (a fork) is read, claimed and observed, but its branch is not treated as a worker branch for auto-binding.
