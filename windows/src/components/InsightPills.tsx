import { L } from '../lib/i18n'

export type InsightMode = 'plan' | 'trend' | 'forecast' | 'calendar' | 'pulse' | 'stats' | 'optimize'

/// Same order as the macOS InsightMode enum: Plan first when it is visible.
export const INSIGHT_ORDER: InsightMode[] = [
  'plan', 'trend', 'forecast', 'calendar', 'pulse', 'stats', 'optimize',
]

/// The glossary's own tab names, resolved at call time so they follow the UI
/// language (the module loads before the language is resolved).
export function insightLabel(mode: InsightMode): string {
  switch (mode) {
    case 'plan': return L('Plan')
    case 'trend': return L('Trend')
    case 'forecast': return L('Forecast')
    case 'calendar': return L('Calendar')
    case 'pulse': return L('Pulse')
    case 'stats': return L('Stats')
    case 'optimize': return L('Optimize')
  }
}

export function isInsightMode(value: string | null): value is InsightMode {
  return value !== null && INSIGHT_ORDER.includes(value as InsightMode)
}

type Props = {
  selected: InsightMode
  onSelect: (m: InsightMode) => void
  modes: InsightMode[]
}

export function InsightPills({ selected, onSelect, modes }: Props) {
  return (
    <div className="insight-pills" role="tablist" aria-label={L('Insight')}>
      {modes.map(m => (
        <button
          key={m}
          type="button"
          role="tab"
          id={`insight-tab-${m}`}
          aria-selected={selected === m}
          aria-controls="insight-panel"
          className={`insight-pill ${selected === m ? 'insight-pill-active' : ''}`}
          onClick={() => onSelect(m)}
        >
          {insightLabel(m)}
        </button>
      ))}
    </div>
  )
}
