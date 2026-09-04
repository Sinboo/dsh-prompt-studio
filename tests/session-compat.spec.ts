import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { latestUserInput, sessionEvents } from '../src/index.ts'

/** Minimal text user/message envelope shared by both shapes below. */
function userMessage(text: string): SessionEvent {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text }] },
  } as unknown as SessionEvent
}

function agentOver(session: Record<string, unknown>): Agent {
  return { session } as unknown as Agent
}

describe('session event log compatibility', () => {
  it('reads the legacy `events` array accessor (dsh 0.1.2-alpha.x)', () => {
    const events = [userMessage('old'), userMessage('newest')]
    const session = { events }
    expect(sessionEvents(session as unknown as Session)).toEqual(events)
    expect(latestUserInput(agentOver(session))).toBe('newest')
  })

  it('reads the `snapshotEvents()` accessor (dsh 0.1.2-rc.1+, no `events` property)', () => {
    const events = [userMessage('old'), userMessage('newest')]
    const session = { snapshotEvents: () => events }
    expect(sessionEvents(session as unknown as Session)).toEqual(events)
    expect(latestUserInput(agentOver(session))).toBe('newest')
  })

  it('skips non-user events and joins text blocks of the latest user message', () => {
    const assistant = {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    } as unknown as SessionEvent
    const mixed = {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'part-a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'part-b' }] },
    } as unknown as SessionEvent
    const session = { snapshotEvents: () => [userMessage('first'), assistant, mixed] }
    expect(latestUserInput(agentOver(session))).toBe('part-a\npart-b')
  })

  it('returns undefined when no user message exists and tolerates an empty log', () => {
    expect(latestUserInput(agentOver({ snapshotEvents: () => [] }))).toBeUndefined()
    expect(latestUserInput(agentOver({ events: [] }))).toBeUndefined()
  })
})
