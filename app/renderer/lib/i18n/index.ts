import { createContext, useContext } from 'react'

import en from './generated/en.json' with { type: 'json' }
import zhHans from './generated/zh-hans.json' with { type: 'json' }

/** The renderer's locales. `system` follows the OS/app language. */
export type Locale = 'en' | 'zh-Hans'

export type LocaleChoice = Locale | 'system'

const CATALOGS: Record<Locale, Record<string, string>> = { en, 'zh-Hans': zhHans }

const LS_KEY = 'codeburn.language'

/** The persisted choice ('system' when nothing was ever chosen). */
export function readLocaleChoice(): LocaleChoice {
  try {
    const saved = globalThis.localStorage?.getItem(LS_KEY)
    if (saved === 'en' || saved === 'zh-Hans' || saved === 'system') return saved
  } catch { /* storage can be unavailable */ }
  return 'system'
}

export function persistLocaleChoice(choice: LocaleChoice): void {
  try {
    if (choice === 'system') globalThis.localStorage?.removeItem(LS_KEY)
    else globalThis.localStorage?.setItem(LS_KEY, choice)
  } catch { /* storage can be unavailable */ }
}

/**
 * Resolve 'system' to a concrete locale. The desktop app's own language is
 * what a desktop user's OS choice means here (the menubar reads AppleLanguages
 * the same way); the preload exposes it as a plain tag. Anything but a
 * Chinese macro-language tag maps to English — the only other catalog.
 */
export function resolveSystemLocale(appLocaleTag: string | undefined): Locale {
  if (appLocaleTag && /^zh\b/i.test(appLocaleTag)) return 'zh-Hans'
  return 'en'
}

/**
 * Translate one user-facing string, keyed by its English copy — the same
 * shape as the menubar's L(). An untranslated key degrades to the English
 * key itself (never an identifier), and `{name}` placeholders interpolate.
 */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const template = CATALOGS[locale][key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Non-React callers (formatters) read the current locale from this module. */
let currentLocale: Locale = 'en'

export function setCurrentLocale(locale: Locale): void {
  currentLocale = locale
}

export function currentLocaleTag(): string {
  return currentLocale === 'zh-Hans' ? 'zh-CN' : 'en-US'
}

/** The t() that components import. React binding lives in LocaleContext. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(currentLocale, key, vars)
}

export type LocaleContextValue = {
  locale: Locale
  /** The effective choice including 'system', for the Settings picker. */
  choice: LocaleChoice
  setChoice: (choice: LocaleChoice) => void
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  choice: 'system',
  setChoice: () => {},
})

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext)
}
