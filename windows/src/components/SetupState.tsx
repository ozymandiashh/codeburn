import { useState } from 'react'
import { BurnFlame } from './LoadingOverlay'
import { WarningIcon } from './Icons'
import { L, Lf } from '../lib/i18n'

/// Shown instead of the data views when the CLI is missing or too old. This is what a
/// brand-new Windows user sees, so it has to explain the one thing they need to do.

export type CliStatus = {
  found: boolean
  program: string
  version: string | null
  min_version: string
  compatible: boolean
  error: string | null
}

const INSTALL_COMMAND = 'npm install -g codeburn'

type Props = {
  status: CliStatus
  checking: boolean
  onCheckAgain: () => void
}

export function SetupState({ status, checking, onCheckAgain }: Props) {
  const [copied, setCopied] = useState(false)
  const outdated = status.found && !status.compatible

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="setup">
      <BurnFlame size={44} />
      <h2 className="setup-title">
        {outdated ? L('Update the CodeBurn CLI') : L('Install the CodeBurn CLI')}
      </h2>
      <p className="setup-copy">
        {outdated
          ? Lf('This app needs codeburn %@ or newer; version %@ was found.', status.min_version, status.version ?? '')
          : L('The tray app reads everything through the codeburn command line tool, which is not installed on this machine yet.')}
      </p>
      <div className="setup-command">
        <code>{INSTALL_COMMAND}</code>
        <button type="button" className="btn" onClick={copy}>{copied ? L('Copied') : L('Copy')}</button>
      </div>
      <p className="setup-copy setup-copy-muted">
        {L('Requires Node.js 22 or newer. After installing, click Check again; no restart needed.')}
      </p>
      <div className="setup-actions">
        <button type="button" className="btn btn-prominent" onClick={onCheckAgain} disabled={checking}>
          {checking ? L('Checking…') : L('Check again')}
        </button>
      </div>
      {status.error && (
        <details className="setup-details">
          <summary><WarningIcon size={9} filled={false} /> {L('Details')}</summary>
          <div className="setup-error">{status.error}</div>
          <div className="setup-error-muted">{Lf('Looked for: %@', status.program)}</div>
        </details>
      )}
    </section>
  )
}
