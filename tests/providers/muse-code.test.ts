import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createMuseCodeProvider, decodeMuseLine, getMuseDataDir, rootSessionIdFromPath } from '../../src/providers/muse-code.js'
import { calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Fixture provenance lives in the first line of each file under
// tests/fixtures/muse-code/ and in docs/providers/muse-code.md. In short:
//   echo-session-1.1.1.jsonl        - a real Muse Code 1.1.1 binary's own log
//   published-codexbar-pr3587.jsonl - steipete/CodexBar PR #3587's real-log case
//   published-superset-1.1.1.jsonl  - superset-sh/superset's real-1.1.1 case
// Nothing here is hand-invented: every token count and field name below is
// either from the local binary or from one of those published excerpts.
const FIXTURES = join(__dirname, '..', 'fixtures', 'muse-code')

const SESSION = '01a0976a-39f3-7c82-9214-f6ff343a5d99'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'muse-code-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function dataDir(): string {
  return join(tmpDir, 'muse')
}

async function writeSession(sessionId: string, lines: string[], opts: { day?: string; subagentOf?: string } = {}): Promise<string> {
  const day = opts.day ?? '2026/09/12'
  const base = opts.subagentOf
    ? join(dataDir(), 'sessions', ...day.split('/'), opts.subagentOf, 'subagent', sessionId)
    : join(dataDir(), 'sessions', ...day.split('/'), sessionId)
  await mkdir(base, { recursive: true })
  const path = join(base, 'session.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** The envelope the 1.1.1 binary writes around every record (confirmed against
 *  a real session, and identical to superset's published helper). */
function envelope(payloadType: string, payload: unknown, opts: { recordedAt?: number; sequence?: number; sessionId?: string; id?: string } = {}): string {
  return JSON.stringify({
    schema_version: 1,
    id: opts.id ?? `rec-${String(opts.sequence ?? 1)}`,
    stream: { kind: 'session', id: opts.sessionId ?? SESSION },
    sequence: opts.sequence ?? 1,
    recorded_at: opts.recordedAt ?? 1789246716491567,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  })
}

function metadata(workspaceRoot = '/private/tmp/muse-probe', extra: Record<string, unknown> = {}): string {
  return envelope('runtime.session.metadata', {
    kind: 'metadata',
    record: {
      workspace_root: workspaceRoot,
      provider_id: 'meta',
      web_search_mode: 'client',
      build: { sha: 'b934305d21', semver: '1.1.1' },
      tool_surface_version: '2',
      ...extra,
    },
  }, { sequence: 3 })
}

function runEvent(event: unknown, opts: { runId?: string; recordedAt?: number; sequence?: number; sessionId?: string; sourceRunRecordId?: string } = {}): string {
  return envelope('runtime.session', {
    kind: 'run',
    run_id: opts.runId ?? 'run-1',
    event,
    ...(opts.sourceRunRecordId ? { source_run_record_id: opts.sourceRunRecordId } : {}),
  }, opts)
}

/** `goal_usage_attribution`, exactly as seq 48 of the real 1.1.1 session. */
function attribution(opts: {
  usageId: string
  input?: number
  output?: number
  cached?: number
  reasoning?: number
  reported?: boolean
  family?: string
  requesterKind?: string
  ownerSessionId?: string
}): unknown {
  return {
    kind: 'goal_usage_attribution',
    record: {
      schema_version: 1,
      usage_id: opts.usageId,
      usage_family: opts.family ?? 'provider',
      quantity: {
        unit: 'tokens',
        reported: opts.reported ?? true,
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cached_tokens: opts.cached ?? 0,
        reasoning_tokens: opts.reasoning ?? 0,
        main_llm_steps: 1,
      },
      owner: {
        requester_kind: opts.requesterKind ?? 'main',
        session_id: opts.ownerSessionId ?? SESSION,
        run_id: 'run-1',
        owner_id: opts.requesterKind === 'main' || !opts.requesterKind ? 'main-root' : 'subagent-1',
        owner_type: opts.requesterKind === 'main' || !opts.requesterKind ? 'main_root' : 'subagent',
      },
      goal_attribution: { mode: 'none' },
    },
  }
}

/** `model_completed`, exactly as seq 49 of the real 1.1.1 session plus the
 *  `model` / cache fields the published real-model excerpts carry. */
function modelCompleted(opts: {
  input?: number
  output?: number
  cached?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  model?: string
  durationMs?: number
}): unknown {
  return {
    kind: 'model_completed',
    usage: {
      input_tokens: opts.input ?? 0,
      output_tokens: opts.output ?? 0,
      cached_tokens: opts.cached ?? 0,
      ...(opts.cacheRead === undefined ? {} : { cache_read_tokens: opts.cacheRead }),
      ...(opts.cacheWrite === undefined ? {} : { cache_write_tokens: opts.cacheWrite }),
      reasoning_tokens: opts.reasoning ?? 0,
    },
    duration_ms: opts.durationMs ?? 6,
    ...(opts.model ? { model: opts.model } : {}),
  }
}

async function parseAll(paths?: string[]): Promise<ParsedProviderCall[]> {
  const provider = createMuseCodeProvider(dataDir())
  const sources = await provider.discoverSessions()
  const wanted = paths ? sources.filter(s => paths.includes(s.path)) : sources
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of wanted) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('muse-code discovery', () => {
  it('walks sessions/YYYY/MM/DD/<id>/session.jsonl and names the project from workspace_root', async () => {
    await writeSession(SESSION, [metadata('/home/dev/checkout')])
    const sources = await createMuseCodeProvider(dataDir()).discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.project).toBe('checkout')
    expect(sources[0]!.provider).toBe('muse-code')
  })

  it('ignores the .msp-view-v1 fold beside the date shards', async () => {
    // The real binary keeps a materialized view of the SAME usage at
    // sessions/.msp-view-v1/<session-id>/. Descending into it would count
    // every call twice.
    await writeSession(SESSION, [metadata()])
    const viewDir = join(dataDir(), 'sessions', '.msp-view-v1', SESSION)
    await mkdir(viewDir, { recursive: true })
    await writeFile(join(viewDir, 'session.jsonl'), metadata() + '\n')
    await writeFile(join(viewDir, 'HEAD.json'), '{}')

    const sources = await createMuseCodeProvider(dataDir()).discoverSessions()
    expect(sources.map(s => s.path)).toHaveLength(1)
    expect(sources[0]!.path).not.toContain('.msp-view-v1')
  })

  it('skips a dot-prefixed directory inside a day shard', async () => {
    await writeSession(SESSION, [metadata()])
    const hidden = join(dataDir(), 'sessions', '2026', '09', '12', '.scratch')
    await mkdir(hidden, { recursive: true })
    await writeFile(join(hidden, 'session.jsonl'), metadata() + '\n')

    const sources = await createMuseCodeProvider(dataDir()).discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.path).not.toContain('.scratch')
  })

  it('discovers subagent transcripts under <session>/subagent/<child-id>/', async () => {
    await writeSession(SESSION, [metadata()])
    await writeSession('child-1', [runEvent(modelCompleted({}))], { subagentOf: SESSION })

    const sources = await createMuseCodeProvider(dataDir()).discoverSessions()
    expect(sources).toHaveLength(2)
    // A subagent log carries no metadata record of its own, so it inherits the
    // parent's project rather than reading as "unknown".
    expect(sources.every(s => s.project === 'muse-probe')).toBe(true)
  })

  it('reports the probed sessions root to doctor even with nothing on disk (#899)', async () => {
    const provider = createMuseCodeProvider(dataDir())
    await expect(provider.discoverSessions()).resolves.toEqual([])
    expect(await provider.probeRoots!()).toEqual([{ path: join(dataDir(), 'sessions'), label: 'sessions' }])
  })

  it('resolves the data dir from MUSE_DATA_DIR, then XDG_DATA_HOME, then ~/.local/share', () => {
    process.env['MUSE_DATA_DIR'] = '/exact/override'
    // MUSE_DATA_DIR is the EXACT dir, like OPENCODE_DATA_DIR: no 'muse' suffix
    // is appended, so a relocated install is found instead of reporting zero.
    expect(getMuseDataDir()).toBe('/exact/override')

    delete process.env['MUSE_DATA_DIR']
    process.env['XDG_DATA_HOME'] = '/xdg'
    expect(getMuseDataDir()).toBe(join('/xdg', 'muse'))

    process.env['MUSE_DATA_DIR'] = ''
    expect(getMuseDataDir()).toBe(join('/xdg', 'muse'))
  })
})

describe('muse-code line decoding', () => {
  it('unwraps a retained_frame transaction into its children', async () => {
    // The FIRST line of every session the 1.1.1 binary wrote is this wrapper.
    // A parser that does not unwrap it starts two records late.
    const inner = JSON.stringify({ schema_version: 1, sequence: 1, payload_type: 'runtime.session.permission_format_declared', payload: { schema_version: 1, format: 'profile_v1' } })
    const wrapper = JSON.stringify({
      retained_frame: 'session_permission_transaction',
      frame_schema_version: 1,
      outer_log_ordinal: 1,
      transaction_id: 't-1',
      children: [{ child_index: 0, record_json: inner }],
      content_sha256: 'sha256:abc',
    })
    const records = decodeMuseLine(wrapper)
    expect(records).toHaveLength(1)
    expect(records[0]!.payload_type).toBe('runtime.session.permission_format_declared')
  })

  it('keeps a wrapper readable children when one child is torn', () => {
    const good = JSON.stringify({ payload_type: 'runtime.session.metadata', payload: { kind: 'metadata', record: { workspace_root: '/p' } } })
    const wrapper = JSON.stringify({
      retained_frame: 'session_permission_transaction',
      children: [{ child_index: 0, record_json: '{"broken":' }, { child_index: 1, record_json: good }],
    })
    expect(decodeMuseLine(wrapper)).toHaveLength(1)
  })

  it('returns nothing for a line that is not JSON, instead of throwing', () => {
    expect(decodeMuseLine('{"torn":')).toEqual([])
    expect(decodeMuseLine('[1,2,3]')).toEqual([])
  })

  it('names the root session of a subagent transcript from its path', () => {
    expect(rootSessionIdFromPath(`/d/sessions/2026/09/12/${SESSION}/subagent/child-1/session.jsonl`)).toBe(SESSION)
    expect(rootSessionIdFromPath(`/d/sessions/2026/09/12/${SESSION}/session.jsonl`)).toBe('')
  })
})

describe('muse-code double-counting traps', () => {
  it('counts one call when a run writes BOTH goal_usage_attribution and model_completed', async () => {
    // Confirmed at seq 48/49 of a real 1.1.1 session: the two records carry the
    // same numbers for the same model step. Summing them doubles every call.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-a', input: 1000, output: 200, cached: 100, reasoning: 5 }), { sequence: 48 }),
      runEvent(modelCompleted({ input: 1000, output: 200, cached: 100, cacheRead: 100, cacheWrite: 0, reasoning: 5, model: 'muse-spark-1.2' }), { sequence: 49 }),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(200)
    expect(calls[0]!.model).toBe('muse-spark-1.2')
  })

  it('counts one call when the same usage_id appears twice, whatever its position', async () => {
    // Identity, not position: Muse 1.1.x can re-emit a record, and a delegated
    // run is copied into the parent's log as well as its own.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-dup', input: 500, output: 60 }), { sequence: 48, runId: 'run-1' }),
      runEvent(attribution({ usageId: 'usage-dup', input: 500, output: 60 }), { sequence: 90, runId: 'run-9' }),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(500)
  })

  it('counts a subagent run once across the parent log and subagent/<id>/session.jsonl, billed to the root session', async () => {
    const childUsage = attribution({
      usageId: 'usage-child',
      input: 800,
      output: 40,
      requesterKind: 'subagent',
      ownerSessionId: 'child-1',
    })
    // Meta's own MSP schema says child usage "rides the owning items" and is
    // never folded into the parent's totals - so the mirrored copy must not be
    // dropped as a duplicate of nothing, nor added on top.
    await writeSession(SESSION, [metadata(), runEvent(childUsage, { sequence: 60 })])
    await writeSession('child-1', [runEvent(childUsage, { sequence: 5, sessionId: 'child-1' })], { subagentOf: SESSION })

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(800)
    expect(calls[0]!.sessionId).toBe(SESSION)
  })

  it('bills a subagent-only run to the root session, not to the child', async () => {
    await writeSession(SESSION, [metadata()])
    await writeSession('child-1', [
      runEvent(attribution({ usageId: 'usage-child-only', input: 10, output: 2, ownerSessionId: 'child-1', requesterKind: 'subagent' }), { sessionId: 'child-1' }),
    ], { subagentOf: SESSION })

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe(SESSION)
  })

  it('ignores the tool-family attribution that rides the same run', async () => {
    // CodexBar PR #3587's real-log case carries a usage_family "tool" record
    // with reported:false next to the provider one. Only 'provider' is billable.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-p', input: 1000, output: 200 }), { sequence: 48 }),
      runEvent(attribution({ usageId: 'usage-t', input: 0, output: 0, family: 'tool', reported: false }), { sequence: 50 }),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(1000)
  })

  it('bills only the provider family even when a tool-family row carries tokens', async () => {
    // The tool row's shape is real (CodexBar PR #3587's excerpt carries one on
    // the same run); the magnitude here is deliberately non-zero so the family
    // filter, not the empty-usage guard, is what excludes it.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-p2', input: 1000, output: 200 }), { sequence: 48 }),
      runEvent(attribution({ usageId: 'usage-t2', input: 777, output: 88, family: 'tool' }), { sequence: 50 }),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(1000)
  })

  it('counts a copied-context session once when it replays the parent usage ids', async () => {
    // `muse export` marks a forked session `is_copied_context: true`; its log
    // replays the prefix it inherited. Because identity is the usage id, the
    // replayed calls collide with the parent's and are not billed twice - the
    // same outcome dsh.ts gets from its seedLength cut.
    const replayed = attribution({ usageId: 'usage-inherited', input: 300, output: 30 })
    await writeSession(SESSION, [metadata(), runEvent(replayed, { sequence: 48 })])
    await writeSession('forked-session', [
      metadata(),
      runEvent(replayed, { sequence: 4, sessionId: 'forked-session' }),
      runEvent(attribution({ usageId: 'usage-fork-own', input: 11, output: 2 }), { sequence: 9, sessionId: 'forked-session' }),
    ], { day: '2026/09/13' })

    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.inputTokens).sort((a, b) => a - b)).toEqual([11, 300])
  })

  it('keeps every model step of a multi-step run', async () => {
    // MUSE-FORMAT.md: model_completed is "one per model step; a run can have
    // several". Collapsing a run to one call would undercount.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-1', input: 100, output: 10 }), { sequence: 40 }),
      runEvent(modelCompleted({ input: 100, output: 10, model: 'muse-spark-1.3' }), { sequence: 41 }),
      runEvent(attribution({ usageId: 'usage-2', input: 200, output: 20 }), { sequence: 42 }),
      runEvent(modelCompleted({ input: 200, output: 20, model: 'muse-spark-1.3' }), { sequence: 43 }),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.inputTokens)).toEqual([100, 200])
  })
})

describe('muse-code token accounting', () => {
  it('treats input_tokens as inclusive of cached and prices the cached share at the cache-read rate', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-c', input: 1000, output: 200, cached: 100, reasoning: 5 }), { sequence: 48 }),
      runEvent(modelCompleted({ input: 1000, output: 200, cached: 100, cacheRead: 100, cacheWrite: 0, reasoning: 5, model: 'muse-spark-1.2' }), { sequence: 49 }),
    ])

    const [call] = await parseAll()
    expect(call!.inputTokens).toBe(900)
    expect(call!.cacheReadInputTokens).toBe(100)
    expect(call!.cachedInputTokens).toBe(100)
    expect(call!.costUSD).toBeCloseTo(calculateCost('muse-spark-1.2', 900, 200, 0, 100, 0), 12)
  })

  it('does not add reasoning on top of output', async () => {
    // Meta's MSP schema defines reasoningTokens as output tokens spent on
    // reasoning, so they are already inside output_tokens.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-r', input: 100, output: 200, reasoning: 50 }), { sequence: 48 }),
      runEvent(modelCompleted({ input: 100, output: 200, reasoning: 50, model: 'muse-spark-1.3' }), { sequence: 49 }),
    ])

    const [call] = await parseAll()
    expect(call!.outputTokens).toBe(200)
    expect(call!.reasoningTokens).toBe(50)
    expect(call!.costUSD).toBeCloseTo(calculateCost('muse-spark-1.3', 100, 200, 0, 0, 0), 12)
  })

  it('marks a call estimated when the attribution says it did not measure the numbers', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-u', input: 400, output: 40, reported: false }), { sequence: 48 }),
    ])

    const [call] = await parseAll()
    expect(call!.costIsEstimated).toBe(true)
  })

  it('keeps a measured call exact', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-m', input: 400, output: 40 }), { sequence: 48 }),
    ])

    const [call] = await parseAll()
    expect(call!.costIsEstimated).toBeUndefined()
  })

  it('skips a step with no tokens at all rather than reporting a $0 call', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-z' }), { sequence: 48 }),
      runEvent(modelCompleted({ model: 'muse-spark-1.3' }), { sequence: 49 }),
    ])

    expect(await parseAll()).toEqual([])
  })

  it('reads recorded_at as microseconds', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-t1', input: 10, output: 1 }), { recordedAt: 1789246717136721 }),
    ])

    const [call] = await parseAll()
    expect(call!.timestamp).toBe(new Date(1789246717136).toISOString())
  })

  it('rejects an implausible timestamp instead of dating the call to 1970', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-t2', input: 10, output: 1 }), { recordedAt: -5 }),
    ])

    const [call] = await parseAll()
    expect(Number.isNaN(Date.parse(call!.timestamp))).toBe(false)
    expect(new Date(call!.timestamp).getFullYear()).toBeGreaterThan(2000)
  })

  it('reads a non-numeric token count as zero rather than letting it reach the totals', async () => {
    const poisoned = JSON.parse(JSON.stringify(attribution({ usageId: 'usage-bad', output: 7 }))) as {
      record: { quantity: Record<string, unknown> }
    }
    poisoned.record.quantity['input_tokens'] = '9' + '9'.repeat(30)
    await writeSession(SESSION, [metadata(), runEvent(poisoned)])

    const [call] = await parseAll()
    expect(call!.inputTokens).toBe(0)
    expect(call!.outputTokens).toBe(7)
  })

  it('carries the typed prompt and the workspace root onto the call', async () => {
    await writeSession(SESSION, [
      metadata('/home/dev/checkout'),
      envelope('runtime.user_intent.accepted', {
        intent_id: 'run-1',
        source_session_id: SESSION,
        surface: 'main',
        semantic_kind: { kind: 'chat' },
        refill_blocks: [{ kind: 'text', text: 'Say hello and list two fruits.' }],
      }, { sequence: 16 }),
      runEvent(attribution({ usageId: 'usage-p1', input: 10, output: 1 })),
    ])

    const [call] = await parseAll()
    expect(call!.userMessage).toBe('Say hello and list two fruits.')
    expect(call!.project).toBe('checkout')
    expect(call!.projectPath).toBe('/home/dev/checkout')
    expect(call!.workingDirectory).toBe('/home/dev/checkout')
  })

  it('collects tool names from assistant_tool_calls_committed', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent({ kind: 'assistant_tool_calls_committed', message_id: 'm1', tool_calls: [{ id: 't1', call_id: 'c1', name: 'bash', args: '{"command":"ls"}' }] }, { sequence: 45 }),
      runEvent(attribution({ usageId: 'usage-tool', input: 10, output: 1 }), { sequence: 48 }),
    ])

    const [call] = await parseAll()
    expect(call!.tools).toEqual(['Bash'])
  })
})

describe('muse-code model resolution', () => {
  it('takes the model from model_completed and prices the two tiers apart', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-std', input: 1_000_000, output: 0 }), { sequence: 40 }),
      runEvent(modelCompleted({ input: 1_000_000, model: 'muse-spark-1.3' }), { sequence: 41 }),
    ])
    await writeSession('session-2', [
      metadata(),
      runEvent(attribution({ usageId: 'usage-con', input: 1_000_000, output: 0 }), { sequence: 40, sessionId: 'session-2' }),
      runEvent(modelCompleted({ input: 1_000_000, model: 'muse-spark-1.3-contributor' }), { sequence: 41, sessionId: 'session-2' }),
    ])

    const calls = await parseAll()
    const byModel = new Map(calls.map(c => [c.model, c]))
    // The bundled LiteLLM snapshot already carries both the bare and the
    // meta/-prefixed spellings, so no alias is needed - but the tiers are 12.5x
    // apart, so a mapping that lost the suffix would be a large silent error.
    expect(byModel.get('muse-spark-1.3')!.costUSD).toBeCloseTo(1.25, 6)
    expect(byModel.get('muse-spark-1.3-contributor')!.costUSD).toBeCloseTo(0.10, 6)
  })

  it('falls back to the session metadata model when the completion carries none', async () => {
    await writeSession(SESSION, [
      metadata('/home/dev/checkout', { model_id: 'muse-spark-1.2' }),
      runEvent(attribution({ usageId: 'usage-meta', input: 10, output: 1 })),
    ])

    const [call] = await parseAll()
    expect(call!.model).toBe('muse-spark-1.2')
  })

  it('lets the completion model win over the session default', async () => {
    // The binary's SessionMetadata struct carries model_id as the session
    // DEFAULT; a session can change model, so a record that names its own model
    // is authoritative for that step.
    await writeSession(SESSION, [
      metadata('/home/dev/checkout', { model_id: 'muse-spark-1.2' }),
      runEvent(attribution({ usageId: 'usage-pref', input: 1_000_000, output: 0 }), { sequence: 48 }),
      runEvent(modelCompleted({ input: 1_000_000, model: 'muse-spark-1.3-contributor' }), { sequence: 49 }),
    ])

    const [call] = await parseAll()
    expect(call!.model).toBe('muse-spark-1.3-contributor')
    expect(call!.costUSD).toBeCloseTo(0.10, 6)
  })

  it('follows a mid-session model change and prices the legs apart', async () => {
    // EffectiveModelState {provider_id, profile_id, model_id, display_label,
    // source, last_command_id} rides a model-selection event. Legs before and
    // after it must not all bill at whatever the metadata record opened with.
    await writeSession(SESSION, [
      metadata('/home/dev/checkout', { model_id: 'muse-spark-1.3' }),
      runEvent(attribution({ usageId: 'usage-before', input: 1_000_000, output: 0 }), { sequence: 40, runId: 'run-a' }),
      runEvent({
        kind: 'model_selection_initialized',
        provider_id: 'meta',
        profile_id: 'default',
        model_id: 'muse-spark-1.3-contributor',
        display_label: 'Muse Spark 1.3 (contributor)',
        source: 'command',
        last_command_id: 'cmd-1',
      }, { sequence: 41 }),
      runEvent(attribution({ usageId: 'usage-after', input: 1_000_000, output: 0 }), { sequence: 42, runId: 'run-b' }),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.model)).toEqual(['muse-spark-1.3', 'muse-spark-1.3-contributor'])
    expect(calls[0]!.costUSD).toBeCloseTo(1.25, 6)
    expect(calls[1]!.costUSD).toBeCloseTo(0.10, 6)
  })

  it('follows a completed reconfigure through its nested EffectiveModelState', async () => {
    // model_reconfigure_completed carries {effective, apply_outcome}, so the new
    // model id sits under `effective`, not flat on the event.
    await writeSession(SESSION, [
      metadata('/home/dev/checkout', { model_id: 'muse-spark-1.3' }),
      runEvent({
        kind: 'model_reconfigure_completed',
        effective: { provider_id: 'meta', profile_id: 'default', model_id: 'muse-spark-1.2-contributor', display_label: 'Muse Spark 1.2 (contributor)', source: 'command', last_command_id: 'cmd-2' },
        apply_outcome: 'applied',
      }, { sequence: 41 }),
      runEvent(attribution({ usageId: 'usage-reconfigured', input: 1_000_000, output: 0 }), { sequence: 42 }),
    ])

    const [call] = await parseAll()
    expect(call!.model).toBe('muse-spark-1.2-contributor')
    expect(call!.costUSD).toBeCloseTo(0.10, 6)
  })

  it('does not let a rejected or failed reconfigure change the model', async () => {
    // These events name the model that was NOT applied. Treating one as a
    // setter would price everything after it at a model the session never ran.
    await writeSession(SESSION, [
      metadata('/home/dev/checkout', { model_id: 'muse-spark-1.3' }),
      runEvent({ kind: 'model_reconfigure_rejected', model_id: 'muse-spark-1.2-contributor', reason: 'unsupported' }, { sequence: 41 }),
      runEvent({ kind: 'model_reconfigure_failed', failure: { model_id: 'muse-spark-1.2-contributor', kind: 'transport' } }, { sequence: 42 }),
      runEvent({ kind: 'standing_model_route_unserved', model_id: 'muse-spark-1.2-contributor' }, { sequence: 43 }),
      runEvent(attribution({ usageId: 'usage-rejected', input: 1_000_000, output: 0 }), { sequence: 44 }),
    ])

    const [call] = await parseAll()
    expect(call!.model).toBe('muse-spark-1.3')
    expect(call!.costUSD).toBeCloseTo(1.25, 6)
  })

  it('prices the internal build id off its published sibling row', async () => {
    // `muse-spark-1.2-internal` is baked into the 1.1.1 binary beside
    // `muse-spark-1.2`. Meta publishes Standard and Contributor rates only, so
    // it resolves to the Standard sibling rather than to a made-up rate or a
    // silent $0. Deliberate: it is NOT a contributor id.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-internal', input: 1_000_000, output: 0 }), { sequence: 48 }),
      runEvent(modelCompleted({ input: 1_000_000, model: 'muse-spark-1.2-internal' }), { sequence: 49 }),
    ])

    const [call] = await parseAll()
    expect(call!.model).toBe('muse-spark-1.2-internal')
    expect(call!.costUSD).toBeCloseTo(1.25, 6)
  })

  it('reports an unreadable model as unknown rather than guessing a Muse Spark tier', async () => {
    // Meta's own rule: SessionTokenUsageParams.modelId null is "never
    // back-filled, an unpriced leg". Guessing between the tiers would be a
    // 12.5x error on input.
    await writeSession(SESSION, [
      metadata(),
      runEvent(attribution({ usageId: 'usage-nomodel', input: 1_000_000, output: 1000 })),
    ])

    const [call] = await parseAll()
    expect(call!.model).toBe('unknown')
    expect(call!.costUSD).toBe(0)
  })
})

describe('muse-code resilience', () => {
  it('skips a corrupt interior line and still counts the rest', async () => {
    await writeSession(SESSION, [
      metadata(),
      '{"schema_version":1,"payload_type":',
      'not json at all',
      runEvent(attribution({ usageId: 'usage-after-corrupt', input: 42, output: 4 })),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(42)
  })

  it('ignores event kinds it does not know', async () => {
    await writeSession(SESSION, [
      metadata(),
      runEvent({ kind: 'a_kind_from_a_future_build', payload: { anything: true } }),
      runEvent({ kind: 'resource_usage_sampled' }),
      runEvent(attribution({ usageId: 'usage-unknown-kinds', input: 5, output: 1 })),
    ])

    expect(await parseAll()).toHaveLength(1)
  })
})

describe('muse-code against captured real logs', () => {
  it('parses a real Muse Code 1.1.1 session end to end', async () => {
    // tests/fixtures/muse-code/echo-session-1.1.1.jsonl came off a real binary.
    // Its echo provider bills nothing, so every counter is 0 - which is exactly
    // the case that must NOT surface as a $0.00 call.
    const dir = join(dataDir(), 'sessions', '2026', '09', '12', SESSION)
    await mkdir(dir, { recursive: true })
    await copyFile(join(FIXTURES, 'echo-session-1.1.1.jsonl'), join(dir, 'session.jsonl'))

    const provider = createMuseCodeProvider(dataDir())
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    // Proves the retained_frame wrapper and the metadata record both decoded:
    // the project can only come from payload.record.workspace_root.
    expect(sources[0]!.project).toBe('muse-probe')
    expect(await parseAll()).toEqual([])
  })

  it('prices a meta-provider run built from the real log plus the binary field layout', async () => {
    // synthesised-meta-run.jsonl is echo-session-1.1.1.jsonl with exactly two
    // fields added - metadata `model_id` and model_completed `model` - at the
    // positions the binary's own serde struct layouts put them, plus non-zero
    // counters. Its first line says so. This is the closest thing to a paid
    // session available here, and it must be replaced by a real one.
    const dir = join(dataDir(), 'sessions', '2026', '09', '12', SESSION)
    await mkdir(dir, { recursive: true })
    await copyFile(join(FIXTURES, 'synthesised-meta-run.jsonl'), join(dir, 'session.jsonl'))

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    const [call] = calls
    // The per-completion model beats the metadata default (1.3 over 1.2).
    expect(call!.model).toBe('muse-spark-1.3')
    expect(call!.inputTokens).toBe(28316 - 316)
    expect(call!.cacheReadInputTokens).toBe(316)
    expect(call!.outputTokens).toBe(22)
    expect(call!.reasoningTokens).toBe(11)
    expect(call!.project).toBe('muse-probe')
    expect(call!.userMessage).toBe('Say hello and list two fruits.')
    expect(call!.costIsEstimated).toBeUndefined()
    expect(call!.costUSD).toBeCloseTo(calculateCost('muse-spark-1.3', 28000, 22, 0, 316, 0), 12)
  })

  it('matches the CodexBar PR #3587 real-log excerpt: one call, model kept, tool row ignored', async () => {
    const dir = join(dataDir(), 'sessions', '2026', '09', '08', 'codexbar-session')
    await mkdir(dir, { recursive: true })
    await copyFile(join(FIXTURES, 'published-codexbar-pr3587.jsonl'), join(dir, 'session.jsonl'))

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.model).toBe('muse-spark-1.2')
    // That excerpt's attribution carries no usage_id, so the model event is the
    // only usable record - the documented fallback, not a duplicate.
    expect(call!.outputTokens).toBe(200)
    expect(call!.cacheReadInputTokens).toBe(100)
    expect(call!.inputTokens).toBe(900)
    expect(call!.reasoningTokens).toBe(5)
    expect(call!.timestamp).toBe(new Date(1788868800000).toISOString())
  })

  it('matches the superset real Muse Code 1.1.1 record, contributor tier included', async () => {
    const dir = join(dataDir(), 'sessions', '2026', '09', '11', '629b3bc1-5dd7-4a0d-a901-69701850922c')
    await mkdir(dir, { recursive: true })
    await copyFile(join(FIXTURES, 'published-superset-1.1.1.jsonl'), join(dir, 'session.jsonl'))

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.model).toBe('muse-spark-1.3-contributor')
    expect(call!.inputTokens).toBe(28316)
    expect(call!.outputTokens).toBe(22)
    expect(call!.reasoningTokens).toBe(11)
    expect(call!.project).toBe('proj')
    // Contributor input is $0.10/1M: 28316 tokens plus 22 output at $0.20/1M.
    expect(call!.costUSD).toBeCloseTo(28316 * 1e-7 + 22 * 2e-7, 12)
  })
})
