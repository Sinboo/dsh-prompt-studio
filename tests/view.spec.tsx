// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PromptStudioView, type PromptStudioViewProps } from '../src/client/PromptStudioView.tsx'
import type { PromptStudioState, PromptStudioStore } from '../src/client/store.ts'

afterEach(cleanup)

const captured = {
  id: 'captured:workspace-1',
  kind: 'captured' as const,
  role: 'user' as const,
  order: 1,
  enabled: true as const,
  template: '<system-reminder>Instructions from: AGENTS.md\n\nBe exact.</system-reminder>',
  messageId: 'workspace-1',
  sourceKind: 'workspace-instructions',
  producer: 'workspace-instructions',
  form: 'instructions',
  source: {
    kind: 'workspace-instructions',
    form: 'instructions',
    baseline: true,
    changes: [{ action: 'set', path: 'AGENTS.md', digest: 'old' }],
  },
  resources: [{ id: 'resource:0', path: 'AGENTS.md', action: 'set' as const, digest: 'old', editable: true }],
}

function renderStudio(components: PromptStudioState['components'] = []) {
  const remote: PromptStudioState = {
    status: 'ready',
    error: null,
    writable: true,
    revision: 7,
    components,
    native: [{ id: 'persona', kind: 'native', role: 'system', order: 0, enabled: true, template: 'Persona.' }],
    assembled: [{ id: 'persona', kind: 'native', role: 'system', order: 0, enabled: true, template: 'Persona.' }],
    captured: [captured],
    capturedSessionId: 'session-a',
    messageCount: 2,
    userAnchor: 0,
    catalogRevision: 4,
  }
  const controller = {
    load: vi.fn(() => Promise.resolve()),
    save: vi.fn(() => Promise.resolve()),
    loadResource: vi.fn(() => Promise.resolve({ path: 'AGENTS.md', content: 'Be exact.\n', digest: 'current' })),
    saveResource: vi.fn(() => Promise.resolve({ path: 'AGENTS.md', content: 'Be concise.\n', digest: 'next' })),
  } as unknown as PromptStudioStore
  const useSnapshot = (<T,>(selector: (state: PromptStudioState) => T): T => selector(remote))
  const useSession = (<T,>(selector: (state: { queue: unknown[]; running: boolean }) => T): T => selector({ queue: [], running: false }))
  render(<PromptStudioView {...({ controller, useSnapshot, useSession } as unknown as PromptStudioViewProps)} />)
  return { controller }
}

describe('PromptStudioView automatic context rows', () => {
  it('shows source/kind/form and the actual model-facing workspace instructions', () => {
    renderStudio()
    const card = screen.getByLabelText('捕获上下文 captured:workspace-1')
    expect(within(card).getByText(/workspace-instructions · kind=workspace-instructions · form=instructions/)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '查看' }))
    expect(within(card).getByText(/Instructions from: AGENTS.md/)).toBeTruthy()
    expect(screen.getByLabelText('完整请求预览').textContent).toContain('自动捕获')
  })

  it('loads raw file bytes and writes them through the source-resource route', async () => {
    const { controller } = renderStudio()
    const card = screen.getByLabelText('捕获上下文 captured:workspace-1')
    fireEvent.click(within(card).getByRole('button', { name: '编辑文件：AGENTS.md' }))
    const editor = await screen.findByLabelText('编辑上下文文件 AGENTS.md')
    const textarea = within(editor).getByRole('textbox')
    expect((textarea as HTMLTextAreaElement).value).toBe('Be exact.\n')
    fireEvent.change(textarea, { target: { value: 'Be concise.\n' } })
    fireEvent.click(within(editor).getByRole('button', { name: '写回文件' }))
    await waitFor(() => {
      expect(controller.saveResource).toHaveBeenCalledWith(
        'captured:workspace-1', 'resource:0', 'Be concise.\n', 'current',
      )
    })
    expect(await within(editor).findByText(/原上下文生产者按其状态机协调/)).toBeTruthy()
  })

  it('keeps settings-backed supplements on the existing save route', async () => {
    const configured = [{
      id: 'supplement:message', kind: 'supplement' as const, role: 'user' as const,
      position: 'tail' as const, order: 100, enabled: true, template: 'Existing.',
    }]
    const { controller } = renderStudio(configured)
    const card = screen.getByText('supplement:message').closest('li')!
    fireEvent.click(within(card).getByRole('button', { name: '编辑' }))
    fireEvent.change(within(card).getByDisplayValue('Existing.'), { target: { value: 'Changed.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => { expect(controller.save).toHaveBeenCalledWith([{ ...configured[0], template: 'Changed.' }], 7) })
  })
})
