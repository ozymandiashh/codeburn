import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { FS_SCAN_CONCURRENCY, mapWithConcurrency, readSessionLines } from '../fs-utils.js'
import { billableOutputTokens, calculateCost, getModelCosts, getShortModelName } from '../models.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// Meta's Muse Code CLI (`muse`) writes one append-only JSONL transcript per
// session under a date-sharded tree, the same shape Codex uses:
//
//   <MUSE_DATA_DIR | $XDG_DATA_HOME/muse | ~/.local/share/muse>/
//     sessions/YYYY/MM/DD/<session-id>/session.jsonl
//     sessions/YYYY/MM/DD/<session-id>/subagent/<child-id>/session.jsonl
//
// PROVENANCE. Everything this parser relies on is either (a) confirmed against
// a real `Muse Code 1.1.1 (1.1.1-R2514.1)` binary, build sha b934305d21, whose
// `muse exec --provider echo` sessions were read off disk while writing this
// file, or (b) taken from a published excerpt of a real log. The one thing the
// local runs could NOT exercise is the model id: the echo provider refuses
// `--model` ("--model requires --provider meta") and writes no model field at
// all, so `model_completed.event.model` is carried here on the authority of two
// independent published excerpts of real Meta-provider logs:
//   * steipete/CodexBar PR #3587, MuseCostUsageScannerTests.swift, the case
//     named "real Muse CLI runtime log counts model_completed once and keeps
//     model name": {"kind":"model_completed","usage":{...},"duration_ms":10,
//     "finish_reason":"stop","model":"muse-spark-1.2"}
//   * superset-sh/superset packages/host-service/src/trpc/router/usage/history/
//     muse.test.ts, the case named "reads the record a real Meta-provider
//     session writes (Muse Code 1.1.1)": model "muse-spark-1.3-contributor".
// A call whose model cannot be read is reported as UNKNOWN_MODEL rather than
// defaulted to any Muse Spark tier: the two tiers differ by 12.5x on input, so
// guessing one would invent spend. That is not a workaround, it is Meta's own
// rule - `SessionTokenUsageParams.modelId` in the MSP wire schema (exported
// offline from this binary with `muse schema generate-json-schema`) says a null
// model is "never back-filled, an unpriced leg (tdd SS4.6.5)".
//
// See docs/providers/muse-code.md for the full confirmed/unverified split.

const UNKNOWN_MODEL = 'unknown'

// `recorded_at` is microseconds since the epoch on every record the 1.1.1
// binary wrote (e.g. 1789246716491567) and in every published excerpt. Promote
// a seconds/millisecond-resolution value rather than trusting the unit blindly,
// and reject what stays implausible - the same hazard guard cline-cli.ts and
// dsh.ts apply. Thresholds are in the unit each branch tests.
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000
const MICROSECOND_FLOOR = 1e14

// Token counts come off an unchecked JSON.parse, so a crafted or corrupt log
// could carry a string, an array or an absurd magnitude. Anything that is not a
// plausible non-negative integer reads as 0 rather than flowing into the global
// totals and the persisted cache.
const MAX_PLAUSIBLE_TOKENS = 1e12

const noticed = new Set<string>()

function notice(message: string): void {
  if (noticed.has(message)) return
  noticed.add(message)
  process.stderr.write(`codeburn: ${message}\n`)
}

const PATH_NOTICE_EXAMPLES = 3
const noticedPaths = new Map<string, number>()

function noticePath(kind: string, detail: string): void {
  const seen = (noticedPaths.get(kind) ?? 0) + 1
  noticedPaths.set(kind, seen)
  if (seen <= PATH_NOTICE_EXAMPLES) process.stderr.write(`codeburn: ${kind}: ${detail}\n`)
  else if (seen === PATH_NOTICE_EXAMPLES + 1) process.stderr.write(`codeburn: ${kind}: further paths suppressed\n`)
}

// Muse's own tool names, as documented for `assistant_tool_calls_committed` in
// specstoryai/getspecstory specstory-cli/docs/MUSE-FORMAT.md. Only names that
// appear there are mapped; anything else passes through unchanged.
const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  workflow: 'TodoWrite',
  web_search: 'WebSearch',
  skill: 'Skill',
  subagent: 'Agent',
}

function mapToolName(raw: string): string {
  return Object.hasOwn(toolNameMap, raw) ? toolNameMap[raw]! : raw
}

// Run-stream event kinds this parser has actually seen, so an unfamiliar one
// can be COUNTED as unknown rather than silently ignored. Every name here was
// observed in a real 1.1.1 session on this machine, in Meta's own cookbook
// export, or in one of the published excerpts.
const KNOWN_RUN_EVENT_KINDS = new Set([
  'started',
  'context_block_diagnostic',
  'model_request_configured',
  'provider_request_options_configured',
  'model_input_trace_recorded',
  'model_response_created',
  'model_completed',
  'goal_usage_attribution',
  'assistant_message_committed',
  'assistant_tool_calls_committed',
  'tool_result_batch_committed',
  'reasoning_committed',
  'todo_snapshot_updated',
  'user_prompt_display',
  'task_stream_linked',
  'memory_reminder_child_session_linked',
  'resource_usage_sampled',
  'run_fatal_error_classified',
  'terminal',
])

type MuseUsage = {
  input_tokens?: unknown
  output_tokens?: unknown
  cached_tokens?: unknown
  cache_read_tokens?: unknown
  cache_write_tokens?: unknown
  reasoning_tokens?: unknown
}

type MuseRecord = {
  id?: unknown
  stream?: { kind?: unknown; id?: unknown }
  sequence?: unknown
  recorded_at?: unknown
  payload_type?: unknown
  payload?: {
    kind?: unknown
    run_id?: unknown
    source_run_record_id?: unknown
    record?: Record<string, unknown>
    event?: {
      kind?: unknown
      model?: unknown
      model_id?: unknown
      finish_reason?: unknown
      duration_ms?: unknown
      usage?: MuseUsage
      record?: Record<string, unknown>
      tool_calls?: unknown
    }
    refill_blocks?: unknown
  }
  // Retained-frame wrapper lines carry their real records as escaped JSON.
  retained_frame?: unknown
  children?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrZero(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= MAX_PLAUSIBLE_TOKENS
    ? Math.floor(raw)
    : 0
}

function stringOrUndefined(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw ? raw : undefined
}

function isoTimestamp(raw: unknown, fallback: string): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback
  // Microseconds on every record the real binary wrote; tolerate a millisecond
  // or second value rather than turning it into a date in the far future/past.
  let ms = raw
  if (ms > MICROSECOND_FLOOR) ms = Math.floor(ms / 1000)
  else if (ms < MIN_REASONABLE_TIMESTAMP_MS) ms = ms * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS) return fallback
  return date.toISOString()
}

function projectFromRoot(root: string, fallback: string): string {
  const segments = root.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? fallback
}

/** The exact data directory Muse Code writes under.
 *
 *  `MUSE_DATA_DIR` is an EXACT directory override, mirroring `OPENCODE_DATA_DIR`
 *  (#617): a fork or a relocated install writing `<dir>/sessions/...` is found
 *  instead of silently reporting zero. An empty string is treated as unset.
 *  Otherwise Muse follows XDG on every platform it supports - the launcher at
 *  https://api.meta.ai/muse-launcher.sh reads XDG for its credential path on
 *  macOS too, and the 1.1.1 binary wrote to ~/.local/share/muse on macOS here. */
export function getMuseDataDir(override?: string): string {
  if (override) return override
  const envOverride = process.env['MUSE_DATA_DIR']
  if (envOverride) return envOverride
  const base = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share')
  return join(base, 'muse')
}

/** Decode one physical line into the logical records it carries.
 *
 *  Most lines ARE the record. Some are a retained-frame transaction wrapper -
 *  `{retained_frame, frame_schema_version, outer_log_ordinal, transaction_id,
 *  children:[{child_index, record_json}], content_sha256}` - whose `record_json`
 *  children are the records, escaped as JSON strings. The very first line of
 *  every session the 1.1.1 binary wrote here is such a wrapper, so a parser that
 *  does not unwrap it starts the session two records late. */
export function decodeMuseLine(line: string): MuseRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObject(parsed)) return []

  const children = parsed['children']
  if (typeof parsed['retained_frame'] === 'string' && Array.isArray(children)) {
    const out: MuseRecord[] = []
    for (const child of children) {
      if (!isObject(child)) continue
      const raw = child['record_json']
      if (typeof raw !== 'string') continue
      try {
        const record: unknown = JSON.parse(raw)
        if (isObject(record)) out.push(record as MuseRecord)
      } catch {
        // A torn or truncated child cannot justify dropping its siblings.
      }
    }
    return out
  }

  return [parsed as MuseRecord]
}

type SessionMeta = { workspaceRoot?: string; model?: string; semver?: string; providerId?: string }

/** `runtime.session.metadata` is the session's own header record: its
 *  `payload.record.workspace_root` is the project (confirmed on the real
 *  binary), alongside `provider_id` and `build.{sha,semver}`.
 *
 *  `model_id` is the SESSION DEFAULT model, and the spelling is confirmed: the
 *  binary's own `SessionMetadata` struct lays its field-name literals out in
 *  declaration order as `provider_id` `model_id` `web_search_mode`
 *  `tool_surface_version`, which is exactly the echo run's record with
 *  `model_id` missing - serde skips a null. It is a fallback, not the
 *  authoritative read: a per-completion `model` wins, because a session can
 *  change model mid-way. */
function readSessionMeta(record: MuseRecord): SessionMeta | null {
  if (record.payload_type !== 'runtime.session.metadata') return null
  const payload = record.payload
  if (!isObject(payload)) return null
  const inner = payload['record']
  if (!isObject(inner)) return null
  const build = inner['build']
  return {
    workspaceRoot: stringOrUndefined(inner['workspace_root']),
    model: stringOrUndefined(inner['model_id'])
      ?? stringOrUndefined(inner['model'])
      ?? stringOrUndefined(inner['default_model']),
    providerId: stringOrUndefined(inner['provider_id']),
    semver: isObject(build) ? stringOrUndefined(build['semver']) : undefined,
  }
}

const SESSION_LOG = 'session.jsonl'
// The metadata record is the session's third record in practice; read a bounded
// head rather than the whole transcript during discovery.
const DISCOVERY_HEAD_LINES = 40

async function readMetaFromFile(filePath: string): Promise<SessionMeta | null> {
  let seen = 0
  try {
    for await (const line of readSessionLines(filePath)) {
      if (!line.trim()) continue
      for (const record of decodeMuseLine(line)) {
        const meta = readSessionMeta(record)
        if (meta) return meta
      }
      seen += 1
      if (seen >= DISCOVERY_HEAD_LINES) return null
    }
  } catch {
    return null
  }
  return null
}

async function isDir(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null)
  return s?.isDirectory() === true
}

async function isFile(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null)
  return s?.isFile() === true
}

/** Walk sessions/YYYY/MM/DD/<session-id>/.
 *
 *  The numeric filters are load-bearing, not cosmetic: the sessions root also
 *  holds `.msp-view-v1/<session-id>/` (HEAD.json, journal/index .bin and folded
 *  `snapshot-*.json`), which is a materialized view of the same usage. Counting
 *  it would double-count every call, so only \d{4}/\d{2}/\d{2} is descended. */
async function discoverSessionsInDir(sessionsDir: string): Promise<SessionSource[]> {
  const years = (await readdir(sessionsDir).catch(() => [] as string[])).filter(y => /^\d{4}$/u.test(y))

  const monthDirs = (await mapWithConcurrency(years, FS_SCAN_CONCURRENCY, async year => {
    const yearDir = join(sessionsDir, year)
    return (await readdir(yearDir).catch(() => [] as string[]))
      .filter(m => /^\d{2}$/u.test(m))
      .map(m => join(yearDir, m))
  })).flat()

  const dayDirs = (await mapWithConcurrency(monthDirs, FS_SCAN_CONCURRENCY, async monthDir =>
    (await readdir(monthDir).catch(() => [] as string[]))
      .filter(d => /^\d{2}$/u.test(d))
      .map(d => join(monthDir, d)),
  )).flat()

  const sessionDirs = (await mapWithConcurrency(dayDirs, FS_SCAN_CONCURRENCY, async dayDir =>
    (await readdir(dayDir).catch(() => [] as string[]))
      .filter(name => !name.startsWith('.'))
      .map(name => join(dayDir, name)),
  )).flat()

  const perSession = await mapWithConcurrency(sessionDirs, FS_SCAN_CONCURRENCY, async sessionDir => {
    const logPath = join(sessionDir, SESSION_LOG)
    if (!(await isFile(logPath))) return []

    const meta = await readMetaFromFile(logPath)
    const root = meta?.workspaceRoot
    const project = root ? projectFromRoot(root, 'unknown') : 'unknown'
    const sources: SessionSource[] = [{ path: logPath, project, provider: 'muse-code' }]

    // Subagent transcripts live beside the parent's, one directory per child.
    // They are their own streams, so they are discovered as their own sources;
    // the usage-id dedup below is what keeps a run mirrored into BOTH logs from
    // being billed twice. Confirmed layout on the real binary: a single
    // `subagent/<child-id>/session.jsonl` per child.
    const subagentDir = join(sessionDir, 'subagent')
    if (await isDir(subagentDir)) {
      const children = await readdir(subagentDir).catch(() => [] as string[])
      for (const child of children) {
        if (child.startsWith('.')) continue
        const childLog = join(subagentDir, child, SESSION_LOG)
        if (!(await isFile(childLog))) continue
        sources.push({ path: childLog, project, provider: 'muse-code' })
      }
    }

    return sources
  })

  return perSession.flat()
}

// A session can change model mid-way, so the session default has to move with
// it. The binary carries an `EffectiveModelState` struct (`provider_id`
// `profile_id` `model_id` `display_label` `source` `last_command_id`) and a
// contiguous family of run-stream event kinds that announce one:
//
//   model_reconfigure_completed  {effective, apply_outcome}   -> new model
//   model_reconfigure_failed     {failure}                    -> NO change
//   model_reconfigure_rejected                                -> NO change
//   model_selection_initialized                               -> new model
//   standing_model_route_unserved                             -> NO change
//   run_model_configured  {profile_id, model_id, display_label, source}
//
// Only the affirmative ones move the default. A failed, rejected or unserved
// reconfigure leaves the session on the model it was already using; treating
// one as a setter would unprice or mis-price everything after it.
const MODEL_SETTING_EVENT_KINDS = new Set([
  'model_selection_initialized',
  'model_reconfigure_completed',
  'run_model_configured',
])

// Announced but deliberately inert. Listed so they are not counted as unknown.
const MODEL_NON_SETTING_EVENT_KINDS = new Set([
  'model_reconfigure_failed',
  'model_reconfigure_rejected',
  'standing_model_route_unserved',
])

/** The `model_id` an `EffectiveModelState`-carrying event announces, wherever
 *  that struct sits on the event: `run_model_configured` carries the field flat,
 *  `model_reconfigure_completed` carries it under `effective`. Only a real
 *  string is accepted, so an event that announces none leaves the default. */
function effectiveModelId(event: Record<string, unknown>): string | undefined {
  const direct = stringOrUndefined(event['model_id'])
  if (direct) return direct
  for (const key of ['effective', 'effective_model', 'model', 'record', 'state']) {
    const nested = event[key]
    if (isObject(nested)) {
      const found = stringOrUndefined(nested['model_id'])
      if (found) return found
    }
  }
  return undefined
}

type ProviderUsage = {
  usageId: string
  input: number
  output: number
  cached: number
  cacheWrite: number
  reasoning: number
  reported: boolean
  timestamp: string
  // The session default model in force when this record was read, so a
  // mid-session model change prices the legs before and after it apart.
  sessionModel?: string
}

type ModelCompletion = {
  recordId: string
  model?: string
  usage: ProviderUsage
  timestamp: string
  sessionModel?: string
}

type RunBucket = {
  attributions: ProviderUsage[]
  completions: ModelCompletion[]
  tools: string[]
}

function emptyRun(): RunBucket {
  return { attributions: [], completions: [], tools: [] }
}

function usageFromTokens(source: Record<string, unknown> | MuseUsage, usageId: string, reported: boolean, timestamp: string): ProviderUsage {
  const raw = source as MuseUsage
  return {
    usageId,
    input: numberOrZero(raw.input_tokens),
    output: numberOrZero(raw.output_tokens),
    // `cached_tokens` is what both the real 1.1.1 binary and CodexBar's real-log
    // excerpt carry; `cache_read_tokens` appears alongside it on
    // `model_completed.usage` with the SAME value in that excerpt, so either
    // spelling reads as the cached share and neither is added to the other.
    cached: Math.max(numberOrZero(raw.cached_tokens), numberOrZero(raw.cache_read_tokens)),
    cacheWrite: numberOrZero(raw.cache_write_tokens),
    reasoning: numberOrZero(raw.reasoning_tokens),
    reported,
    timestamp,
  }
}

/** `goal_usage_attribution` is the usage record that carries a stable identity.
 *
 *  Confirmed on the real binary (seq 48 of a 1.1.1 echo session):
 *    payload.event.record = {schema_version, usage_id:"usage-<uuid>",
 *      usage_family:"provider", quantity:{unit:"tokens", reported:true,
 *      input_tokens, output_tokens, cached_tokens, reasoning_tokens,
 *      main_llm_steps}, owner:{requester_kind, session_id, run_id, owner_id,
 *      owner_type}, goal_attribution:{mode}}
 *
 *  Only `usage_family === 'provider'` is billable. CodexBar PR #3587's real-log
 *  excerpt also carries a `usage_family: "tool"` attribution with
 *  `reported:false` on the same run; summing every attribution would count that
 *  row too. */
function readAttribution(event: Record<string, unknown>, timestamp: string): ProviderUsage | null {
  const record = event['record']
  if (!isObject(record)) return null
  if (record['usage_family'] !== 'provider') return null
  const quantity = record['quantity']
  if (!isObject(quantity)) return null
  if (quantity['unit'] !== undefined && quantity['unit'] !== 'tokens') return null

  // `record.owner` ({requester_kind, session_id, run_id, owner_id, owner_type})
  // says WHOSE call this is. It deliberately does not gate counting: Meta's MSP
  // schema says subagent usage "is never folded in - it rides the owning items"
  // (SessionTokenUsageParams.cumulative, tdd SS4.6.5), so a child's attribution
  // is real spend wherever it appears, and `usage_id` is what keeps the copy in
  // the parent's log and the copy in subagent/<id>/session.jsonl from being
  // billed twice. That mirroring is Meta's own documented behaviour, not a
  // defensive guess: `muse trace inspect --help` says its projection includes
  // "hashed workflow-child run streams mirrored into the parent log (#6408)".
  const usageId = stringOrUndefined(record['usage_id'])
  if (!usageId) return null
  return usageFromTokens(quantity, usageId, quantity['reported'] === true, timestamp)
}

/** The root session a transcript belongs to, from its own path.
 *
 *  A subagent log lives at `<...>/<root-session-id>/subagent/<child-id>/session.jsonl`
 *  - confirmed on the real 1.1.1 binary and in Meta's own cookbook - so the
 *  directory above `subagent/` names the session that delegated the work. That
 *  is where its cost belongs, the same way codex bills a fork's replayed calls
 *  under the parent. A top-level transcript returns '' and keeps its own id. */
export function rootSessionIdFromPath(path: string): string {
  const segments = path.split(/[\\/]/u)
  const index = segments.lastIndexOf('subagent')
  if (index <= 0) return ''
  return segments[index - 1] ?? ''
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      let sessionId = ''
      const rootSessionId = rootSessionIdFromPath(source.path)
      let meta: SessionMeta | null = null
      let sessionStart = ''
      let userMessage = ''
      let sawUnreportedUsage = false
      // Starts at the metadata record's `model_id` and moves with any
      // model-selection event; captured onto each usage record as it is read.
      let currentSessionModel: string | undefined
      // `muse export` reports `diagnostics.duplicate_records` and
      // `unknown_payload_kinds` for exactly these two classes; report the same
      // two rather than dropping records silently.
      let duplicatesDropped = 0
      let unknownRunEventKinds = 0

      const runs = new Map<string, RunBucket>()
      const runOrder: string[] = []

      const bucketFor = (runId: string): RunBucket => {
        let bucket = runs.get(runId)
        if (!bucket) {
          bucket = emptyRun()
          runs.set(runId, bucket)
          runOrder.push(runId)
        }
        return bucket
      }

      let lines: AsyncGenerator<string>
      try {
        lines = readSessionLines(source.path)
      } catch {
        return
      }

      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          for (const record of decodeMuseLine(line)) {
            const timestamp = isoTimestamp(record.recorded_at, sessionStart)
            if (!sessionStart && timestamp) sessionStart = timestamp

            const stream = record.stream
            if (!sessionId && isObject(stream)) {
              sessionId = stringOrUndefined(stream['id']) ?? ''
            }

            const nextMeta = readSessionMeta(record)
            if (nextMeta) {
              meta ??= nextMeta
              currentSessionModel = nextMeta.model ?? currentSessionModel
              continue
            }

            const payload = record.payload
            if (!isObject(payload)) continue

            // The typed prompt for the turn. Confirmed on the real binary:
            // payload.refill_blocks[] = [{kind:"text", text:"..."}].
            if (record.payload_type === 'runtime.user_intent.accepted') {
              if (!userMessage) {
                const blocks = payload['refill_blocks']
                if (Array.isArray(blocks)) {
                  const texts = blocks
                    .filter(isObject)
                    .map(block => stringOrUndefined(block['text']))
                    .filter((text): text is string => Boolean(text))
                  if (texts.length > 0) userMessage = texts.join(' ').slice(0, 500)
                }
              }
              continue
            }

            if (record.payload_type !== 'runtime.session') continue
            if (payload['kind'] !== 'run') continue

            const event = payload['event']
            if (!isObject(event)) continue
            const eventKind = stringOrUndefined(event['kind'])
            if (!eventKind) continue
            const runId = stringOrUndefined(payload['run_id']) ?? (sessionId || source.path)

            if (MODEL_SETTING_EVENT_KINDS.has(eventKind)) {
              currentSessionModel = effectiveModelId(event) ?? currentSessionModel
              continue
            }
            if (MODEL_NON_SETTING_EVENT_KINDS.has(eventKind)) continue

            if (eventKind === 'goal_usage_attribution') {
              const usage = readAttribution(event, timestamp)
              if (!usage) continue
              if (!usage.reported) sawUnreportedUsage = true
              usage.sessionModel = currentSessionModel
              bucketFor(runId).attributions.push(usage)
              continue
            }

            if (eventKind === 'model_completed') {
              const usage = event['usage']
              const recordId = stringOrUndefined(payload['source_run_record_id'])
                ?? stringOrUndefined(record.id)
                ?? `${runId}:${String(bucketFor(runId).completions.length)}`
              bucketFor(runId).completions.push({
                recordId,
                // `model`, not `model_id`: the binary's `model_completed` struct
                // lays its fields out as `usage` `duration_ms` `finish_reason`
                // `model`. Absent on an echo run, where there is no model.
                // `duration_ms` and `finish_reason` sit beside it on the same
                // struct; neither is read, because codeburn has no throughput
                // or stop-reason accounting for this provider yet.
                model: stringOrUndefined(event['model']),
                usage: usageFromTokens(isObject(usage) ? usage : {}, `completed-${recordId}`, isObject(usage), timestamp),
                timestamp,
                sessionModel: currentSessionModel,
              })
              continue
            }

            if (eventKind !== 'assistant_tool_calls_committed') {
              // Everything else is lifecycle, diagnostics or trace detail. An
              // unknown kind is skipped, never fatal: the CLI auto-updates
              // hourly and adds event kinds between builds.
              if (!KNOWN_RUN_EVENT_KINDS.has(eventKind)) unknownRunEventKinds += 1
              continue
            }

            // Tool names, per MUSE-FORMAT.md:
            // {message_id, tool_calls:[{id, call_id, name, args}]}. `args` is an
            // escaped JSON string there, and is deliberately not decoded: no
            // real-model excerpt pins its per-tool shape.
            if (eventKind === 'assistant_tool_calls_committed') {
              const calls = event['tool_calls']
              if (!Array.isArray(calls)) continue
              const bucket = bucketFor(runId)
              for (const call of calls) {
                if (!isObject(call)) continue
                const name = stringOrUndefined(call['name'])
                if (name) bucket.tools.push(mapToolName(name))
              }
              continue
            }

          }
        }
      } catch (err) {
        noticePath('skipped unreadable Muse Code session log', `${source.path}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      if (duplicatesDropped > 0) {
        noticePath('Muse Code session repeated usage records that were counted once', `${source.path} (${String(duplicatesDropped)})`)
      }
      if (unknownRunEventKinds > 0) {
        noticePath('Muse Code session carries run events this build does not know; they were skipped', `${source.path} (${String(unknownRunEventKinds)})`)
      }
      if (sawUnreportedUsage) {
        noticePath('Muse Code session reports usage it did not measure; those calls are priced from the model event instead', source.path)
      }

      // Muse Code is beta and auto-updates hourly, so the schema can move under
      // this parser. It was written against the builds two `build.semver`
      // families were verified on - 1.1.x (a local 1.1.1 binary, plus CodexBar
      // PR #3587 and superset's real-log excerpts) and 0.1.x (Meta's own
      // cookbook export, SpecStory, firstmate). A third family is still parsed
      // - dropping every session on a point release would be worse than reading
      // one with slightly stale assumptions - but it says so once.
      const family = meta?.semver?.split('.').slice(0, 2).join('.')
      if (family && family !== '1.1' && family !== '0.1') {
        notice(`Muse Code ${meta!.semver!} is newer than the versions this parser was verified against (0.1.x, 1.1.x); usage may be incomplete. Update codeburn.`)
      }

      const workspaceRoot = meta?.workspaceRoot
      const project = workspaceRoot ? projectFromRoot(workspaceRoot, source.project) : source.project
      // A subagent transcript bills into its parent session so one delegated run
      // does not read as a second session; the dedup key stays the usage id, so
      // the copy mirrored into the parent's own log still collapses onto it.
      const billedSessionId = rootSessionId || sessionId || source.path

      for (const runId of runOrder) {
        const bucket = runs.get(runId)!
        const steps = Math.max(bucket.attributions.length, bucket.completions.length)

        for (let index = 0; index < steps; index += 1) {
          const attribution = bucket.attributions[index]
          const completion = bucket.completions[index]

          // Muse Code 1.1.x writes BOTH a `goal_usage_attribution` and a
          // `model_completed` for the same model step, carrying the same
          // numbers - confirmed at seq 48/49 of a real 1.1.1 session and
          // reported independently by CodexBar PR #3587. Summing them doubles
          // every call. The attribution wins because it carries the stable
          // `usage_id`; `model_completed` contributes the model name only, and
          // stands in for the tokens when no attribution accompanies it.
          const usage = attribution?.reported ? attribution : completion?.usage ?? attribution
          if (!usage) continue
          // Exact only when the figure we used says it was measured: a reported
          // attribution, or a `model_completed` that carried a usage block.
          const measured = attribution?.reported === true || (usage === completion?.usage && completion.usage.reported)

          // Identity, never position: a repeated `usage_id` is the same billed
          // call seen twice (parent log plus `subagent/<id>/session.jsonl`, or a
          // 1.1.x re-emission), so it is counted once across the whole scan.
          const identity = attribution?.usageId ?? completion?.recordId ?? `${runId}:${String(index)}`
          const dedupKey = `muse-code:${identity}`
          if (seenKeys.has(dedupKey)) {
            duplicatesDropped += 1
            continue
          }

          const input = usage.input
          const output = usage.output
          const cached = usage.cached
          const reasoning = usage.reasoning
          if (input + output + cached + usage.cacheWrite + reasoning === 0) continue
          seenKeys.add(dedupKey)

          // THE ONE PRICING CLAIM META'S OWN SCHEMA DOES NOT SETTLE OUTRIGHT.
          // Corroborated, though, by the binary's own field naming: a sibling
          // usage struct in muse-bin-1.1.1-R2514.1 spells `input_tokens`
          // `cached_input_tokens` `non_cached_input_tokens` `output_tokens`
          // `total_tokens` - cached is a PARTITION OF input there, not a
          // sibling of it. That is not proof for `quantity.cached_tokens`
          // specifically, but nothing in the binary points the other way.
          // `TokenUsage.cachedTokens` there is documented as living "inside or
          // beside `inputTokens`, provider-convention-dependent - the reason
          // `promptTokens` exists" (tdd SS4.6.5). `promptTokens` is the
          // server-derived counted-once figure, and it is NOT in the durable log
          // (it is an MSP `session/tokenUsage` derivation), so a log reader has
          // to pick the convention. We subtract, i.e. read input as INCLUSIVE of
          // cached, the same normalization codex.ts applies to OpenAI counts:
          // that is what superset-sh/superset states outright in the header of
          // packages/host-service/src/trpc/router/usage/history/muse.ts, having
          // checked real logs, and it computes max(0, input - cached) too. No
          // published excerpt is numerically decisive (both real-model excerpts
          // have cached == 0 or no total), so this is the one place where a real
          // `--provider meta` session has to confirm the reading. If it turns
          // out cached sits BESIDE input, this line and this line only changes.
          const uncachedInput = Math.max(0, input - cached)
          const cacheWriteInput = Math.max(0, Math.min(usage.cacheWrite, uncachedInput))

          // Precedence, in the order the binary makes available:
          //   1. this step's own `model_completed.model`;
          //   2. another completion in the same run that named one (a run's
          //      steps share a model unless a selection event says otherwise);
          //   3. the session default in force when this record was read. That
          //      is seeded from the metadata record's `model_id` and moved by
          //      every affirmative model event, so it is the ONLY session-level
          //      source - reading `meta.model` again here would silently undo a
          //      mid-session change for any step that named no model itself;
          //   4. unknown, which is unpriced. Never a guessed tier.
          const model = completion?.model
            ?? bucket.completions.find(c => c.model)?.model
            ?? completion?.sessionModel
            ?? attribution?.sessionModel
            ?? UNKNOWN_MODEL

          // Same rule codex.ts applies: only move tokens into the cache-write
          // bucket when the pricing source publishes a real cache-write rate,
          // so a fabricated default never invents a surcharge Meta never billed.
          const billedCacheWrite = cacheWriteInput > 0 && getModelCosts(model)?.cacheWriteCostIsExplicit
            ? cacheWriteInput
            : 0
          const billedInput = uncachedInput - billedCacheWrite

          const costUSD = calculateCost(
            model,
            billedInput,
            billableOutputTokens('muse-code', output, reasoning),
            billedCacheWrite,
            cached,
            0,
          )

          const isLastStep = index === steps - 1
          yield {
            provider: 'muse-code',
            model,
            inputTokens: billedInput,
            outputTokens: output,
            cacheCreationInputTokens: billedCacheWrite,
            cacheReadInputTokens: cached,
            cachedInputTokens: cached,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD,
            // `quantity.reported` is a boolean on the attribution record: false
            // means Muse did not measure what it is reporting, so the figure is
            // surfaced as an estimate rather than as a confident zero.
            costIsEstimated: measured ? undefined : true,
            tools: isLastStep ? [...new Set(bucket.tools)] : [],
            bashCommands: [],
            timestamp: usage.timestamp || completion?.timestamp || sessionStart,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage,
            sessionId: billedSessionId,
            project,
            ...(workspaceRoot ? { projectPath: workspaceRoot, workingDirectory: workspaceRoot } : {}),
          }
        }
      }
    },
  }
}

export function createMuseCodeProvider(dataDirOverride?: string): Provider {
  const dataDir = getMuseDataDir(dataDirOverride)
  const sessionsDir = join(dataDir, 'sessions')

  return {
    name: 'muse-code',
    displayName: 'Muse Code',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    // #899: report the probed root even when nothing is discovered, so
    // `codeburn doctor` can tell "Muse Code is not installed" from
    // "MUSE_DATA_DIR points somewhere empty" instead of a silent $0.00.
    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: sessionsDir, label: 'sessions' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(sessionsDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const museCode = createMuseCodeProvider()
