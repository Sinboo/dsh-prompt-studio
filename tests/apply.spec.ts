import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { PromptStudioView } from '../src/client/PromptStudioView.tsx'
import type { PromptStudioViewInjected } from '../src/client/PromptStudioView.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('conversation', {} as never)
  ctx.provide('connection', { api: { settings: {} } } as never)
  const remoteHandlers = new Map<string, (namespace: string) => void>()
  ctx.provide('remote', {
    $on: (event: string, handler: (namespace: string) => void) => {
      remoteHandlers.set(event, handler)
      return () => { remoteHandlers.delete(event) }
    },
  } as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots, remoteHandlers }
}

describe('Prompt Studio browser apply', () => {
  it('registers one session-scoped tab and keeps controllers isolated by session', async () => {
    const { slots } = await bench()
    const entry = slots.entries('conversation.view')[0]!
    expect(entry.component).toBe(PromptStudioView)
    expect(entry.options).toMatchObject({ id: 'prompt-studio', order: 20, label: 'Prompt Studio' })
    const injectFace = entry.inject as unknown as (sessionId: string) => PromptStudioViewInjected
    const a1 = injectFace('session-a')
    const a2 = injectFace('session-a')
    const b = injectFace('session-b')
    expect(a1).toBe(a2)
    expect(a1.controller).not.toBe(b.controller)
  })

  it('refreshes every loaded session controller on relevant invalidations', async () => {
    const { ctx, slots, remoteHandlers } = await bench()
    const injectFace = slots.entries('conversation.view')[0]!.inject as unknown as (sessionId: string) => PromptStudioViewInjected
    const a = injectFace('session-a')
    const b = injectFace('session-b')
    a.controller.store.update(state => { state.status = 'ready' })
    b.controller.store.update(state => { state.status = 'ready' })
    const loadA = vi.spyOn(a.controller, 'load').mockResolvedValue()
    const loadB = vi.spyOn(b.controller, 'load').mockResolvedValue()

    const settingsUpdated = remoteHandlers.get('settings/document-updated')!
    settingsUpdated('unrelated')
    expect(loadA).not.toHaveBeenCalled()
    settingsUpdated('prompt-studio')
    ctx.emit('connection/reset')
    expect(loadA).toHaveBeenCalledTimes(2)
    expect(loadB).toHaveBeenCalledTimes(2)
  })
})
