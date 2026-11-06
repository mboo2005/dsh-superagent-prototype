/**
 * GitLab merge requests as changes: the API shape, and the GitLab adapter of the kind-neutral change lifecycle.
 * --- @ty.aicoding@ ---
 */
import { z } from 'zod'
import { key, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment, GitlabProject } from '../deployment.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { changesOf, changeThread, claimChange, observeChange,
  type Change, type ChangeHost, type Review } from './change.ts'

/** The Source prefix GitLab threads carry; it matches the GitLab Source kind's `kind`. */
export const SOURCE = 'gitlab'

const UserSchema = z.looseObject({ username: z.string() })
/**
 * GitLab's merge request approvals: whether the required approvals are in, and who approved. GitLab 14.9, the version this
 * Source was verified against, has no request-changes verdict to read; that arrives as a note, which note polling delivers.
 * --- @ty.aicoding@1793952047896 ---
 */
const ApprovalsSchema = z.looseObject({ approved: z.boolean().nullish(), approved_by: z.array(UserSchema).nullish() })
export type GitlabApprovals = z.infer<typeof ApprovalsSchema>
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
 * Reads who approved a merge request of `project`, so an approval given without a note still reaches the ticket. An instance
 * that does not serve the approvals endpoint (GitLab 14.9 answers 404) reports none rather than failing the poll.
 * --- @ty.aicoding@1793952240316 ---
 */
export async function readApprovals(ctx: SourceContext, project: GitlabProject, iid: number, signal?: AbortSignal): Promise<GitlabApprovals> {
  const path = `projects/${encodeURIComponent(project.project)}/merge_requests/${iid}/approvals`
  try {
    const raw = await ctx.commands.withSignal(signal).run(project.cli, ['api', '--hostname', project.host, path])
    return ApprovalsSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (error instanceof CliError && error.code === 404) return {}
    throw error
  }
}
/**
 * The review verdict an approvals payload states, ignoring the agent's own approval. An instance that requires no approval
 * reports `approved` from the start, which would say nothing about a reviewer, so only approvals with an approver count.
 * --- @ty.aicoding@1793952240316 ---
 */
export const approvalReview = (approvals: GitlabApprovals, account: string): Review | undefined => {
  const by = [...new Set((approvals.approved_by ?? []).map(user => user.username))].filter(name => !sameName(name, account))
  return by.length ? { verdict: 'approved', by } : undefined
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
    read: async (ctx, iid, signal) => {
      const mr = await readMrIn(ctx, project, iid, signal)
      const change = asChange(mr, project.project)
      // An ended merge request has no verdict left to act on, so its approvals are not read.
      if (change.state === 'closed') return change
      const review = approvalReview(await readApprovals(ctx, project, iid, signal), project.account)
      return review ? { ...change, review } : change
    },
  }
}
/**
 * Records a review verdict on the change's Thread and, in a reply the worker sees, so an approval given without a note reaches
 * the ticket: each poll states a verdict once, the way note polling states a comment once.
 * --- @ty.aicoding@1793952673025 ---
 */
async function announceReview(ctx: SourceContext, host: ChangeHost, iid: number, change: Change): Promise<void> {
  const review = change.review
  const thread = changeThread(host, iid)
  const previous = ctx.threads.get(thread)?.meta.review as Review['verdict'] | undefined
  // A verdict that is gone, such as a reset approval, clears the record so the next one is stated again.
  if (!review) { if (previous !== undefined) ctx.threads.patch(thread, { review: undefined }); return }
  if (review.verdict === previous) return
  ctx.threads.patch(thread, { review: review.verdict })
  const who = review.by.join(', ')
  const text = `${who} approved ${host.term} #${iid}. Read the review and answer it before calling the work done.`
  await ctx.receive({ id: key('review', host.source, String(iid), review.verdict, who), source: host.source,
    threads: [{ source: host.source, id: thread.startsWith(`${host.source}:`) ? thread.slice(host.source.length + 1) : String(iid) }],
    actor: { source: host.source, id: review.by[0] ?? '' }, human: true, at: new Date().toISOString(), text,
    meta: { isPr: true, number: iid, kind: 'review', review: review.verdict } })
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
 * Observes the merge requests of open tickets, so a merge or close ends a ticket even when no note arrives, and so an approval
 * given without a note reaches the ticket on the merge request's own Thread.
 * One failed read records the error on the merge request's Thread and leaves the other tickets alone.
 * --- @ty.aicoding@1793952619352 ---
 */
export async function pollTicketMrs(ctx: SourceContext): Promise<void> {
  // A Source the tests drive without a deployment has no merge requests to observe.
  const host = ctx.change?.() ?? (ctx.deployment ? gitlabChange(ctx.deployment) : undefined)
  if (!host) return
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => changesOf(host, ticket, true)))]
  for (const iid of iids) {
    try {
      const change = await host.read(ctx, iid)
      await announceReview(ctx, host, iid, change)
      await observeChange(ctx, host, change)
      ctx.threads.patch(changeThread(host, iid), { pollError: undefined })
    } catch (error) {
      ctx.threads.patch(changeThread(host, iid), { pollError: String(error) })
    }
  }
}
