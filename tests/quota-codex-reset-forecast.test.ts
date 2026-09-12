import { describe, expect, it } from 'vitest'

import { codexResetHistory, withCodexResetForecast } from '../src/quota/codex-forecast.js'
import { collectQuota, renderQuotaTable, type QuotaCommandProvider, type QuotaReport } from '../src/quota/index.js'
import { resetInstants } from '../src/reset-forecast.js'
import type { QuotaProvider } from '../src/quota/types.js'

// Twelve hours after the newest reset in the committed record, so the numbers
// are the ones a user would actually see and the clock never moves under CI.
const NOW = new Date(Math.max(...resetInstants(codexResetHistory)) + 12 * 3_600_000)

function commandProvider(overrides: Partial<QuotaCommandProvider> = {}): QuotaCommandProvider {
  return {
    id: 'codex',
    name: 'Codex',
    available: true,
    plan: 'Pro',
    windows: [{ label: '5h', usedPct: 42, resetsAt: '2026-09-12T20:00:00Z' }],
    ...overrides,
  }
}

function connectedCodex(): QuotaProvider {
  return {
    provider: 'codex',
    connection: 'connected',
    primary: { label: '5h', percent: 0.42, resetsAt: '2026-09-12T20:00:00Z' },
    details: [{ label: '5h', percent: 0.42, resetsAt: '2026-09-12T20:00:00Z' }],
    planLabel: 'Pro',
    footerLines: [],
  }
}

describe('the Codex section of `codeburn quota`', () => {
  it('attaches the forecast to a connected Codex row', () => {
    const provider = withCodexResetForecast(commandProvider(), { now: NOW })
    expect(provider.resetForecast?.available).toBe(true)
    expect(provider.resetForecast?.lines[0]).toMatch(/^Reset forecast: /)
  })

  it('leaves every other provider untouched', () => {
    const claude = commandProvider({ id: 'claude', name: 'Claude' })
    expect(withCodexResetForecast(claude, { now: NOW })).toEqual(claude)
  })

  it('says nothing on a machine that is not signed in to Codex', () => {
    const signedOut = commandProvider({ available: false, windows: [], error: 'Not connected' })
    expect(withCodexResetForecast(signedOut, { now: NOW }).resetForecast).toBeUndefined()
  })

  it('carries the numbers as well as the sentence, so --format json is not parsed as English', () => {
    const forecast = withCodexResetForecast(commandProvider(), { now: NOW }).resetForecast
    if (!forecast?.available) throw new Error('expected a forecast')
    expect(forecast.within24h.point).toBeGreaterThan(0)
    expect(forecast.within24h.low).toBeLessThanOrEqual(forecast.within24h.point)
    expect(forecast.within24h.high).toBeGreaterThanOrEqual(forecast.within24h.point)
    expect(forecast.within6h).toBeTruthy()
    expect(forecast.confidence).toBe('low')
    expect(forecast.source).toBe('https://codex-reset.com/api/timeline')
    // Whole shape survives JSON round-tripping, which is what the command does.
    expect(JSON.parse(JSON.stringify(forecast)).within24h.point).toBe(forecast.within24h.point)
  })

  it('renders as its own block under the table, never as a table row', () => {
    const report: QuotaReport = { providers: [withCodexResetForecast(commandProvider(), { now: NOW })] }
    const rendered = renderQuotaTable(report, { color: false })
    const [tableAndRest] = rendered.split('\nCodex reset forecast\n')
    expect(tableAndRest).not.toMatch(/Reset forecast:/)
    expect(rendered).toContain('\nCodex reset forecast\n')
    expect(rendered).toMatch(/ {2}Reset forecast: .* chance in the next 24h \(\d+ to \d+%\)/)
    expect(rendered).toMatch(/ {2}Source: https:\/\/codex-reset\.com\/api\/timeline — refreshed in this repo/)
  })

  it('renders nothing extra for a report with no Codex forecast in it', () => {
    const report: QuotaReport = { providers: [commandProvider({ id: 'claude', name: 'Claude' })] }
    expect(renderQuotaTable(report, { color: false })).not.toContain('reset forecast')
  })

  it('reaches the command output through collectQuota, with no reader of its own', () => {
    // The forecast is arithmetic over a bundled file: `collectQuota` gains no
    // new reader, no new request and no new timeout budget.
    return collectQuota({
      readers: [{ id: 'codex', name: 'Codex', read: async () => connectedCodex() }],
      forecast: { now: NOW },
    }).then(report => {
      expect(report.providers).toHaveLength(1)
      expect(report.providers[0].resetForecast?.available).toBe(true)
    })
  })
})
