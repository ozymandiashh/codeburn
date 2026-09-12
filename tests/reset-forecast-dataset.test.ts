import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_KEYS,
  datasetPaths,
  normalizeTimeline,
  SCHEMA,
  TIMELINE_URL,
  validateDocument,
} from '../scripts/refresh-codex-reset-history.mjs'
import { resetInstants } from '../src/reset-forecast.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
// Spelled out segment by segment rather than taken from `datasetPaths`, so a
// refresh script that stopped writing one of the two copies could not make this
// check vacuous — and joined rather than written with '/', because the
// separator is '\\' on Windows and a hand-written path only matches on POSIX.
const CANONICAL_SEGMENTS = ['src', 'data', 'codex-reset-history.json']
const BUNDLED_SEGMENTS = ['mac', 'Sources', 'CodeBurnMenubar', 'Resources', 'CodexResetHistory', 'codex-reset-history.json']
const canonicalPath = join(repoRoot, ...CANONICAL_SEGMENTS)
const bundledPath = join(repoRoot, ...BUNDLED_SEGMENTS)
const canonicalText = readFileSync(canonicalPath, 'utf8')
const dataset = JSON.parse(canonicalText)

/** Path segments, whichever separator this platform uses. */
function segments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean)
}

/** Git on Windows can check a committed file out with CRLF. The two copies are
 *  written identically by the refresh script; comparing them must test that,
 *  not the runner's checkout settings. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

describe('the committed dataset', () => {
  it('validates against the same rules the refresh workflow applies', () => {
    expect(() => validateDocument(dataset)).not.toThrow()
  })

  it('carries nothing but ids, instants, a type and a reset kind', () => {
    for (const event of dataset.events) {
      expect(Object.keys(event).every(key => ALLOWED_KEYS.includes(key))).toBe(true)
    }
    // Nothing that looks like prose, a handle or a link in the events
    // themselves. The header's own attribution note is the only English in the
    // file, and it is ours.
    const events = JSON.stringify(dataset.events)
    expect(events).not.toMatch(/https?:\/\//)
    expect(events).not.toMatch(/\btext\b|\bbody\b|\btitle\b|\bauthor\b|\bsummary\b|@\w+/i)
    // Every value is an id, an instant, or one of four fixed words.
    for (const event of dataset.events) {
      expect(event.id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(['reset', 'credits']).toContain(event.type)
      if (event.reset_kind !== undefined) expect(event.reset_kind).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
    }
  })

  it('attributes its source in the file itself', () => {
    expect(dataset.source).toBe(TIMELINE_URL)
    expect(dataset.source_name).toBe('codex-reset.com')
    expect(dataset.source_note).toMatch(/not operated by or endorsed by OpenAI/i)
    expect(dataset.source_note).toMatch(/no post text/i)
  })

  it('holds enough resets, in order, for the model to condition on', () => {
    const resets = resetInstants(dataset)
    expect(resets.length).toBeGreaterThanOrEqual(40)
    for (let i = 1; i < resets.length; i += 1) expect(resets[i]).toBeGreaterThan(resets[i - 1])
  })

  it('is written to both copies by the refresh script', () => {
    const [canonical, bundled] = datasetPaths(repoRoot)
    // The invariant is which files are written, not how this platform spells a
    // path, so the tail segments are what is pinned.
    expect(segments(canonical).slice(-CANONICAL_SEGMENTS.length)).toEqual(CANONICAL_SEGMENTS)
    expect(segments(bundled).slice(-BUNDLED_SEGMENTS.length)).toEqual(BUNDLED_SEGMENTS)
    expect(datasetPaths(repoRoot)).toEqual([canonicalPath, bundledPath])
  })

  it('addresses both copies the same way on a Windows separator', () => {
    // #1291's lesson: a path assertion that only holds on POSIX is a test that
    // fails on the Windows runner and nowhere a developer will see it.
    const windowsish = 'C:\\\\src\\\\repo\\\\mac\\\\Sources\\\\CodeBurnMenubar\\\\Resources\\\\CodexResetHistory\\\\codex-reset-history.json'
    expect(segments(windowsish).slice(-BUNDLED_SEGMENTS.length)).toEqual(BUNDLED_SEGMENTS)
    expect(segments('/home/u/repo/src/data/codex-reset-history.json').slice(-CANONICAL_SEGMENTS.length))
      .toEqual(CANONICAL_SEGMENTS)
  })

  it('is byte-identical to the copy the menubar bundles', () => {
    // SwiftPM resources must live inside the target directory, so the record
    // exists twice. The refresh workflow writes both; this is what stops them
    // drifting apart between refreshes.
    const bundledText = readFileSync(bundledPath, 'utf8')
    expect(normalizeNewlines(bundledText)).toBe(normalizeNewlines(canonicalText))
    // Content, not just bytes: this is what the two readers actually consume.
    expect(JSON.parse(bundledText)).toEqual(dataset)
  })
})

describe('the refresh transform', () => {
  const raw = [
    {
      id: '1',
      announced_at: '2026-01-01T10:00:00.000Z',
      type: 'reset',
      reset_kind: 'Global',
      text: 'Resetting limits for everyone!',
      author: 'someone',
      url: 'https://x.com/someone/status/1',
    },
    { id: '2', announcedAt: '2026-01-03T10:00:00Z', event_type: 'banked', summary: 'free banked reset' },
    { id: '3', at: '2026-01-02T10:00:00Z', kind: 'global', type: 'special_global' },
    { id: '4', at: '2026-01-04T10:00:00Z', type: 'policy_change', body: 'not a reset' },
    { id: '5', at: 'nonsense', type: 'reset' },
    { announced_at: '2026-01-05T10:00:00Z', type: 'reset' },
    null,
    'not an object',
  ]

  it('keeps only the four allowed fields and drops every text field', () => {
    const doc = normalizeTimeline(raw, { generatedAt: '2026-01-06T00:00:00Z' })
    for (const event of doc.events) expect(Object.keys(event).every(key => ALLOWED_KEYS.includes(key))).toBe(true)
    expect(JSON.stringify(doc)).not.toMatch(/Resetting limits|free banked|someone|x\.com/)
  })

  it('maps the upstream type spellings onto reset and credits, and drops the rest', () => {
    const doc = normalizeTimeline(raw, { generatedAt: '2026-01-06T00:00:00Z' })
    expect(doc.events.map(event => event.id)).toEqual(['1', '3', '2'])
    expect(doc.events.map(event => event.type)).toEqual(['reset', 'reset', 'credits'])
  })

  it('drops rows with no id, no usable instant, or an unrecognised type', () => {
    const doc = normalizeTimeline(raw, { generatedAt: '2026-01-06T00:00:00Z' })
    expect(doc.events.map(event => event.id)).not.toContain('4')
    expect(doc.events.map(event => event.id)).not.toContain('5')
    expect(doc.events).toHaveLength(3)
  })

  it('sorts ascending and normalizes instants to whole seconds in UTC', () => {
    const doc = normalizeTimeline(raw, { generatedAt: '2026-01-06T00:00:00Z' })
    expect(doc.events.map(event => event.announced_at)).toEqual([
      '2026-01-01T10:00:00Z',
      '2026-01-02T10:00:00Z',
      '2026-01-03T10:00:00Z',
    ])
  })

  it('labels an unlabelled reset global rather than leaving the model to guess', () => {
    const doc = normalizeTimeline([
      { id: 'a', at: '2026-01-01T00:00:00Z', type: 'reset' },
      { id: 'b', at: '2026-01-03T00:00:00Z', type: 'reset' },
    ])
    expect(doc.events.every(event => event.reset_kind === 'global')).toBe(true)
  })

  it('lets a corrected row replace an earlier one with the same id', () => {
    const doc = normalizeTimeline([
      { id: 'a', at: '2026-01-01T00:00:00Z', type: 'reset' },
      { id: 'b', at: '2026-01-03T00:00:00Z', type: 'reset' },
      { id: 'a', at: '2026-01-02T00:00:00Z', type: 'reset' },
    ])
    expect(doc.events.map(event => event.announced_at)).toEqual(['2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'])
  })

  it('accepts the array shapes the upstream might use', () => {
    const rows = [{ id: 'a', at: '2026-01-01T00:00:00Z', type: 'reset' }, { id: 'b', at: '2026-01-03T00:00:00Z', type: 'reset' }]
    for (const payload of [rows, { events: rows }, { items: rows }, { timeline: rows }]) {
      expect(normalizeTimeline(payload).events).toHaveLength(2)
    }
  })

  it('refuses a payload that is not a list of events at all', () => {
    expect(() => normalizeTimeline({ ok: true })).toThrow(/not an array/)
    expect(() => normalizeTimeline(null)).toThrow(/not an array/)
  })
})

describe('the refresh guard rails', () => {
  const good = () => ({
    schema: SCHEMA,
    source: TIMELINE_URL,
    generated_at: '2026-01-06T00:00:00Z',
    events: [
      { id: 'a', announced_at: '2026-01-01T00:00:00Z', type: 'reset', reset_kind: 'global' },
      { id: 'b', announced_at: '2026-01-03T00:00:00Z', type: 'reset', reset_kind: 'global' },
      { id: 'c', announced_at: '2026-01-04T00:00:00Z', type: 'credits' },
    ],
  })

  it('accepts a well-formed document', () => {
    expect(() => validateDocument(good())).not.toThrow()
  })

  it('refuses timestamps that go backwards', () => {
    const doc = good()
    doc.events[1].announced_at = '2025-12-01T00:00:00Z'
    expect(() => validateDocument(doc)).toThrow(/out of order/)
  })

  it('refuses a repeated id', () => {
    const doc = good()
    doc.events[1].id = 'a'
    expect(() => validateDocument(doc)).toThrow(/repeats id/)
  })

  it('refuses any field beyond the four allowed', () => {
    const doc = good()
    doc.events[0].text = 'a post body'
    expect(() => validateDocument(doc)).toThrow(/disallowed fields: text/)
  })

  it('refuses a credit grant wearing a reset kind, and a reset without one', () => {
    const withKind = good()
    withKind.events[2].reset_kind = 'global'
    expect(() => validateDocument(withKind)).toThrow(/credit grant with a reset_kind/)

    const withoutKind = good()
    delete withoutKind.events[0].reset_kind
    expect(() => validateDocument(withoutKind)).toThrow(/reset with no reset_kind/)
  })

  it('refuses a reset kind that is not a plain slug', () => {
    const doc = good()
    doc.events[0].reset_kind = 'global · announced on x'
    expect(() => validateDocument(doc)).toThrow(/unusable reset_kind/)
  })

  it('refuses an unparseable instant and an unparseable generated_at', () => {
    const badEvent = good()
    badEvent.events[0].announced_at = 'soon'
    expect(() => validateDocument(badEvent)).toThrow(/unparseable announced_at/)

    const badDoc = good()
    badDoc.generated_at = 'soon'
    expect(() => validateDocument(badDoc)).toThrow(/generated_at is not an ISO instant/)
  })

  it('refuses a wrong schema or a source it does not recognise', () => {
    const schema = good()
    schema.schema = 99
    expect(() => validateDocument(schema)).toThrow(/Unexpected schema/)

    const source = good()
    source.source = 'https://example.com/feed'
    expect(() => validateDocument(source)).toThrow(/does not name the expected source/)
  })

  it('refuses a response that would shrink the committed record', () => {
    // The whole point: a truncated or half-failed upstream response must not
    // quietly delete history that is already committed.
    expect(() => validateDocument(good(), { previousResetCount: 44 })).toThrow(/refusing to lose history/)
    expect(() => validateDocument(good(), { previousResetCount: 2 })).not.toThrow()
  })

  it('refuses a response with almost no resets in it', () => {
    const doc = good()
    doc.events = [doc.events[0], doc.events[2]]
    expect(() => validateDocument(doc)).toThrow(/refusing to replace the committed record/)
  })
})
