/// <reference types="node" />
/** Host half of Prompt Studio: reversible component activation and request-local composition. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AssistantMessage,
  GenerateOptions,
  Message,
  MessageId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {
  AssembledSection,
  AssembleContext,
  PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'
import { createStudioScope, type StudioScope } from './settings-scope.ts'
import { captureInjectedMessages, requestLayout } from './capture.ts'
import {
  CapturedResourceConflictError,
  CapturedResourceNotFoundError,
  loadCapturedResource,
  saveCapturedResource,
} from './resource.ts'
import {
  PROMPT_STUDIO_MESSAGE_SOURCE,
  PROMPT_STUDIO_NAMESPACE,
  PROMPT_STUDIO_OVERRIDE_MARKER_PREFIX,
  PROMPT_STUDIO_RESOURCE_PATH,
  PROMPT_STUDIO_SETTINGS_PATH,
  PROMPT_STUDIO_STATE_PATH,
  isNativeOverride,
  renderSupplementBoundary,
  sessionEvents,
  validatePromptComponents,
  type CapturedPromptComponent,
  type NativeOverride,
  type PromptComponent,
  type PromptStudioSettingsSnapshot,
  type RuntimePromptCatalog,
  type StudioConfig,
} from './shared.ts'

export {
  DEFAULT_SUPPLEMENT_ORDER,
  PROMPT_STUDIO_NAMESPACE,
  PROMPT_STUDIO_RESOURCE_PATH,
  PROMPT_STUDIO_SETTINGS_PATH,
  PROMPT_STUDIO_STATE_PATH,
  PROMPT_STUDIO_VIEW_ORDER,
  buildDraftSystemComponents,
  isNativeOverride,
  nextOverrideId,
  nextSupplementId,
  renderSystemPreview,
  renderSupplementBoundary,
  sessionEvents,
  validatePromptComponents,
} from './shared.ts'
export type {
  CapturedContextResource,
  CapturedPromptComponent,
  CapturedResourceSnapshot,
  NativeOverride,
  PromptComponent,
  PromptComponentKind,
  PromptComponentPosition,
  PromptComponentRole,
  RuntimePromptCatalog,
  StudioConfig,
} from './shared.ts'
export { studioConfigSchema } from './config.ts'

/**
 * dsh >= 0.1.7-rc.2: the loader resolves this schema and passes the parsed
 * value to `apply(ctx, config)`. On older hosts it is inert — `apply` picks
 * the live settings namespace when `ctx.settings.register` exists.
 */
export { studioConfigSchema as Config } from './config.ts'

/** Branded Host settings key. */
export const PROMPT_STUDIO_SETTINGS_NAMESPACE = PROMPT_STUDIO_NAMESPACE as SettingsNamespace

/** Stable Cordis plugin name. */
export const name = 'client-ui-prompt-studio'

/**
 * Host services required by the component and request pipelines.
 *
 * Both host generations ship the `settings` service — 0.1.6 with the live
 * `register` API, 0.1.7-rc.2+ with a service that only carries `configure`.
 * The scope adapter in `settings-scope.ts` feature-detects the available one.
 */
export const inject = ['settings', 'systemPrompt', 'llm', 'sessions']

const SYSTEM_SECTION_PREFIX = 'prompt-studio:supplement-section:'

function markerName(target: string): string {
  return `${PROMPT_STUDIO_OVERRIDE_MARKER_PREFIX}${target}`
}

function systemSectionName(id: string): string {
  return `${SYSTEM_SECTION_PREFIX}${id}`
}

function cloneComponent(component: PromptComponent): PromptComponent {
  return { ...component }
}

/** Live values contributed by currently active configuration effects. */
class RuntimeBindings {
  readonly ownedSectionNames = new Set<string>()
  readonly overridesByMarker = new Map<string, NativeOverride>()
  readonly systemBySection = new Map<string, PromptComponent>()
  readonly supplements = new Map<string, PromptComponent>()

  /** Activate one component and return its composed inverse. */
  activate(ctx: Context, component: PromptComponent): () => void {
    if (component.kind === 'native') throw new TypeError(`native prompt component "${component.id}" cannot be activated from settings`)
    if (isNativeOverride(component)) {
      const snapshot = { ...component, origin: component.origin }
      const marker = markerName(snapshot.origin)
      return ctx.effect(function* (this: RuntimeBindings) {
        this.ownedSectionNames.add(marker)
        this.overridesByMarker.set(marker, snapshot)
        if (snapshot.enabled && snapshot.role === 'system') {
          this.systemBySection.set(marker, snapshot)
        } else if (snapshot.enabled) {
          this.supplements.set(snapshot.id, snapshot)
        }
        yield () => {
          this.supplements.delete(snapshot.id)
          this.systemBySection.delete(marker)
          this.overridesByMarker.delete(marker)
          this.ownedSectionNames.delete(marker)
        }
        yield ctx.systemPrompt.section({
          name: marker,
          order: snapshot.order,
          text: snapshot.enabled && snapshot.role === 'system'
            ? renderSupplementBoundary(snapshot.id, snapshot.template)
            : '',
        })
      }.bind(this), `prompt-studio: override ${snapshot.origin}`)
    }
    if (!component.enabled) return ctx.effect(() => () => undefined, `prompt-studio: disabled ${component.id}`)
    const snapshot = cloneComponent(component)
    if (snapshot.role === 'system') {
      const sectionName = systemSectionName(snapshot.id)
      return ctx.effect(function* (this: RuntimeBindings) {
        this.ownedSectionNames.add(sectionName)
        this.systemBySection.set(sectionName, snapshot)
        yield () => {
          this.systemBySection.delete(sectionName)
          this.ownedSectionNames.delete(sectionName)
        }
        yield ctx.systemPrompt.section({
          name: sectionName,
          order: snapshot.order,
          text: renderSupplementBoundary(snapshot.id, snapshot.template),
        })
      }.bind(this), `prompt-studio: system supplement ${component.id}`)
    }
    return ctx.effect(function* (this: RuntimeBindings) {
      this.supplements.set(snapshot.id, snapshot)
      yield () => { this.supplements.delete(snapshot.id) }
    }.bind(this), `prompt-studio: supplement ${component.id}`)
  }
}

/** Replaces a complete configuration by recovering and reapplying one composed effect. */
class ComponentPipeline {
  private recover: () => void = () => undefined

  constructor(
    private readonly ctx: Context,
    private readonly bindings: RuntimeBindings,
  ) {}

  replace(components: readonly PromptComponent[]): void {
    validatePromptComponents(components)
    this.recover()
    const snapshots = components.map(cloneComponent)
    this.recover = this.ctx.effect(function* (this: ComponentPipeline) {
      for (const component of snapshots) yield this.bindings.activate(this.ctx, component)
    }.bind(this), 'prompt-studio: configured component set')
  }
}

function applyOverrides(
  assembly: PromptAssembly,
  overridesByMarker: ReadonlyMap<string, NativeOverride>,
): Set<string> {
  const matchedOverrideIds = new Set<string>()
  if (overridesByMarker.size === 0) return matchedOverrideIds
  const presentNames = new Set(assembly.sections.map(section => section.name))
  const matchedMarkers = new Set<string>()
  const replacedTargets = new Set<string>()
  for (const [marker, override] of overridesByMarker) {
    if (!presentNames.has(marker) || !presentNames.has(override.origin)) continue
    matchedMarkers.add(marker)
    replacedTargets.add(override.origin)
    matchedOverrideIds.add(override.id)
  }
  assembly.sections = assembly.sections.flatMap((section) => {
    const override = overridesByMarker.get(section.name)
    if (override !== undefined) {
      return matchedMarkers.has(section.name) && override.enabled && override.role === 'system'
        ? [section]
        : []
    }
    return replacedTargets.has(section.name) ? [] : [section]
  })
  return matchedOverrideIds
}

function runtimeNative(
  sections: readonly AssembledSection[],
  ownedSectionNames: ReadonlySet<string>,
): PromptComponent[] {
  return sections
    .filter(section => !ownedSectionNames.has(section.name))
    .map((section, order) => ({
      id: section.name,
      kind: 'native',
      role: 'system',
      order,
      enabled: true,
      template: section.text,
    }))
}

function effectiveAssembly(
  sections: readonly AssembledSection[],
  systemBySection: ReadonlyMap<string, PromptComponent>,
): PromptComponent[] {
  return sections.map((section, order) => {
    const supplement = systemBySection.get(section.name)
    if (supplement !== undefined) {
      const snapshot = { ...supplement, template: section.text }
      delete snapshot.position
      return snapshot
    }
    return {
      id: section.name,
      kind: 'native',
      role: 'system',
      order,
      enabled: true,
      template: section.text,
    }
  })
}

/** Latest value-level snapshot of the runtime registry. */
class RuntimeCatalogStore {
  private revision = 0
  private native: PromptComponent[] = []
  private assembled: PromptComponent[] = []
  private readonly requests = new Map<string, {
    captured: CapturedPromptComponent[]
    layout: RuntimePromptCatalog['layout']
  }>()
  private latestSessionId: string | undefined

  commit(native: readonly PromptComponent[], assembled: readonly PromptComponent[]): void {
    const nextNative = native.map(cloneComponent)
    const nextAssembled = assembled.map(cloneComponent)
    if (
      JSON.stringify(nextNative) === JSON.stringify(this.native)
      && JSON.stringify(nextAssembled) === JSON.stringify(this.assembled)
    ) return
    this.native = nextNative
    this.assembled = nextAssembled
    this.revision += 1
  }

  commitRequest(sessionId: string, messages: readonly Message[]): void {
    const next = {
      captured: captureInjectedMessages(messages),
      layout: requestLayout(messages),
    }
    const previous = this.requests.get(sessionId)
    this.latestSessionId = sessionId
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return
    this.requests.set(sessionId, structuredClone(next))
    this.revision += 1
  }

  snapshot(requestedSessionId?: string): RuntimePromptCatalog {
    const sessionId = requestedSessionId ?? this.latestSessionId
    const request = sessionId === undefined ? undefined : this.requests.get(sessionId)
    return {
      revision: this.revision,
      native: this.native.map(cloneComponent),
      assembled: this.assembled.map(cloneComponent),
      ...sessionId === undefined ? {} : { sessionId },
      captured: request === undefined ? [] : structuredClone(request.captured),
      layout: request === undefined
        ? { messageCount: 0, userAnchor: null }
        : { ...request.layout },
    }
  }

  capturedResource(
    sessionId: string,
    componentId: string,
    resourceId: string,
  ): CapturedPromptComponent['resources'][number] | undefined {
    const component = this.requests.get(sessionId)?.captured.find(item => item.id === componentId)
    const resource = component?.resources.find(item => item.id === resourceId)
    return resource === undefined ? undefined : { ...resource }
  }
}

export function latestUserInput(agent: Agent): string | undefined {
  const events = sessionEvents(agent.session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    return event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  return undefined
}

/** One seed turn folding all configured user/assistant supplements. */
function injectionSeedTurn(components: readonly PromptComponent[]): {
  userText: string
  assistantText: string
} | undefined {
  const userText = components
    .filter(component => component.role === 'user')
    .map(component => renderSupplementBoundary(component.id, component.template))
    .join('\n\n')
  const assistantText = components
    .filter(component => component.role === 'assistant')
    .map(component => renderSupplementBoundary(component.id, component.template))
    .join('\n\n')
  if (userText.length === 0 && assistantText.length === 0) return undefined
  return { userText, assistantText }
}

/**
 * Append the configured injection dialogue as the session seed turn (turn 0,
 * before the agent's first real turn). The user message carries a plain user
 * source so message-edit treats it as the turn's user input; the assistant
 * message keeps plugin provenance for tracing.
 */
function appendInjectionTurn(session: Session, components: readonly PromptComponent[]): void {
  const seed = injectionSeedTurn(components)
  if (seed === undefined) return
  const { userText, assistantText } = seed
  const turn = 0
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (userText.length > 0) {
    session.append('user/message', {
      id: crypto.randomUUID() as MessageId,
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
  }
  if (assistantText.length > 0) {
    session.append('assistant/message', {
      turn,
      step: 1,
      message: {
        id: crypto.randomUUID() as MessageId,
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        // Plugin provenance kept for tracing; the wire accepts non-model
        // sources at runtime (verified), the cast satisfies the model-source
        // type contract of AssistantMessage.
        source: { kind: 'plugin', plugin: PROMPT_STUDIO_MESSAGE_SOURCE },
      } as unknown as AssistantMessage,
      // dsh 0.1.6 makes the compacted model stream a required field; a
      // synthetic injection turn carries no model stream, so it stays empty.
      stream: [],
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function rewriteRequest(
  catalog: RuntimeCatalogStore,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  if (options.sessionId === undefined || options.purpose !== undefined) return next()
  catalog.commitRequest(String(options.sessionId), options.messages)
  return next()
}

function respondJson(response: ServerResponse, status: number, value: unknown, head = false): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(head ? undefined : body)
}

function requestJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => { chunks.push(chunk) })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch (error: unknown) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://prompt-studio.local')
}

interface CapturedResourceSelection {
  sessionId: string
  componentId: string
  resourceId: string
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} 必须是非空字符串。`)
  return value
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} 必须是字符串。`)
  return value
}

function resourceSelectionFromUrl(request: IncomingMessage): CapturedResourceSelection {
  const params = requestUrl(request).searchParams
  return {
    sessionId: requiredString(params.get('sessionId'), 'sessionId'),
    componentId: requiredString(params.get('componentId'), 'componentId'),
    resourceId: requiredString(params.get('resourceId'), 'resourceId'),
  }
}

function resourceUpdate(value: unknown): CapturedResourceSelection & { content: string; expectedDigest: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('请求体必须是 JSON 对象。')
  }
  const record = value as Record<string, unknown>
  return {
    sessionId: requiredString(record['sessionId'], 'sessionId'),
    componentId: requiredString(record['componentId'], 'componentId'),
    resourceId: requiredString(record['resourceId'], 'resourceId'),
    content: requiredText(record['content'], 'content'),
    expectedDigest: requiredString(record['expectedDigest'], 'expectedDigest'),
  }
}

function selectedResource(
  ctx: Context,
  catalog: RuntimeCatalogStore,
  selection: CapturedResourceSelection,
): { cwd: string; resource: CapturedPromptComponent['resources'][number] } {
  const session = ctx.sessions.get(selection.sessionId as SessionId)
  if (session === undefined) {
    throw new CapturedResourceNotFoundError(`会话不存在：${selection.sessionId}`)
  }
  const resource = catalog.capturedResource(
    selection.sessionId,
    selection.componentId,
    selection.resourceId,
  )
  if (resource === undefined || !resource.editable) {
    throw new CapturedResourceNotFoundError('捕获项没有可编辑的文件资源。')
  }
  return { cwd: session.header.cwd ?? '.', resource }
}

function resourceErrorStatus(error: unknown): number {
  if (error instanceof TypeError) return 400
  if (error instanceof CapturedResourceNotFoundError) return 404
  if (error instanceof CapturedResourceConflictError) return 409
  return 500
}

function settingsSnapshot(scope: StudioScope): PromptStudioSettingsSnapshot {
  const value = scope.get()
  return {
    writable: true,
    revision: scope.revision,
    value: { components: value.components.map(cloneComponent) },
  }
}

function settingsUpdate(value: unknown): { components: PromptComponent[]; expectedRevision: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('请求体必须是 JSON 对象。')
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record['expectedRevision']) || (record['expectedRevision'] as number) < 0) {
    throw new TypeError('expectedRevision 必须是非负安全整数。')
  }
  if (!Array.isArray(record['components'])) throw new TypeError('components 必须是数组。')
  const components = structuredClone(record['components']) as PromptComponent[]
  validatePromptComponents(components)
  return { components, expectedRevision: record['expectedRevision'] as number }
}

function installRoutes(ctx: Context, scope: StudioScope, catalog: RuntimeCatalogStore): void {
  ctx.inject(['webServer'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: PROMPT_STUDIO_STATE_PATH,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405)
          response.end()
          return
        }
        const sessionId = requestUrl(request).searchParams.get('sessionId') ?? undefined
        respondJson(response, 200, catalog.snapshot(sessionId), request.method === 'HEAD')
      },
    }), 'prompt-studio: runtime catalog route')
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: PROMPT_STUDIO_SETTINGS_PATH,
      handler: async (request, response) => {
        try {
          if (request.method === 'GET' || request.method === 'HEAD') {
            respondJson(response, 200, settingsSnapshot(scope), request.method === 'HEAD')
            return
          }
          if (request.method === 'POST') {
            const update = settingsUpdate(await requestJson(request))
            // Refuse a stale write here so the client keeps its 409 contract.
            if (scope.revision !== update.expectedRevision) {
              throw new Error(`prompt-studio settings revision conflict: expected ${update.expectedRevision}, current ${scope.revision}`)
            }
            await scope.replace({ components: update.components })
            respondJson(response, 200, settingsSnapshot(scope))
            return
          }
          response.writeHead(405)
          response.end()
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          respondJson(response, error instanceof TypeError ? 400 : 409, { error: message })
        }
      },
    }), 'prompt-studio: settings route')
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: PROMPT_STUDIO_RESOURCE_PATH,
      handler: async (request, response) => {
        try {
          if (request.method === 'GET' || request.method === 'HEAD') {
            const selected = selectedResource(routeCtx, catalog, resourceSelectionFromUrl(request))
            const snapshot = await loadCapturedResource(selected.cwd, selected.resource)
            respondJson(response, 200, snapshot, request.method === 'HEAD')
            return
          }
          if (request.method === 'POST') {
            const update = resourceUpdate(await requestJson(request))
            const selected = selectedResource(routeCtx, catalog, update)
            const snapshot = await saveCapturedResource(
              selected.cwd,
              selected.resource,
              update.content,
              update.expectedDigest,
            )
            respondJson(response, 200, snapshot)
            return
          }
          response.writeHead(405)
          response.end()
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          respondJson(response, resourceErrorStatus(error), { error: message })
        }
      },
    }), 'prompt-studio: captured resource route')
  })
}

/** Register the unified component pipeline; config source depends on host generation. */
export async function apply(ctx: Context, liveConfig?: StudioConfig): Promise<void> {
  const scope: StudioScope = await createStudioScope(ctx, liveConfig)
  const bindings = new RuntimeBindings()
  const pipeline = new ComponentPipeline(ctx, bindings)
  const catalog = new RuntimeCatalogStore()

  ctx.systemPrompt.variable('user_input', context => context.agent === undefined
    ? undefined
    : latestUserInput(context.agent))

  ctx.on('system-prompt/assemble', async (assembly, _context: AssembleContext, next) => {
    const native = runtimeNative(assembly.sections, bindings.ownedSectionNames)
    applyOverrides(assembly, bindings.overridesByMarker)
    const resolved = await next()
    catalog.commit(native, effectiveAssembly(resolved.sections, bindings.systemBySection))
    return resolved
  }, { prepend: true })

  let refreshRequested = false
  let refreshTask: Promise<void> | undefined
  const requestRefresh = (): void => {
    refreshRequested = true
    if (refreshTask !== undefined) return
    refreshTask = (async () => {
      while (refreshRequested) {
        refreshRequested = false
        await ctx.systemPrompt.assemble()
      }
    })().catch((error: unknown) => {
      ctx.logger.warn('prompt-studio: runtime prompt discovery failed')
      ctx.logger.warn(error)
    }).finally(() => {
      refreshTask = undefined
      if (refreshRequested) requestRefresh()
    })
  }

  ctx.on('system-prompt/change', requestRefresh)
  ctx.on('llm/stream', (options, next) => rewriteRequest(catalog, options, next))
  ctx.on('session/created', (session) => {
    try {
      appendInjectionTurn(session, [...bindings.supplements.values()])
    } catch (error: unknown) {
      ctx.logger.warn('prompt-studio: injection seed turn failed')
      ctx.logger.warn(error)
    }
  }, { prepend: true })
  installRoutes(ctx, scope, catalog)

  const initial = scope.get()
  validatePromptComponents(initial.components)
  pipeline.replace(initial.components)
  ctx.effect(() => scope.watch((next) => {
    validatePromptComponents(next.components)
    pipeline.replace(next.components)
  }), 'prompt-studio: settings component source')

  await ctx.systemPrompt.assemble()
}
