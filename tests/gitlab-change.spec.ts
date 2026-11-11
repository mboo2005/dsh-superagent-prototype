import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { Deployment } from '../src/deployment.ts'
import { CliError } from '../src/infra/commands.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { claimChange } from '../src/sources/change.ts'
import { asChange, approvalReview, claimMr, gitlabChange, mrOf, mrsOf, pollTicketMrs, readApprovals, readMr, type GitlabMr }
  from '../src/sources/gitlab-change.ts'

const project: NonNullable<Deployment['gitlab']> = { url: 'https://gitlab.example.com', host: 'gitlab.example.com',
  project: 'group/project', cli: 'glab-agent', account: 'agent', email: 'agent@example.com' }
const mr = (over: Partial<GitlabMr> = {}): GitlabMr => ({
  iid: 5, title: 'Fix the widget', web_url: 'https://gitlab.example.com/group/project/-/merge_requests/5', state: 'opened',
  author: { username: 'agent' }, source_branch: 'agent/ticket', source_project_id: 1, target_project_id: 1, ...over,
})
/**
 * A Source context whose one command answers both reads the change lifecycle makes: the merge request, and its approvals.
 * --- @ty.aicoding@1793953170445 ---
 */
const context = (options: { mr?: GitlabMr; approvals?: unknown; fail?: Error; tickets?: Ticket[]; deployment?: Deployment['gitlab'] } = {}) => {
  // One mock answers both reads the change lifecycle makes: the merge request itself, and its approvals.
  const run = vi.fn(async (_program: string, args: string[]) => {
    if (options.fail) throw options.fail
    const path = args[3] ?? ''
    return JSON.stringify(path.endsWith('/approvals') ? options.approvals ?? {} : options.mr ?? mr())
  })
  const patch = vi.fn(), describe = vi.fn(), threadClosed = vi.fn(), bindThread = vi.fn(), receive = vi.fn()
  const ctx = {
    deployment: { gitlab: options.deployment ?? project },
    commands: { run, withSignal: vi.fn(() => ({ run })) },
    config: () => ({}),
    tickets: { open: () => options.tickets ?? [], get: vi.fn(), threadClosed, bindThread },
    threads: { patch, describe, get: vi.fn() },
    atomic: (action: () => void) => action(),
    triggers: { get: () => undefined },
    receive,
  } as unknown as SourceContext
  return { ctx, run, patch, describe, threadClosed, bindThread, receive }
}
const followed = (thread: string, closed = false): Ticket => ({ follows: [{ thread, closed }] } as unknown as Ticket)

describe('GitLab merge requests as changes', () => {
  it('reduces an open merge request to an open change of the watched project', () => {
    expect(asChange(mr({ merge_when_pipeline_succeeds: true }), 'group/project')).toEqual({
      id: 5, url: 'https://gitlab.example.com/group/project/-/merge_requests/5', state: 'open', merged: false,
      author: 'agent', head: { ref: 'agent/ticket', repository: 'group/project' }, autoMerge: true, endedAt: undefined,
    })
  })
  it('reports a fork head as no repository and a merged or closed merge request as ended', () => {
    expect(asChange(mr({ source_project_id: 2 }), 'group/project').head.repository).toBeNull()
    expect(asChange(mr({ state: 'merged', merged_at: '2026-02-01T00:00:00.000Z' }), 'group/project'))
      .toMatchObject({ state: 'closed', merged: true, endedAt: '2026-02-01T00:00:00.000Z' })
    expect(asChange(mr({ state: 'closed', closed_at: '2026-02-02T00:00:00.000Z' }), 'group/project'))
      .toMatchObject({ state: 'closed', merged: false, endedAt: '2026-02-02T00:00:00.000Z' })
  })
  it('names the merge request host, thread number, link and auto-merge fact', () => {
    const host = gitlabChange({ gitlab: project })!
    expect(host).toMatchObject({ source: 'gitlab', term: 'MR', account: 'agent', repository: 'group/project' })
    expect(host.thread(5)).toBe('gitlab:mr:5')
    expect(host.id('gitlab:mr:5')).toBe(5)
    expect(host.id('github:pull:5')).toBeUndefined()
    expect(host.link(5)).toBe('https://gitlab.example.com/group/project/-/merge_requests/5')
    expect(host.facts!(asChange(mr({ merge_when_pipeline_succeeds: true }), 'group/project'))).toMatchObject({ autoMerge: { value: { en: 'on' } } })
    expect(host.facts!(asChange(mr({ state: 'merged', merged_at: '2026-02-01T00:00:00.000Z' }), 'group/project'))).toEqual({ autoMerge: null })
    expect(gitlabChange({ gitlab: undefined })).toBeUndefined()
  })
  it('builds a project instance\'s change host over its own configuration and thread prefix', () => {
    const two = { ...project, project: 'group/two' }
    const host = gitlabChange({ gitlab: project }, two, 'gitlab-two')!
    expect(host).toMatchObject({ source: 'gitlab-two', repository: 'group/two' })
    expect(host.thread(5)).toBe('gitlab-two:mr:5')
    expect(host.id('gitlab-two:mr:5')).toBe(5)
    expect(host.id('gitlab:mr:5')).toBeUndefined()
    expect(host.link(5)).toBe('https://gitlab.example.com/group/two/-/merge_requests/5')
  })
  it('reads one merge request through the project CLI and refuses without a GitLab project', async () => {
    const { ctx, run } = context()
    await expect(readMr(ctx, { gitlab: project }, 5)).resolves.toMatchObject({ iid: 5 })
    expect(run).toHaveBeenCalledWith('glab-agent', ['api', '--hostname', 'gitlab.example.com', 'projects/group%2Fproject/merge_requests/5'])
    await expect(readMr(ctx, { gitlab: undefined }, 5)).rejects.toThrow('no GitLab project')
    expect(claimMr({ ...context().ctx, deployment: { gitlab: undefined } } as SourceContext, 'ticket-1', mr())).toBe('This installation has no GitLab project')
  })
  /**
   * A bound merge request must be findable again by `mrOf`, or its merge would never end the ticket: the follow is stored under
   * the key `gitlab:mr:<iid>`, which is what `changeRef` derives from `host.thread`, not the bare IID.
   * --- @ty.aicoding@1793938961579 ---
   */
  it('binds a merge request to a ticket under the thread key it can read back', () => {
    const ticket = { id: 'ticket-1', follows: [], execution: { name: 'ticket' }, origin: { triggerId: 't' } } as unknown as Ticket
    const { ctx, bindThread } = context({ tickets: [ticket] })
    ;(ctx.tickets as unknown as { get: () => Ticket }).get = () => ticket
    const host = gitlabChange({ gitlab: project })!
    expect(claimChange(ctx, host, 'ticket-1', asChange(mr(), 'group/project'))).toBeUndefined()
    expect(bindThread).toHaveBeenCalledWith('ticket-1', { source: 'gitlab', id: 'mr:5' }, true)
    expect(mrOf({ follows: [{ thread: 'gitlab:mr:5' }] } as unknown as Ticket)).toBe(5)
  })
  it('treats only its own thread keys as followed merge requests', () => {
    const ticket = { follows: [{ thread: 'github:pull:3' }, { thread: 'gitlab:mr:5' }, { thread: 'gitlab:mr:7', closed: true }] } as unknown as Ticket
    expect(mrsOf(ticket)).toEqual([5, 7])
    expect(mrsOf(ticket, true)).toEqual([5])
    expect(mrOf(ticket)).toBe(5)
    expect(mrOf({ follows: [{ thread: 'github:pull:3' }] } as unknown as Ticket)).toBeUndefined()
  })
  it('observes the open merge requests of open tickets and records a failed read on their thread', async () => {
    const tickets = [followed('gitlab:mr:5'), followed('gitlab:mr:6')]
    const { ctx, patch, describe, threadClosed } = context({ mr: mr({ state: 'merged', merged_at: '2026-02-01T00:00:00.000Z' }), tickets })
    await pollTicketMrs(ctx)
    expect(threadClosed).toHaveBeenCalledTimes(2)
    // The close names the Thread `bind` stored, not the bare IID: `gitlab:<iid>` would match no follow and never end the ticket.
    expect(threadClosed).toHaveBeenCalledWith({ source: 'gitlab', id: 'mr:5' }, 'merged', '2026-02-01T00:00:00.000Z')
    expect(describe).toHaveBeenCalledWith('gitlab:mr:5', expect.anything())
    expect(patch).toHaveBeenCalledWith('gitlab:mr:5', { pollError: undefined })
    const failing = context({ fail: new Error('glab failed'), tickets })
    await pollTicketMrs(failing.ctx)
    expect(failing.patch).toHaveBeenCalledWith('gitlab:mr:5', { pollError: 'Error: glab failed' })
  })
  it('does nothing when the installation watches no GitLab project', async () => {
    const { ctx, run, patch } = context({ deployment: undefined })
    await pollTicketMrs(ctx)
    expect(run).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })
  /**
   * A reviewer who only approves writes no note, so the approval itself must reach the ticket: it is read with the merge
   * request, stated once on its Thread, and received as a message there.
   * --- @ty.aicoding@1793953033352 ---
   */
  it('reads an approval given without a note and states it once on the merge request\'s thread', async () => {
    const approvals = { approved: true, approved_by: [{ username: 'alice' }, { username: 'agent' }] }
    const { ctx, patch, receive } = context({ approvals, tickets: [followed('gitlab:mr:5')] })
    ;(ctx.threads as unknown as { get: () => { meta: Record<string, unknown> } }).get = () => ({ meta: {} })
    await pollTicketMrs(ctx)
    expect(patch).toHaveBeenCalledWith('gitlab:mr:5', { review: 'approved' })
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0]![0]).toMatchObject({ human: true, threads: [{ source: 'gitlab', id: 'mr:5' }], meta: { number: 5, kind: 'review' } })
    expect(receive.mock.calls[0]![0].text).toContain('alice approved MR #5')
    expect(receive.mock.calls[0]![0].text).not.toContain('agent')
  })
  it('states an approval once and ignores the agent\'s own', async () => {
    const stated = context({ approvals: { approved: true, approved_by: [{ username: 'alice' }] }, tickets: [followed('gitlab:mr:5')] })
    ;(stated.ctx.threads as unknown as { get: () => { meta: Record<string, unknown> } }).get = () => ({ meta: { review: 'approved' } })
    await pollTicketMrs(stated.ctx)
    expect(stated.receive).not.toHaveBeenCalled()
    expect(approvalReview({ approved: true, approved_by: [{ username: 'agent' }] }, 'agent')).toBeUndefined()
    expect(approvalReview({ approved: true, approved_by: [{ username: 'bob' }, { username: 'bob' }] }, 'agent')).toEqual({ verdict: 'approved', by: ['bob'] })
  })
  it('reports no approval when the instance does not serve the approvals endpoint', async () => {
    const run = vi.fn(async () => { throw new CliError('glab: HTTP 404', 404) })
    const ctx = { commands: { run, withSignal: vi.fn(() => ({ run })) } } as unknown as SourceContext
    await expect(readApprovals(ctx, project, 5)).resolves.toEqual({})
  })
})
