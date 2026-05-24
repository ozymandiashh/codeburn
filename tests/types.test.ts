import { describe, expect, it } from 'vitest'

import { apiCallCount, turnApiCallCount, type ParsedApiCall, type ParsedTurn } from '../src/types.js'

function call(apiCallCount?: number): ParsedApiCall {
  return {
    provider: 'hermes',
    model: 'gpt-5.5',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0,
    apiCallCount,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-23T00:00:00.000Z',
    bashCommands: [],
    deduplicationKey: `call-${apiCallCount ?? 'missing'}`,
  }
}

describe('apiCallCount helpers', () => {
  it('defaults missing, non-positive, and sub-one counts to one', () => {
    expect(apiCallCount(call())).toBe(1)
    expect(apiCallCount(call(0))).toBe(1)
    expect(apiCallCount(call(-2))).toBe(1)
    expect(apiCallCount(call(0.5))).toBe(1)
  })

  it('floors positive fractional counts and sums turn counts', () => {
    expect(apiCallCount(call(3.9))).toBe(3)

    const turn: ParsedTurn = {
      userMessage: 'test',
      assistantCalls: [call(2), call(3.9), call()],
      timestamp: '2026-05-23T00:00:00.000Z',
      sessionId: 's1',
    }
    expect(turnApiCallCount(turn)).toBe(6)
  })
})
