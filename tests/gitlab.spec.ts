/** Unit tests for the GitLab Source: configuration, trigger parsing, polling, channel replies and thread context. */
import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/core/index.ts'
import { key } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { GitlabConfigSchema, gitlabKind, gitlabLink, gitlabThreadContext, noteTrigger, pollRound, sendGitlab, todoTrigger,
  type GitlabConfig } from '../src/sources/gitlab.ts'
import type { SourceContext } from '../src/sources/host.ts'

const config = (overrides: Partial<GitlabConfig> = {}): GitlabConfig => GitlabConfigSchema.parse({ url: 'https://gitlab.example.com',
  project: 'group/sub/project', account: 'agent', ...overrides })
const thread = (id: string, meta: Record<string, unknown> = {}): Thread => ({ key: `gitlab:${id}`, ref: { source: 'gitlab', id },
  createdAt: '2026-01-01T00:00:00.000Z', subscriptions: ['ticket'], correlated: [], pending: [], meta })
const note = (id: number, body: string, created_at = '2026-01-02T00:00:00.000Z', author: { username: string; bot?: boolean } = { username: 'alice' }) =>
  ({ id, body, author, created_at, updated_at: created_at })
const context = (value: GitlabConfig, overrides: Partial<SourceContext> = {}): SourceContext => ({
  commands: { run: vi.fn() }, configured: () => true, config: () => value, receive: vi.fn(),
  threads: { subscribed: () => [], patch: vi.fn(), describe: vi.fn(), get: vi.fn() },
  ...overrides,
} as unknown as SourceContext)

describe('GitLab configuration', () => {
  it('fills defaults and treats an unconfigured instance as unusable', async () => {
    const empty = GitlabConfigSchema.parse({})
    expect(empty).toMatchObject({ url: '', project: '', cli: 'glab', account: '', pollSeconds: 60, failuresBeforeError: 3, observeTodos: true, observeNotes: true })
    const ctx = context(empty)
    expect(await pollRound(ctx)).toBe(60)
    expect(ctx.commands.run).not.toHaveBeenCalled()
    expect(await pollRound(context(config({ url: 'https://' })))).toBe(60)
  })
  it('describes the kind as a Source peer with its own project path', () => {
    expect(gitlabKind.kind).toBe('gitlab')
    expect(gitlabKind.health).toEqual(['gitlab'])
    expect(gitlabKind.schema.parse({ url: 'https://gitlab.example.com', project: 'group/project', account: 'agent' }))
      .toMatchObject({ project: 'group/project', account: 'agent' })
  })
})

describe('GitLab triggers', () => {
  it('turns a note on an issue into a mention trigger with a GitLab channel address', () => {
    const trigger = noteTrigger(note(7, '@agent please look'), { kind: 'issue', iid: 12, project: 'group/project', cli: 'glab',
      host: 'gitlab.example.com' }, config({ project: 'group/project' }))
    expect(trigger.id).toBe(key('gitlab-note', 'group/project', 'issue', '12', '7', '2026-01-02T00:00:00.000Z'))
    expect(trigger.threads).toEqual([{ source: 'gitlab', id: 'issue:12' }])
    expect(trigger.addressed).toBe('mention')
    expect(trigger.human).toBe(true)
    expect(trigger.channel?.address).toEqual({ kind: 'issue', iid: '12', project: 'group/project', cli: 'glab', host: 'gitlab.example.com' })
  })
  it('does not treat the agent\'s own notes or bots as human', () => {
    const place = { kind: 'mr' as const, iid: 3, project: 'group/project', cli: 'glab', host: 'gitlab.example.com' }
    expect(noteTrigger(note(1, 'mine', undefined, { username: 'agent' }), place, config()).human).toBe(false)
    expect(noteTrigger(note(2, 'ci', undefined, { username: 'ci', bot: true }), place, config()).human).toBe(false)
  })
  it('turns an assigned to-do into a direct trigger and ignores other target types', () => {
    const todo = { id: 5, author: { username: 'alice' }, action_name: 'assigned', target_type: 'MergeRequest',
      target: { iid: 9, title: 'Fix it', web_url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/9' },
      target_url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/9',
      body: '', created_at: '2026-01-02T00:00:00.000Z' }
    const trigger = todoTrigger(todo, config())
    expect(trigger?.threads).toEqual([{ source: 'gitlab', id: 'mr:9' }])
    expect(trigger?.addressed).toBe('direct')
    expect(todoTrigger({ ...todo, target_type: 'Epic', target: { iid: 1 } }, config())).toBeUndefined()
    expect(todoTrigger({ ...todo, target: { iid: 9, title: 'Fix it' }, target_url: undefined }, config())).toBeUndefined()
    expect(todoTrigger({ ...todo, target_url: 'https://gitlab.example.com/other/project/-/issues/1',
      target: { iid: 9, web_url: 'https://gitlab.example.com/other/project/-/issues/1' } }, config())).toBeUndefined()
  })
})

describe('GitLab polling', () => {
  const notes = [note(1, 'old', '2026-01-01T00:00:00.000Z'), note(2, 'new', '2026-01-03T00:00:00.000Z')]
  const run = vi.fn(async (_program: string, args: string[]) => {
    const path = args[3] ?? ''
    if (path.startsWith('todos')) return JSON.stringify([])
    return JSON.stringify(notes)
  })
  it('seeds the note cursor on the first read without receiving history', async () => {
    const patch = vi.fn(), receive = vi.fn()
    const ctx = context(config(), { commands: { run } as unknown as SourceContext['commands'],
      receive: receive as unknown as SourceContext['receive'],
      threads: { subscribed: () => [thread('issue:12')], patch, describe: vi.fn(), get: vi.fn() } })
    await pollRound(ctx)
    expect(receive).not.toHaveBeenCalled()
    expect(patch).toHaveBeenCalledWith('gitlab:issue:12', { gitlabNoteId: 2 })
  })
  it('starts an empty thread at zero so its first note is received', async () => {
    const empty = vi.fn(async (_program: string, args: string[]) => args[3]?.startsWith('todos') ? '[]' : '[]')
    const receive = vi.fn(), patch = vi.fn()
    const ctx = context(config(), { commands: { run: empty } as unknown as SourceContext['commands'],
      receive: receive as unknown as SourceContext['receive'],
      threads: { subscribed: () => [thread('issue:12')], patch, describe: vi.fn(), get: vi.fn() } })
    await pollRound(ctx)
    expect(patch).toHaveBeenCalledWith('gitlab:issue:12', { gitlabNoteId: 0 })
    const first = vi.fn(async (_program: string, args: string[]) => args[3]?.startsWith('todos') ? '[]' : JSON.stringify([note(9, 'first')]))
    await pollRound(context(config(), { commands: { run: first } as unknown as SourceContext['commands'],
      receive: receive as unknown as SourceContext['receive'],
      threads: { subscribed: () => [thread('issue:12', { gitlabNoteId: 0 })], patch, describe: vi.fn(), get: vi.fn() } }))
    expect(receive).toHaveBeenCalledTimes(1)
  })
  it('receives only notes newer than the cursor, skipping the agent and system notes', async () => {
    const latest = [note(2, 'old', '2026-01-03T00:00:00.000Z'), note(3, 'mine', '2026-01-04T00:00:00.000Z', { username: 'agent' }),
      { ...note(4, 'system', '2026-01-04T00:00:00.000Z'), system: true }, note(5, 'new', '2026-01-05T00:00:00.000Z')]
    const run2 = vi.fn(async (_program: string, args: string[]) => args[3]?.startsWith('todos') ? '[]' : JSON.stringify(latest))
    const receive = vi.fn()
    const ctx = context(config(), { commands: { run: run2 } as unknown as SourceContext['commands'],
      receive: receive as unknown as SourceContext['receive'],
      threads: { subscribed: () => [thread('issue:12', { gitlabNoteId: 2 })], patch: vi.fn(), describe: vi.fn(), get: vi.fn() } })
    await pollRound(ctx)
    expect(run2.mock.calls.some(call => call[1][3]?.includes('sort=desc'))).toBe(true)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0]![0]).toMatchObject({ text: 'new', threads: [{ source: 'gitlab', id: 'issue:12' }] })
  })
  it('processes a newest-first page in chronological order', async () => {
    const page = [note(5, 'newest', '2026-01-05T00:00:00.000Z'), note(4, 'older', '2026-01-04T00:00:00.000Z'),
      note(3, 'old', '2026-01-03T00:00:00.000Z')]
    const run = vi.fn(async (_program: string, args: string[]) => args[3]?.startsWith('todos') ? '[]' : JSON.stringify(page))
    const receive = vi.fn()
    await pollRound(context(config(), { commands: { run } as unknown as SourceContext['commands'],
      receive: receive as unknown as SourceContext['receive'],
      threads: { subscribed: () => [thread('issue:12', { gitlabNoteId: 3 })], patch: vi.fn(), describe: vi.fn(), get: vi.fn() } }))
    expect(receive.mock.calls.map(call => call[0].text)).toEqual(['older', 'newest'])
  })
  it('receives pending to-dos and skips the agent\'s own', async () => {
    const todos = [{ id: 1, author: { username: 'alice' }, action_name: 'assigned', target_type: 'Issue', target: { iid: 4, title: 'Do it', web_url: 'https://gitlab.example.com/group/sub/project/-/issues/4' },
      created_at: '2026-01-02T00:00:00.000Z' },
    { id: 2, author: { username: 'agent' }, action_name: 'assigned', target_type: 'Issue', target: { iid: 4, title: 'Do it', web_url: 'https://gitlab.example.com/group/sub/project/-/issues/4' },
      created_at: '2026-01-02T00:00:00.000Z' },
    { id: 3, author: { username: 'alice' }, action_name: 'assigned', target_type: 'Commit', target: null,
      created_at: '2026-01-02T00:00:00.000Z' },
    { id: 4, author: { username: 'alice' }, action_name: 'build_failed', target_type: 'Issue', target: { iid: 4, title: 'Do it', web_url: 'https://gitlab.example.com/group/sub/project/-/issues/4' },
      created_at: '2026-01-02T00:00:00.000Z' }]
    const run3 = vi.fn(async (_program: string, args: string[]) => args[3]?.startsWith('todos') ? JSON.stringify(todos) : '[]')
    const receive = vi.fn()
    const ctx = context(config({ observeNotes: false }), { commands: { run: run3 } as unknown as SourceContext['commands'],
      receive: receive as unknown as SourceContext['receive'] })
    await pollRound(ctx)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0]![0]).toMatchObject({ text: 'Do it', meta: { kind: 'issue', iid: 4 } })
  })
})

describe('GitLab channel', () => {
  const message = { id: 'm1', text: 'hello', channel: { address: { kind: 'issue', iid: '12', project: 'group/project', cli: 'glab', host: 'gitlab.example.com' } } }
  it('posts a note once and treats an existing marker as sent', async () => {
    const run = vi.fn(async (_program: string, args: string[]) => args.includes('--method') ? '{}' : JSON.stringify([{ id: 1, body: '<!-- dsh-superagent:m1 -->',
      author: { username: 'agent' }, created_at: '2026-01-01T00:00:00.000Z' }]))
    expect(await sendGitlab({ commands: { run } as unknown as SourceContext['commands'] }, message)).toBe('sent')
    expect(run).toHaveBeenCalledTimes(1)
    const post = vi.fn(async (_program: string, args: string[]) => args.includes('--method') ? '{}' : '[]')
    expect(await sendGitlab({ commands: { run: post } as unknown as SourceContext['commands'] }, message)).toBe('sent')
    const sent = post.mock.calls.find(call => call[1].includes('--method'))!
    expect(sent[1]).toContain('body=hello\n\n<!-- dsh-superagent:m1 -->')
  })
  it('reports a deleted target as gone', async () => {
    const run = vi.fn(async () => { throw new CliError('not found', 404) })
    expect(await sendGitlab({ commands: { run } as unknown as SourceContext['commands'] }, message)).toBe('gone')
  })
  it('links a thread and rejects another project', () => {
    expect(gitlabLink({ kind: 'mr', iid: '9', url: 'https://gitlab.example.com/group/project/-/merge_requests/9' }, {})).toEqual({
      url: 'https://gitlab.example.com/group/project/-/merge_requests/9', label: { zh: 'GitLab MR !9', en: 'GitLab MR !9' } })
    expect(gitlabLink({ kind: 'issue', iid: '12' }, {}).label).toEqual({ zh: 'GitLab Issue #12', en: 'GitLab Issue #12' })
    expect(gitlabKind.channel?.allowed?.({ kind: 'issue', iid: '1', project: 'other/project' }, config())).toBe(false)
    expect(gitlabKind.channel?.allowed?.({ kind: 'issue', iid: '1', project: 'GROUP/SUB/PROJECT' }, config())).toBe(true)
  })
})

describe('GitLab reads and search', () => {
  it('reads a thread body and its notes', async () => {
    const run = vi.fn(async (_program: string, args: string[]) => JSON.stringify(args[3]?.endsWith('/notes?sort=asc&order_by=created_at&per_page=100')
      ? [note(1, 'first')] : { iid: 12, title: 'Broken', description: 'details', author: { username: 'alice' } }))
    const trigger = noteTrigger(note(1, 'first'), { kind: 'issue', iid: 12, project: 'group/project', cli: 'glab', host: 'gitlab.example.com' }, config())
    const part = await gitlabThreadContext.read({ run } as unknown as SourceContext['commands'], trigger, 'thread', undefined,
      config({ project: 'group/project' }))
    expect(part.body).toMatchObject({ title: 'Broken', description: 'details' })
    expect(part.messages).toEqual([{ id: '1', from: 'alice', at: '2026-01-02T00:00:00.000Z', text: 'first' }])
    expect(gitlabThreadContext.messageId(trigger)).toBe('1')
  })
  it('finds issues and MRs by number, URL and IID', () => {
    const find = gitlabKind.find!
    expect(find('12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(find('!12')).toEqual({ threads: ['gitlab:mr:12'], terms: [] })
    expect(find('https://gitlab.example.com/group/sub/project/-/merge_requests/7')).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
    expect(find('nothing')).toEqual({ threads: [], terms: [] })
  })
})
