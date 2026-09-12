import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CACHE_FILENAME,
  FETCH_MIN_INTERVAL_MS,
  RESET_HISTORY_HOST,
  RESET_HISTORY_URL,
  SNAPSHOT_ONLY_ENV,
  loadResetHistory,
} from '../src/codex-reset-history-fetch.js'
import { isUsableResetHistory, type ResetHistory } from '../src/reset-forecast.js'

const NOW = Date.parse('2026-09-13T12:00:00Z')

function history(generatedAt: string, resets = 3): ResetHistory {
  return {
    schema: 1,
    source: 'https://codex-reset.com/api/timeline',
    generated_at: generatedAt,
    events: Array.from({ length: resets }, (_, i) => ({
      id: `r${i}`,
      announced_at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString(),
      type: 'reset' as const,
      reset_kind: 'global',
    })),
  }
}

const BUNDLED = history('2026-09-01T00:00:00Z')
const NEWER = history('2026-09-13T11:30:00Z', 4)
const OLDER = history('2026-08-01T00:00:00Z', 4)

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codeburn-reset-fetch-'))
}

type Call = { url: string; headers: Record<string, string> }

function responder(
  calls: Call[],
  reply: () => { status: number; body?: string; headers?: Record<string, string> } | Error,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    const next = reply()
    if (next instanceof Error) throw next
    return new Response(next.body ?? '', { status: next.status, headers: next.headers })
  }) as typeof fetch
}

async function readCache(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, CACHE_FILENAME), 'utf-8'))
  } catch {
    return null
  }
}

describe('the hourly reset-history refresh', () => {
  it('talks to exactly one host, the one the app already contacts', () => {
    expect(new URL(RESET_HISTORY_URL).host).toBe(RESET_HISTORY_HOST)
    expect(RESET_HISTORY_HOST).toBe('api.github.com')
    // Never the tracker, from the client.
    expect(RESET_HISTORY_URL).not.toContain('codex-reset.com')
    // The dedicated data branch, not main.
    expect(RESET_HISTORY_URL).toContain('ref=data/codex-reset-history')
  })

  it('sends no credential, no cookie and nothing about the user', async () => {
    const dir = await sandbox()
    const calls: Call[] = []
    await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 304 })),
    })
    expect(calls).toHaveLength(1)
    const keys = Object.keys(calls[0].headers).map(k => k.toLowerCase())
    expect(keys.sort()).toEqual(['accept', 'user-agent'])
    expect(calls[0].headers.accept).toBe('application/vnd.github.raw+json')
  })

  it('accepts a newer record and caches it with its ETag', async () => {
    const dir = await sandbox()
    const calls: Call[] = []
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({
        status: 200, body: JSON.stringify(NEWER), headers: { etag: 'W/"abc"' },
      })),
    })
    expect(load.source).toBe('fetched')
    expect(load.generatedAt).toBe(NEWER.generated_at)
    expect(load.history.events).toHaveLength(4)
    const cache = await readCache(dir)
    expect(cache?.etag).toBe('W/"abc"')
    expect((cache?.document as ResetHistory).generated_at).toBe(NEWER.generated_at)
  })

  it('sends If-None-Match on the next attempt and keeps the cache on a 304', async () => {
    const dir = await sandbox()
    const calls: Call[] = []
    await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 200, body: JSON.stringify(NEWER), headers: { etag: 'W/"abc"' } })),
    })
    const later = NOW + FETCH_MIN_INTERVAL_MS + 1
    const load = await loadResetHistory({
      bundled: BUNDLED, now: later, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 304 })),
    })
    expect(calls[1].headers['if-none-match']).toBe('W/"abc"')
    expect(load.source).toBe('fetched')
    expect(load.generatedAt).toBe(NEWER.generated_at)
  })

  it('ignores a record older than the one it holds', async () => {
    const dir = await sandbox()
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder([], () => ({ status: 200, body: JSON.stringify(OLDER) })),
    })
    expect(load.source).toBe('bundled')
    expect(load.generatedAt).toBe(BUNDLED.generated_at)
  })

  it('ignores a record with the same timestamp, which is not an update', async () => {
    const dir = await sandbox()
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder([], () => ({ status: 200, body: JSON.stringify(history(BUNDLED.generated_at, 9)) })),
    })
    expect(load.source).toBe('bundled')
  })

  it('ignores a malformed body', async () => {
    for (const body of ['', 'not json', '{}', '[]', JSON.stringify({ ...NEWER, schema: 2 })]) {
      const dir = await sandbox()
      const load = await loadResetHistory({
        bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
        fetchImpl: responder([], () => ({ status: 200, body })),
      })
      expect(load.source).toBe('bundled')
    }
  })

  it('ignores a record whose timestamps go backwards', async () => {
    const dir = await sandbox()
    const scrambled = history('2026-09-13T11:30:00Z', 4)
    scrambled.events[2].announced_at = '2025-01-01T00:00:00Z'
    expect(isUsableResetHistory(scrambled)).toBe(false)
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder([], () => ({ status: 200, body: JSON.stringify(scrambled) })),
    })
    expect(load.source).toBe('bundled')
  })

  it('ignores a record carrying a text field, however well-formed otherwise', async () => {
    const dir = await sandbox()
    const chatty = history('2026-09-13T11:30:00Z', 4) as unknown as { events: Record<string, unknown>[] }
    chatty.events[0].text = 'Resetting limits for everyone!'
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder([], () => ({ status: 200, body: JSON.stringify(chatty) })),
    })
    expect(load.source).toBe('bundled')
  })

  it('keeps the bundled record when the network is gone, and still only tries hourly', async () => {
    const dir = await sandbox()
    const calls: Call[] = []
    const offline = responder(calls, () => new Error('getaddrinfo ENOTFOUND'))
    const first = await loadResetHistory({ bundled: BUNDLED, now: NOW, cacheDir: dir, env: {}, fetchImpl: offline })
    expect(first.source).toBe('bundled')
    const second = await loadResetHistory({
      bundled: BUNDLED, now: NOW + 60_000, cacheDir: dir, env: {}, fetchImpl: offline,
    })
    expect(second.source).toBe('bundled')
    expect(calls).toHaveLength(1)
  })

  it('keeps a previously fetched record when a later fetch fails', async () => {
    const dir = await sandbox()
    await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder([], () => ({ status: 200, body: JSON.stringify(NEWER) })),
    })
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW + FETCH_MIN_INTERVAL_MS + 1, cacheDir: dir, env: {},
      fetchImpl: responder([], () => new Error('offline')),
    })
    expect(load.source).toBe('fetched')
    expect(load.generatedAt).toBe(NEWER.generated_at)
  })

  it('does not fetch again inside the hour', async () => {
    const dir = await sandbox()
    const calls: Call[] = []
    const reply = responder(calls, () => ({ status: 200, body: JSON.stringify(NEWER), headers: { etag: 'W/"a"' } }))
    await loadResetHistory({ bundled: BUNDLED, now: NOW, cacheDir: dir, env: {}, fetchImpl: reply })
    await loadResetHistory({ bundled: BUNDLED, now: NOW + FETCH_MIN_INTERVAL_MS - 1, cacheDir: dir, env: {}, fetchImpl: reply })
    expect(calls).toHaveLength(1)
    await loadResetHistory({ bundled: BUNDLED, now: NOW + FETCH_MIN_INTERVAL_MS + 1, cacheDir: dir, env: {}, fetchImpl: reply })
    expect(calls).toHaveLength(2)
  })

  it('pushes the next attempt out when the host asks it to wait', async () => {
    const dir = await sandbox()
    const calls: Call[] = []
    await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 403, headers: { 'retry-after': '7200' } })),
    })
    // Retry-After of two hours, so an hour later is still too early.
    await loadResetHistory({
      bundled: BUNDLED, now: NOW + FETCH_MIN_INTERVAL_MS + 1, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 200, body: JSON.stringify(NEWER) })),
    })
    expect(calls).toHaveLength(1)
    await loadResetHistory({
      bundled: BUNDLED, now: NOW + 2 * FETCH_MIN_INTERVAL_MS + 1, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 200, body: JSON.stringify(NEWER) })),
    })
    expect(calls).toHaveLength(2)
  })

  it('makes no request at all under the snapshot-only knob, and reads no cache', async () => {
    const dir = await sandbox()
    await writeFile(join(dir, CACHE_FILENAME), JSON.stringify({ attemptedAt: 0, document: NEWER }), 'utf-8')
    const calls: Call[] = []
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir,
      env: { [SNAPSHOT_ONLY_ENV]: '1' },
      fetchImpl: responder(calls, () => ({ status: 200, body: JSON.stringify(NEWER) })),
    })
    expect(calls).toHaveLength(0)
    expect(load.source).toBe('bundled')
  })

  it('treats a corrupt cache file as no cache rather than as an error', async () => {
    const dir = await sandbox()
    await writeFile(join(dir, CACHE_FILENAME), '{ not json', 'utf-8')
    const calls: Call[] = []
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder(calls, () => ({ status: 200, body: JSON.stringify(NEWER) })),
    })
    expect(calls).toHaveLength(1)
    expect(load.source).toBe('fetched')
  })

  it('discards a cached document that no longer validates', async () => {
    const dir = await sandbox()
    await writeFile(join(dir, CACHE_FILENAME),
      JSON.stringify({ attemptedAt: NOW, document: { schema: 1, events: 'nope' } }), 'utf-8')
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: dir, env: {},
      fetchImpl: responder([], () => ({ status: 500 })),
    })
    expect(load.source).toBe('bundled')
  })

  it('survives an unwritable cache directory', async () => {
    const load = await loadResetHistory({
      bundled: BUNDLED, now: NOW, cacheDir: '/proc/definitely/not/writable', env: {},
      fetchImpl: responder([], () => ({ status: 200, body: JSON.stringify(NEWER) })),
    })
    expect(load.source).toBe('fetched')
  })
})
