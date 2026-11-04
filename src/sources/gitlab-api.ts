/**
 * Minimal GitLab REST transport: reads the deployment's token file, builds API URLs for one project, and pages results.
 * --- @ty.aicoding@ ---
 */
import { readFileSync } from 'node:fs'
import { CliError } from '../infra/commands.ts'

/** Where one self-hosted GitLab instance lives and which token file authenticates its account. */
export interface GitlabServer {
  /** Base URL of the instance, such as `https://gitlab.example.com`; a trailing slash is ignored. */
  url: string
  /** File holding the token, either alone or as a `NAME=value` line. */
  tokenFile: string
  /** Variable a `NAME=value` token file is read by; defaults to `VLIVE_GITLAB_TOKEN`. */
  tokenVariable?: string
}
/** Options of one API call; `query` values set to undefined are left out, so defaults list them once. */
export interface GitlabRequest {
  method?: 'GET' | 'POST' | 'PUT' | undefined
  query?: Record<string, string | number | boolean | undefined> | undefined
  body?: unknown
  signal?: AbortSignal | undefined
}

const TIMEOUT_MS = 30_000
const PAGES_MAX = 20
const VARIABLE = 'VLIVE_GITLAB_TOKEN'

/**
 * Reads the API token from a file that either contains the token alone or sets it on a `NAME=value` line.
 * A file with variable lines is read by its variable name (the configured `tokenVariable`, defaulting to `VLIVE_GITLAB_TOKEN`), so the
 * deployment can point at an existing credential file instead of copying the secret.
 * --- @ty.aicoding@ ---
 */
export function readToken(server: Pick<GitlabServer, 'tokenFile' | 'tokenVariable'>): string {
  const variable = server.tokenVariable || VARIABLE
  let content: string
  try { content = readFileSync(server.tokenFile, 'utf8') }
  catch (error) {
    throw new CliError(`GitLab token file ${server.tokenFile} cannot be read: ${(error as Error).message}`)
  }
  const lines = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const assignment = new RegExp(`^(?:export\\s+)?${variable}\\s*=\\s*(.*)$`)
  for (const line of lines) {
    const match = assignment.exec(line)
    if (match) return unquote(match[1] ?? '')
  }
  const raw = lines.length === 1 && !lines[0]!.includes('=') ? unquote(lines[0]!) : ''
  if (raw) return raw
  throw new CliError(`GitLab token file ${server.tokenFile} does not set ${variable}`)
}
/** Trims the quotes a shell-style assignment may put around a token. */
function unquote(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 1 && (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1) : trimmed
}
/** API root of an instance URL, ignoring a trailing slash. */
export const apiBase = (url: string): string => `${url.trim().replace(/\/+$/, '')}/api/v4`
/** The `:id` path segment of a project given by its full path, such as `group/project`. */
export const projectId = (path: string): string => encodeURIComponent(path.trim().replace(/^\/+|\/+$/g, ''))

/**
 * Calls one API path on behalf of the account and returns the parsed JSON body.
 * Non-2xx responses become `CliError` carrying the HTTP status, so callers can treat a deleted target (404) differently from a retryable failure.
 * --- @ty.aicoding@ ---
 */
export async function gitlab<T>(server: GitlabServer, path: string, request: GitlabRequest = {}): Promise<T> {
  const url = new URL(`${apiBase(server.url)}${path.startsWith('/') ? '' : '/'}${path}`)
  for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
  const success = await call(server, url, request)
  if (success.status === 204) return undefined as T
  return await success.json() as T
}

/**
 * Reads every page of a list endpoint, following GitLab's `X-Next-Page` header, and concatenates the items.
 * Pages are capped so a malformed header cannot loop forever; callers narrow with `per_page` and a query filter.
 * --- @ty.aicoding@ ---
 */
export async function gitlabPages<T>(server: GitlabServer, path: string, request: GitlabRequest = {}): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= PAGES_MAX; page++) {
    const url = new URL(`${apiBase(server.url)}${path.startsWith('/') ? '' : '/'}${path}`)
    for (const [name, value] of Object.entries({ per_page: 100, ...request.query, page })) if (value !== undefined) url.searchParams.set(name, String(value))
    const success = await call(server, url, request)
    items.push(...await success.json() as T[])
    const next = Number(success.headers.get('x-next-page') ?? '')
    if (!next) return items
    page = next - 1
  }
  return items
}
/** Performs the request, mapping transport failures and non-2xx bodies to a `CliError`. */
async function call(server: GitlabServer, url: URL, request: GitlabRequest): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, {
      method: request.method ?? 'GET', signal,
      headers: { 'PRIVATE-TOKEN': readToken(server), ...request.body === undefined ? {} : { 'content-type': 'application/json' } },
      ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
    })
  } catch (error) {
    throw new CliError(`GitLab request failed: ${(error as Error).message}`)
  }
  if (response.ok) return response
  throw new CliError(await failure(response), response.status)
}
/** Renders an API error body without echoing the request or its headers. */
async function failure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown }
    const message = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : ''
    if (message) return `GitLab ${response.status}: ${message.slice(0, 500)}`
  } catch { /* Non-JSON error pages are summarized by the status line below. */ }
  return `GitLab ${response.status} ${response.statusText}`.trim()
}
