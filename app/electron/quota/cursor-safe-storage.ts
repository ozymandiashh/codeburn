// Unlocks Cursor 3.27+ `cursor-safe-storage:v1:` access tokens for Electron
// quota readers (Grok Bot today, and any future desktop Cursor quota reader).
//
// Policy (mirrors CursorSafeStorage.swift and #1802):
// - Plaintext tokens pass through without touching the Keychain.
// - On macOS, Keychain reads happen only on a user-initiated refresh
//   (`allowKeychain: true`), or on a background poll after one user-initiated
//   read has already succeeded in this session.
// - Lookup tries only `["Cursor Key", "Cursor"]` — never a service-only lookup,
//   which would re-prompt after a Deny — and stops immediately on Deny or an
//   unanswered prompt (via `readKeychainPassword`).
// - Never logs the password or decrypted JWT.
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'

import { readKeychainPassword, type KeychainOutcome, type KeychainRefusal } from './security'

export const SAFE_STORAGE_PREFIX = 'cursor-safe-storage:'
export const SAFE_STORAGE_SERVICE = 'Cursor Safe Storage'
// Cursor 3.27's account is "Cursor Key". Older Electron builds used "Cursor".
// No service-only lookup: after a Deny it finds the same item and asks again.
export const SAFE_STORAGE_ACCOUNTS: (string | null)[] = ['Cursor Key', 'Cursor']

export type CursorKeychainReader = (
  service: string,
  accounts: (string | null)[],
) => Promise<KeychainOutcome>

export type CursorUnlockResult =
  | { status: 'ok'; token: string }
  | { status: 'unchecked' }
  | { status: 'unsupported'; message: string }
  | { status: 'accessDenied'; reason?: KeychainRefusal }
  | { status: 'locked' }

// Remember consent and the last opened blob in memory so background refreshes
// work after one user-initiated allow without re-prompting.
let consented = false
let opened: { stored: string; jwt: string } | null = null
// Share one in-flight default Keychain lookup across concurrent readers
// (Grok Bot + any future desktop Cursor quota) so one prompt covers both.
let inFlightDefaultRead: Promise<KeychainOutcome> | null = null

export function forgetCursorSafeStorageConsent(): void {
  consented = false
  opened = null
  inFlightDefaultRead = null
}

export function isCursorSafeStorageToken(token: string): boolean {
  return token.startsWith(SAFE_STORAGE_PREFIX)
}

export function cursorLockedMessage(platform: string = process.platform): string {
  if (platform === 'darwin') {
    return 'Cursor encrypted its app session. Click Refresh and allow the Cursor Safe Storage keychain prompt.'
  }
  return `Cursor encrypted its app session, which CodeBurn cannot unlock on ${platform === 'win32' ? 'Windows' : 'Linux'} yet.`
}

/**
 * Chromium safe-storage v10: PBKDF2-HMAC-SHA1(password, "saltysalt", 1003, 16)
 * and AES-128-CBC with a 16-space IV. Returns the plaintext JWT, or null when
 * the blob is not v1/v10 or the password does not open it.
 */
export function decryptCursorSafeStorage(token: string, password: string): string | null {
  if (!isCursorSafeStorageToken(token)) return token
  const rest = token.slice(SAFE_STORAGE_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep < 0 || rest.slice(0, sep) !== 'v1') return null
  const blob = Buffer.from(rest.slice(sep + 1), 'base64')
  if (blob.length < 4 || blob.subarray(0, 3).toString('utf8') !== 'v10') return null
  try {
    // `security -w` appends a newline. AES key derivation needs the trimmed secret.
    const key = pbkdf2Sync(Buffer.from(password.trim(), 'utf8'), 'saltysalt', 1003, 16, 'sha1')
    const iv = Buffer.alloc(16, 0x20)
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString('utf8').trim()
    return plain.length > 0 ? plain : null
  } catch {
    return null
  }
}

/** Memoizes one Cursor Safe Storage Keychain read for a single quota run so
 *  multiple Cursor-backed readers share one prompt. */
export function memoizeCursorKeychainReader(
  readKeychain: CursorKeychainReader = defaultCursorKeychainRead,
): CursorKeychainReader {
  let pending: Promise<KeychainOutcome> | null = null
  return (service, accounts) => {
    if (!pending) pending = readKeychain(service, accounts)
    return pending
  }
}

function defaultCursorKeychainRead(service: string, accounts: (string | null)[]): Promise<KeychainOutcome> {
  if (!inFlightDefaultRead) {
    inFlightDefaultRead = readKeychainPassword(service, accounts).finally(() => {
      inFlightDefaultRead = null
    })
  }
  return inFlightDefaultRead
}

export async function unlockCursorSafeStorageToken(
  token: string,
  options: {
    allowKeychain: boolean
    platform?: string
    readKeychain?: CursorKeychainReader
  },
): Promise<CursorUnlockResult> {
  if (!isCursorSafeStorageToken(token)) return { status: 'ok', token }
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return { status: 'unsupported', message: cursorLockedMessage(platform) }
  }
  if (!options.allowKeychain) {
    if (opened && opened.stored === token) return { status: 'ok', token: opened.jwt }
    if (!consented) return { status: 'unchecked' }
  }

  const readKeychain = options.readKeychain ?? defaultCursorKeychainRead
  const outcome = await readKeychain(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNTS)
  if (outcome.status === 'accessDenied') {
    consented = false
    opened = null
    return { status: 'accessDenied', reason: outcome.reason }
  }
  if (outcome.status !== 'found') {
    consented = false
    opened = null
    return { status: 'locked' }
  }

  const jwt = decryptCursorSafeStorage(token, outcome.value)
  if (!jwt) {
    consented = false
    opened = null
    return { status: 'locked' }
  }

  consented = true
  opened = { stored: token, jwt }
  return { status: 'ok', token: jwt }
}
