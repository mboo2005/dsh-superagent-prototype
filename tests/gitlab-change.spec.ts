import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { Deployment } from '../src/deployment.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { asChange, claimMr, gitlabChange, mrOf, mrsOf, pollTicketMrs, readMr, type GitlabMr } from '../src/sources/gitlab-change.ts'

const project: NonNullable<Deployment['gitlab']> = { url: 'https://gitlab.example.com', host: 'gitlab.example.com',
  project: 'group/project', cli: 'glab-agent', account: 'agent', email: 'agent@example.com' }
const mr = (over: Partial<GitlabMr> = {}): GitlabMr => ({
  iid: 5, title: 'Fix the widget', web_url: 'https://gitlab.example.com/group/project/-/merge_requests/5', state: 'opened',
  author: { username: 'agent' }, source_branch: 'agent/ticket', source_project_id: 1, target_project_id: 1, ...over,
})
const context = (options: { mr?: GitlabMr; fail?: Error; tickets?: Ticket[]; deployment?: Deployment['gitlab'] } = {}) => {
  const run = vi.fn(async () => {
    if (options.fail) throw options.fail
    return JSON.stringify(options.mr ?? mr())
  })
  const patch = vi.fn(), describe = vi.fn(), threadClosed = vi.fn()
  const ctx = {
    deployment: { gitlab: options.deployment ?? project },
    commands: { run, withSignal: vi.fn(() => ({ run })) },
    config: () => ({}),
    tickets: { open: () => options.tickets ?? [], get: vi.fn(), threadClosed },
    threads: { patch, describe },
    atomic: (action: () => void) => action(),
    triggers: { get: () => undefined },
  } as unknown as SourceContext
  return { ctx, run, patch, describe, threadClosed }
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
  it('reads one merge request through the project CLI and refuses without a GitLab project', async () => {
    const { ctx, run } = context()
    await expect(readMr(ctx, { gitlab: project }, 5)).resolves.toMatchObject({ iid: 5 })
    expect(run).toHaveBeenCalledWith('glab-agent', ['api', '--hostname', 'gitlab.example.com', 'projects/group%2Fproject/merge_requests/5'])
    await expect(readMr(ctx, { gitlab: undefined }, 5)).rejects.toThrow('no GitLab project')
    expect(claimMr({ ...context().ctx, deployment: { gitlab: undefined } } as SourceContext, 'ticket-1', mr())).toBe('This installation has no GitLab project')
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
})
