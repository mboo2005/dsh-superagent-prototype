/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChangeHost } from './change.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'


/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /**
   * Every configured instance: each installed kind's own instance followed by its stored project instances, in ID order,
   * and last the stored instances whose kind is not installed (with their config kept as stored).
   * --- @ty.aicoding@ ---
   */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => [
      { ...this.build(kind, settings.sources[kind.kind], kind.kind), installed: true },
      ...Object.entries(settings.sources)
        .filter(([id, stored]) => id !== kind.kind && stored.kind === kind.kind)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, stored]) => ({ ...this.build(kind, stored, id, settings.sources[kind.kind]?.config), installed: true })),
    ])
    const orphaned = Object.entries(settings.sources).filter(([id, stored]) => !this.kinds.has(stored.kind ?? id))
      .map(([id, stored]) => ({ id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  /** The configured instance `id`, which may be a kind id or a project instance id. */
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    return this.resolve(id, settings)?.instance as SourceInstance<C> | undefined
  }
  /**
   * The installed kind serving stored instance `id`; the id may name the kind itself or one of its project instances.
   * --- @ty.aicoding@ ---
   */
  kindOf(id: string, settings = this.settings()): SourceKind | undefined { return this.resolve(id, settings)?.kind }
  /**
   * Validates one submitted instance. A `kind` other than the instance id stores a project instance: its submitted fields
   * are validated over the kind instance's configuration and only those fields are kept, so the rest keeps inheriting.
   * --- @ty.aicoding@ ---
   */
  validate(id: string, value: { enabled: boolean; kind?: string; config: unknown }): { enabled: boolean; kind?: string; config: Record<string, unknown> } {
    const kind = this.kinds.get(value.kind ?? id)
    if (!kind) throw new Error(`Source kind not installed: ${value.kind ?? id}`)
    if (!value.kind || value.kind === id) return { enabled: value.enabled, config: kind.schema.parse(value.config) }
    const base = this.settings().sources[value.kind]?.config ?? {}
    const fields = Object.keys(value.config as Record<string, unknown>)
    const parsed = kind.schema.parse({ ...base, ...value.config as Record<string, unknown> }) as Record<string, unknown>
    return { enabled: value.enabled, kind: value.kind, config: Object.fromEntries(fields.map(field => [field, parsed[field]])) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindOf(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindOf(id, settings)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const resolved = this.resolve(channel.source, settings)
    if (!resolved) return false
    return resolved.instance.enabled && (resolved.kind.channel?.allowed?.(channel.address, resolved.instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      return kind?.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.resolve(message.channel.source)?.kind
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.resolve(channel.source)?.kind.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.resolve(trigger.source)?.kind.repliesTo?.(trigger) }
  /**
   * The change lifecycle adapter of the kind whose Thread prefix is `source`, if that kind has one.
   * --- @ty.aicoding@ ---
   */
  change(source: string, deployment: Deployment): ChangeHost | undefined {
    return this.resolve(source)?.kind.change?.(deployment)
  }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const resolved = this.resolve(trigger.source, settings)
    const context = resolved?.kind.threadContext
    if (!resolved || !context) return undefined
    const { kind, instance: { config } } = resolved
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const resolved = this.resolve(input.source, settings)
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!resolved) return settings.sources[input.source] ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const { kind, instance } = resolved
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Resolves the kind serving stored instance `id` and builds that instance over its kind instance's configuration. */
  private resolve(id: string, settings = this.settings()): { kind: SourceKind; instance: SourceInstance } | undefined {
    const stored = settings.sources[id]
    const kindId = stored?.kind ?? id
    const kind = this.kinds.get(kindId)
    if (!kind) return undefined
    const base = kindId === id ? undefined : settings.sources[kindId]?.config
    return { kind, instance: this.build(kind, stored, id, base) }
  }
  /**
   * Parses an instance's stored configuration over its kind instance's configuration, falling back to schema defaults
   * and disabling the instance when stored configuration fails validation.
   * --- @ty.aicoding@ ---
   */
  private build(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined, id: string, base?: Record<string, unknown>): SourceInstance {
    const source = base ? { ...base, ...stored?.config } : stored?.config ?? {}
    const parsed = kind.schema.safeParse(source)
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
