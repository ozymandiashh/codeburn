// The Codex reset-forecast section of `codeburn quota`.
//
// The dataset is a file in this repo, refreshed by
// `.github/workflows/refresh-codex-reset-history.yml`. #725's "no new network
// polling in the client" non-goal holds in full: nothing here fetches anything,
// at any cadence, ever. The forecast is arithmetic over a bundled file.

import { loadResetHistory, type ResetHistoryLoad } from '../codex-reset-history-fetch.js'
import historyData from '../data/codex-reset-history.json' with { type: 'json' }
import {
  forecastReset,
  renderForecastLines,
  type LocalResetEvent,
  type ResetForecastResult,
  type ResetHistory,
} from '../reset-forecast.js'
import type { QuotaCommandProvider } from './index.js'

/** The dataset as shipped. Exported so tests and the parity check read the same
 *  object the command does, rather than re-reading the file by path. */
export const codexResetHistory = historyData as ResetHistory

export type CodexResetForecastPayload = ResetForecastResult & {
  lines: string[]
  /** Which copy of the record produced these numbers, and when it was built. */
  dataset: { source: 'fetched' | 'bundled'; generatedAt: string }
}

/**
 * The record to forecast from, refreshed at most hourly from this repository on
 * GitHub. Separate from `withCodexResetForecast` because that is synchronous and
 * pure; the command awaits this once and hands the result in.
 */
export async function resolveCodexResetHistory(
  options: { now?: Date; cacheDir?: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<ResetHistoryLoad> {
  return loadResetHistory({
    bundled: codexResetHistory,
    ...(options.now ? { now: options.now.getTime() } : {}),
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
}

export type CodexForecastOptions = {
  now?: Date
  history?: ResetHistory
  /** Where `history` came from, for the provenance line. Defaults to bundled. */
  dataset?: { source: 'fetched' | 'bundled'; generatedAt: string }
  /**
   * Resets this machine observed for itself. The local early-reset detector
   * (#1320) and the banked-credit watcher (#1322) are the intended sources;
   * neither has to merge before this works. With none, the forecast is
   * conditioned on the global record, which is the behaviour today.
   */
  localEvents?: LocalResetEvent[]
}

/**
 * Attach the forecast to a Codex provider row. Add-only: a provider that is not
 * Codex, or one with no readable quota at all, comes back untouched, so no
 * other provider's output changes and a signed-out machine is not told about a
 * reset it cannot use.
 */
export function withCodexResetForecast(
  provider: QuotaCommandProvider,
  options: CodexForecastOptions = {},
): QuotaCommandProvider {
  if (provider.id !== 'codex' || !provider.available) return provider
  const history = options.history ?? codexResetHistory
  const result = forecastReset({
    history,
    now: options.now ?? new Date(),
    localEvents: options.localEvents,
  })
  const dataset = options.dataset
    ?? { source: 'bundled' as const, generatedAt: history.generated_at }
  return { ...provider, resetForecast: { ...result, lines: renderForecastLines(result), dataset } }
}
