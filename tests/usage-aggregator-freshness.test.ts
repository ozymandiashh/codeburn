import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  freshness: { asOf: '2026-07-28T02:00:00.000Z', stale: false },
  parse: vi.fn(),
}))

vi.mock('../src/parser.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/parser.js')>()
  return { ...actual, parseAllSessionsWithFreshness: mocks.parse }
})

vi.mock('../src/daily-cache.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daily-cache.js')>()
  return { ...actual, ensureCacheHydrated: async () => actual.emptyCache() }
})

vi.mock('../src/providers/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/providers/index.js')>()
  return { ...actual, getAllProviders: async () => [], safeDiscoverSessions: async () => [] }
})

vi.mock('../src/providers/claude.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/providers/claude.js')>()
  return {
    ...actual,
    getClaudeConfigDirs: async () => [],
    getDesktopSessionsDirs: () => [],
    claude: { ...actual.claude, discoverSessions: async () => [] },
  }
})

import { getDateRange } from '../src/cli-date.js'
import { buildMenubarPayloadForRange } from '../src/usage-aggregator.js'

beforeEach(() => {
  mocks.freshness = { asOf: '2026-07-28T02:00:00.000Z', stale: false }
  mocks.parse.mockReset()
  mocks.parse.mockImplementation(async () => ({ projects: [], freshness: mocks.freshness }))
})

describe('buildMenubarPayloadForRange data freshness', () => {
  it('emits the fresh parse provenance', async () => {
    const payload = await buildMenubarPayloadForRange(
      getDateRange('today'),
      { provider: 'all', optimize: false, timeline: false },
    )

    expect(mocks.parse).toHaveBeenCalled()
    expect(payload.dataFreshness).toEqual(mocks.freshness)
  })

  it('emits the prior snapshot provenance for a stale read-only serve', async () => {
    mocks.freshness = { asOf: '2026-07-28T01:00:00.000Z', stale: true }

    const payload = await buildMenubarPayloadForRange(
      getDateRange('today'),
      { provider: 'all', optimize: false, timeline: false },
    )

    expect(payload.dataFreshness).toEqual(mocks.freshness)
    expect(payload.generated).not.toBe(mocks.freshness.asOf)
  })
})
