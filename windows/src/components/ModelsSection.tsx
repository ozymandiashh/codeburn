import type { Model } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatTokens } from '../lib/currency'
import { L, Lf } from '../lib/i18n'
import { CollapsibleSection } from './CollapsibleSection'
import { FixedBar, COL_COST, COL_COUNT } from './ActivitySection'

/// The Saved column only appears once something was actually saved. With no local-model
/// mapping it would be an unlabelled column of dashes, so the mac drops it entirely.
const COL_SAVED = 54

type Props = {
  models: Model[]
  inputTokens: number
  outputTokens: number
  cacheHitPercent: number
  currency: CurrencyState
}

export function ModelsSection({ models, inputTokens, outputTokens, cacheHitPercent, currency }: Props) {
  if (models.length === 0) return null
  const maxCost = Math.max(...models.map(m => m.cost), 0.01)
  const showSavings = models.some(m => (m.savingsUSD ?? 0) > 0)

  return (
    <CollapsibleSection
      caption={L('Models')}
      columns={[
        { label: L('Cost'), width: COL_COST },
        ...(showSavings ? [{ label: L('Saved'), width: COL_SAVED }] : []),
        { label: L('Calls'), width: COL_COUNT },
      ]}
    >
      {models.map(m => (
        <div key={m.name} className="data-row">
          {/* The bar tracks real cost, so a local model at $0 leaves it empty. The
              counterfactual saving is text in its own column and is never added in. */}
          <FixedBar fraction={m.cost / maxCost} />
          <span className="row-name">{m.name}</span>
          <span className="row-cost" style={{ minWidth: COL_COST }}>{formatCompactCurrency(m.cost, currency)}</span>
          {showSavings && (
            <span
              className={`row-saved ${(m.savingsUSD ?? 0) > 0 ? 'row-saved-on' : ''}`}
              style={{ minWidth: COL_SAVED }}
            >
              {(m.savingsUSD ?? 0) > 0 ? formatCompactCurrency(m.savingsUSD ?? 0, currency) : '-'}
            </span>
          )}
          <span className="row-count" style={{ minWidth: COL_COUNT }}>{m.calls}</span>
        </div>
      ))}
      {(inputTokens > 0 || outputTokens > 0) && (
        <div className="tokens-line">
          <span className="tokens-label">{L('Tokens')}</span>
          <span className="tokens-value">{Lf('%@ in', formatTokens(inputTokens))}</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{Lf('%@ out', formatTokens(outputTokens))}</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{Lf('%@%% cache hit', `${Math.round(cacheHitPercent)}`)}</span>
        </div>
      )}
    </CollapsibleSection>
  )
}
