import { useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { readSetting, writeSetting } from '../lib/settings'
import { L } from '../lib/i18n'
import { StarIcon, XIcon } from './Icons'

const GITHUB_URL = 'https://github.com/getagentseal/codeburn'

export function StarBanner() {
  const [dismissed, setDismissed] = useState(() => readSetting('starBannerDismissed') === 'true')
  if (dismissed) return null

  const dismiss = () => {
    writeSetting('starBannerDismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="star-banner">
      <StarIcon size={10} className="star-banner-icon" />
      <button type="button" className="star-banner-link" onClick={() => openUrl(GITHUB_URL)}>
        <span>{L('Enjoying CodeBurn?')}</span>{' '}
        <span className="star-banner-cta">{L('Star us on GitHub')}</span>
      </button>
      <span className="star-banner-spacer" />
      <button
        type="button"
        className="star-banner-close"
        onClick={dismiss}
        title={L('Hide this banner')}
        aria-label={L('Hide this banner')}
      >
        <XIcon size={9} />
      </button>
    </div>
  )
}
