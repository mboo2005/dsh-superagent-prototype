/**
 * GitLab merge requests as changes: the API shape, and the GitLab adapter of the kind-neutral change lifecycle.
 * --- @ty.aicoding@ ---
 */
import { z } from 'zod'
import type { ThreadFact, Ticket } from '../core/index.ts'
import type { Deployment, GitlabProject } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import { changesOf, changeThread, claimChange, observeChange,
  type Change, type ChangeHost } from './change.ts'

/** The Source prefix GitLab threads carry; it matches the GitLab Source kind's `kind`. */
export const SOURCE = 'gitlab'

const UserSchema = z.looseObject({ username: z.string() })
const MrSchema = z.looseObject({
  iid: z.number(),
  title: z.string().nullish(),
  web_url: z.string().nullish(),
  state: z.string(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  author: UserSchema,
  source_branch: z.string().nullish(),
  source_project_id: z.number().nullish(),
  target_project_id: z.number().nullish(),
  merge_when_pipeline_succeeds: z.boolean().nullish(),
})
export type GitlabMr = z.infer<typeof MrSchema>
/**
 * Reads one merge request through the deployment's glab CLI.
 * @throws when the installation has no GitLab project or the API call fails.
 * --- @ty.aicoding@ ---
 */
export async function readMr(ctx: SourceContext, deployment: Pick<Deployment, 'gitlab'>, iid: number, signal?: AbortSignal): Promise<GitlabMr> {
  const gitlab = deployment.gitlab
  if (!gitlab) throw new Error('This installation has no GitLab project, so it cannot read a merge request')
  return readMrIn(ctx, gitlab, iid, signal)
}
/**
 * Reads one merge request of `project` through the deployment's glab CLI.
 * @throws when the API call fails.
 * --- @ty.aicoding@ ---
 */
export async function readMrIn(ctx: SourceContext, project: GitlabProject, iid: number, signal?: AbortSignal): Promise<GitlabMr> {
  const path = `projects/${encodeURIComponent(project.project)}/merge_requests/${iid}`
  const raw = await ctx.commands.withSignal(signal).run(project.cli, ['api', '--hostname', project.host, path])
  return MrSchema.parse(JSON.parse(raw))
}
/**
 * Reduces a GitLab merge request to the change the generic lifecycle reconciles. `project` is the watched project's
 * path: a merge request whose source project differs comes from a fork, and the host reports no path for it.
 * --- @ty.aicoding@ ---
 */
export const asChange = (mr: GitlabMr, project: string): Change => {
  const merged = mr.state === 'merged' || !!mr.merged_at
  const sameProject = mr.source_project_id == null || mr.target_project_id == null || mr.source_project_id === mr.target_project_id
  return {
    id: mr.iid,
    url: mr.web_url ?? '',
    state: merged || mr.state === 'closed' ? 'closed' : 'open',
    merged,
    author: mr.author.username,
    head: { ref: mr.source_branch ?? '', repository: sameProject ? project : null },
    autoMerge: mr.merge_when_pipeline_succeeds === true,
    endedAt: mr.merged_at ?? mr.closed_at ?? undefined,
  }
}
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/**
 * The Thread key of one merge request, and the IID a Thread key names; each change Source owns this mapping.
 * --- @ty.aicoding@ ---
 */
const mrThread = (source: string, iid: number): string => `${source}:mr:${iid}`
const mrNumber = (source: string, thread: string): number | undefined => {
  const match = new RegExp(`^${source}:mr:(\\d+)$`).exec(thread)
  return match ? Number(match[1]) : undefined
}
/**
 * The change lifecycle of GitLab merge requests in `deployment`, or undefined when this installation watches no
 * GitLab project (in which case a worker can neither read nor claim a merge request).
 * --- @ty.aicoding@ ---
 */
export const gitlabChange = (deployment: Pick<Deployment, 'gitlab'>, project = deployment.gitlab, source = SOURCE): ChangeHost | undefined => {
  if (!project) return undefined
  return {
    source, term: 'MR', account: project.account, repository: project.project,
    facts: change => ({ autoMerge: !(change.state === 'closed' || change.merged) && change.autoMerge ? AUTO_MERGE_ON : null }),
    link: iid => `${project.url}/${project.project}/-/merge_requests/${iid}`,
    thread: iid => mrThread(source, iid), id: thread => mrNumber(source, thread),
    read: (ctx, iid, signal) => readMrIn(ctx, project, iid, signal).then(mr => asChange(mr, project.project)),
  }
}
/**
 * The merge requests a ticket follows, oldest first; `open` keeps the ones not yet closed.
 * --- @ty.aicoding@ ---
 */
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  changesOf({ id: (thread: string) => /^[^:]+:mr:(\d+)$/.exec(thread)?.[1] ? Number(/^[^:]+:mr:(\d+)$/.exec(thread)![1]) : undefined }, ticket, open)
/**
 * The newest merge request a ticket follows, if any.
 * --- @ty.aicoding@ ---
 */
export const mrOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/**
 * Validates and binds an open merge request to a ticket, with the change lifecycle's PR rules.
 * --- @ty.aicoding@ ---
 */
export const claimMr = (ctx: SourceContext, ticketId: string, mr: GitlabMr): string | undefined => {
  const host = ctx.change?.() ?? (ctx.deployment ? gitlabChange(ctx.deployment) : undefined)
  return host ? claimChange(ctx, host, ticketId, asChange(mr, host.repository)) : 'This installation has no GitLab project'
}
/**
 * Observes the merge requests of open tickets, so a merge or close ends a ticket even when no note arrives.
 * One failed read records the error on the merge request's Thread and leaves the other tickets alone.
 * --- @ty.aicoding@ ---
 */
export async function pollTicketMrs(ctx: SourceContext): Promise<void> {
  // A Source the tests drive without a deployment has no merge requests to observe.
  const host = ctx.change?.() ?? (ctx.deployment ? gitlabChange(ctx.deployment) : undefined)
  if (!host) return
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => changesOf(host, ticket, true)))]
  for (const iid of iids) {
    try {
      await observeChange(ctx, host, await host.read(ctx, iid))
      ctx.threads.patch(changeThread(host, iid), { pollError: undefined })
    } catch (error) {
      ctx.threads.patch(changeThread(host, iid), { pollError: String(error) })
    }
  }
}
