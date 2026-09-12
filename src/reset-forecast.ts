// Chance of an OpenAI Codex usage-limit reset landing soon, estimated from the
// public record of past resets. Pure and side-effect free: no clock of its own,
// no I/O, no network. Callers hand in the committed dataset
// (`src/data/codex-reset-history.json`) and a `now`, and get back probabilities
// with a range, the inputs they were derived from, and an earned confidence
// label. The Swift menubar mirrors this file
// (mac/Sources/CodeBurnMenubar/Data/CodexResetForecast.swift) because the
// menubar reads quota from its own native adapters, not from the CLI payload.
//
// Honesty rules this module enforces, because a forecast that reads as a
// promise is worse than no forecast at all:
// - A probability is never rendered without its range.
// - The wording is "chance". Never "expected", never "will".
// - `confidence` is "low" unless a walk-forward backtest over the same record
//   beats the base rate. `backtest()` is exported and is run as a test, so the
//   label is earned rather than asserted.
// - A dataset older than `STALE_AFTER_DAYS` is stale and says so.
// - Missing inputs produce `available: false` with a reason, never a zero.
//
// Source of the record: the public codex-reset.com tracker. It is not operated
// by or endorsed by OpenAI, and it is unaudited — see docs/codex-reset-forecast.md.

export type ResetHistoryEvent = {
  id: string
  announced_at: string
  type: 'reset' | 'credits'
  reset_kind?: string
}

export type ResetHistory = {
  schema: number
  source: string
  source_name?: string
  source_note?: string
  generated_at: string
  events: ResetHistoryEvent[]
}

/**
 * A reset this machine observed for itself, rather than one from the public
 * record: the local early-reset detector (#1320) and the banked-credit watcher
 * (#1322) both produce these. The seam is an input, not an import — neither
 * feature has to merge before this one works, and with an empty array the
 * forecast falls back to the global record exactly as it does today.
 */
export type LocalResetEvent = {
  /** ISO-8601 instant the reset was observed. */
  at: string
  origin: 'local-early-reset' | 'banked-credit'
}

export type ProbabilityRange = {
  /** Point estimate, 0..1. */
  point: number
  /** Lower bound, 0..1. */
  low: number
  /** Upper bound, 0..1. */
  high: number
}

export type ResetForecastConfidence = 'low' | 'moderate'

export type ResetForecast = {
  available: true
  /** The record is older than `STALE_AFTER_DAYS` and should not be trusted. */
  stale: boolean
  datasetAgeDays: number
  datasetGeneratedAt: string
  source: string
  /** Resets in the record. Credit grants are not resets and are not counted. */
  resetCount: number
  /** Inter-reset waits the estimate is conditioned on. */
  waitCount: number
  lastResetAt: string
  lastResetSource: 'global' | 'local'
  hoursSinceLastReset: number
  /** Weighted median inter-reset wait, in hours. */
  typicalWaitHours: number
  within6h: ProbabilityRange
  within24h: ProbabilityRange
  /** Local hour 0..23 in San Francisco at `now`. */
  sanFranciscoHour: number
  /** 07:00-23:00 in San Francisco, the band the record actually lands in. */
  workingHoursSF: boolean
  /** Elapsed time already exceeds every wait in the record. */
  beyondRecord: boolean
  confidence: ResetForecastConfidence
}

export type ResetForecastUnavailable = {
  available: false
  /** Why nothing can be said. Rendered as-is; never replaced with a zero. */
  reason: string
  stale: boolean
}

export type ResetForecastResult = ResetForecast | ResetForecastUnavailable

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Waits ending inside this window carry `RECENT_WEIGHT`; older ones carry 1.
 *  Both public trackers note the cadence sped up, so the full record alone
 *  would understate the chance. */
export const RECENT_WINDOW_DAYS = 120
export const RECENT_WEIGHT = 3

/** A record older than this is out of date: the client says so. */
export const STALE_AFTER_DAYS = 14

/** The hour-of-day prior scales the hazard but never zeroes it. Six hours of
 *  the San Francisco night carry no reset at all in the record, and "never"
 *  is not a claim 44 events can support. */
export const MIN_HOUR_MULTIPLIER = 0.1

/** No estimate from a record this size is entitled to say "certain". The hour
 *  prior can multiply a hazard by up to 24, which turns an already high
 *  probability into 100%; this is the ceiling that stops it. */
export const MAX_PROBABILITY = 0.99

/** Below this many waits there is nothing to condition on. */
export const MIN_WAITS_FOR_FORECAST = 3

/** Below this many waits the backtest cannot earn anything, whatever it says. */
export const MIN_WAITS_FOR_CONFIDENCE = 20

/** Shrinkage strength for the conditional estimate. Deep in the tail the
 *  at-risk set thins to one or two waits, where the raw empirical share is 0 or
 *  1 and reads as certainty; the estimate is pulled toward a memoryless rate in
 *  proportion to how thin it is. At 20 at-risk waits the pull is under a fifth. */
export const SHRINKAGE_PSEUDO_COUNT = 5

/** Probe offsets after a reset, in hours, used by the walk-forward backtest. */
const BACKTEST_PROBE_OFFSETS_HOURS = [3, 6, 12, 24, 36, 48, 72, 96, 144, 192]

const SF_TIME_ZONE = 'America/Los_Angeles'

const sfHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SF_TIME_ZONE,
  hour: '2-digit',
  hour12: false,
  weekday: 'short',
})

/** Hour 0..23 and weekday in San Francisco. Kept in one place because the
 *  Swift mirror has to agree with it, and because a wall-clock hour is the one
 *  thing a "pure" module is most likely to get silently wrong. */
export function sanFranciscoClock(at: Date): { hour: number; weekday: string } {
  let hour = 0
  let weekday = ''
  for (const part of sfHourFormatter.formatToParts(at)) {
    if (part.type === 'hour') hour = Number.parseInt(part.value, 10) % 24
    if (part.type === 'weekday') weekday = part.value
  }
  return { hour: Number.isFinite(hour) ? hour : 0, weekday }
}

/** The San Francisco band the record actually lands in: 07:00-23:00 PT, any
 *  day. 42 of the 44 shipped resets fall inside it, and the weekday counts are
 *  close to flat (Saturday carries as many as Tuesday), so restricting this to
 *  Monday-Friday would describe a pattern the record does not show. */
export const WORKING_HOURS_SF_START = 7
export const WORKING_HOURS_SF_END = 23

export function isWorkingHoursSF(at: Date): boolean {
  const { hour } = sanFranciscoClock(at)
  return hour >= WORKING_HOURS_SF_START && hour < WORKING_HOURS_SF_END
}

/** Reset instants in the record, ascending, de-duplicated, non-finite dropped. */
export function resetInstants(history: ResetHistory | null | undefined): number[] {
  const events = Array.isArray(history?.events) ? history.events : []
  const seen = new Set<number>()
  for (const event of events) {
    if (!event || event.type !== 'reset') continue
    const at = Date.parse(String(event.announced_at ?? ''))
    if (!Number.isFinite(at)) continue
    seen.add(at)
  }
  return [...seen].sort((a, b) => a - b)
}

type Wait = { hours: number; endsAt: number; weight: number }

function waitsFrom(instants: number[], referenceMs: number): Wait[] {
  const cutoff = referenceMs - RECENT_WINDOW_DAYS * DAY_MS
  const waits: Wait[] = []
  for (let i = 1; i < instants.length; i += 1) {
    const hours = (instants[i] - instants[i - 1]) / HOUR_MS
    // A non-positive wait means two announcements share an instant; it carries
    // no information about how long anyone waited.
    if (!(hours > 0)) continue
    waits.push({ hours, endsAt: instants[i], weight: instants[i] >= cutoff ? RECENT_WEIGHT : 1 })
  }
  return waits
}

function weightedMedian(waits: Wait[]): number {
  const sorted = [...waits].sort((a, b) => a.hours - b.hours)
  const total = sorted.reduce((sum, w) => sum + w.weight, 0)
  if (total <= 0) return 0
  let running = 0
  for (const wait of sorted) {
    running += wait.weight
    if (running >= total / 2) return wait.hours
  }
  return sorted[sorted.length - 1].hours
}

/** Wilson score interval. Used instead of a normal approximation because the
 *  counts here are small and often land at 0 or n, where the normal interval
 *  collapses to a point and would read as certainty. */
export function wilsonInterval(successes: number, trials: number, z = 1.96): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 }
  const p = successes / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const centre = p + z2 / (2 * trials)
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
  const low = (centre - spread) / denominator
  const high = (centre + spread) / denominator
  return { low: clamp01(low), high: clamp01(high) }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Hazard-space multiply, so a multiplier can never push a probability above 1
 *  or (given `MIN_HOUR_MULTIPLIER`) down to exactly 0. */
function scaleProbability(probability: number, multiplier: number): number {
  const p = Math.min(Math.max(probability, 0), 0.999)
  if (p <= 0) return 0
  const hazard = -Math.log(1 - p)
  return Math.min(MAX_PROBABILITY, clamp01(1 - Math.exp(-hazard * Math.max(multiplier, 0))))
}

/** Weighted hour-of-day density in San Francisco, as a multiplier against a
 *  uniform day. Floored per hour so the prior tilts the estimate and never
 *  erases it. */
function hourMultipliers(instants: number[], referenceMs: number): number[] {
  const cutoff = referenceMs - RECENT_WINDOW_DAYS * DAY_MS
  const buckets = new Array<number>(24).fill(0)
  let total = 0
  for (const at of instants) {
    const weight = at >= cutoff ? RECENT_WEIGHT : 1
    buckets[sanFranciscoClock(new Date(at)).hour] += weight
    total += weight
  }
  if (total <= 0) return new Array<number>(24).fill(1)
  return buckets.map(count => Math.max(MIN_HOUR_MULTIPLIER, (count / total) * 24))
}

/** Average hour multiplier over the next `horizonHours`, hour by hour, so a
 *  24h horizon is barely tilted while a 6h horizon starting at 3am is. */
function horizonMultiplier(multipliers: number[], nowMs: number, horizonHours: number): number {
  if (!(horizonHours > 0)) return 1
  let weighted = 0
  let covered = 0
  let offset = 0
  while (offset < horizonHours) {
    const step = Math.min(1, horizonHours - offset)
    const at = new Date(nowMs + (offset + step / 2) * HOUR_MS)
    weighted += multipliers[sanFranciscoClock(at).hour] * step
    covered += step
    offset += step
  }
  return covered > 0 ? weighted / covered : 1
}

type Estimate = { range: ProbabilityRange; beyondRecord: boolean }

/**
 * P(a reset lands within `horizonHours`), conditioned on `elapsedHours` already
 * having passed since the last one. This is the plain empirical conditional
 * distribution of waits, which for a fully observed (uncensored) record is what
 * Kaplan-Meier reduces to. Recent waits count more; the hour-of-day prior is
 * applied in hazard space afterwards.
 */
function estimate(
  waits: Wait[],
  multipliers: number[],
  elapsedHours: number,
  nowMs: number,
  horizonHours: number,
): Estimate {
  const atRisk = waits.filter(wait => wait.hours > elapsedHours)
  const multiplier = horizonMultiplier(multipliers, nowMs, horizonHours)
  const totalWeight = waits.reduce((sum, w) => sum + w.weight, 0)
  const meanWait = totalWeight > 0
    ? waits.reduce((sum, w) => sum + w.hours * w.weight, 0) / totalWeight
    : 0
  // The memoryless rate the conditional estimate is shrunk toward, and the
  // whole answer once the record has run out.
  const memoryless = meanWait > 0 ? 1 - Math.exp(-horizonHours / meanWait) : 0

  if (atRisk.length === 0) {
    // Longer than anything in the record. There is no at-risk set to divide by,
    // so the memoryless rate is all that is left, and the range opens to the
    // full span rather than pretending the record still says something.
    return {
      range: { point: scaleProbability(memoryless, multiplier), low: 0, high: 1 },
      beyondRecord: true,
    }
  }

  const riskWeight = atRisk.reduce((sum, w) => sum + w.weight, 0)
  const hit = atRisk.filter(wait => wait.hours <= elapsedHours + horizonHours)
  const hitWeight = hit.reduce((sum, w) => sum + w.weight, 0)
  const empirical = riskWeight > 0 ? hitWeight / riskWeight : 0
  const lambda = atRisk.length / (atRisk.length + SHRINKAGE_PSEUDO_COUNT)
  const point = lambda * empirical + (1 - lambda) * memoryless
  // The interval is computed on the honest unweighted counts: weighting and
  // shrinkage are judgements, not extra observations, and must not narrow the
  // range. It is then widened, never narrowed, to contain the point estimate.
  const interval = wilsonInterval(hit.length, atRisk.length)
  const scaled = {
    point: scaleProbability(point, multiplier),
    low: scaleProbability(interval.low, multiplier),
    high: scaleProbability(interval.high, multiplier),
  }
  return {
    range: {
      point: scaled.point,
      low: Math.min(scaled.low, scaled.point),
      high: Math.max(scaled.high, scaled.point),
    },
    beyondRecord: false,
  }
}

export type ForecastInput = {
  history: ResetHistory | null | undefined
  now: Date
  /** This machine's own observed resets, when either feature is present. */
  localEvents?: LocalResetEvent[]
}

/**
 * The forecast, or a stated reason there isn't one. Never throws, and never
 * substitutes a zero for an unknown.
 */
export function forecastReset(input: ForecastInput): ResetForecastResult {
  const nowMs = input.now.getTime()
  if (!Number.isFinite(nowMs)) return { available: false, reason: 'The local clock is not readable.', stale: false }

  const history = input.history
  const generatedAt = Date.parse(String(history?.generated_at ?? ''))
  const hasGeneratedAt = Number.isFinite(generatedAt)
  const datasetAgeDays = hasGeneratedAt ? (nowMs - generatedAt) / DAY_MS : Number.POSITIVE_INFINITY
  const stale = !(datasetAgeDays <= STALE_AFTER_DAYS)

  const instants = resetInstants(history)
  if (instants.length === 0) {
    return { available: false, reason: 'No reset history is bundled with this build.', stale }
  }
  // A record generated in this machine's future is skew, not a fresh dataset.
  // Tolerate an hour for a slow clock; beyond that, say nothing.
  if (hasGeneratedAt && datasetAgeDays < -1 / 24) {
    return { available: false, reason: 'The reset history is dated in the future; check this machine\'s clock.', stale: false }
  }

  const globalLast = instants[instants.length - 1]
  let lastResetAtMs = globalLast
  let lastResetSource: 'global' | 'local' = 'global'
  for (const event of input.localEvents ?? []) {
    const at = Date.parse(String(event?.at ?? ''))
    // A local event from the future is skew; one older than the global record
    // tells us nothing the record does not already say.
    if (!Number.isFinite(at) || at > nowMs || at <= lastResetAtMs) continue
    lastResetAtMs = at
    lastResetSource = 'local'
  }

  const elapsedHours = (nowMs - lastResetAtMs) / HOUR_MS
  if (elapsedHours < 0) {
    return { available: false, reason: 'The last reset is dated in the future; check this machine\'s clock.', stale }
  }

  // Waits are anchored on the record's own reference point, not on `now`: a
  // stale dataset must not silently drop every wait out of the recent window.
  const referenceMs = hasGeneratedAt ? Math.max(generatedAt, globalLast) : globalLast
  const waits = waitsFrom(instants, referenceMs)
  if (waits.length < MIN_WAITS_FOR_FORECAST) {
    return {
      available: false,
      reason: `Only ${waits.length} inter-reset wait${waits.length === 1 ? '' : 's'} in the record; not enough to say anything.`,
      stale,
    }
  }

  const multipliers = hourMultipliers(instants, referenceMs)
  const six = estimate(waits, multipliers, elapsedHours, nowMs, 6)
  const day = estimate(waits, multipliers, elapsedHours, nowMs, 24)
  const beyondRecord = six.beyondRecord || day.beyondRecord
  // 24 hours contain the next 6, so the longer horizon cannot be the less
  // likely one. The survival term alone guarantees that; the hour-of-day prior
  // does not, because a 6h window can sit entirely inside the record's busiest
  // hours while the 24h window averages across the quiet ones. Raising the 24h
  // figure rather than lowering the 6h one keeps the prior's information and
  // never understates either.
  const within24h: ProbabilityRange = {
    point: Math.max(day.range.point, six.range.point),
    low: Math.max(day.range.low, six.range.low),
    high: Math.max(day.range.high, six.range.high),
  }

  const earned = !stale
    && !beyondRecord
    && waits.length >= MIN_WAITS_FOR_CONFIDENCE
    && backtest(history as ResetHistory).beatsBaseRate

  return {
    available: true,
    stale,
    datasetAgeDays: hasGeneratedAt ? datasetAgeDays : Number.POSITIVE_INFINITY,
    datasetGeneratedAt: hasGeneratedAt ? new Date(generatedAt).toISOString() : '',
    source: String(history?.source ?? ''),
    resetCount: instants.length,
    waitCount: waits.length,
    lastResetAt: new Date(lastResetAtMs).toISOString(),
    lastResetSource,
    hoursSinceLastReset: elapsedHours,
    typicalWaitHours: weightedMedian(waits),
    within6h: six.range,
    within24h,
    sanFranciscoHour: sanFranciscoClock(input.now).hour,
    workingHoursSF: isWorkingHoursSF(input.now),
    beyondRecord,
    confidence: earned ? 'moderate' : 'low',
  }
}

// MARK: - Backtest

export type BacktestResult = {
  /** Probe points scored. */
  probes: number
  /** Mean squared error of the model's P(reset within the horizon). */
  modelBrier: number
  /** Same, for a constant predictor equal to the training prefix's base rate. */
  baseRateBrier: number
  beatsBaseRate: boolean
  horizonHours: number
}

/**
 * Walk-forward validation. For each reset in the record after a burn-in, the
 * model is rebuilt from that prefix alone and asked, at fixed offsets after
 * that reset, for the chance the next one lands within the horizon. The answer
 * is scored against what actually happened, and against a constant predictor
 * set to the same prefix's base rate. Nothing after the probe is ever visible
 * to either predictor, so `beatsBaseRate` is not a fit statistic.
 *
 * This is what earns `confidence: "moderate"`, and it ships as a test.
 */
export function backtest(
  history: ResetHistory | null | undefined,
  options: { horizonHours?: number; burnInWaits?: number } = {},
): BacktestResult {
  const horizonHours = options.horizonHours ?? 24
  const burnIn = options.burnInWaits ?? 10
  const instants = resetInstants(history)
  const empty: BacktestResult = { probes: 0, modelBrier: 0, baseRateBrier: 0, beatsBaseRate: false, horizonHours }
  if (instants.length < burnIn + 2) return empty

  let modelError = 0
  let baseError = 0
  let probes = 0

  for (let index = burnIn; index < instants.length - 1; index += 1) {
    const prefix = instants.slice(0, index + 1)
    const anchor = prefix[prefix.length - 1]
    const next = instants[index + 1]
    const waits = waitsFrom(prefix, anchor)
    if (waits.length < MIN_WAITS_FOR_FORECAST) continue
    const multipliers = hourMultipliers(prefix, anchor)
    const baseRate = trainingBaseRate(prefix, horizonHours)
    if (baseRate === null) continue

    for (const offset of BACKTEST_PROBE_OFFSETS_HOURS) {
      const probeAt = anchor + offset * HOUR_MS
      // The probe has to describe a state that existed: once the next reset has
      // landed, "offset hours since the last reset" is a different situation.
      if (probeAt >= next) continue
      const outcome = next - probeAt <= horizonHours * HOUR_MS ? 1 : 0
      const predicted = estimate(waits, multipliers, offset, probeAt, horizonHours).range.point
      modelError += (predicted - outcome) ** 2
      baseError += (baseRate - outcome) ** 2
      probes += 1
    }
  }

  if (probes === 0) return empty
  const modelBrier = modelError / probes
  const baseRateBrier = baseError / probes
  return { probes, modelBrier, baseRateBrier, beatsBaseRate: modelBrier < baseRateBrier, horizonHours }
}

/** The competitor: one number, the share of probes inside the training prefix
 *  whose next reset landed within the horizon. */
function trainingBaseRate(prefix: number[], horizonHours: number): number | null {
  let hits = 0
  let total = 0
  for (let i = 0; i < prefix.length - 1; i += 1) {
    const anchor = prefix[i]
    const next = prefix[i + 1]
    for (const offset of BACKTEST_PROBE_OFFSETS_HOURS) {
      const probeAt = anchor + offset * HOUR_MS
      if (probeAt >= next) continue
      if (next - probeAt <= horizonHours * HOUR_MS) hits += 1
      total += 1
    }
  }
  return total > 0 ? hits / total : null
}

// MARK: - Wording
//
// Mirrored character for character in `CodexResetForecastPresentation` on the
// Swift side, so the CLI and the menubar print the same sentence.

export function formatForecastPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`
}

/** "(10 to 51%)" — one sign, on the end, as in a spoken range. */
export function formatForecastRange(range: ProbabilityRange): string {
  return `(${Math.round(clamp01(range.low) * 100)} to ${formatForecastPercent(range.high)})`
}

/** "14:30" in the reader's own time zone. Used only to say when a reset this
 *  machine observed was seen, which is a wall-clock fact about this machine. */
export function formatLocalClock(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** "45m", "12h", "2.2d". Compact on purpose: this sits inside a sentence. */
export function formatForecastDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '0m'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${(Math.round((hours / 24) * 10) / 10).toFixed(1)}d`
}

/**
 * The rendered forecast. Line one is the sentence the CLI, the hover card and
 * the Plan tab all print; it always carries the range, and it says "chance".
 * Line two is provenance and caveats, and deliberately carries no number that
 * could be read as a probability on its own.
 */
export function renderForecastLines(result: ResetForecastResult): string[] {
  if (!result.available) return [`Reset forecast: unavailable. ${result.reason}`]
  const { within6h, within24h } = result
  const headline = 'Reset forecast: '
    + `${formatForecastPercent(within24h.point)} chance in the next 24h `
    + `${formatForecastRange(within24h)}, `
    + `${formatForecastPercent(within6h.point)} in 6h `
    + `${formatForecastRange(within6h)}. `
    + `${formatForecastDuration(result.hoursSinceLastReset)} since the `
    + (result.lastResetSource === 'local'
      ? `reset observed on this machine at ${formatLocalClock(new Date(result.lastResetAt))}`
      : 'last global reset')
    + '; '
    + `typical wait ${formatForecastDuration(result.typicalWaitHours)}. `
    + `Working hours in SF: ${result.workingHoursSF ? 'yes' : 'no'}.`

  const caveats: string[] = []
  caveats.push(`Estimated from ${result.resetCount} past resets in the public record`)
  if (result.beyondRecord) caveats.push('the wait is already longer than any in that record')
  if (result.stale) {
    caveats.push(Number.isFinite(result.datasetAgeDays)
      ? `the record is ${Math.floor(result.datasetAgeDays)} days old and out of date`
      : 'the record carries no date and is out of date')
  }
  caveats.push(`${result.confidence} confidence`)
  return [headline, `${caveats.join('; ')}.`]
}
