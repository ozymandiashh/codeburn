/// Localization for the Windows tray (#1336), the twin of `L(_:)` in
/// mac/Sources/CodeBurnMenubar/Localization.swift. Keys are the English copy, so
/// a missing translation degrades to correct English rather than a visible
/// identifier, and a sentence both apps render is one key with one translation
/// on both platforms.
///
/// The two tables under src/i18n/ are the same files the Rust side embeds
/// (src-tauri/src/i18n.rs reads them with include_str!), so the tray menu and
/// the webview can never disagree about a term. The catalog coverage test that
/// keeps the tables honest lives there, next to the parser that mirrors this
/// one.
///
/// What is not translated: provider, model and plan names, units (tok, tok/s,
/// ACU), currency codes, shell commands, and anything the `codeburn` CLI
/// produces (payload labels, activity and project names, forwarded error
/// text). Numbers and dates are formatted before they reach `L`, exactly as
/// `L(_:_:)` only substitutes already-formatted values.

import en from '../i18n/en.lproj/Localizable.strings?raw'
import zh from '../i18n/zh-Hans.lproj/Localizable.strings?raw'
import { loadSettings } from './appSettings'

export type UiLanguage = 'en' | 'zh-Hans'

/// The persisted choice, from windows-settings.json beside the other tray
/// preferences. `system` follows the Windows UI language (the webview's
/// navigator language, which WebView2 keeps in step with it).
export type LanguageChoice = 'system' | UiLanguage

// Parsed once at module load; the tables are static assets, so a Map built from
// them is shareable and immutable for the page's lifetime.
const PARSED: Record<UiLanguage, Map<string, string>> = {
  en: parseTable(en),
  'zh-Hans': parseTable(zh),
}

/// Minimal OpenStep `.strings` parser: `/* comment */` blocks, `"key" = "value";`
/// lines, and the `\"` `\\` `\n` `\t` escapes the menubar tables use. A line
/// that does not fit that shape is skipped rather than throwing: a malformed
/// entry must not take the whole UI down, and the Rust catalog test fails the
/// build on the same files, so drift is caught in CI instead.
function parseTable(table: string): Map<string, string> {
  const entries = new Map<string, string>()
  let i = 0
  const skipSpace = () => {
    while (i < table.length) {
      const c = table[i]
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue }
      // /* ... */ comment.
      if (c === '/' && table[i + 1] === '*') {
        const end = table.indexOf('*/', i + 2)
        i = end === -1 ? table.length : end + 2
        continue
      }
      // // line comment, for safety with hand edits.
      if (c === '/' && table[i + 1] === '/') {
        const end = table.indexOf('\n', i)
        i = end === -1 ? table.length : end + 1
        continue
      }
      break
    }
  }
  const readQuoted = (): string | null => {
    if (table[i] !== '"') return null
    i++
    let out = ''
    while (i < table.length && table[i] !== '"') {
      if (table[i] === '\\' && i + 1 < table.length) {
        const next = table[i + 1]
        if (next === 'n') { out += '\n'; i += 2; continue }
        if (next === 't') { out += '\t'; i += 2; continue }
        if (next === '"') { out += '"'; i += 2; continue }
        if (next === '\\') { out += '\\'; i += 2; continue }
      }
      out += table[i]
      i++
    }
    if (table[i] !== '"') return null
    i++
    return out
  }
  for (;;) {
    skipSpace()
    if (i >= table.length) break
    const key = readQuoted()
    skipSpace()
    if (key === null || table[i] !== '=') { skipToEndOfLine(); continue }
    i++
    skipSpace()
    const value = readQuoted()
    if (value === null) { skipToEndOfLine(); continue }
    skipSpace()
    if (table[i] === ';') i++
    if (key !== '') entries.set(key, value)
  }
  return entries

  function skipToEndOfLine(): void {
    const end = table.indexOf('\n', i)
    i = end === -1 ? table.length : end + 1
  }
}

// The language, resolved once before the first render (main.tsx awaits it).
// Deliberately not reactive: the tray menu the Rust side built at launch is in
// the language it read at launch, so a change mid-run would put the menu and
// the pages in two languages. Settings says so — "Relaunch to apply." — the
// same way the mac's picker does.
let current: UiLanguage = 'en'

/// What the Windows UI language says, as one of the two locales we ship.
/// WebView2's navigator language tracks the Windows display language.
function systemLanguage(): UiLanguage {
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    if (tag.toLowerCase().startsWith('zh')) return 'zh-Hans'
  }
  return 'en'
}

/// Resolves the persisted choice against the system language. Reads through
/// the shared settings store so the file is loaded once, not once per window.
export function resolveLanguage(choice: LanguageChoice): UiLanguage {
  if (choice === 'en' || choice === 'zh-Hans') return choice
  return systemLanguage()
}

/// Must run before the first render of any window (see main.tsx). Loads the
/// settings if they are not loaded yet and freezes the language for this run.
export async function initUiLanguage(): Promise<UiLanguage> {
  const settings = await loadSettings().catch(() => null)
  current = resolveLanguage((settings?.language as LanguageChoice | undefined) ?? 'system')
  return current
}

export function uiLanguage(): UiLanguage {
  return current
}

/// Localized copy for `key`, falling back to the key (its English text) when a
/// translation is missing — the contract that makes the key the dev language.
export function L(key: string): string {
  return PARSED[current].get(key) ?? key
}

/// Localized format string for `key`, with each `%@` / `%lld` occurrence
/// replaced by the next argument verbatim, and `%%` collapsed to a literal
/// percent. The values arrive already formatted (currency, counts, names); the
/// specifier names come from the shared menubar glossary and only their order
/// is contractual between the two tables.
export function Lf(key: string, ...args: Array<string | number>): string {
  const formatted = L(key).replace(/%(@|lld)|%%/g, (match) => {
    if (match === '%%') return '%'
    const arg = args.shift()
    return arg === undefined ? match : String(arg)
  })
  return formatted
}

/// A pluralized count through the glossary's own pair of keys ("1 call",
/// "%lld calls"), so the sentence and its translation stay one entry.
export function Lcount(n: number, one: string, many: string): string {
  return Lf(n === 1 ? one : many, n)
}

// Width-aware truncation ----------------------------------------------------------------
//
// Port of displayCells / abbreviate from mac/Sources/CodeBurnMenubar/
// MenubarSecondRow.swift. Chinese labels are shorter in characters but wider
// per glyph, so any bound on text the tray shows must count display cells,
// not characters: "6 小时 2 分" is 8 characters and 11 cells. The one such
// bound today is the fetch-error overlay's message cap; new ones must go
// through here too rather than through String.slice.

/// Display cells `text` occupies: an East Asian Wide/Fullwidth glyph counts
/// twice. The ranges are the ones the menubar catalog can actually contain;
/// widen them if a locale outside them ships.
export function displayCells(text: string): number {
  let total = 0
  for (const scalar of text) {
    const c = scalar.codePointAt(0) ?? 0
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
    total += wide ? 2 : 1
  }
  return total
}

/// Shortens `text` to `limit` display cells, marking the cut with an ellipsis.
/// Returns "" when there is no room for even one character plus the mark.
export function abbreviate(text: string, limit: number): string {
  if (displayCells(text) <= limit) return text
  if (limit < 2) return ''
  let kept = ''
  let used = 0
  for (const character of text) {
    const width = displayCells(character)
    if (used + width > limit - 1) break
    kept += character
    used += width
  }
  while (kept.endsWith(' ')) kept = kept.slice(0, -1)
  return kept === '' ? '' : `${kept}…`
}
