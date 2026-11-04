import { describe, expect, it } from 'vitest'
import { gitlabChannel, isHumanUser, mentions, mergeChange, noteTrigger, objectTrigger, type GitlabTarget } from '../src/sources/gitlab-trigger.ts'

const target: GitlabTarget = {
  project: 'shark/ai-live/app-api', iid: 154, kind: 'merge_request', url: 'http://gitlab.example.com/shark/ai-live/app-api/-/merge_requests/154',
}
const user = (username: string) => ({ id: 7, username, name: username.toUpperCase() })
const note = (body: string, overrides: Record<string, unknown> = {}) => ({
  id: 31, body, author: user('mabo1'), created_at: '2026-11-03T02:00:00.000Z', updated_at: '2026-11-03T02:00:00.000Z', system: false, ...overrides,
})
const merge = (overrides: Record<string, unknown> = {}) => ({
  id: 991, iid: 154, title: '直播基地实时生成', description: 'story 1-5', state: 'opened', author: user('mabo1'),
  created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', web_url: target.url,
  source_branch: 'agent/multi-project-support-4f09f023ff65', target_branch: 'master', merged_at: null, closed_at: null, ...overrides,
})

describe('GitLab triggers', () => {
  it('addresses a note thread and marks a human request', () => {
    const trigger = noteTrigger(note('@docapi 升级2：需要支持多个项目'), target, 'docapi')
    expect(trigger).toMatchObject({
      source: 'gitlab', threads: [{ source: 'gitlab', id: '154' }], actor: { source: 'gitlab', id: 'mabo1' },
      human: true, addressed: 'mention', url: target.url,
    })
    expect(trigger.channel).toEqual(gitlabChannel(target))
    expect(trigger.meta).toMatchObject({ project: target.project, iid: 154, kind: 'merge_request', noteId: 31 })
  })
  it('keeps the agent and GitLab bots out of the human senders', () => {
    expect(noteTrigger(note('doing it'), target, 'mabo1').human).toBe(false)
    expect(noteTrigger(note('done', { author: user('project_12_bot') }), target, 'docapi').human).toBe(false)
    expect(isHumanUser({ username: 'mabo1' })).toBe(true)
  })
  it('does not mark a note addressed without a mention', () => {
    expect(noteTrigger(note('ordinary discussion'), target, 'docapi').addressed).toBeUndefined()
    expect(mentions('@docapi please', 'docapi')).toBe(true)
    expect(mentions('@docapi2 please', 'docapi')).toBe(false)
    expect(mentions('mail me at x@docapi.example', 'docapi')).toBe(false)
  })
  it('re-ingests an edited note under a new trigger id', () => {
    const first = noteTrigger(note('v1'), target, 'docapi')
    const edited = noteTrigger(note('v2', { updated_at: '2026-11-03T03:00:00.000Z' }), target, 'docapi')
    expect(first.id).not.toBe(edited.id)
    expect(noteTrigger(note('v1'), target, 'docapi').id).toBe(first.id)
  })
  it('builds the trigger for an opened merge request from its title and description', () => {
    const trigger = objectTrigger(merge(), target, 'docapi')
    expect(trigger.text).toBe('直播基地实时生成\n\nstory 1-5')
    expect(objectTrigger(merge(), target, 'docapi').id).toBe(trigger.id)
    expect(objectTrigger(merge({ iid: 155 }), { ...target, iid: 155 }, 'docapi').id).not.toBe(trigger.id)
    expect(trigger.meta).toMatchObject({ iid: 154, kind: 'merge_request' })
  })
  it('reduces a merge request to a closed or merged change', () => {
    expect(mergeChange(merge(), target.project)).toMatchObject({
      id: 154, state: 'open', merged: false, author: 'mabo1', head: { ref: 'agent/multi-project-support-4f09f023ff65', repository: target.project },
    })
    const merged = mergeChange(merge({ state: 'merged', merged_at: '2026-11-02T00:00:00.000Z' }), target.project)
    expect(merged).toMatchObject({ state: 'closed', merged: true, endedAt: '2026-11-02T00:00:00.000Z' })
    const closed = mergeChange(merge({ state: 'closed', closed_at: '2026-11-02T00:00:00.000Z' }), target.project)
    expect(closed).toMatchObject({ state: 'closed', merged: false, endedAt: '2026-11-02T00:00:00.000Z' })
  })
})
