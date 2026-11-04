---
name: dsh-superagent-gitlab
description: Read GitLab issues, merge requests and discussion with the GitLab Source.
---

The GitLab Source watches one self-hosted project's issues and merge requests. Its to-dos assigned to the agent, and every note on a subscribed issue or merge request, arrive as triggers with their discussion; the assessment reads that context through the Source, so no direct `glab` call is needed to start. A note counts as addressed only when it mentions the agent's GitLab username; a to-do is addressed to the agent directly. Other activity stays context and creates no ticket. Reply in the thread with `orchestrator_reply` or the usual report path, not by calling `glab` yourself.

A thread key reads `gitlab:issue:<iid>` or `gitlab:mr:<iid>`; an issue and a merge request may share an IID, so name the kind. The source configuration carries the instance URL, the project as `group/project`, the agent's username and its CLI; the execution environment names the instance, project, account and, for a GitLab Ticket, its kind and IID.

## Worker delivery

Ticket branch: `agent/$DSH_SUPERAGENT_NAME`, cut from the project's default branch. Commit as the Delivery requirements author, otherwise as `$DSH_SUPERAGENT_GITLAB_ACCOUNT` with `$DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`; the environment's credential helper already authorizes the push.

Read an MR with `glab mr view <iid> --repo $DSH_SUPERAGENT_GITLAB_PROJECT --output json`; read its notes or discussions through `glab api --hostname $DSH_SUPERAGENT_GITLAB_HOST projects/<url-encoded $DSH_SUPERAGENT_GITLAB_PROJECT>/merge_requests/<iid>/notes` (or `/discussions`), and CI with `glab ci status --repo $DSH_SUPERAGENT_GITLAB_PROJECT`.

Open the MR with `glab mr create --source-branch agent/$DSH_SUPERAGENT_NAME --target-branch <default> --title <title> --description <body> --repo $DSH_SUPERAGENT_GITLAB_PROJECT --yes`; the description must start with `This is by an automated agent, not a human.` and carries the final implementation, verification and material limitations. Then immediately call `orchestrator_report` with `state: progress` and `pr_number` set to the MR IID; the Source polls that MR and ends the ticket when it is merged or closed. Report `ready` once review and CI are done.

A person merges every MR: never merge it, approve on a reviewer's behalf, or turn on merge-when-pipeline-succeeds. Reply in a review discussion with `glab mr note create <iid> --repo $DSH_SUPERAGENT_GITLAB_PROJECT --reply <discussion-id> -m <text>`, and resolve it with `glab mr note resolve <iid> <discussion-id> --repo $DSH_SUPERAGENT_GITLAB_PROJECT`. Record bot run identifiers, review-round counts and dispositions in `orchestrator_report`.

Before substantial work on a new human request or review comment, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`, even within an existing ticket; the host replies once in that source thread. Do not acknowledge bots or CI. Reading or replying does not create tickets. Keep the final implementation, verification and material limitations in the PR or MR description, and send the reviewed result through `orchestrator_report`.
