import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const refresh = vi.hoisted(() => ({ outcome: 'timed-out' as 'timed-out' | 'completed-by-other' }))

vi.mock('../src/cache-refresh-lock.js', () => ({
  acquireCacheRefreshLock: async () => ({ outcome: refresh.outcome }),
}))

import { clearSessionCache, parseAllSessions, parseAllSessionsWithFreshness } from '../src/parser.js'
import { sessionCachePath } from '../src/session-cache.js'

let root: string
let sessionPath: string

function output(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
  return projects.flatMap(p => p.sessions).flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls).reduce((sum, call) => sum + call.usage.outputTokens, 0)
}

async function writeSession(value: number): Promise<void> {
  await writeFile(sessionPath, JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: `msg-${value}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: value },
    },
  }) + '\n')
}

beforeEach(async () => {
  refresh.outcome = 'timed-out'
  clearSessionCache()
  root = await mkdtemp(join(tmpdir(), 'cb-refresh-timeout-'))
  const home = join(root, 'home')
  const project = join(home, 'projects', 'proj')
  await mkdir(project, { recursive: true })
  sessionPath = join(project, 'sess.jsonl')
  process.env['CLAUDE_CONFIG_DIR'] = home
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  await rm(root, { recursive: true, force: true })
})

describe('parseAllSessions warm refresh timeout', () => {
  it('serves the prior complete snapshot and leaves the holder cache untouched', async () => {
    await writeSession(50)
    const fresh = await parseAllSessionsWithFreshness(undefined, 'claude')
    expect(output(fresh.projects)).toBe(50)
    expect(fresh.freshness).toEqual({ asOf: expect.any(String), stale: false })
    const before = await readFile(sessionCachePath(), 'utf-8')

    await writeSession(5000)
    clearSessionCache()
    const stale = await parseAllSessionsWithFreshness(undefined, 'claude')
    expect(output(stale.projects)).toBe(50)
    expect(stale.freshness).toEqual({ asOf: fresh.freshness.asOf, stale: true })
    expect(await readFile(sessionCachePath(), 'utf-8')).toBe(before)
  }, 15_000)

  it('keeps a snapshot completed by the other lock holder fresh', async () => {
    await writeSession(50)
    const initial = await parseAllSessionsWithFreshness(undefined, 'claude')

    refresh.outcome = 'completed-by-other'
    clearSessionCache()
    const readOnly = await parseAllSessionsWithFreshness(undefined, 'claude')

    expect(output(readOnly.projects)).toBe(50)
    expect(readOnly.freshness).toEqual({ asOf: initial.freshness.asOf, stale: false })
  }, 15_000)
})
