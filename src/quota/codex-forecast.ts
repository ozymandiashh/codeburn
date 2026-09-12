// The Codex reset-forecast section of `codeburn quota`.
//
// The dataset is a file in this repo, refreshed by
// `.github/workflows/refresh-codex-reset-history.yml`. #725's "no new network
// polling in the client" non-goal holds in full: nothing here fetches anything,
// at any cadence, ever. The forecast is arithmetic over a bundled file.

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

export type CodexResetForecastPayload = ResetForecastResult & { lines: string[] }

export type CodexForecastOptions = {
  now?: Date
  history?: ResetHistory
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
  const result = forecastReset({
    history: options.history ?? codexResetHistory,
    now: options.now ?? new Date(),
    localEvents: options.localEvents,
  })
  return { ...provider, resetForecast: { ...result, lines: renderForecastLines(result) } }
}
