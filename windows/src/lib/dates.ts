/// All calendar math is in the machine's local time zone. The CLI buckets `history.daily`
/// by local date, so "today" here must be the same local day or the trend chart and the
/// hero disagree around midnight.
///
/// Day and month names go through Intl with the resolved UI language, so an
/// explicitly picked language names dates the same way the rest of the page is
/// written (a Chinese UI on an English machine must not spell out "Sep 14").

import { L, Lf, uiLanguage } from './i18n'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export const MS_PER_DAY = 86_400_000

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/// Weekday/month names in the UI language. The formatters are memoized lazily
/// (never at module load: the language is resolved after the module graph is
/// imported) and fall back to the English tables above if the runtime's Intl
/// cannot format the tag.
const NAME_CACHE = new Map<string, (d: Date) => string>()
function names(part: 'weekday' | 'month', style: 'short' | 'narrow'): (d: Date) => string {
  const tag = uiLanguage() === 'zh-Hans' ? 'zh-Hans' : 'en'
  const key = `${tag}:${part}:${style}`
  const cached = NAME_CACHE.get(key)
  if (cached) return cached
  const table = part === 'weekday' ? DAY_NAMES : MONTH_NAMES
  let fmt: Intl.DateTimeFormat | null = null
  try {
    fmt = new Intl.DateTimeFormat(tag, { [part]: style })
  } catch {
    fmt = null
  }
  const pick = (d: Date) => {
    if (fmt) {
      try {
        return fmt.format(d)
      } catch {
        // An unformattable date falls through to the English table.
      }
    }
    return table[part === 'weekday' ? d.getDay() : d.getMonth()]
  }
  NAME_CACHE.set(key, pick)
  return pick
}

export function todayKey(): string {
  return formatDateKey(new Date())
}

export function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function parseDateKey(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  r.setDate(r.getDate() + n)
  return r
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

const WEEKDAY_SHORT = () => names('weekday', 'short')
const MONTH_SHORT = () => names('month', 'short')

export function prettyDate(ymd: string): string {
  const dt = parseDateKey(ymd)
  return `${WEEKDAY_SHORT()(dt)} ${MONTH_SHORT()(dt)} ${dt.getDate()}`
}

export function monthDay(ymd: string): string {
  const dt = parseDateKey(ymd)
  return `${MONTH_SHORT()(dt)} ${dt.getDate()}`
}

export function shortDate(ymd: string): string {
  const parts = ymd.split('-')
  return `${parts[1]}/${parts[2]}`
}

export function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

export function dayOfMonth(d: Date): number {
  return d.getDate()
}

export function previousMonthRange(d: Date): { first: string; last: string } {
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const last = new Date(d.getFullYear(), d.getMonth(), 0)
  return { first: formatDateKey(first), last: formatDateKey(last) }
}

/// Two-letter weekday heads for the calendar popover (Mo Tu …). Chinese keeps
/// the glossary's single glyphs (一二三…), which is what the mac's calendar
/// labels use.
export function weekdayInitials(): string[] {
  if (uiLanguage() === 'zh-Hans') {
    const narrow = names('weekday', 'narrow')
    // Monday-first, the order the popover grid uses.
    return [1, 2, 3, 4, 5, 6, 0].map(day => narrow(new Date(2024, 0, day)))
  }
  return ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
}

/// "in 42m", "in 3h", "in 2d", or "now". The forms are the menubar glossary's
/// countdown keys, so the tray and the mac read the same sentence.
export function relativeFuture(target: Date, now = new Date()): string {
  const secs = (target.getTime() - now.getTime()) / 1000
  if (secs <= 0) return L('now')
  if (secs < 3600) return Lf('in %lldm', Math.ceil(secs / 60))
  if (secs < 86_400) return Lf('in %lldh', Math.ceil(secs / 3600))
  return Lf('in %lldd', Math.ceil(secs / 86_400))
}

/// "just now", "2 min ago", "1 h ago".
export function relativePast(target: Date, now = new Date()): string {
  const secs = Math.max(0, (now.getTime() - target.getTime()) / 1000)
  if (secs < 45) return L('just now')
  if (secs < 3600) return Lf('%lld min ago', Math.round(secs / 60))
  if (secs < 86_400) return Lf('%lld h ago', Math.round(secs / 3600))
  return Lf('%lld d ago', Math.round(secs / 86_400))
}
