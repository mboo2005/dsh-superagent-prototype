/**
 * GitLab source kind: receives to-dos and notes on subscribed issues and merge requests, reads their discussion,
 * and posts replies through the agent's `glab` account. It is a peer of the GitHub Source and implements the same
 * `SourceKind` interface, so an installation may run either or both.
 * --- @ty.aicoding@ ---
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Thread, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, ContextMessage, ContextPart, ContextPartName, Localized, SourceKind, ThreadContext } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'gitlab'

/** Configuration of one GitLab instance and the project in it that this Source watches. */
export const GitlabConfigSchema = z.object({
  // The registry resolves an installed but disabled Source from `{}`, so these fields stay optional here and
  // `usable` decides whether the configured instance can poll.
  url: z.string().trim().default(''),
  project: z.string().trim().default(''),
  cli: z.string().trim().default('glab'),
  account: z.string().trim().default(''),
  email: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeTodos: z.boolean().default(true),
  observeNotes: z.boolean().default(true),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
/** True when the instance names an instance URL, project, account, and CLI; otherwise the Source stays paused. */
function usable(config: GitlabConfig): boolean {
  try {
    const url = new URL(config.url)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host
      && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(config.project) && !!config.account && !!config.cli
  } catch {
    return false
  }
}

const UserSchema = z.looseObject({ username: z.string(), name: z.string().nullish(), bot: z.boolean().optional() })
const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().optional(), web_url: z.string().nullish(),
})
const TargetSchema = z.looseObject({ iid: z.number().nullish(), title: z.string().nullish(), web_url: z.string().nullish(), project_id: z.number().nullish() })
const TodoSchema = z.looseObject({
  id: z.number(), author: UserSchema, action_name: z.string(), target_type: z.string(), target: TargetSchema.nullish(),
  body: z.string().nullish(), created_at: z.string(), target_url: z.string().nullish(),
})
const SubjectSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), web_url: z.string().nullish(), author: UserSchema,
})
export type GitlabNote = z.infer<typeof NoteSchema>
export type GitlabTodo = z.infer<typeof TodoSchema>

type Kind = 'issue' | 'mr'
/** Where a GitLab thread lives: enough to read it and to post a reply without the stored configuration. */
interface Place { kind: Kind; iid: number; project: string; cli: string; host: string; url?: string | undefined }

const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return '' }
}
const encoded = (project: string): string => encodeURIComponent(project)
const segment = (kind: Kind): string => kind === 'mr' ? 'merge_requests' : 'issues'
const threadId = (kind: Kind, iid: number): string => `${kind}:${iid}`
const place = (kind: Kind, iid: number, config: GitlabConfig, url?: string | undefined): Place =>
  ({ kind, iid, project: config.project, cli: config.cli, host: hostOf(config.url), ...url ? { url } : {} })
/** The write-only channel address of a GitLab thread; `cli` and `host` let a retained reply find its instance later. */
function addressOf(target: Place): Record<string, string> {
  return { kind: target.kind, iid: String(target.iid), project: target.project, cli: target.cli, host: target.host,
    ...target.url ? { url: target.url } : {} }
}
/** Reads a thread key such as `gitlab:issue:12` back into its kind and IID. */
function parseThread(id: string): { kind: Kind; iid: number } | undefined {
  const match = /^(issue|mr):(\d+)$/.exec(id)
  if (!match) return undefined
  return { kind: match[1] as Kind, iid: Number(match[2]) }
}
const mentioned = (text: string, account: string): boolean => {
  const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_.-])@${escaped}(?![A-Za-z0-9_.-])`, 'i').test(text)
}
const at = (value: string): string => {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}
/** Calls one GitLab API path through the configured CLI and validates its JSON payload. */
async function api<T>(ctx: Pick<SourceContext, 'commands'>, config: GitlabConfig, path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await ctx.commands.run(config.cli, ['api', '--hostname', hostOf(config.url), path])
  return schema.parse(JSON.parse(raw))
}
/** Calls the API of a place already recorded on a thread, using the CLI and host stored in its address. */
async function apiAt<T>(commands: SourceContext['commands'], target: Place, path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await commands.run(target.cli, ['api', '--hostname', target.host, path])
  return schema.parse(JSON.parse(raw))
}
/** Builds the Trigger for one note on an issue or merge request. */
export function noteTrigger(note: GitlabNote, target: Place, config: GitlabConfig): Trigger {
  const body = note.body ?? ''
  const edited = note.updated_at ?? note.created_at
  return { id: key('gitlab-note', target.project, target.kind, String(target.iid), String(note.id), edited), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(target.kind, target.iid) }],
    actor: { source: SOURCE, id: note.author.username },
    human: note.author.bot !== true && !sameName(note.author.username, config.account),
    ...mentioned(body, config.account) ? { addressed: 'mention' as const } : {},
    at: at(edited), text: body,
    channel: { source: SOURCE, thread: threadId(target.kind, target.iid), address: addressOf(target) },
    url: note.web_url ?? target.url ?? '', meta: { kind: target.kind, iid: target.iid, project: target.project, noteId: note.id, author: note.author.username } }
}
/** Builds the Trigger for one pending to-do, or undefined for a target type this Source does not watch. */
export function todoTrigger(todo: GitlabTodo, config: GitlabConfig): Trigger | undefined {
  if (!['assigned', 'mentioned', 'directly_addressed'].includes(todo.action_name)) return undefined
  const kind: Kind | undefined = todo.target_type === 'MergeRequest' ? 'mr' : todo.target_type === 'Issue' ? 'issue' : undefined
  const todoTarget = todo.target
  const iid = todoTarget?.iid
  if (!kind || !iid) return undefined
  const url = todoTarget.web_url ?? todo.target_url ?? undefined
  // The to-do list of one account spans every project; without a URL the project is unknown, so never answer it.
  if (!url || !config.url || !url.startsWith(`${config.url.replace(/\/$/, '')}/${config.project}/`)) return undefined
  const target = place(kind, iid, config, url)
  return { id: key('gitlab-todo', config.project, kind, String(iid), String(todo.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(kind, iid) }], actor: { source: SOURCE, id: todo.author.username },
    human: todo.author.bot !== true && !sameName(todo.author.username, config.account),
    addressed: todo.action_name === 'assigned' || todo.action_name === 'directly_addressed' ? 'direct' : 'mention',
    at: at(todo.created_at), text: todo.body?.trim() || todoTarget.title || '',
    channel: { source: SOURCE, thread: threadId(kind, iid), address: addressOf(target) }, url: todo.target_url ?? todoTarget.web_url ?? '',
    meta: { kind, iid, project: config.project, todoId: todo.id, action: todo.action_name, author: todo.author.username } }
}
/** The subject URL of the issue or merge request a thread belongs to. */
function subjectPath(target: Place): string {
  return `projects/${encoded(target.project)}/${segment(target.kind)}/${target.iid}`
}
/** Reads one page of notes; polling asks for the newest first so a busy thread cannot hide new notes. */
function notesPath(target: Place, order: 'asc' | 'desc' = 'asc'): string {
  return `${subjectPath(target)}/notes?sort=${order}&order_by=created_at&per_page=100`
}
/** Converts one GitLab note into the normalized message an assessment reads. */
function contextMessage(note: GitlabNote, target: Place): ContextMessage {
  return { id: String(note.id), from: note.author.username, at: at(note.updated_at ?? note.created_at), text: note.body ?? '',
    ...note.author.bot === true ? { bot: true as const } : {}, ...note.web_url ? { url: note.web_url } : {} }
}
/** The discussion around a GitLab issue or merge request, read through the configured CLI. */
export const gitlabThreadContext: ThreadContext<GitlabConfig> = {
  messageId: trigger => String(trigger.meta.noteId ?? trigger.meta.todoId ?? ''),
  async read(commands, trigger, part: ContextPartName, _cursor, config): Promise<ContextPart> {
    const kind = trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    const iid = Number(trigger.meta.iid)
    if (!iid) return { messages: [], body: {}, status: 'missing' }
    const target = place(kind, iid, config, trigger.url)
    const issue = await apiAt(commands, target, subjectPath(target), SubjectSchema)
    const body: Record<string, unknown> = { title: issue.title, description: issue.description ?? '', url: issue.web_url ?? '' }
    if (part === 'root') return { messages: [], body, status: 'ok' }
    const notes = await apiAt(commands, target, notesPath(target), z.array(NoteSchema))
    const messages = notes.map(note => contextMessage(note, target))
    return { messages, body, status: 'ok' }
  },
}
/** Posts a note with an embedded HTML marker so a retry does not duplicate the reply. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: { id: string; channel: { address: Record<string, string> }; text: string }): Promise<'sent' | 'gone'> {
  const { kind, iid, project, cli, host: instance } = message.channel.address
  const number = Number(iid)
  if ((kind !== 'issue' && kind !== 'mr') || !Number.isInteger(number) || number <= 0 || !project || !cli || !instance) return 'gone'
  const target: Place = { kind: kind === 'mr' ? 'mr' : 'issue', iid: number, project, cli, host: instance, url: message.channel.address.url }
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const existing = await apiAt(host.commands, target, notesPath(target, 'desc'), z.array(NoteSchema))
    if (existing.some(note => (note.body ?? '').includes(marker))) return 'sent'
    await host.commands.run(cli, ['api', '--hostname', instance, '--method', 'POST', `${subjectPath(target)}/notes`, '-f', `body=${message.text}\n\n${marker}`])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && (error.code === 404 || error.code === 410)) return 'gone'
    throw error
  }
}
/** The link shown for a GitLab thread, preferring the URL captured on its trigger. */
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const label = address.kind === 'mr' ? 'MR' : 'Issue'
  const number = `${address.kind === 'mr' ? '!' : '#'}${address.iid ?? ''}`
  return { url: address.url ?? '', label: { zh: `GitLab ${label} ${number}`, en: `GitLab ${label} ${number}` } }
}
/** Reads notes on a subscribed thread and ingests the ones that arrived since the last poll. */
async function pollNotes(ctx: SourceContext, config: GitlabConfig, thread: Thread): Promise<void> {
  const parsed = parseThread(thread.ref.id)
  if (!parsed) return
  const target = place(parsed.kind, parsed.iid, config, typeof thread.meta.url === 'string' ? thread.meta.url : undefined)
  const notes = (await api(ctx, config, notesPath(target, 'desc'), z.array(NoteSchema)))
    .sort((left, right) => left.id - right.id)
  const cursor = typeof thread.meta.gitlabNoteId === 'number' ? thread.meta.gitlabNoteId : undefined
  // A thread seen for the first time starts at its newest note: its earlier discussion is context, not new work.
  // Note ids grow within an instance, so a cursor on the newest id keeps notes written in the same second apart.
  if (cursor === undefined) {
    const newest = notes.map(note => note.id).sort((left, right) => left - right).at(-1) ?? 0
    ctx.threads.patch(thread.key, { gitlabNoteId: newest })
    return
  }
  let latest = cursor
  for (const note of notes) {
    if (note.id <= cursor) continue
    latest = Math.max(latest, note.id)
    if (note.system || sameName(note.author.username, config.account)) continue
    await ctx.receive(noteTrigger(note, target, config))
  }
  if (latest !== cursor) ctx.threads.patch(thread.key, { gitlabNoteId: latest })
}
/** One polling round: pending to-dos, then notes on every subscribed GitLab thread. */
export async function pollRound(ctx: SourceContext): Promise<number> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return 60
  if (!usable(config)) return 60
  if (config.observeTodos) {
    const todos = await api(ctx, config, 'todos?state=pending&per_page=100', z.array(TodoSchema))
    for (const todo of todos) {
      if (sameName(todo.author.username, config.account)) continue
      const trigger = todoTrigger(todo, config)
      if (trigger) await ctx.receive(trigger)
    }
  }
  if (config.observeNotes) {
    for (const thread of ctx.threads.subscribed(SOURCE)) await pollNotes(ctx, config, thread)
  }
  return config.pollSeconds
}
/** Source kind descriptor for a GitLab project; the same interface GitHub implements. */
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收发给它的待办和已订阅 Issue、MR 的讨论，通过 glab 回复。',
    en: 'The agent\'s GitLab account; receives its to-dos and discussion on subscribed Issues and MRs, and replies through glab.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'url', type: 'text', label: { zh: 'GitLab 地址', en: 'GitLab URL' },
      hint: { zh: '公司自建实例的地址，例如 https://gitlab.example.com；这里也决定 glab 用哪个 hostname。', en: 'The self-hosted instance URL, such as https://gitlab.example.com; it also selects the hostname glab uses.' } },
    { key: 'project', type: 'text', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project，可以有嵌套 group。这个来源只接收这个项目的待办和讨论。', en: 'Written group/project, with nested groups allowed. This Source receives only this project\'s to-dos and discussion.' } },
    { key: 'cli', type: 'text', advanced: true, label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR.' } },
    { key: 'account', type: 'text', label: { zh: '智能体的 GitLab 账号', en: 'Agent GitLab account' },
      hint: { zh: '用户名；用来识别它自己的评论和 @ 提及。', en: 'The username; used to recognize its own comments and mentions.' } },
    { key: 'email', type: 'text', advanced: true, label: { zh: '提交邮箱', en: 'Commit email' },
      hint: { zh: '留空时用 用户名@users.noreply.<实例域名>。', en: 'Empty uses username@users.noreply.<instance host>.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeTodos', type: 'switch', label: { zh: '接收待办', en: 'Receive to-dos' },
      hint: { zh: '打开后，GitLab 发给智能体的待办会成为候选。', en: 'When on, to-dos GitLab assigns to the agent become candidates.' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收已订阅讨论的新评论', en: 'Receive new comments on subscribed discussion' },
      hint: { zh: '只接收订阅发生之后的新评论，不读以前的。', en: 'Only comments after subscription are received; earlier ones are not read.' } },
  ],
  health: [SOURCE],
  // Every note on a subscribed Issue or MR is observed; to-dos are always addressed to the agent.
  scope: () => ({ listened: true, observed: true }),
  channel: { allowed: (address, config) => !!address.kind && !!address.iid && address.project?.toLowerCase() === config.project.toLowerCase(),
    send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const text = query.trim()
    const url = /gitlab[^/]*\/.+\/(?:-\/)?(issues|merge_requests)\/(\d+)/.exec(text)
    const mr = /^!(\d+)$/.exec(text)
    const plain = /^#?(\d+)$/.exec(text)
    const kind: Kind = url?.[1] === 'merge_requests' || mr ? 'mr' : 'issue'
    const iid = url?.[2] ?? mr?.[1] ?? plain?.[1]
    return { threads: iid ? [`${SOURCE}:${threadId(kind, Number(iid))}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或 MR 里 @ 智能体，或者给智能体派待办。', en: 'An account on the list mentions the agent in an Issue or MR, or assigns it a to-do.' },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '这个来源监听的 GitLab 实例地址', en: 'The GitLab instance this Source watches' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/project', en: 'The project this Source watches, as group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录', en: 'The agent\'s GitLab account; glab is signed in to it' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent\'s account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的是 issue 还是 mr；工单不是从 GitLab 来的时为空', en: 'Whether the ticket started from an issue or an mr; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或 MR 的 IID；工单不是从 GitLab 来的时为空', en: 'IID of the Issue or MR that started the ticket; empty when the ticket did not start on GitLab' } },
    ],
    values: ({ config, trigger }) => {
      const iid = trigger?.threads[0]?.source === SOURCE ? trigger.meta.iid : undefined
      return { DSH_SUPERAGENT_GITLAB_URL: config.url, DSH_SUPERAGENT_GITLAB_PROJECT: config.project,
        DSH_SUPERAGENT_GITLAB_ACCOUNT: config.account,
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: config.email || (config.url ? `${config.account}@users.noreply.${hostOf(config.url)}` : ''),
        DSH_SUPERAGENT_GITLAB_KIND: typeof iid === 'number' ? String(trigger?.meta.kind ?? '') : '',
        DSH_SUPERAGENT_GITLAB_IID: typeof iid === 'number' ? String(iid) : '' }
    },
  },
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
/** Registers the kind and starts its polling loop until the plugin unmounts. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Reports a failed poll once the configured threshold is reached, so one interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** Polls until aborted; setup keeps the source paused until the deployment resolves. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
      else if (!usable(config)) ctx.report(SOURCE, health('paused', 'setupPending'))
      else await pollRound(ctx)
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause(Math.max(60, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
