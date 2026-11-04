import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/infra/commands.ts'
import { apiBase, gitlab, gitlabPages, projectId, readToken } from '../src/sources/gitlab-api.ts'

const directories: string[] = []
const tokenFile = (content: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-token-'))
  directories.push(directory)
  const file = join(directory, 'token.env')
  writeFileSync(file, content)
  return file
}
const server = (content: string) => ({ url: 'https://gitlab.example.com/', tokenFile: tokenFile(content) })
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('GitLab transport', () => {
  it('reads a token that is the only line of its file', () => {
    expect(readToken(server('  s3cret\n'))).toBe('s3cret')
  })
  it('reads a token from an exported assignment and strips quotes', () => {
    expect(readToken(server('# credential file\nexport VLIVE_GITLAB_TOKEN="abc"\nOTHER=1\n'))).toBe('abc')
  })
  it('reads the configured variable name', () => {
    expect(readToken({ tokenFile: tokenFile('GITLAB_TOKEN=x\n'), tokenVariable: 'GITLAB_TOKEN' })).toBe('x')
  })
  it('reports a token file without the variable', () => {
    expect(() => readToken(server('OTHER=1\n'))).toThrow(CliError)
  })
  it('builds the API root and project identifier', () => {
    expect(apiBase('http://gitlab2.example.com/')).toBe('http://gitlab2.example.com/api/v4')
    expect(projectId('/group/sub/project/')).toBe('group%2Fsub%2Fproject')
  })
  it('sends the token header and query, and parses JSON', async () => {
    const fetch = vi.fn(async () => json({ id: 7 }))
    vi.stubGlobal('fetch', fetch)
    const result = await gitlab<{ id: number }>(server('t'), '/projects/group%2Fproject', { query: { simple: true, page: 1, omit: undefined } })
    expect(result.id).toBe(7)
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://gitlab.example.com/api/v4/projects/group%2Fproject?simple=true&page=1')
    expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('t')
  })
  it('raises the HTTP status and the API message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: '404 Project Not Found' }, 404)))
    const error = await gitlab(server('t'), '/projects/none').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe(404)
    expect((error as CliError).message).toContain('404 Project Not Found')
  })
  it('concatenates pages until the next page header is empty', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json([1, 2], 200, { 'x-next-page': '2' }))
      .mockResolvedValueOnce(json([3], 200, { 'x-next-page': '' }))
    vi.stubGlobal('fetch', fetch)
    expect(await gitlabPages<number>(server('t'), '/projects/group%2Fproject/issues')).toEqual([1, 2, 3])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
