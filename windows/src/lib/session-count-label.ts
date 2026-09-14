/// Display copy for period session counts. Keep in lockstep with
/// `src/session-count-label.ts`.
///
/// The sentences are the menubar glossary's own keys, so the tray and the mac
/// count sessions in the same words; the numbers themselves are already
/// grouped when they get here and ride through the `%lld` slots verbatim.

import { L, Lf } from './i18n'

export type SessionCountBasis = 'identity' | 'partial'

export const SESSION_COUNT_HELP = () => L('Older session logs may be unavailable.')
export const COMBINED_SESSION_COUNT_HELP = () => L('Session identities are unavailable across devices.')
export const COMBINED_SESSION_COUNT_LABEL = () => L('Session count unavailable')

export function sessionCountIsExact(basis: SessionCountBasis | undefined): boolean {
  return basis === 'identity'
}

/// The counts keep their existing en-US grouping; the glossary contract is the
/// sentence around them, not the digits.
function grouped(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatSessionCount(
  sessions: number,
  basis: SessionCountBasis | undefined,
): string {
  if (!sessionCountIsExact(basis)) {
    if (sessions <= 0) return L('Session count unavailable')
    return sessions === 1
      ? L('At least 1 session')
      : Lf('At least %lld sessions', grouped(sessions))
  }
  if (sessions === 1) return L('1 session')
  return Lf('%lld sessions', grouped(sessions))
}

export function formatCompactSessionCount(
  sessions: number,
  basis: SessionCountBasis | undefined,
): string {
  if (!sessionCountIsExact(basis)) {
    if (sessions <= 0) return L('Unavailable')
    return Lf('≥%lld sess', grouped(sessions))
  }
  return Lf('%lld sess', grouped(sessions))
}

export function formatSessionAveragePlaceholder(): string {
  return '—'
}

export function formatCombinedSessionCount(): string {
  return COMBINED_SESSION_COUNT_LABEL()
}
