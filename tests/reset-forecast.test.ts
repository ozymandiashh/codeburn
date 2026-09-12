import { describe, expect, it } from 'vitest'
import {
  backtest,
  forecastReset,
  formatForecastDuration,
  formatForecastPercent,
  formatForecastRange,
  formatLocalClock,
  isWorkingHoursSF,
  MIN_HOUR_MULTIPLIER,
  MAX_PROBABILITY,
  MIN_WAITS_FOR_CONFIDENCE,
  RECENT_WEIGHT,
  renderForecastLines,
  resetInstants,
  sanFranciscoClock,
  STALE_AFTER_DAYS,
  wilsonInterval,
  type LocalResetEvent,
  type ResetForecast,
  type ResetHistory,
} from '../src/reset-forecast.js'
import { codexResetHistory } from '../src/quota/codex-forecast.js'

// Every clock in this file is explicit. The model takes `now` as an argument
// precisely so the numbers a fixture produces never depend on when CI runs.

function history(isoTimes: string[], options: { generatedAt?: string; credits?: string[] } = {}): ResetHistory {
  return {
    schema: 1,
    source: 'https://codex-reset.com/api/timeline',
    generated_at: options.generatedAt ?? isoTimes[isoTimes.length - 1] ?? '2026-09-12T00:00:00Z',
    events: [
      ...isoTimes.map((at, index) => ({
        id: `r${index}`,
        announced_at: at,
        type: 'reset' as const,
        reset_kind: 'global',
      })),
      ...(options.credits ?? []).map((at, index) => ({
        id: `c${index}`,
        announced_at: at,
        type: 'credits' as const,
      })),
    ],
  }
}

/** A regular cadence, anchored so every reset lands at the same UTC hour. */
function cadence(count: number, spacingHours: number, startIso = '2026-01-01T18:00:00Z'): string[] {
  const start = Date.parse(startIso)
  return Array.from({ length: count }, (_, i) => new Date(start + i * spacingHours * 3_600_000).toISOString())
}

function available(result: ReturnType<typeof forecastReset>): ResetForecast {
  if (!result.available) throw new Error(`expected a forecast, got: ${result.reason}`)
  return result
}

describe('reset history parsing', () => {
  it('counts resets only, ignoring credit grants', () => {
    const doc = history(['2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'], { credits: ['2026-01-03T00:00:00Z'] })
    expect(resetInstants(doc)).toHaveLength(2)
  })

  it('de-duplicates and sorts, and drops unparseable timestamps', () => {
    const doc = history(['2026-01-05T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'])
    doc.events.push({ id: 'bad', announced_at: 'not-a-date', type: 'reset', reset_kind: 'global' })
    const instants = resetInstants(doc)
    expect(instants).toHaveLength(2)
    expect(instants[0]).toBeLessThan(instants[1])
  })
})

describe('unavailable, never zero', () => {
  it('says so for an empty history', () => {
    const result = forecastReset({ history: history([]), now: new Date('2026-09-12T12:00:00Z') })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/No reset history/)
  })

  it('says so for a missing history', () => {
    const result = forecastReset({ history: null, now: new Date('2026-09-12T12:00:00Z') })
    expect(result.available).toBe(false)
  })

  it('says so for a single reset, which yields no waits at all', () => {
    const result = forecastReset({ history: history(['2026-09-10T00:00:00Z']), now: new Date('2026-09-12T12:00:00Z') })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/Only 0 inter-reset waits/)
  })

  it('says so for two resets, which yield one wait', () => {
    const result = forecastReset({
      history: history(['2026-09-08T00:00:00Z', '2026-09-10T00:00:00Z']),
      now: new Date('2026-09-12T12:00:00Z'),
    })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/Only 1 inter-reset wait in the record/)
  })

  it('refuses a `now` that precedes the last reset', () => {
    const result = forecastReset({ history: history(cadence(10, 48)), now: new Date('2025-01-01T00:00:00Z') })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/clock/)
  })

  it('refuses a record dated in this machine\'s future', () => {
    const doc = history(cadence(10, 48), { generatedAt: '2027-01-01T00:00:00Z' })
    const result = forecastReset({ history: doc, now: new Date('2026-01-19T00:00:00Z') })
    expect(result.available).toBe(false)
    // Named exactly: the record's own date, not the last reset, is what is wrong.
    if (!result.available) expect(result.reason).toBe('The reset history is dated in the future; check this machine\'s clock.')
  })

  it('refuses a `now` that precedes the last reset even when the record itself is not future-dated', () => {
    // The future-dated-record guard runs first and would hide this one, so the
    // record is dated at its own first event: old, definitely not in the
    // future, and the last reset still sits ahead of `now`.
    const times = cadence(30, 48)
    const doc = history(times, { generatedAt: times[0] })
    const result = forecastReset({ history: doc, now: new Date(times[10]) })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toBe('The last reset is dated in the future; check this machine\'s clock.')
  })

  it('tolerates an hour of clock drift on the record\'s own date', () => {
    const times = cadence(10, 48)
    const last = Date.parse(times[times.length - 1])
    const doc = history(times, { generatedAt: new Date(last + 30 * 60_000).toISOString() })
    const result = forecastReset({ history: doc, now: new Date(last + 3_600_000) })
    expect(result.available).toBe(true)
  })
})

describe('staleness', () => {
  const times = cadence(20, 48)
  const last = times[times.length - 1]

  it('draws the line at fourteen days', () => {
    expect(STALE_AFTER_DAYS).toBe(14)
  })

  it('is fresh inside the window', () => {
    const now = new Date(Date.parse(last) + 13 * 86_400_000)
    expect(available(forecastReset({ history: history(times), now })).stale).toBe(false)
  })

  it('is stale past it, and the rendered caveat says so', () => {
    const now = new Date(Date.parse(last) + 21 * 86_400_000)
    const result = available(forecastReset({ history: history(times), now }))
    expect(result.stale).toBe(true)
    expect(result.confidence).toBe('low')
    expect(renderForecastLines(result)[1]).toMatch(/days old and out of date/)
  })

  it('treats a record with no date at all as stale', () => {
    const doc = history(times, { generatedAt: '' })
    const result = available(forecastReset({ history: doc, now: new Date(Date.parse(last) + 3_600_000) }))
    expect(result.stale).toBe(true)
    expect(renderForecastLines(result)[1]).toMatch(/carries no date and is out of date/)
  })
})

describe('conditional survival', () => {
  const times = cadence(30, 48)
  const last = Date.parse(times[times.length - 1])

  it('rises as the wait lengthens on a regular cadence', () => {
    const early = available(forecastReset({ history: history(times), now: new Date(last + 3 * 3_600_000) }))
    const late = available(forecastReset({ history: history(times), now: new Date(last + 36 * 3_600_000) }))
    expect(late.within24h.point).toBeGreaterThan(early.within24h.point)
  })

  it('keeps the point estimate inside its own range', () => {
    // 42h is the interesting one: every wait lands inside the six-hour horizon
    // there, so the empirical share is 1 while the shrunk, hour-scaled point
    // estimate is far below it. Without the widening, the point sits outside
    // its own lower bound.
    for (const elapsed of [1, 6, 24, 30, 36, 40, 42, 47, 60, 200]) {
      const result = available(forecastReset({ history: history(times), now: new Date(last + elapsed * 3_600_000) }))
      for (const range of [result.within6h, result.within24h]) {
        expect(range.low).toBeLessThanOrEqual(range.point + 1e-9)
        expect(range.high).toBeGreaterThanOrEqual(range.point - 1e-9)
      }
    }
  })

  it('never exceeds the 24h chance with the 6h one', () => {
    for (const elapsed of [1, 12, 30, 47]) {
      const result = available(forecastReset({ history: history(times), now: new Date(last + elapsed * 3_600_000) }))
      expect(result.within6h.point).toBeLessThanOrEqual(result.within24h.point + 1e-9)
    }
  })

  it('follows the recent cadence rather than the whole record when the two disagree', () => {
    // Thirty waits of ten days, then twenty of one day: the cadence sped up,
    // which is what both public trackers report of the real record. The
    // unweighted median is still ten days; the weighted one is one day.
    const HOUR = 3_600_000
    let at = Date.parse('2025-01-01T18:00:00Z')
    const times = [new Date(at).toISOString()]
    for (let i = 0; i < 30; i += 1) { at += 240 * HOUR; times.push(new Date(at).toISOString()) }
    for (let i = 0; i < 20; i += 1) { at += 24 * HOUR; times.push(new Date(at).toISOString()) }

    const waits: number[] = []
    for (let i = 1; i < times.length; i += 1) waits.push((Date.parse(times[i]) - Date.parse(times[i - 1])) / HOUR)
    const unweightedMedian = [...waits].sort((a, b) => a - b)[Math.floor(waits.length / 2)]
    expect(unweightedMedian).toBe(240)

    const result = available(forecastReset({ history: history(times), now: new Date(at + 6 * HOUR) }))
    expect(result.typicalWaitHours).toBe(24)
    expect(RECENT_WEIGHT).toBeGreaterThan(1)
  })

  it('widens the range upward when shrinkage lifts the point past its upper bound', () => {
    // Two hundred resets three hours apart, then one long outage. At a probe
    // early in a new wait the at-risk set is the single long wait, so the
    // empirical share is 0 and the Wilson bound is narrow, while the memoryless
    // rate from a three-hour cadence is very high. The shrunk point lands above
    // that bound, and the range has to move up to contain it.
    const HOUR = 3_600_000
    let at = Date.parse('2026-06-01T20:00:00Z')
    const times = [new Date(at).toISOString()]
    for (let i = 0; i < 200; i += 1) { at += 3 * HOUR; times.push(new Date(at).toISOString()) }
    at += 600 * HOUR
    times.push(new Date(at).toISOString())

    const result = available(forecastReset({ history: history(times), now: new Date(at + 6 * HOUR) }))
    expect(result.beyondRecord).toBe(false)
    expect(result.within24h.point).toBeGreaterThan(0.8)
    expect(result.within24h.high).toBe(result.within24h.point)
  })

  it('never reports certainty, whatever the record and the hour prior agree on', () => {
    // The hour prior multiplies a hazard by up to 24. Without a ceiling, a
    // record this regular reads as 100%, which 30 events cannot support.
    expect(MAX_PROBABILITY).toBeLessThan(1)
    for (const elapsed of [44, 46, 47.5]) {
      const result = available(forecastReset({ history: history(times), now: new Date(last + elapsed * 3_600_000) }))
      expect(result.within6h.point).toBeLessThanOrEqual(MAX_PROBABILITY)
      expect(result.within24h.high).toBeLessThanOrEqual(MAX_PROBABILITY)
      expect(renderForecastLines(result)[0]).not.toContain('100%')
    }
  })

  it('reports a wait longer than anything in the record as such, with the widest range', () => {
    const result = available(forecastReset({ history: history(times), now: new Date(last + 400 * 3_600_000) }))
    expect(result.beyondRecord).toBe(true)
    expect(result.within24h.low).toBe(0)
    expect(result.within24h.high).toBe(1)
    // Still a number, from a memoryless fallback — not a silence and not a zero.
    expect(result.within24h.point).toBeGreaterThan(0)
    expect(result.confidence).toBe('low')
    expect(renderForecastLines(result)[1]).toMatch(/longer than any in that record/)
  })
})

describe('the San Francisco hour-of-day prior', () => {
  // A record that lands only at 09:00, 11:00, 13:00, 15:00 and 17:00 San
  // Francisco time, and never in the small hours — the shape the real record
  // has. Every wait is at least 40 hours, so at any probe under 34 hours the
  // six-hour hit set is empty and the survival term is identical: whatever
  // differs between two such probes is the hour-of-day prior and nothing else.
  const daytimeOnly = (() => {
    const cycle = [9, 11, 13, 15, 17]
    let at = Date.parse('2026-06-01T16:00:00Z')
    const times = [new Date(at).toISOString()]
    for (let i = 1; i < 30; i += 1) {
      at += (48 + (cycle[i % 5] - cycle[(i - 1) % 5])) * 3_600_000
      times.push(new Date(at).toISOString())
    }
    return times
  })()
  const last = Date.parse(daytimeOnly[daytimeOnly.length - 1])

  it('describes a record with no resets between 01:00 and 08:00 PT', () => {
    const hours = new Set(daytimeOnly.map(at => sanFranciscoClock(new Date(at)).hour))
    for (let hour = 0; hour < 8; hour += 1) expect(hours.has(hour)).toBe(false)
    expect([...hours].sort((a, b) => a - b)).toEqual([9, 11, 13, 15, 17])
  })

  it('suppresses the six-hour chance across the 03:00-to-08:00 PT window', () => {
    // Both probes sit under the threshold where any wait could land inside six
    // hours, so the empirical term is identical and only the prior moves.
    const night = available(forecastReset({ history: history(daytimeOnly), now: new Date(last + 10 * 3_600_000) }))
    const day = available(forecastReset({ history: history(daytimeOnly), now: new Date(last + 18 * 3_600_000) }))
    expect(night.sanFranciscoHour).toBe(3)
    expect(day.sanFranciscoHour).toBe(11)
    expect(night.within6h.point).toBeLessThan(day.within6h.point)
    // And by a lot: the prior is doing real work, not rounding.
    expect(night.within6h.point * 3).toBeLessThan(day.within6h.point)
  })

  it('never takes a probability to exactly zero, even across the emptiest hours', () => {
    const night = available(forecastReset({ history: history(daytimeOnly), now: new Date(last + 10 * 3_600_000) }))
    expect(night.within6h.point).toBeGreaterThan(0)
    expect(night.within6h.high).toBeGreaterThan(0)
    expect(MIN_HOUR_MULTIPLIER).toBeGreaterThan(0)
  })

  it('calls the band the record lands in working hours, and the small hours not', () => {
    expect(isWorkingHoursSF(new Date('2026-06-15T20:00:00Z'))).toBe(true)   // 13:00 PT
    expect(isWorkingHoursSF(new Date('2026-06-15T11:00:00Z'))).toBe(false)  // 04:00 PT
    expect(isWorkingHoursSF(new Date('2026-06-15T13:00:00Z'))).toBe(false)  // 06:00 PT
    expect(isWorkingHoursSF(new Date('2026-06-15T14:00:00Z'))).toBe(true)   // 07:00 PT
    expect(isWorkingHoursSF(new Date('2026-06-16T06:00:00Z'))).toBe(false)  // 23:00 PT
  })
})

describe('this machine\'s own resets', () => {
  const times = cadence(30, 48)
  const last = Date.parse(times[times.length - 1])
  const now = new Date(last + 40 * 3_600_000)

  it('falls back to the global record when there are none', () => {
    const result = available(forecastReset({ history: history(times), now }))
    expect(result.lastResetSource).toBe('global')
    expect(result.hoursSinceLastReset).toBeCloseTo(40, 6)
  })

  it('prefers a locally observed reset that is more recent', () => {
    const local: LocalResetEvent[] = [{ at: new Date(last + 36 * 3_600_000).toISOString(), origin: 'local-early-reset' }]
    const result = available(forecastReset({ history: history(times), now, localEvents: local }))
    expect(result.lastResetSource).toBe('local')
    expect(result.hoursSinceLastReset).toBeCloseTo(4, 6)
    const at = new Date(Date.parse(local[0].at))
    expect(renderForecastLines(result)[0])
      .toContain(`since the reset observed on this machine at ${formatLocalClock(at)}`)
  })

  it('ignores a local event older than the global record', () => {
    const local: LocalResetEvent[] = [{ at: new Date(last - 10 * 3_600_000).toISOString(), origin: 'banked-credit' }]
    expect(available(forecastReset({ history: history(times), now, localEvents: local })).lastResetSource).toBe('global')
  })

  it('ignores a local event dated in the future, rather than reporting a negative wait', () => {
    const local: LocalResetEvent[] = [{ at: new Date(now.getTime() + 86_400_000).toISOString(), origin: 'local-early-reset' }]
    const result = available(forecastReset({ history: history(times), now, localEvents: local }))
    expect(result.lastResetSource).toBe('global')
    expect(result.hoursSinceLastReset).toBeGreaterThan(0)
  })

  it('ignores a local event with an unparseable timestamp', () => {
    const local = [{ at: 'yesterday', origin: 'banked-credit' }] as LocalResetEvent[]
    expect(available(forecastReset({ history: history(times), now, localEvents: local })).lastResetSource).toBe('global')
  })
})

describe('wording', () => {
  const times = cadence(30, 48)
  const now = new Date(Date.parse(times[times.length - 1]) + 12 * 3_600_000)
  const result = available(forecastReset({ history: history(times), now }))
  const lines = renderForecastLines(result)

  it('matches the agreed sentence', () => {
    expect(lines[0]).toMatch(
      /^Reset forecast: \d+% chance in the next 24h \(\d+ to \d+%\), \d+% in 6h \(\d+ to \d+%\)\. \S+ since the last global reset; typical wait \S+\. Working hours in SF: (yes|no)\.$/,
    )
  })

  it('zero-pads the local clock', () => {
    expect(formatLocalClock(new Date(2026, 8, 12, 4, 5))).toBe('04:05')
    expect(formatLocalClock(new Date(2026, 8, 12, 14, 30))).toBe('14:30')
  })

  it('carries a range beside every probability it prints', () => {
    const probabilities = lines[0].match(/\d+%/g) ?? []
    const ranges = lines[0].match(/\(\d+ to \d+%\)/g) ?? []
    // Two point estimates, two ranges. Each range itself contributes one of the
    // four `%` matches, so the point estimates are the other two.
    expect(ranges).toHaveLength(2)
    expect(probabilities).toHaveLength(4)
  })

  it('says chance, and never expected or will', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/\bexpect(ed|s)?\b/i)
      expect(line).not.toMatch(/\bwill\b/i)
      expect(line).not.toMatch(/\bguarantee/i)
    }
    expect(lines[0]).toContain('chance')
  })

  it('names the confidence on the caveat line without a number that reads as a probability', () => {
    expect(lines[1]).toMatch(/(low|moderate) confidence\.$/)
    expect(lines[1]).not.toMatch(/%/)
  })

  it('renders an unavailable forecast as a reason, not as a zero', () => {
    const rendered = renderForecastLines(forecastReset({ history: history([]), now }))
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatch(/^Reset forecast: unavailable\./)
    expect(rendered[0]).not.toMatch(/0%/)
  })

  it('formats percentages, ranges and durations the way the Swift mirror does', () => {
    expect(formatForecastPercent(0.244)).toBe('24%')
    expect(formatForecastPercent(2)).toBe('100%')
    expect(formatForecastPercent(Number.NaN)).toBe('0%')
    expect(formatForecastRange({ point: 0.24, low: 0.1, high: 0.51 })).toBe('(10 to 51%)')
    expect(formatForecastDuration(0.25)).toBe('15m')
    expect(formatForecastDuration(0.001)).toBe('1m')
    expect(formatForecastDuration(12)).toBe('12h')
    expect(formatForecastDuration(47.4)).toBe('47h')
    expect(formatForecastDuration(52.8)).toBe('2.2d')
    expect(formatForecastDuration(-1)).toBe('0m')
  })
})

describe('wilson interval', () => {
  it('stays inside 0..1 and never collapses to a point at the extremes', () => {
    const none = wilsonInterval(0, 8)
    expect(none.low).toBe(0)
    expect(none.high).toBeGreaterThan(0)
    const all = wilsonInterval(8, 8)
    expect(all.high).toBe(1)
    expect(all.low).toBeLessThan(1)
  })

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(5, 10)
    const large = wilsonInterval(50, 100)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  it('admits everything when there is nothing to go on', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
  })
})

describe('the backtest that earns the confidence label', () => {
  it('scores the shipped record walk-forward, with probes to spare', () => {
    const result = backtest(codexResetHistory)
    expect(result.probes).toBeGreaterThan(100)
    expect(result.modelBrier).toBeGreaterThan(0)
    expect(result.baseRateBrier).toBeGreaterThan(0)
  })

  it('does NOT beat the base rate on the shipped record, so the shipped label is low', () => {
    // This is the finding, not a placeholder: conditioning on elapsed time does
    // not improve on a constant predictor over these 44 events. The label has to
    // follow the evidence, so it stays "low" until the record says otherwise.
    // If a future refresh flips this, the assertion fails and the claim gets
    // looked at rather than quietly upgraded.
    const result = backtest(codexResetHistory)
    expect(result.beatsBaseRate).toBe(false)
    expect(result.modelBrier).toBeGreaterThanOrEqual(result.baseRateBrier)

    const newest = Math.max(...resetInstants(codexResetHistory))
    const forecast = available(forecastReset({ history: codexResetHistory, now: new Date(newest + 12 * 3_600_000) }))
    expect(forecast.confidence).toBe('low')
  })

  it('does beat it on a record with a real cadence, and the label follows', () => {
    // A tight 48-hour cadence is exactly the structure the conditional model
    // exists to exploit, and a constant predictor cannot.
    const times = cadence(40, 48)
    const doc = history(times)
    const result = backtest(doc)
    expect(result.probes).toBeGreaterThan(0)
    expect(result.beatsBaseRate).toBe(true)
    expect(result.modelBrier).toBeLessThan(result.baseRateBrier)

    const now = new Date(Date.parse(times[times.length - 1]) + 12 * 3_600_000)
    expect(available(forecastReset({ history: doc, now })).confidence).toBe('moderate')
  })

  it('refuses to earn a label from a record too small to mean anything, even when it scores well', () => {
    // Thirteen resets produce twelve waits, under MIN_WAITS_FOR_CONFIDENCE. The
    // backtest walks forward over them and wins handsomely on a perfect
    // cadence; the label still has to stay low, because twelve waits is not a
    // sample you can promise anything from.
    const times = cadence(13, 48)
    const doc = history(times)
    const result = backtest(doc)
    expect(result.probes).toBeGreaterThan(0)
    expect(result.beatsBaseRate).toBe(true)
    const forecast = available(forecastReset({ history: doc, now: new Date(Date.parse(times[12]) + 12 * 3_600_000) }))
    expect(forecast.waitCount).toBeLessThan(MIN_WAITS_FOR_CONFIDENCE)
    expect(forecast.confidence).toBe('low')
  })

  it('refuses to earn anything from a record too short to validate', () => {
    const doc = history(cadence(6, 48))
    expect(backtest(doc).probes).toBe(0)
    expect(backtest(doc).beatsBaseRate).toBe(false)
  })

  it('will not label a stale record moderate however well it scores', () => {
    const times = cadence(40, 48)
    const now = new Date(Date.parse(times[times.length - 1]) + (STALE_AFTER_DAYS + 1) * 86_400_000)
    const result = available(forecastReset({ history: history(times), now }))
    expect(result.stale).toBe(true)
    expect(result.confidence).toBe('low')
  })

  it('will not label a stale record moderate even when it is well inside its own waits', () => {
    // The other staleness case is also past the end of the record, so it cannot
    // show that staleness alone withholds the label. Here the record scores
    // well, the wait is ordinary, and only the record's age is wrong.
    const times = cadence(40, 48)
    const doc = history(times, { generatedAt: new Date(Date.parse(times[times.length - 1]) - 20 * 86_400_000).toISOString() })
    const result = available(forecastReset({ history: doc, now: new Date(Date.parse(times[times.length - 1]) + 12 * 3_600_000) }))
    expect(result.stale).toBe(true)
    expect(result.beyondRecord).toBe(false)
    expect(backtest(doc).beatsBaseRate).toBe(true)
    expect(result.confidence).toBe('low')
  })

  it('will not label a forecast past the end of the record moderate', () => {
    const times = cadence(40, 48)
    const doc = history(times, { generatedAt: new Date(Date.parse(times[times.length - 1]) + 300 * 3_600_000).toISOString() })
    const now = new Date(Date.parse(times[times.length - 1]) + 300 * 3_600_000)
    const result = available(forecastReset({ history: doc, now }))
    expect(result.beyondRecord).toBe(true)
    expect(result.confidence).toBe('low')
  })
})
