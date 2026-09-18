// Build the renderer's locale catalogs from the menubar's reviewed glossary
// plus the desktop-only additions. Output: app/renderer/lib/i18n/generated/
// {en,zhHans}.json — committed, with a drift test that re-runs this script and
// fails when the checked-in files no longer match (same contract as the
// menubar's LocalizationCatalogTests).
//
// Reuse is the point (#1335): the menubar glossary is the reviewed source of
// truth for shared terminology (Today 今天, Cost 花费, Capacity Dock 容量 Dock…),
// so both surfaces read the same. Desktop-only strings live in
// app/renderer/lib/i18n/desktop-additions.{en,zh-Hans}.ts and win on key
// collisions (the desktop wording is the desktop's to choose).
//
// The menubar uses Cocoa %@/%lld specifiers; the renderer's t() interpolates
// {braces}. %@ -> {v} and %lld -> {n}, in order, with %% left alone — none of
// the shared keys mix more than two, and the conversion is deterministic so
// the drift test catches any glossary edit that changes the shape.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const menubar = (locale) => join(root, 'mac', 'Sources', 'CodeBurnMenubar', 'Resources', locale, 'Localizable.strings')
const outDir = join(root, 'app', 'renderer', 'lib', 'i18n', 'generated')

/** Parse an Apple .strings file: "key" = "value"; lines, // comments. */
function parseStrings(path) {
  const src = readFileSync(path, 'utf8')
  const map = new Map()
  const re = /^"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/gm
  let m
  while ((m = re.exec(src)) !== null) {
    const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    map.set(unescape(m[1]), unescape(m[2]))
  }
  return map
}

/** First %@ becomes {v}, second {v2}; first %lld {n}, second {n2}; %% stays. */
function toBraces2(s) {
  let v = 0, n = 0
  return s
    .replace(/%%/g, '\u0000')
    .replace(/%@/g, () => (v++ === 0 ? '{v}' : `{v${v}}`))
    .replace(/%lld/g, () => (n++ === 0 ? '{n}' : `{n${n}}`))
    .replace(/\u0000/g, '%%')
}

function build() {
  const additions = {
    en: JSON.parse(readFileSync(join(root, 'app', 'renderer', 'lib', 'i18n', 'desktop-additions.en.json'), 'utf8')),
    zhHans: JSON.parse(readFileSync(join(root, 'app', 'renderer', 'lib', 'i18n', 'desktop-additions.zh-hans.json'), 'utf8')),
  }

  const en = {}
  for (const [k, v] of parseStrings(menubar('en.lproj'))) en[toBraces2(k)] = toBraces2(v === '' ? k : v)
  Object.assign(en, additions.en)

  const zhHans = {}
  for (const [k, v] of parseStrings(menubar('zh-Hans.lproj'))) zhHans[toBraces2(k)] = toBraces2(v)
  Object.assign(zhHans, additions.zhHans)

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'en.json'), JSON.stringify(en, null, 0) + '\n')
  writeFileSync(join(outDir, 'zh-hans.json'), JSON.stringify(zhHans, null, 0) + '\n')
  console.log(`i18n: ${Object.keys(en).length} en keys, ${Object.keys(zhHans).length} zh-Hans keys`)
}

build()
