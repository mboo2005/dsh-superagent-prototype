/**
 * Kind-neutral change (pull or merge request) lifecycle: ticket binding, state observation, and terminal notices.
 * --- @ty.aicoding@ ---
 */
import { key, liveTicket, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'

/**
 * A pull or merge request reduced to what ticket binding, state observation, and terminal notices need.
 * --- @ty.aicoding@ ---
 */
export interface Change {
  /** Host-local number, used as the Thread ID after the Source prefix. */
  id: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  /** Author login (or username). */
  author: string
  /** Source branch and the repository the change comes from; `repository` is null when the host does not report it. */
  head: { ref: string; repository: string | null }
  /** Whether auto-merge was requested; undefined when the host has no such feature or did not report it. */
  autoMerge?: boolean | undefined
  /** When the host reported the merge or closure, if it did. */
  endedAt?: string | undefined
}

/**
 * What a Source kind supplies to the generic change lifecycle: how changes are named, where they live, and how they appear.
 * --- @ty.aicoding@ ---
 */
export interface ChangeHost {
  /** Source prefix of a change's Thread, such as `github` or `gitlab-web`. */
  source: string
  /** What the host calls a change in messages: `PR` or `MR`. */
  term: string
  /** Login of the account changes are opened by. */
  account: string
  /** Full name (or project path) of the repository a change targets; a change from another repository is not the agent's. */
  repository: string
  /** Facts a change states on its Thread (`null` removes one); each kind owns its fact IDs. */
  facts(change: Change): Record<string, ThreadFact | null>
  /** Absolute URL of a change, for terminal notices. */
  link(id: number): string
  /** The Thread key of one of this host's changes, such as `github:12` or `gitlab:mr:12`. */
  thread(id: number): string
  /** The change number a Thread key of this Source names, or undefined for a Thread that is not a change of this host. */
  id(thread: string): number | undefined
  /** Reads the change's current state from the host, so the Executor can claim the change a report names. */
  read(ctx: SourceContext, id: number, signal?: AbortSignal): Promise<Change>
}

/**
 * The parts of a ChangeHost a terminal notice needs, for a caller that has no deployment at hand.
 * --- @ty.aicoding@ ---
 */
export type NoticeHost = Pick<ChangeHost, 'source' | 'term' | 'link' | 'id'>

/**
 * The Thread key of a change on its Source.
 * --- @ty.aicoding@ ---
 */
export const changeThread = (host: Pick<ChangeHost, 'thread'>, id: number): string => host.thread(id)
/** The change number a Thread key of this host names, or undefined for another Thread. */
export const changeIn = (host: Pick<ChangeHost, 'id'>, thread: string): number | undefined => host.id(thread)
/** The changes a ticket follows, oldest first; `open` keeps the ones not yet closed. */
export const changesOf = (host: Pick<ChangeHost, 'id'>, ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => changeIn(host, item.thread) ?? [])
/** The newest change a ticket follows (the last open one, else the last closed), if any. */
export const changeOf = (host: Pick<ChangeHost, 'id'>, ticket: Pick<Ticket, 'follows'>): number | undefined =>
  changesOf(host, ticket, true).at(-1) ?? changesOf(host, ticket).at(-1)
/** True when the change was opened by the agent's account from a branch in the configured repository (not a fork). */
export const agentChange = (change: Change, host: Pick<ChangeHost, 'account' | 'repository'>): boolean =>
  sameName(change.author, host.account) && sameName(change.head.repository ?? '', host.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name

/**
 * Validates and binds an open change to a ticket when the change is either the ticket's origin change or an agent-authored change on the ticket's branch, enforcing that one change binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the change is bound or not open (which is not an error).
 * --- @ty.aicoding@ ---
 */
export function claimChange(ctx: SourceContext, host: ChangeHost, ticketId: string, change: Change): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return `Ticket ended because its ${host.term} was closed`
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === host.source && source.meta.isPr === true && source.meta.number === change.id
  const opened = agentChange(change, host) && ticketBranch(ticket, change.head.ref)
  if (!started && !opened) {
    return `${host.term} does not belong to this ticket: use the source ${host.term} or a ${host.term} by ${host.account} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no ${host.term} exists`
  }
  const owner = ctx.tickets.open().find(item => changesOf(host, item, true).includes(change.id))
  if (owner && owner.id !== ticketId) return `${host.term} already belongs to another active ticket`
  const follow = ticket.follows?.find(item => item.thread === changeThread(host, change.id))
  if (change.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, host, ticketId, change, opened)
  return undefined
}
/**
 * Reconciles a polled change's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent change auto-binds to the single open ticket on its branch unless that ticket already follows another open
 * change (which only the Executor's report changes).
 * @returns whether the change has ended.
 * --- @ty.aicoding@ ---
 */
export async function observeChange(ctx: SourceContext, host: ChangeHost, change: Change): Promise<boolean> {
  const ended = change.state === 'closed' || change.merged
  if (ended) closeChange(ctx, host, change)
  else {
    const candidates = agentChange(change, host) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, change.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A change the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === changeThread(host, change.id) && item.closed)
    if (ticket && (reopened || changesOf(host, ticket, true).every(id => id === change.id))) claimChange(ctx, host, ticket.id, change)
  }
  ctx.threads.describe(changeThread(host, change.id), { facts: host.facts(change) })
  return ended
}
/**
 * The ThreadRef of a change, read back from the key the host names it by, so a bound Thread and `host.id` agree. A GitLab
 * change's id is `mr:<iid>`, not the bare number, and binding the bare number would leave `changesOf` unable to find the
 * follow again: the ticket would never observe its change close, and a merge would never end it.
 * --- @ty.aicoding@1793938961579 ---
 */
const changeRef = (host: ChangeHost, id: number): { source: string; id: string } => {
  const thread = host.thread(id)
  return { source: host.source, id: thread.startsWith(`${host.source}:`) ? thread.slice(host.source.length + 1) : String(id) }
}
/**
 * Binds the change's Thread to the ticket and records the change on it.
 * --- @ty.aicoding@1793938961579 ---
 */
function bind(ctx: SourceContext, host: ChangeHost, ticketId: string, change: Change, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, changeRef(host, change.id), own)
    ctx.threads.patch(changeThread(host, change.id), { number: change.id, isPr: true, url: change.url, prAuthor: change.author })
  })
}
/**
 * Reports a merged or closed change once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the change's Thread stays so a later human comment there resumes the ticket.
 * --- @ty.aicoding@ ---
 */
function closeChange(ctx: SourceContext, host: ChangeHost, change: Change): void {
  if (!ctx.tickets.open().some(ticket => changesOf(host, ticket, true).includes(change.id))) return
  const at = change.endedAt ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: host.source, id: String(change.id) }, change.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with a change (selecting the last-closed change
 * it opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it
 * contains Han characters and no kana, otherwise English. A change's own Source channels need no notice, because its
 * timeline already shows the merge or closure.
 * --- @ty.aicoding@ ---
 */
export function endNotices(ticket: Ticket, request: string, hostFor: (source: string) => NoticeHost | undefined): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  if (outcome !== 'merged' && outcome !== 'closed') return []
  const closed = (ticket.follows ?? []).flatMap(item => {
    const host = hostFor(item.thread.split(':')[0] ?? '')
    const number = host?.id(item.thread)
    return item.closed && host && number !== undefined ? [{ item, host, number, at: item.closed.at }] : []
  })
  const latest = (entries: typeof closed) => [...entries].sort((a, b) => b.at.localeCompare(a.at))[0]
  const chosen = latest(closed.filter(entry => entry.item.own)) ?? latest(closed)
  if (!chosen) return []
  const { host, number } = chosen
  const url = host.link(number)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const label = `[${host.term} #${number}](${url})`
  const text = chinese
    ? outcome === 'merged' ? `${label} 已合并。` : `${label} 已关闭，未合并。`
    : outcome === 'merged' ? `${label} has merged.` : `${label} was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== host.source).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome),
    channel, text, kind: 'notice', ticketId: ticket.id }))
}
