import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Drive parseAllSessions through the cache-refresh-lock outcomes exactly like
// parser-cache-refresh-timeout.test.ts does: the warm-refresh transaction's
// lock is what a degraded serve fails to acquire, so flipping its outcome is
// the whole knob between a stale and a clean run within one payload build.
const { acquireMock } = vi.hoisted(() => ({ acquireMock: vi.fn() }))

vi.mock('../src/cache-refresh-lock.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cache-refresh-lock.js')>('../src/cache-refresh-lock.js')
  return {
    ...actual,
    acquireCacheRefreshLock: acquireMock,
  }
})

import { clearSessionCache, consumeServedDegraded, parseAllSessions } from '../src/parser.js'

const acquired = {
  outcome: 'acquired' as const,
  handle: {
    token: 'test-token',
    release: async () => {},
    verifyStillOwner: async () => true,
  },
}

let root: string
let projectDir: string

beforeEach(async () => {
  acquireMock.mockReset()
  clearSessionCache()
  root = await mkdtemp(join(tmpdir(), 'cb-freshness-'))
  const home = join(root, 'home')
  projectDir = join(home, 'projects', 'proj')
  await mkdir(projectDir, { recursive: true })
  process.env['CLAUDE_CONFIG_DIR'] = home
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  await rm(root, { recursive: true, force: true })
})

async function writeSession(id: string, ts: string, value: number): Promise<void> {
  await writeFile(join(projectDir, `${id}.jsonl`), JSON.stringify({
    type: 'assistant',
    sessionId: id,
    timestamp: ts,
    cwd: '/tmp/proj',
    message: {
      id: `msg-${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: value },
    },
  }) + '\n')
}

describe('serveDegraded sticky-OR across a payload build (#771)', () => {
  it('is OR-ed across a degraded run then a clean run, then consumed once', async () => {
    // Warm, complete cache.
    await writeSession('sess-1', '2026-05-15T10:00:00Z', 50)
    await parseAllSessions(undefined, 'claude')

    // The lock cannot be acquired: the new file has no cache entry, so the
    // prior snapshot is served read-only and under-reports -> degraded.
    await writeSession('sess-2', '2026-05-15T11:00:00Z', 5000)
    clearSessionCache()
    acquireMock.mockResolvedValueOnce({ outcome: 'timed-out' })
    acquireMock.mockResolvedValue(acquired)
    await parseAllSessions(undefined, 'claude')

    // A clean run within the same build: the lock is acquired, the new file is
    // parsed and persisted. readOnlyServedStale resets per-run, but the
    // build-scoped sticky accumulator must survive the clean run.
    clearSessionCache()
    await parseAllSessions(undefined, 'claude')

    expect(consumeServedDegraded().degraded).toBe(true)
    expect(consumeServedDegraded().degraded).toBe(false)
  })

  it('survives the CACHE_TTL_MS memo: a later same-key call that skips runParse does not clear it', async () => {
    // Warm, complete cache.
    await writeSession('sess-1', '2026-05-15T10:00:00Z', 50)
    await parseAllSessions(undefined, 'claude')

    // Degraded serve: servedDegraded flips to true.
    await writeSession('sess-2', '2026-05-15T11:00:00Z', 5000)
    clearSessionCache()
    acquireMock.mockResolvedValueOnce({ outcome: 'timed-out' })
    acquireMock.mockResolvedValue(acquired)
    await parseAllSessions(undefined, 'claude')

    // No clearSessionCache: the identical call hits the in-memory memo
    // (CACHE_TTL_MS) and never re-enters runParse, yet the sticky flag is not
    // cleared by that skip.
    const again = await parseAllSessions(undefined, 'claude')
    expect(again.length).toBeGreaterThan(0)

    expect(consumeServedDegraded().degraded).toBe(true)
    expect(consumeServedDegraded().degraded).toBe(false)
  })

  it('memo hit re-asserts a consumed degraded flag with the same asOfMs', async () => {
    // Warm, complete cache.
    await writeSession('sess-1', '2026-05-15T10:00:00Z', 50)
    await parseAllSessions(undefined, 'claude')

    // Degraded serve: the memo entry now records degraded plus the served
    // snapshot's as-of.
    await writeSession('sess-2', '2026-05-15T11:00:00Z', 5000)
    clearSessionCache()
    acquireMock.mockResolvedValueOnce({ outcome: 'timed-out' })
    acquireMock.mockResolvedValue(acquired)
    await parseAllSessions(undefined, 'claude')

    // Build A ends and CONSUMES the flag; the build-scoped accumulator resets.
    const buildA = consumeServedDegraded()
    expect(buildA.degraded).toBe(true)

    // Build B within the CACHE_TTL_MS window: the memo hit returns the SAME
    // stale data without entering runParse, so it must re-assert the flag and
    // re-stamp the served as-of itself.
    await parseAllSessions(undefined, 'claude')
    const buildB = consumeServedDegraded()
    expect(buildB.degraded).toBe(true)
    expect(buildB.asOfMs).toBe(buildA.asOfMs)
    expect(consumeServedDegraded().degraded).toBe(false)
  })
})
