import { useLayoutEffect, useRef, useState } from 'react'
import type { DailyEntry } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatCurrency, formatTokens } from '../lib/currency'
import { addDays, formatDateKey, monthDay, prettyDate, startOfDay } from '../lib/dates'
import { L, Lf } from '../lib/i18n'

/// Port of ContributionHeatmapInsight in mac/.../Views/HeatmapSection.swift: a GitHub-style
/// grid of the last N weeks, one column per week, Monday at the top. The week count is
/// measured rather than fixed so the grid always ends flush with the right edge.

const CELL = 8
const GAP = 3
const LABEL_WIDTH = 26
/// The gap between the weekday labels and the grid, from the mac HStack spacing.
const LABEL_GAP = 6
const MAX_WEEKS = 52

type Day = {
  date: string
  cost: number
  calls: number
  tokens: number
  level: number
  isToday: boolean
  isFuture: boolean
}

type Week = { start: string; days: Day[] }

export function contributionLevel(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) return 0
  const ratio = Math.min(Math.max(value / maxValue, 0), 1)
  if (ratio < 0.25) return 1
  if (ratio < 0.5) return 2
  if (ratio < 0.75) return 3
  return 4
}

/// Monday of the week containing `date`.
function startOfWeek(date: Date): Date {
  return addDays(date, -((date.getDay() + 6) % 7))
}

export function buildWeeks(entries: DailyEntry[], weekCount: number, now = new Date()): Week[] {
  const today = startOfDay(now)
  const tk = formatDateKey(today)
  const visible = Math.min(Math.max(weekCount, 1), MAX_WEEKS)
  const byDate = new Map(entries.map(e => [e.date, e]))
  const first = addDays(startOfWeek(today), -(visible - 1) * 7)

  // The scale is set by the busiest visible day, so the shading answers "compared with my
  // own busiest day", not with some absolute figure.
  let maxCost = 0
  for (let i = 0; i < visible * 7; i++) {
    const d = addDays(first, i)
    if (d > today) break
    maxCost = Math.max(maxCost, byDate.get(formatDateKey(d))?.cost ?? 0)
  }

  const weeks: Week[] = []
  for (let w = 0; w < visible; w++) {
    const weekStart = addDays(first, w * 7)
    const days: Day[] = []
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i)
      const key = formatDateKey(d)
      const entry = byDate.get(key)
      const isFuture = d > today
      const cost = isFuture ? 0 : entry?.cost ?? 0
      days.push({
        date: key,
        cost,
        calls: isFuture ? 0 : entry?.calls ?? 0,
        tokens: isFuture ? 0 : (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0),
        level: isFuture ? 0 : contributionLevel(cost, maxCost),
        isToday: key === tk,
        isFuture,
      })
    }
    weeks.push({ start: formatDateKey(weekStart), days })
  }
  return weeks
}

type Stats = {
  total: number
  activeDays: number
  avgActive: number
  peak: Day | null
  streak: number
}

export function computeStats(weeks: Week[]): Stats {
  const days = weeks.flatMap(w => w.days).filter(d => !d.isFuture)
  const active = days.filter(d => d.cost > 0)
  const total = active.reduce((s, d) => s + d.cost, 0)
  const peak = active.reduce<Day | null>((best, d) => (best && best.cost >= d.cost ? best : d), null)
  let streak = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].cost <= 0) break
    streak++
  }
  return {
    total,
    activeDays: active.length,
    avgActive: active.length === 0 ? 0 : total / active.length,
    peak,
    streak,
  }
}

/// Monday-first weekday labels with the blanks the grid spacing needs; these
/// are the glossary's own weekday keys, so Chinese shows the same single
/// glyphs (一三五日) the mac's calendar does.
const WEEKDAY_LABELS = () => [L('Mon'), '', L('Wed'), '', L('Fri'), '', L('Sun')]

export function CalendarInsight({ days, currency }: { days: DailyEntry[]; currency: CurrencyState }) {
  const grid = useRef<HTMLDivElement>(null)
  const [weekCount, setWeekCount] = useState(26)
  const [hovered, setHovered] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = grid.current
    if (!el) return
    const measure = () => {
      const available = Math.max(0, el.clientWidth - LABEL_WIDTH - LABEL_GAP - 4)
      const raw = Math.floor((available + GAP) / (CELL + GAP))
      setWeekCount(Math.min(Math.max(raw, 1), MAX_WEEKS))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const weeks = buildWeeks(days, weekCount)
  const stats = computeStats(weeks)
  const hoveredDay = hovered === null ? null : weeks.flatMap(w => w.days).find(d => d.date === hovered) ?? null
  return (
    <div className="calendar-insight" ref={grid}>
      <div className="insight-header">
        <div>
          <div className="insight-sublabel">{L('Daily activity')}</div>
          <div className="insight-hero">{formatCurrency(stats.total, currency)}</div>
        </div>
        <div className="heat-active">{Lf('%lld active days', stats.activeDays)}</div>
      </div>

      <div className="heat-body">
        <div className="heat-weekdays">
          {WEEKDAY_LABELS().map((label, i) => <span key={i}>{label}</span>)}
        </div>
        {/* The cells are painted squares, so the day each one stands for lives in its
            label. A bare span carries no role for that label to attach to, hence role="img". */}
        <div className="heat-weeks" role="group" aria-label={L('Daily spend')} onMouseLeave={() => setHovered(null)}>
          {weeks.map(week => (
            <div key={week.start} className="heat-week">
              {week.days.map(day => (
                <span
                  key={day.date}
                  className={cellClass(day, hovered === day.date)}
                  role="img"
                  title={helpText(day, currency)}
                  aria-label={helpText(day, currency)}
                  onMouseEnter={() => setHovered(day.date)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="heat-detail">
        <div className="heat-detail-main">
          <div className="heat-detail-label">{hoveredDay ? prettyDate(hoveredDay.date) : L('Daily detail')}</div>
          <div className="heat-detail-value">{detailValue(hoveredDay, currency)}</div>
        </div>
        <div className="heat-detail-metric">
          <div className="heat-detail-label">{L('Calls')}</div>
          <div className="heat-detail-num">{hoveredDay && !hoveredDay.isFuture ? hoveredDay.calls : '-'}</div>
        </div>
        <div className="heat-detail-metric">
          <div className="heat-detail-label">{L('Tokens')}</div>
          <div className="heat-detail-num">
            {hoveredDay && !hoveredDay.isFuture ? formatTokens(hoveredDay.tokens) : '-'}
          </div>
        </div>
      </div>

      <div className="mini-stats">
        <div className="mini-stat">
          <div className="mini-stat-label">{L('Peak day')}</div>
          <div className="mini-stat-value">
            {stats.peak ? Lf('%@ on %@', formatCompactCurrency(stats.peak.cost, currency), monthDay(stats.peak.date)) : '-'}
          </div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{L('Avg active')}</div>
          <div className="mini-stat-value">{formatCompactCurrency(stats.avgActive, currency)}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{L('Streak')}</div>
          <div className="mini-stat-value">{Lf('%lldd', stats.streak)}</div>
        </div>
      </div>
    </div>
  )
}

function cellClass(day: Day, isHovered: boolean): string {
  return [
    'heat-cell',
    `heat-l${day.level}`,
    day.isFuture ? 'is-future' : '',
    day.isToday ? 'is-today' : '',
    isHovered ? 'is-hovered' : '',
  ].filter(Boolean).join(' ')
}

function detailValue(day: Day | null, currency: CurrencyState): string {
  if (!day) return L('Hover a day')
  if (day.isFuture) return L('Future day')
  if (day.cost <= 0 && day.calls === 0) return L('No tracked usage')
  return formatCompactCurrency(day.cost, currency)
}

function helpText(day: Day, currency: CurrencyState): string {
  if (day.isFuture) return Lf('%@: future day', prettyDate(day.date))
  if (day.cost <= 0 && day.calls === 0) return Lf('%@: no tracked usage', prettyDate(day.date))
  return Lf(
    '%@: %@, %lld calls, %@ tokens',
    prettyDate(day.date),
    formatCompactCurrency(day.cost, currency),
    day.calls,
    formatTokens(day.tokens),
  )
}
