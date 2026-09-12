// Keeps the Codex reset history fresher than a release cycle.
//
// #725 exception granted by the maintainer on 2026-09-13: a client-side,
// first-party, conditional fetch of the reset-history dataset from this
// repository on GitHub, at most hourly, carrying no user data; no request is
// ever made to codex-reset.com or any third party from the client.
//
// Concretely, that means:
// - one host, `api.github.com`, which the macOS app already contacts for update
//   checks. The raw.githubusercontent.com URL would have been a new host, so it
//   is deliberately not used;
// - a conditional GET with the stored ETag, so the common case is a 304 that
//   costs one request against the unauthenticated 60/hour limit and no body;
// - at most one attempt per hour, from the refresh that already runs;
// - no credential, no cookie, no account id, no plan, no query string beyond the
//   branch name. The request carries nothing about the user but their IP, which
//   GitHub already sees from the update check;
// - and a failure is never worse than not trying: the bundled record is always
//   there, and a fetched record that does not validate is discarded.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCodeburnCacheDir } from './cache-dir.js'
import { fetchWithTimeout } from './fetch-utils.js'
import { isUsableResetHistory, type ResetHistory } from './reset-forecast.js'

/** The dataset on the branch the refresh workflow pushes to, through the
 *  contents API on the host the app already talks to. */
export const RESET_HISTORY_URL =
  'https://api.github.com/repos/getagentseal/codeburn/contents/src/data/codex-reset-history.json'
  + '?ref=data/codex-reset-history'

export const RESET_HISTORY_HOST = 'api.github.com'

/** At most one attempt per hour, cached on disk so it is per machine and not
 *  per process: `codeburn quota` is a fresh process every time it runs. */
export const FETCH_MIN_INTERVAL_MS = 60 * 60 * 1000

/** The same knob that pins pricing to its bundled snapshot. Deliberately reused
 *  rather than inventing a second offline switch for users to discover. */
export const SNAPSHOT_ONLY_ENV = 'CODEBURN_PRICING_SNAPSHOT_ONLY'

export const CACHE_FILENAME = 'codex-reset-history-fetched.json'

/** Ceiling on each cache read and write. The cache is a convenience — it saves a
 *  request an hour from now — so it is never worth making anyone wait on it. A
 *  filesystem that answers slowly, or not at all, must degrade to "no cache",
 *  not to a hung command: `codeburn quota` blocks the macOS menubar on its exit,
 *  and an unwritable or pathological cache directory (a read-only mount, a
 *  synthetic filesystem such as procfs, a stalled network mount) must not be
 *  able to wedge it. */
export const CACHE_IO_TIMEOUT_MS = 2000

/** Runs `work`, giving up with `fallback` after `timeoutMs`. The timer is
 *  unref'd so it can never hold a CLI process open. */
async function withDeadline<T>(work: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work().catch(() => fallback), expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type CacheRecord = {
  /** When the last request was made, successful or not. Gates the hourly retry. */
  attemptedAt: number
  etag?: string
  document?: ResetHistory
}

export type ResetHistoryLoad = {
  history: ResetHistory
  /** Which copy the forecast is actually reading. */
  source: 'fetched' | 'bundled'
  generatedAt: string
}

export type FetchOptions = {
  /** Injected by tests. Defaults to the global. */
  fetchImpl?: typeof fetch
  now?: number
  cacheDir?: string
  env?: Record<string, string | undefined>
  /** The record compiled into this build; always the floor. */
  bundled: ResetHistory
}

function cachePath(cacheDir: string): string {
  return join(cacheDir, CACHE_FILENAME)
}

async function readCache(cacheDir: string): Promise<CacheRecord | null> {
  return withDeadline(() => readCacheUnbounded(cacheDir), CACHE_IO_TIMEOUT_MS, null)
}

async function readCacheUnbounded(cacheDir: string): Promise<CacheRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(cacheDir), 'utf-8')) as CacheRecord
    if (!parsed || typeof parsed.attemptedAt !== 'number') return null
    // A cache file that has been corrupted, truncated or hand-edited is not a
    // reason to fail; it is a reason to behave as though there were none.
    if (parsed.document !== undefined && !isUsableResetHistory(parsed.document)) {
      return { attemptedAt: parsed.attemptedAt }
    }
    return parsed
  } catch {
    return null
  }
}

async function writeCache(cacheDir: string, record: CacheRecord): Promise<void> {
  // An unwritable cache costs a request an hour from now. It is not an error
  // anyone can act on, it must not fail the command, and it must not delay it:
  // whatever the filesystem does, the caller gets its answer.
  await withDeadline(async () => {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cachePath(cacheDir), JSON.stringify(record), 'utf-8')
  }, CACHE_IO_TIMEOUT_MS, undefined)
}

function generatedAtMs(history: ResetHistory | undefined): number {
  const at = Date.parse(String(history?.generated_at ?? ''))
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
}

/** The newer of the two, by the record's own timestamp. The bundled copy is the
 *  floor: a fetch can only ever move the record forward. */
function choose(bundled: ResetHistory, fetched: ResetHistory | undefined): ResetHistoryLoad {
  if (fetched && generatedAtMs(fetched) > generatedAtMs(bundled)) {
    return { history: fetched, source: 'fetched', generatedAt: fetched.generated_at }
  }
  return { history: bundled, source: 'bundled', generatedAt: bundled.generated_at }
}

/**
 * The record to forecast from, refreshing it at most hourly.
 *
 * Never throws and never blocks on a slow network beyond the shared fetch
 * timeout. Every failure path — offline, rate limited, 500, timeout, malformed
 * body, a body that validates but is older than what we hold — leaves the
 * caller with the newest record already on this machine, which is at worst the
 * one compiled into the build.
 */
export async function loadResetHistory(options: FetchOptions): Promise<ResetHistoryLoad> {
  const {
    bundled,
    now = Date.now(),
    cacheDir = getCodeburnCacheDir(),
    env = process.env,
    fetchImpl,
  } = options

  const cache = await readCache(cacheDir)

  // Snapshot-only pins the forecast to the record in the build, exactly as it
  // pins pricing to the bundled table. No request, and no cached copy either.
  if (env[SNAPSHOT_ONLY_ENV]) {
    return { history: bundled, source: 'bundled', generatedAt: bundled.generated_at }
  }

  const dueAt = (cache?.attemptedAt ?? Number.NEGATIVE_INFINITY) + FETCH_MIN_INTERVAL_MS
  if (cache && now < dueAt) return choose(bundled, cache.document)

  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetchWithTimeout(String(input), init))
  const headers: Record<string, string> = {
    // `raw` gives the file itself rather than a base64 envelope, on the same
    // host and the same endpoint.
    accept: 'application/vnd.github.raw+json',
    'user-agent': 'codeburn-reset-history',
  }
  if (cache?.etag) headers['if-none-match'] = cache.etag

  let next: CacheRecord = { attemptedAt: now, etag: cache?.etag, document: cache?.document }
  try {
    const response = await doFetch(RESET_HISTORY_URL, { headers })
    if (response.status === 304) {
      // Unchanged. The stored copy stands and the clock restarts.
    } else if (response.ok) {
      const parsed = JSON.parse(await response.text()) as unknown
      // Validated before it is believed, and only accepted if it actually moves
      // the record forward. An older or equal document is not an update.
      if (isUsableResetHistory(parsed) && generatedAtMs(parsed) > generatedAtMs(cache?.document ?? bundled)) {
        const etag = response.headers.get('etag')
        next = { attemptedAt: now, document: parsed, ...(etag ? { etag } : {}) }
      }
    }
    // Any other status — 403 with a rate-limit reset, 404, 5xx — is silence.
    // `Retry-After`, when the host sends one, is honoured by pushing the next
    // attempt out rather than by sleeping here.
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      next.attemptedAt = now + retryAfter * 1000 - FETCH_MIN_INTERVAL_MS
    }
  } catch {
    // Offline, DNS down, timed out. Recorded as an attempt so a machine with no
    // network tries once an hour rather than on every command.
  }

  await writeCache(cacheDir, next)
  return choose(bundled, next.document)
}
