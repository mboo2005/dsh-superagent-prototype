/**
 * Normalizes GitLab issues, merge requests and their notes into domain Triggers, and reduces a merge request to the
 * generic change lifecycle's `Change`.
 * --- @ty.aicoding@ ---
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { Change } from './change.ts'

export const SOURCE = 'gitlab'
/** What an issue or merge request is called where its thread lives. */
export type Noteable = 'issue' | 'merge_request'
/** The part of `{ project, iid }` targets needed to address, link and report one thread. */
export interface GitlabTarget { project: string; iid: number; kind: Noteable; url: string }
/** GitLab's account record; `name` is a display name and may be absent for a deleted account. */
export const UserSchema = z.looseObject({ id: z.number(), username: z.string(), name: z.string().nullish() })
export type GitlabUser = z.infer<typeof UserSchema>
/** One note on an issue or merge request; GitLab sets `system` on notes it writes itself (state changes, assignments). */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), noteable_id: z.number().nullish(), noteable_iid: z.number().nullish(), noteable_type: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** An issue or merge request as the list and single-object endpoints return it. */
export const ObjectSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  author: UserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(), web_url: z.string(),
  source_branch: z.string().nullish(), target_branch: z.string().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  draft: z.boolean().nullish(), work_in_progress: z.boolean().nullish(),
})
export type GitlabObject = z.infer<typeof ObjectSchema>
/** The web address of an issue or merge request, used when a note does not carry its own. */
export const objectUrl = (target: Pick<GitlabTarget, 'url'>): string => target.url
/** True for accounts GitLab runs itself, such as `project_12_bot`; every other account is treated as a person. */
export const isHumanUser = (user: { username: string }): boolean => !/_bot$/.test(user.username)
/** True when `text` mentions `@username` as a whole account name. */
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`, 'i').test(text)

/**
 * The reply address of a thread: the object's URL, project and number, which the channel needs to post a note and build a link.
 * --- @ty.aicoding@ ---
 */
export const gitlabChannel = (target: GitlabTarget): ChannelRef =>
  ({ source: SOURCE, thread: String(target.iid), address: { project: target.project, iid: String(target.iid), kind: target.kind, url: target.url } })

/**
 * Builds the Trigger for a note on an issue or merge request.
 * The ID includes the note's `updated_at` so an edited note is ingested again, as GitHub comments are.
 * --- @ty.aicoding@ ---
 */
export function noteTrigger(note: GitlabNote, target: GitlabTarget, agent: string): Trigger {
  const version = note.updated_at ?? note.created_at ?? ''
  const text = note.body ?? ''
  return {
    id: key('gitlab-note', target.project, String(note.id), version), source: SOURCE,
    threads: [{ source: SOURCE, id: String(target.iid) }],
    actor: { source: SOURCE, id: note.author.username }, human: isHumanUser(note.author) && !sameName(note.author.username, agent),
    at: version || new Date().toISOString(), text, ...(mentions(text, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(target), url: target.url,
    meta: { project: target.project, iid: target.iid, kind: target.kind, noteId: note.id },
  }
}
/**
 * Builds the Trigger for a newly opened issue or merge request's title and description.
 * --- @ty.aicoding@ ---
 */
export function objectTrigger(object: GitlabObject, target: GitlabTarget, agent: string): Trigger {
  const text = [object.title, object.description ?? ''].filter(Boolean).join('\n\n')
  const at = object.created_at ?? new Date().toISOString()
  return {
    id: key('gitlab-object', target.project, String(target.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(target.iid) }],
    actor: { source: SOURCE, id: object.author.username }, human: isHumanUser(object.author) && !sameName(object.author.username, agent),
    at, text, ...(mentions(object.description ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(target), url: target.url,
    meta: { project: target.project, iid: target.iid, kind: target.kind },
  }
}
/**
 * Reduces a merge request to the generic change, mapping a merged MR's `merged_at` to the end time.
 * --- @ty.aicoding@ ---
 */
export function mergeChange(mr: GitlabObject, project: string): Change {
  const merged = !!mr.merged_at
  const ended = mr.merged_at ?? mr.closed_at
  return { id: mr.iid, url: mr.web_url, state: mr.state === 'opened' ? 'open' : 'closed', merged, author: mr.author.username,
    head: { ref: mr.source_branch ?? '', repository: project }, ...ended ? { endedAt: ended } : {} }
}
