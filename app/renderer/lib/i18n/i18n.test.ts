import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  persistLocaleChoice,
  readLocaleChoice,
  resolveSystemLocale,
  setCurrentLocale,
  t,
  translate,
  type Locale,
} from './index'
import en from './generated/en.json' with { type: 'json' }
import zhHans from './generated/zh-hans.json' with { type: 'json' }

const here = dirname(fileURLToPath(import.meta.url))

describe('locale catalogs (menubar glossary reuse)', () => {
  it('every key exists in both catalogs (coverage parity)', () => {
    const enKeys = new Set(Object.keys(en))
    const zhKeys = new Set(Object.keys(zhHans))
    expect([...enKeys].filter(k => !zhKeys.has(k))).toEqual([])
    expect([...zhKeys].filter(k => !enKeys.has(k))).toEqual([])
  })

  it('no empty translations in the zh-Hans catalog', () => {
    const empties = Object.entries(zhHans).filter(([, v]) => !v)
    expect(empties.map(([k]) => k)).toEqual([])
  })

  it('placeholder sets and order match between catalogs', () => {
    const braces = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1])
    for (const [key, value] of Object.entries(zhHans)) {
      expect(braces(value), key).toEqual(braces(key))
    }
  })

  it('the checked-in catalogs match the menubar glossary + additions (drift)', () => {
    // Re-running the builder must be byte-identical: a menubar glossary edit
    // or an additions change without a regen fails here, mirroring the
    // menubar's LocalizationCatalogTests contract.
    const script = join(here, '..', '..', '..', 'scripts', 'build-i18n.mjs')
    const repoRoot = join(here, '..', '..', '..')
    execFileSync(process.execPath, [script], { cwd: repoRoot, stdio: 'pipe' })
    const genEn = readFileSync(join(here, 'generated', 'en.json'), 'utf8')
    const genZh = readFileSync(join(here, 'generated', 'zh-hans.json'), 'utf8')
    expect(JSON.parse(genZh)).toEqual(zhHans)
    expect(JSON.parse(genEn)).toEqual(en)
  })

  it('shared terminology reads the same as the menubar glossary', () => {
    expect(zhHans['Today']).toBe('今天')
    expect(zhHans['Cost']).toBe('花费')
    expect(zhHans['Sessions']).toBe('会话')
    expect(zhHans['Providers']).toBe('服务商')
    expect(zhHans['Settings']).toBe('设置')
  })
})

describe('t()', () => {
  it('translates a known key in zh-Hans and degrades to English otherwise', () => {
    expect(translate('zh-Hans', 'Today')).toBe('今天')
    expect(translate('zh-Hans', 'A string no catalog carries')).toBe('A string no catalog carries')
    expect(translate('en', 'Today')).toBe('Today')
  })

  it('interpolates {braces} and leaves unknown placeholders literal', () => {
    expect(translate('en', 'refreshed {n}s ago', { n: 42 })).toBe('refreshed 42s ago')
    expect(translate('zh-Hans', 'refreshed {n}s ago', { n: 42 })).toBe('42 秒前刷新')
    expect(translate('en', 'refreshed {n}s ago', { other: 1 })).toBe('refreshed {n}s ago')
  })

  it('the module-level t() follows setCurrentLocale', () => {
    setCurrentLocale('zh-Hans')
    try {
      expect(t('Today')).toBe('今天')
    } finally {
      setCurrentLocale('en')
    }
    expect(t('Today')).toBe('Today')
  })
})

describe('locale choice', () => {
  it('system resolves Chinese macro-language tags to zh-Hans, everything else to en', () => {
    expect(resolveSystemLocale('zh-CN')).toBe('zh-Hans')
    expect(resolveSystemLocale('zh-Hans_TW')).toBe('zh-Hans')
    expect(resolveSystemLocale('zh')).toBe('zh-Hans')
    expect(resolveSystemLocale('en-US')).toBe('en')
    expect(resolveSystemLocale(undefined)).toBe('en')
  })

  it('persists and reads back explicit choices; removal restores system', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    }
    vi.stubGlobal('localStorage', storage)
    try {
      expect(readLocaleChoice()).toBe('system')
      persistLocaleChoice('zh-Hans')
      expect(readLocaleChoice()).toBe('zh-Hans')
      persistLocaleChoice('system')
      expect(readLocaleChoice()).toBe('system')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
