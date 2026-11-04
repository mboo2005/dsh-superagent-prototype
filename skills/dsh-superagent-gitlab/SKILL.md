---
name: dsh-superagent-gitlab
description: Read GitLab issues, merge requests and discussion with the GitLab Source.
---

The GitLab Source watches one self-hosted project's issues and merge requests. Its to-dos assigned to the agent, and every note on a subscribed issue or merge request, arrive as triggers with their discussion; the assessment reads that context through the Source, so no direct `glab` call is needed to start. A note counts as addressed only when it mentions the agent's GitLab username; a to-do is addressed to the agent directly. Other activity stays context and creates no ticket. Reply in the thread with `orchestrator_reply` or the usual report path, not by calling `glab` yourself.

A thread key reads `gitlab:issue:<iid>` or `gitlab:mr:<iid>`; an issue and a merge request may share an IID, so name the kind. The source configuration carries the instance URL, the project as `group/project`, the agent's username and its CLI; the execution environment names the instance, project, account and, for a GitLab Ticket, its kind and IID.

Before substantial work on a new human request or review comment, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`, even within an existing ticket; the host replies once in that source thread. Do not acknowledge bots or CI. Reading or replying does not create tickets. Keep the final implementation, verification and material limitations in the PR description, and send the reviewed result through `orchestrator_report`.
