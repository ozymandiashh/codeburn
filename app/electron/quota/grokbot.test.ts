import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decryptCursorSafeStorage,
  forgetCursorSafeStorageConsent,
  memoizeCursorKeychainReader,
  SAFE_STORAGE_ACCOUNTS,
  SAFE_STORAGE_SERVICE,
  type CursorKeychainReader,
} from './cursor-safe-storage'
import { cursorDatabasePath, decodeGrokbotUsage, fetchGrokbotQuota, grokbotInstalled } from './grokbot'

function wrapSafeStorageToken(jwt: string, password: string): string {
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1')
  const iv = Buffer.alloc(16, 0x20)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([Buffer.from('v10', 'utf8'), cipher.update(jwt, 'utf8'), cipher.final()])
  return `cursor-safe-storage:v1:${encrypted.toString('base64')}`
}

// The live response shape, captured from the account the app itself reads.
const liveBody = {
  currentPeriodStart: '2026-09-13T14:56:21.487Z',
  nextResetTimestampUtc: '2026-09-20T14:56:21.487Z',
  usagePercent: 98.542043,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
  grokPlanLabel: 'Grok Bot Plan',
}

const okJson = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
const deps = (fetchImpl: typeof fetch, token: string | null = 'synthetic-cursor-token') => ({
  fetch: fetchImpl,
  databasePath: '/mock/state.vscdb',
  loadAccessToken: vi.fn(async () => token),
})

describe('Grok Bot usage decode', () => {
  it('decodes the weekly window, plan label and reset stamp', () => {
    const quota = decodeGrokbotUsage(liveBody)
    expect(quota).not.toBe(null)
    if (quota === null || typeof quota === 'string') throw new Error('expected a quota')
    expect(quota.connection).toBe('connected')
    expect(quota.primary?.label).toBe('Weekly usage')
    expect(quota.primary?.percent).toBeCloseTo(0.98542043, 8)
    expect(quota.primary?.resetsAt).toBe('2026-09-20T14:56:21.487Z')
    expect(quota.planLabel).toBe('Grok Bot Plan')
    expect(quota.footerLines).toEqual(['Source: Cursor dashboard (the account the Cursor app is signed into)'])
  })

  it('reports no reading rather than a zero it cannot stand behind', () => {
    expect(decodeGrokbotUsage({ ...liveBody, usagePercent: undefined })).toBe(null)
    expect(decodeGrokbotUsage({ ...liveBody, hasNonZeroIncludedLimit: false })).toBe('noAllowance')
    expect(decodeGrokbotUsage({ ...liveBody, usesPooledEnterpriseAllowance: true })).toBe('pooled')
    expect(decodeGrokbotUsage('not an object')).toBe(null)
  })
})

describe('Grok Bot quota fetch', () => {
  it('posts an empty Connect body with the Cursor bearer', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const { quota } = await fetchGrokbotQuota(deps(fetchMock))
    expect(quota.connection).toBe('connected')
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    expect(init.headers.Authorization).toBe('Bearer synthetic-cursor-token')
    expect(init.headers['connect-protocol-version']).toBe('1')
  })

  it('reports the signed-out state when Cursor holds no session', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const { quota } = await fetchGrokbotQuota(deps(fetchMock, null))
    expect(quota.connection).toBe('disconnected')
    expect(quota.footerLines[0]).toContain('Sign in to the Cursor app')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a rejected session as terminal and a malformed body as retryable', async () => {
    const rejected = await fetchGrokbotQuota(deps((async () => new Response('', { status: 401 })) as unknown as typeof fetch))
    expect(rejected.quota.connection).toBe('terminalFailure')

    const malformed = await fetchGrokbotQuota(deps((async () => new Response('not json', { status: 200 })) as unknown as typeof fetch))
    expect(malformed.quota.connection).toBe('transientFailure')
  })

  it('reports an account with no per-account reading as terminal, not signed out', async () => {
    for (const [body, expected] of [
      [{ ...liveBody, usesPooledEnterpriseAllowance: true }, 'pooled enterprise allowance'],
      [{ ...liveBody, hasNonZeroIncludedLimit: false }, 'no included Grok Bot allowance'],
    ] as const) {
      const { quota } = await fetchGrokbotQuota(deps((async () => okJson(body)) as unknown as typeof fetch))
      expect(quota.connection).toBe('terminalFailure')
      expect(quota.footerLines[0]).toContain(expected)
    }
  })

  it('backs off on a 429 with the served Retry-After', async () => {
    const response = new Response('', { status: 429, headers: { 'Retry-After': '900' } })
    const result = await fetchGrokbotQuota(deps((async () => response) as unknown as typeof fetch))
    expect(result.quota.rateLimited).toBe(true)
    expect(result.retryAfterSeconds).toBe(900)
  })
})

describe('Grok Bot install detection', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grokbot-home-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('accepts either Applications bundle or the data root', () => {
    const applications = path.join(home, 'SystemApplications')
    const installed = (platform: string) => grokbotInstalled(platform, home, applications)
    expect(installed('darwin')).toBe(false)
    expect(installed('linux')).toBe(false)

    mkdirSync(path.join(home, 'Applications', 'Grok Bot.app'), { recursive: true })
    expect(installed('darwin')).toBe(true)
    // Only macOS ships an .app bundle, so the data root is the marker elsewhere.
    expect(installed('linux')).toBe(false)

    mkdirSync(path.join(applications, 'Grok Bot.app'), { recursive: true })
    expect(installed('darwin')).toBe(true)

    mkdirSync(path.join(home, '.grokbot'))
    expect(installed('linux')).toBe(true)
  })

  it('follows the VS Code state layout for the Cursor session', () => {
    expect(cursorDatabasePath('darwin', '/h')).toBe('/h/Library/Application Support/Cursor/User/globalStorage/state.vscdb')
    expect(cursorDatabasePath('win32', '/h')).toBe('/h/AppData/Roaming/Cursor/User/globalStorage/state.vscdb')
    expect(cursorDatabasePath('linux', '/h')).toBe('/h/.config/Cursor/User/globalStorage/state.vscdb')
  })
})

describe('Cursor Safe Storage token unlock', () => {
  const password = 'synthetic-keychain-secret'
  const plainJwt = 'synthetic.jwt.payload'
  const wrapped = wrapSafeStorageToken(plainJwt, password)

  beforeEach(() => forgetCursorSafeStorageConsent())

  it('decrypts v1/v10 safe-storage blobs and trims trailing security -w newlines', () => {
    expect(decryptCursorSafeStorage(wrapped, `${password}\n`)).toBe(plainJwt)
    expect(decryptCursorSafeStorage(wrapped, 'wrong-password')).toBeNull()
    expect(decryptCursorSafeStorage('cursor-safe-storage:v2:abc', password)).toBeNull()
    expect(decryptCursorSafeStorage(plainJwt, password)).toBe(plainJwt)
  })

  it('reports keychainUnchecked on a macOS background poll before user consent and never touches Keychain or fetch', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const readKeychain = vi.fn<CursorKeychainReader>(async () => ({ status: 'found', value: password }))

    const { quota } = await fetchGrokbotQuota({
      ...deps(fetchMock, wrapped),
      platform: 'darwin',
      allowKeychain: false,
      readKeychain,
    })

    expect(quota.connection).toBe('keychainUnchecked')
    expect(readKeychain).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unlocks on a user-initiated refresh, sends the unwrapped bearer, and keeps background polls working afterward', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const readKeychain = vi.fn<CursorKeychainReader>(async () => ({ status: 'found', value: `${password}\n` }))

    const first = await fetchGrokbotQuota({
      ...deps(fetchMock, wrapped),
      platform: 'darwin',
      allowKeychain: true,
      readKeychain,
    })
    expect(first.quota.connection).toBe('connected')
    expect(readKeychain).toHaveBeenCalledTimes(1)
    expect(readKeychain).toHaveBeenCalledWith(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNTS)
    expect(SAFE_STORAGE_ACCOUNTS).not.toContain(null)
    const firstHeaders = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers
    expect(firstHeaders.Authorization).toBe(`Bearer ${plainJwt}`)

    // Same wrapped blob on a background poll reuses the opened JWT without re-reading Keychain.
    const second = await fetchGrokbotQuota({
      ...deps(fetchMock, wrapped),
      platform: 'darwin',
      allowKeychain: false,
      readKeychain,
    })
    expect(second.quota.connection).toBe('connected')
    expect(readKeychain).toHaveBeenCalledTimes(1)

    // A rotated wrapped blob after consent reads Keychain in the background and decrypts the new JWT.
    const rotatedJwt = 'synthetic.rotated.jwt'
    const rotatedWrapped = wrapSafeStorageToken(rotatedJwt, password)
    const third = await fetchGrokbotQuota({
      ...deps(fetchMock, rotatedWrapped),
      platform: 'darwin',
      allowKeychain: false,
      readKeychain,
    })
    expect(third.quota.connection).toBe('connected')
    expect(readKeychain).toHaveBeenCalledTimes(2)
    const thirdHeaders = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[2]![1].headers
    expect(thirdHeaders.Authorization).toBe(`Bearer ${rotatedJwt}`)
  })

  it('stops on Deny or unanswered prompt, clears consent, and never sends ciphertext as a bearer', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const allow = vi.fn<CursorKeychainReader>(async () => ({ status: 'found', value: password }))
    await fetchGrokbotQuota({ ...deps(fetchMock, wrapped), platform: 'darwin', allowKeychain: true, readKeychain: allow })
    ;(fetchMock as unknown as ReturnType<typeof vi.fn>).mockClear()

    const deny = vi.fn<CursorKeychainReader>(async () => ({ status: 'accessDenied', reason: 'denied' }))
    const denied = await fetchGrokbotQuota({
      ...deps(fetchMock, wrapped),
      platform: 'darwin',
      allowKeychain: true,
      readKeychain: deny,
    })
    expect(denied.quota.connection).toBe('accessDenied')
    expect(denied.quota.footerLines[0]).toContain('denied')
    expect(fetchMock).not.toHaveBeenCalled()

    // Consent was cleared on Deny, so the next background poll does not touch Keychain.
    const afterDeny = await fetchGrokbotQuota({
      ...deps(fetchMock, wrapped),
      platform: 'darwin',
      allowKeychain: false,
      readKeychain: deny,
    })
    expect(afterDeny.quota.connection).toBe('keychainUnchecked')
    expect(deny).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported wrapped tokens on Windows/Linux without sending ciphertext', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const readKeychain = vi.fn<CursorKeychainReader>(async () => ({ status: 'found', value: password }))

    const win = await fetchGrokbotQuota({
      ...deps(fetchMock, wrapped),
      platform: 'win32',
      allowKeychain: true,
      readKeychain,
    })
    expect(win.quota.connection).toBe('terminalFailure')
    expect(win.quota.footerLines[0]).toContain('Windows')
    expect(readKeychain).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one Keychain read across concurrent callers via memoizeCursorKeychainReader', async () => {
    const underlying = vi.fn<CursorKeychainReader>(async () => ({ status: 'found', value: password }))
    const shared = memoizeCursorKeychainReader(underlying)
    const [a, b] = await Promise.all([
      shared(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNTS),
      shared(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNTS),
    ])
    expect(a).toEqual({ status: 'found', value: password })
    expect(b).toEqual({ status: 'found', value: password })
    expect(underlying).toHaveBeenCalledTimes(1)
  })
})
