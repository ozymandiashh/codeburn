// Refreshes the committed Codex reset history from the public codex-reset.com
// timeline. Run by `.github/workflows/refresh-codex-reset-history.yml` every six
// hours; never by the CodeBurn client, which only ever reads the committed file.
//
// What crosses into the repo is deliberately tiny: an event id, an ISO instant,
// `reset` or `credits`, and a short reset kind. Every text field the upstream
// timeline carries — post bodies, titles, author names, URLs, summaries — is
// dropped here and never written. The file is a table of times, not a copy of
// anyone's posts.
//
// Source: https://codex-reset.com/api/timeline (a community tracker, not
// operated by or endorsed by OpenAI). See docs/codex-reset-forecast.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TIMELINE_URL = 'https://codex-reset.com/api/timeline'
export const SOURCE_NAME = 'codex-reset.com'
export const SOURCE_NOTE = 'Public community tracker of OpenAI Codex usage-limit resets. Not operated by or endorsed by OpenAI. Only event ids, timestamps and a reset kind are kept; no post text is copied or redistributed.'
export const SCHEMA = 1

/** The only keys allowed to reach the committed file. */
export const ALLOWED_KEYS = ['id', 'announced_at', 'type', 'reset_kind']

const RESET_KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

const TIMESTAMP_KEYS = ['announced_at', 'announcedAt', 'at', 'occurred_at', 'occurredAt', 'created_at', 'createdAt', 'timestamp', 'time', 'date']
const TYPE_KEYS = ['type', 'event_type', 'eventType', 'category']
const KIND_KEYS = ['reset_kind', 'resetKind', 'kind', 'scope', 'reset_type', 'resetType']
const ID_KEYS = ['id', 'post_id', 'postId', 'event_id', 'eventId']

/** Upstream type spellings we accept, mapped onto our two. Anything else is
 *  dropped rather than guessed at: a policy note or an outage is not a reset. */
const TYPE_MAP = new Map([
  ['reset', 'reset'],
  ['resets', 'reset'],
  ['global_reset', 'reset'],
  ['special_global', 'reset'],
  ['limit_reset', 'reset'],
  ['credits', 'credits'],
  ['credit', 'credits'],
  ['banked', 'credits'],
  ['banked_reset', 'credits'],
  ['reset_credit', 'credits'],
  ['reset_credits', 'credits'],
])

function firstString(row, keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function isoOrNull(value) {
  if (value === null) return null
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return null
  // Normalize to whole-second UTC so a reformat upstream cannot churn the file.
  return new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

function normalizeKind(raw) {
  if (!raw) return null
  const slug = raw.toLowerCase().replace(/[\s]+/g, '_').replace(/[^a-z0-9_-]/g, '')
  return RESET_KIND_PATTERN.test(slug) ? slug : null
}

/**
 * Upstream payload -> the committed document. Pure, so the tests exercise the
 * same transform the workflow runs. Tolerant about where the upstream puts its
 * fields and strict about what comes out the other side.
 */
export function normalizeTimeline(raw, options = {}) {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.events) ? raw.events
      : Array.isArray(raw?.items) ? raw.items
        : Array.isArray(raw?.timeline) ? raw.timeline
          : null
  if (!rows) throw new Error('Timeline payload is not an array and carries no events/items/timeline array.')

  const byId = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = firstString(row, ID_KEYS)
    const announcedAt = isoOrNull(firstString(row, TIMESTAMP_KEYS))
    const type = TYPE_MAP.get((firstString(row, TYPE_KEYS) ?? '').toLowerCase())
    if (!id || !announcedAt || !type) continue
    const event = { id, announced_at: announcedAt, type }
    if (type === 'reset') {
      const kind = normalizeKind(firstString(row, KIND_KEYS))
      // An unlabelled reset in this record has always been a global one; saying
      // so is better than an absent field the model would have to guess at.
      event.reset_kind = kind ?? 'global'
    }
    // Last write wins, so a corrected timestamp for the same id replaces it.
    byId.set(id, event)
  }

  const events = [...byId.values()].sort((a, b) =>
    a.announced_at < b.announced_at ? -1 : a.announced_at > b.announced_at ? 1 : (a.id < b.id ? -1 : 1))

  return {
    schema: SCHEMA,
    source: TIMELINE_URL,
    source_name: SOURCE_NAME,
    source_note: SOURCE_NOTE,
    generated_at: isoOrNull(options.generatedAt ?? new Date().toISOString()) ?? new Date().toISOString(),
    events,
  }
}

/**
 * Refuses anything that would corrupt the dataset: a wrong shape, a text field
 * that slipped through, a non-monotonic or unparseable timestamp, a duplicate
 * id, or a response that lost history. Throws with the reason; the workflow
 * fails loudly rather than committing a bad file.
 */
export function validateDocument(doc, options = {}) {
  if (!doc || typeof doc !== 'object') throw new Error('Document is not an object.')
  if (doc.schema !== SCHEMA) throw new Error(`Unexpected schema ${doc.schema}; expected ${SCHEMA}.`)
  if (doc.source !== TIMELINE_URL) throw new Error('Document does not name the expected source.')
  if (!Number.isFinite(Date.parse(doc.generated_at))) throw new Error('generated_at is not an ISO instant.')
  if (!Array.isArray(doc.events)) throw new Error('events is not an array.')

  const seen = new Set()
  let previous = ''
  for (const [index, event] of doc.events.entries()) {
    const where = `events[${index}]`
    const extra = Object.keys(event ?? {}).filter(key => !ALLOWED_KEYS.includes(key))
    if (extra.length > 0) throw new Error(`${where} carries disallowed fields: ${extra.join(', ')}.`)
    if (typeof event.id !== 'string' || !event.id.trim()) throw new Error(`${where} has no id.`)
    if (seen.has(event.id)) throw new Error(`${where} repeats id ${event.id}.`)
    seen.add(event.id)
    if (event.type !== 'reset' && event.type !== 'credits') throw new Error(`${where} has type ${event.type}.`)
    if (typeof event.announced_at !== 'string' || !Number.isFinite(Date.parse(event.announced_at))) {
      throw new Error(`${where} has an unparseable announced_at.`)
    }
    // Monotonic, which is also what makes the inter-reset waits meaningful.
    if (previous && event.announced_at < previous) throw new Error(`${where} is out of order (${event.announced_at} after ${previous}).`)
    previous = event.announced_at
    if ('reset_kind' in event) {
      if (event.type !== 'reset') throw new Error(`${where} is a credit grant with a reset_kind.`)
      if (typeof event.reset_kind !== 'string' || !RESET_KIND_PATTERN.test(event.reset_kind)) {
        throw new Error(`${where} has an unusable reset_kind.`)
      }
    } else if (event.type === 'reset') {
      throw new Error(`${where} is a reset with no reset_kind.`)
    }
  }

  const resets = doc.events.filter(event => event.type === 'reset').length
  if (resets < 2) throw new Error(`Only ${resets} resets in the response; refusing to replace the committed record.`)
  const previousResets = options.previousResetCount ?? 0
  // A truncated or half-failed upstream response must not silently delete
  // history that the committed file already holds.
  if (resets < previousResets) {
    throw new Error(`Response holds ${resets} resets but the committed file holds ${previousResets}; refusing to lose history.`)
  }
  return doc
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Byte-identical copies, so the CLI's dataset and the menubar's bundled one
 *  can never drift. `tests/reset-forecast-dataset.test.ts` enforces it. */
export function datasetPaths(repoRoot) {
  return [
    join(repoRoot, 'src', 'data', 'codex-reset-history.json'),
    join(repoRoot, 'mac', 'Sources', 'CodeBurnMenubar', 'Resources', 'CodexResetHistory', 'codex-reset-history.json'),
  ]
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const [canonicalPath] = datasetPaths(repoRoot)

  let previousResetCount = 0
  let previous = null
  try {
    previous = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    previousResetCount = previous.events.filter(event => event.type === 'reset').length
  } catch {
    // First run, or a file that is not readable. The reset-count floor below
    // simply has nothing to compare against.
  }

  const response = await fetch(TIMELINE_URL, {
    headers: { accept: 'application/json', 'user-agent': 'codeburn-reset-history-refresh' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${TIMELINE_URL} answered ${response.status} ${response.statusText}.`)

  const doc = validateDocument(normalizeTimeline(await response.json()), { previousResetCount })

  // The timestamp alone must not make the file look changed: an unchanged
  // record that rewrites `generated_at` every six hours would open a pull
  // request four times a day that says nothing.
  const unchanged = previous && JSON.stringify(previous.events) === JSON.stringify(doc.events)
  if (unchanged) {
    doc.generated_at = previous.generated_at
    console.log(`No change: ${doc.events.length} events, ${previousResetCount} resets.`)
  } else {
    const resets = doc.events.filter(event => event.type === 'reset').length
    console.log(`Updated: ${doc.events.length} events, ${resets} resets (was ${previousResetCount}).`)
  }

  const body = serialize(doc)
  for (const path of datasetPaths(repoRoot)) writeFileSync(path, body)
}

// Only when run directly, so the tests can import the pure halves.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
