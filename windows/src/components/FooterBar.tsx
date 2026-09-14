import type { CurrencyState } from '../lib/currency'
import { CURRENCY_CODES } from '../lib/currency'
import { TRAY_BADGE_SUPPORTED } from '../lib/platform'
import { L } from '../lib/i18n'
import { DropMenu } from './DropMenu'
import { CoinIcon, DownloadIcon, EllipsisIcon, RefreshIcon, TerminalIcon } from './Icons'

type Props = {
  currency: CurrencyState
  onCurrency: (code: string) => void
  loading: boolean
  onRefresh: () => void
  onExport: (format: 'csv' | 'json') => void
  onOpenReport: () => void
  onToggleTheme: () => void
  onQuit: () => void
  themeLabel: string
  footnote: string
  trayBadge: boolean
  onToggleTrayBadge: () => void
  onOpenSettings: () => void
}

export function FooterBar({
  currency, onCurrency, loading, onRefresh, onExport, onOpenReport, onToggleTheme, onQuit, themeLabel, footnote,
  trayBadge, onToggleTrayBadge, onOpenSettings,
}: Props) {
  return (
    <footer className="footer">
      <DropMenu
        title={L('Currency')}
        label={<><CoinIcon size={12} /><span>{currency.code}</span></>}
        items={CURRENCY_CODES.map(c => ({ id: c, label: c, checked: c === currency.code }))}
        columns={3}
        onSelect={onCurrency}
      />
      <button
        type="button"
        className={`btn btn-icon ${loading ? 'btn-spinning' : ''}`}
        title={L('Refresh')}
        aria-label={L('Refresh')}
        onClick={onRefresh}
        disabled={loading}
      >
        <RefreshIcon size={12} />
      </button>
      <DropMenu
        title={L('Export')}
        label={<><DownloadIcon size={12} /><span>{L('Export')}</span></>}
        items={[
          { id: 'csv', label: L('CSV (folder)') },
          { id: 'json', label: L('JSON') },
        ]}
        onSelect={id => onExport(id as 'csv' | 'json')}
      />
      <span className="footer-spacer" />
      <button type="button" className="btn btn-prominent" onClick={onOpenReport}>
        <TerminalIcon size={12} />
        <span>{L('Open Full Report')}</span>
      </button>
      <DropMenu
        title={L('More')}
        align="right"
        label={<EllipsisIcon size={12} />}
        className="dropmenu-more"
        items={[
          { id: 'settings', label: L('Settings…') },
          ...(TRAY_BADGE_SUPPORTED
            ? [{ id: 'badge', label: L("Show today's cost in tray"), checked: trayBadge, separatorBefore: true }]
            : []),
          { id: 'theme', label: themeLabel },
          { id: 'quit', label: L('Quit CodeBurn'), separatorBefore: true },
        ]}
        footnote={footnote}
        onSelect={id => {
          if (id === 'settings') onOpenSettings()
          if (id === 'badge') onToggleTrayBadge()
          if (id === 'theme') onToggleTheme()
          if (id === 'quit') onQuit()
        }}
      />
    </footer>
  )
}
