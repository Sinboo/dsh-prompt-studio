import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime, {
  createUserMessage,
  markAgentLoopRequest,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  PROMPT_STUDIO_SETTINGS_NAMESPACE,
  apply,
  inject,
} from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  constructor(ctx: Context, readonly doc: Record<string, unknown> = {}) { super(ctx) }
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

interface RegisteredRoute {
  path: string
  handler: (request: unknown, response: unknown) => void | Promise<void>
}

class MemoryWebServer {
  readonly routes = new Map<string, RegisteredRoute>()
  register(route: RegisteredRoute): () => void {
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  async get(path: string): Promise<{ status: number; value: unknown }> {
    const url = new URL(path, 'http://test')
    const route = this.routes.get(url.pathname)
    if (route === undefined) throw new Error(`missing route ${url.pathname}`)
    let status = 0
    let body = ''
    await route.handler({ method: 'GET', url: `${url.pathname}${url.search}` }, {
      writeHead(next: number) { status = next },
      end(next?: string) { body = next ?? '' },
    })
    return { status, value: JSON.parse(body) as unknown }
  }
}

async function boot(doc: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemorySettings, doc)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: 'Persona.' })
  const webServer = new MemoryWebServer()
  ctx.provide('webServer', webServer as never)
  const fiber = ctx.plugin({ name: 'prompt-studio-test', inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, webServer }
}

describe('Prompt Studio Host composition', () => {
  it('keeps the existing settings-backed system component pipeline live', async () => {
    const component = {
      id: 'supplement:system', kind: 'supplement', role: 'system',
      order: 20, enabled: true, template: 'Configured.',
    }
    const { ctx } = await boot({ 'prompt-studio': { components: [component] } })
    expect(ctx.settings.describe().find(row => row.ns === PROMPT_STUDIO_SETTINGS_NAMESPACE)).toMatchObject({
      value: { components: [component] }, applies: 'live',
    })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(
      'Persona.\n\nConfigured.',
    )
  })

  it('captures unknown context producers from a real frozen llm/stream request', async () => {
    const { ctx, webServer } = await boot()
    const sessionId = SessionId('capture-session')
    ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    const direct = createUserMessage({ content: [{ type: 'text', text: 'Go' }], source: { kind: 'user' } })
    const workspace = createUserMessage({
      content: [{ type: 'text', text: '<system-reminder>Instructions from: AGENTS.md</system-reminder>' }],
      source: {
        kind: 'workspace-instructions', form: 'instructions', baseline: true,
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'abc' }],
      },
    })
    const future = createUserMessage({
      content: [{ type: 'text', text: 'Opaque future context' }],
      source: { kind: 'plugin', plugin: 'future-plugin', form: 'catalog' },
    })
    ctx.on('llm/stream', () => (async function* () {})())
    const request = markAgentLoopRequest(deepFreeze({
      provider: 'virtual', model: 'virtual', messages: [direct, workspace, future], sessionId,
    } satisfies GenerateOptions))
    for await (const _chunk of ctx.llm.stream(request)) { /* exhaust the real waterfall */ }

    const response = await webServer.get('/prompt-studio/state?sessionId=capture-session')
    expect(response.status).toBe(200)
    expect(response.value).toMatchObject({
      sessionId: 'capture-session',
      layout: { messageCount: 3, userAnchor: 0 },
      captured: [
        { producer: 'workspace-instructions', form: 'instructions', order: 1 },
        { producer: 'future-plugin', form: 'catalog', order: 2 },
      ],
    })
  })
})
