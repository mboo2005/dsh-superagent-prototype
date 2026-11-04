/** GitHub pull requests as changes: the API shape, and the GitHub adapter of the kind-neutral change lifecycle. */
import { z } from 'zod'
import type { OutboundMessage, ThreadFact, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { agentChange, changeOf, changesOf, claimChange, endNotices, observeChange,
  type Change, type ChangeHost } from './change.ts'
import { githubPage, SOURCE, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** The fields a pulled payload carries, from the API or a bare fixture. */
type PullFields = Pick<Pull, 'number' | 'state' | 'html_url' | 'user' | 'head' | 'merged' | 'merged_at' | 'closed_at' | 'auto_merge'>
/**
 * Reduces a GitHub pull to the change the generic lifecycle reconciles.
 * --- @ty.aicoding@ ---
 */
const asChange = (pr: PullFields): Change => ({
  id: pr.number, url: pr.html_url ?? '', state: pr.state === 'closed' ? 'closed' : 'open', merged: !!pr.merged,
  author: pr.user.login, head: { ref: pr.head.ref, repository: pr.head.repo?.full_name ?? null },
  autoMerge: pr.auto_merge != null, endedAt: pr.merged_at ?? pr.closed_at ?? undefined,
})
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/**
 * The change lifecycle of GitHub pull requests in `deployment`.
 * --- @ty.aicoding@ ---
 */
export const githubChange = (deployment: Pick<Deployment, 'github' | 'repository'>): ChangeHost => ({
  source: SOURCE, term: 'PR', account: deployment.github.login, repository: deployment.repository,
  facts: change => ({ autoMerge: !(change.state === 'closed' || change.merged) && change.autoMerge ? AUTO_MERGE_ON : null }),
  link: id => githubPage(deployment.repository, id, true),
})
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] => changesOf({ source: SOURCE }, ticket, open)
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => changeOf({ source: SOURCE }, ticket)
export { ticketBranch } from './change.ts'
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', deployment.repository)
/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export const claimPull = (ctx: SourceContext, ticketId: string, pr: Pull): string | undefined =>
  claimChange(ctx, githubChange(ctx.deployment), ticketId, asChange(pr))
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export const observePull = (ctx: SourceContext, pr: Pull): Promise<boolean> =>
  observeChange(ctx, githubChange(ctx.deployment), asChange(pr))
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  return endNotices(ticket, request, source => source === SOURCE
    ? { source: SOURCE, term: 'PR', link: id => githubPage(repository, id, true) }
    : undefined)
}
