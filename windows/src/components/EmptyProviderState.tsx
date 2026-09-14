import type { Period } from './PeriodTabs'
import { periodPhrase } from './PeriodTabs'
import { Lf } from '../lib/i18n'
import { TrayIcon } from './Icons'

type Props = {
  label: string
  period: Period
}

export function EmptyProviderState({ label, period }: Props) {
  return (
    <div className="empty-provider">
      <TrayIcon size={26} className="empty-provider-icon" />
      <div className="empty-provider-text">{Lf('No %@ data for %@', label, periodPhrase(period))}</div>
    </div>
  )
}
