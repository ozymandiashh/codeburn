import { WarningIcon } from './Icons'
import { L, Lf, abbreviate } from '../lib/i18n'

/// Port of FetchErrorOverlay in mac/.../Views/MenuBarContent.swift. Shown in place of the
/// loading overlay when the fetch failed and there is nothing cached to fall back on, so a
/// failed CLI run reads as a failure with a way out rather than an endless spinner.

/// The cap on the forwarded message, in display cells rather than characters: a Han glyph
/// is about twice as wide as a Latin one, so the same character count lets a Chinese
/// message run to twice the width of the box. This is the width-weighted budget from
/// mac/.../MenubarSecondRow.swift (displayCells/abbreviate), applied to the one text the
/// tray truncates.
const MAX_MESSAGE_CELLS = 240

type Props = {
  message: string
  periodLabel: string
  onRetry: () => void
}

export function FetchErrorOverlay({ message, periodLabel, onRetry }: Props) {
  const shown = abbreviate(message.trim(), MAX_MESSAGE_CELLS)

  return (
    <div className="fetch-error-overlay" role="alert">
      <div className="fetch-error-content">
        <WarningIcon size={28} className="fetch-error-icon" />
        <div className="fetch-error-title">{Lf("Couldn't load %@", periodLabel)}</div>
        <div className="fetch-error-message">{shown}</div>
        <button type="button" className="btn btn-prominent" onClick={onRetry}>{L('Retry')}</button>
      </div>
    </div>
  )
}
