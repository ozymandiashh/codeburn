import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

import type { CurrencyState } from '../lib/currency'
import { CURRENCY_CODES, CURRENCY_NAMES, USD } from '../lib/currency'
import { ACCENT_PRESETS, accentById, applyAccent } from '../lib/accent'
import {
  DISPLAY_METRICS, MENUBAR_PERIODS, TERMINALS, USAGE_CADENCES, subscribeSettings, writeSettings,
  type AppSettings, type DisplayMetric, type MenubarPeriod, type MenubarScope, type ThemeChoice,
} from '../lib/appSettings'
import { applyTheme } from '../lib/settings'
import { L, Lf, type LanguageChoice } from '../lib/i18n'
import { TRAY_BADGE_SUPPORTED, homePath } from '../lib/platform'
import { summaryFor, type QuotaState } from '../lib/quota'
import {
  DEFAULT_DOCK_PREFS, DOCK_GAUGE_SHAPES, DOCK_SCALE_MAX, DOCK_SCALE_MIN, DOCK_SCALE_STEP,
  DOCK_THEMES, canDeselect, loadDockPrefs, manageableProviders, onDockPrefsChanged,
  writeDockPrefs, type DockPrefs,
} from '../lib/dockPrefs'
import { ProviderGlyph } from '../providerIcons'
import { TelemetryNotice } from '../components/TelemetryNotice'
import {
  TELEMETRY_DOCS_URL, setTelemetryEnabled, telemetryStatus, type TelemetryStatus,
} from '../lib/telemetry'
import { Field, Group, Note, Pane, Row, Select, Slider, Switch } from './controls'

/// The mac's GeneralSettingsTab. Display first, because it is what the reader came for; the
/// Windows-only rows (login item, tray badge) sit under System at the end, where the mac
/// keeps nothing because macOS handles both for it.

type Props = {
  quota: QuotaState
  /// A deep link's anchor, so "Capacity Dock Settings..." lands on that section.
  anchor: string | null
}

export function GeneralPane({ quota, anchor }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [currency, setCurrency] = useState<CurrencyState>(USD)
  const [currencyError, setCurrencyError] = useState<string | null>(null)
  const [loginItem, setLoginItem] = useState<boolean | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => subscribeSettings(setSettings), [])

  useEffect(() => {
    invoke<boolean>('launch_at_login').then(setLoginItem).catch(() => setLoginItem(false))
    invoke<CurrencyState>('currency').then(setCurrency).catch(() => {})
  }, [])

  useEffect(() => {
    if (!anchor) return
    document.getElementById(`stg-${anchor}`)?.scrollIntoView({ block: 'start' })
  }, [anchor])

  if (!settings) return <Pane />

  const applyCurrency = async (code: string) => {
    setCurrencyError(null)
    try {
      setCurrency(await invoke<CurrencyState>('set_currency', { code }))
    } catch (err) {
      setCurrencyError(err instanceof Error ? err.message : String(err))
    }
  }

  const chooseAccent = (id: string) => {
    // Applied here as well as persisted: this window is tinted by the same tokens, so the
    // swatch has to take effect before the event comes back.
    applyAccent(accentById(id))
    void writeSettings({ accent: id })
  }

  const chooseTheme = (theme: ThemeChoice) => {
    applyTheme(theme === 'system' ? null : theme)
    void writeSettings({ theme })
  }

  const toggleLogin = async () => {
    if (loginItem === null) return
    setLoginError(null)
    try {
      setLoginItem(await invoke<boolean>('set_launch_at_login', { enabled: !loginItem }))
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Pane>
      <Group
        title={L('Display')}
        footer={Lf(
          'The currency is shared with the CLI through %@.',
          homePath('.config', 'codeburn', 'config.json'),
        )}
      >
        <Row
          label={L('Currency')}
          control={
            <Select
              ariaLabel={L('Currency')}
              value={currency.code}
              options={CURRENCY_CODES.map(code => ({
                id: code as string,
                label: `${code} - ${L(CURRENCY_NAMES[code] ?? code)}`,
              }))}
              onChange={applyCurrency}
            />
          }
        />
        {currencyError && <Note><span className="stg-error">{currencyError}</span></Note>}
        <Row
          label={L('Metric')}
          hint={L("What the number beside the tray flame counts.")}
          control={
            <Select
              ariaLabel={L('Metric')}
              value={settings.metric}
              options={DISPLAY_METRICS.map(m => ({ id: m.id, label: m.label() }))}
              onChange={(metric: DisplayMetric) => writeSettings({ metric })}
            />
          }
        />
        <Row
          label={L('Period')}
          hint={L('How far back that number reaches.')}
          control={
            <Select
              ariaLabel={L('Period')}
              value={settings.menubarPeriod}
              options={MENUBAR_PERIODS.map(p => ({ id: p.id, label: p.label() }))}
              onChange={(menubarPeriod: MenubarPeriod) => writeSettings({ menubarPeriod })}
            />
          }
        />
        <Row
          label={L('Scope')}
          hint={L('Combined adds every paired device the CLI can reach.')}
          control={
            <Select
              ariaLabel={L('Scope')}
              value={settings.menubarScope}
              options={[
                { id: 'local' as MenubarScope, label: L('Local') },
                { id: 'combined' as MenubarScope, label: L('Combined') },
              ]}
              onChange={(menubarScope: MenubarScope) => writeSettings({ menubarScope })}
            />
          }
        />
        <Row
          label={L('Accent')}
          hint={L('Tints the popover, this window and the Capacity Dock.')}
          control={
            <div className="stg-swatches" role="radiogroup" aria-label={L('Accent')}>
              {ACCENT_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={settings.accent === preset.id}
                  aria-label={preset.label()}
                  title={preset.label()}
                  className={`stg-swatch ${settings.accent === preset.id ? 'stg-swatch-on' : ''}`}
                  style={{ background: preset.base }}
                  onClick={() => chooseAccent(preset.id)}
                />
              ))}
            </div>
          }
        />
      </Group>

      <CapacityDockSection quota={quota} />

      <LanguageSection settings={settings} />

      <Group title={L('Usage Refresh')}>
        <Row
          label={L('Update every')}
          control={
            <Select
              ariaLabel={L('Usage refresh cadence')}
              value={settings.usageRefreshSeconds}
              options={USAGE_CADENCES.map(c => ({ id: c.id, label: c.label() }))}
              onChange={usageRefreshSeconds => writeSettings({ usageRefreshSeconds })}
            />
          }
        />
        <Note>
          {L('How often the tray figure re-reads your local session data. Auto refreshes every minute while the popover is open and every two minutes when it is closed. Manual only refreshes when you open the popover or press Refresh.')}
        </Note>
      </Group>

      <TerminalSection settings={settings} />

      <AlertsSection settings={settings} currency={currency} />

      <Group title={L('System')}>
        <Row
          label={L('Theme')}
          control={
            <Select
              ariaLabel={L('Theme')}
              value={settings.theme}
              options={[
                { id: 'system' as ThemeChoice, label: L('System') },
                { id: 'light' as ThemeChoice, label: L('Light') },
                { id: 'dark' as ThemeChoice, label: L('Dark') },
              ]}
              onChange={chooseTheme}
            />
          }
        />
        <Row
          label={L('Launch at login')}
          hint={L('Start CodeBurn in the tray when you sign in.')}
          control={
            <Switch
              ariaLabel={L('Launch at login')}
              on={loginItem === true}
              disabled={loginItem === null}
              onToggle={toggleLogin}
            />
          }
        />
        {loginError && <Note><span className="stg-error">{loginError}</span></Note>}
        {TRAY_BADGE_SUPPORTED && (
          <Row
            label={L("Show today's figure in the tray")}
            hint={L('A second tray icon carrying the number, next to the logo.')}
            control={
              <Switch
                ariaLabel={L("Show today's figure in the tray")}
                on={settings.trayBadge}
                onToggle={() => writeSettings({ trayBadge: !settings.trayBadge })}
              />
            }
          />
        )}
      </Group>

      <TelemetrySection />
    </Pane>
  )
}

/// The UI language, the counterpart of the mac's Language section. Each language names
/// itself (a reader opening a picker written in a language they cannot read is stranded), so
/// only the System row translates. The choice lands in windows-settings.json beside the
/// other tray preferences, and applies on the next launch: the tray menu the Rust side built
/// reads the language once, at startup, so a mid-run switch would split the app in two —
/// the note and the Relaunch button say so instead of pretending otherwise.
function LanguageSection({ settings }: { settings: AppSettings }) {
  const [languageChanged, setLanguageChanged] = useState(false)

  const choose = (language: LanguageChoice) => {
    setLanguageChanged(language !== settings.language)
    void writeSettings({ language })
  }

  return (
    <Group title={L('Language')}>
      <Row
        label={L('Language')}
        control={
          <Select
            ariaLabel={L('Language')}
            value={settings.language}
            options={[
              { id: 'system' as LanguageChoice, label: L('System') },
              { id: 'en' as LanguageChoice, label: 'English' },
              { id: 'zh-Hans' as LanguageChoice, label: '简体中文' },
            ]}
            onChange={choose}
          />
        }
      />
      {languageChanged ? (
        <Note>
          {L('Relaunch to apply.')}{' '}
          <button type="button" className="consent-link" onClick={() => { invoke('relaunch_app').catch(() => {}) }}>
            {L('Relaunch')}
          </button>
        </Note>
      ) : (
        <Note>{L('Follows the Windows UI language unless you pick one here.')}</Note>
      )}
    </Group>
  )
}

/// The anonymous-telemetry decision, the counterpart of the desktop app's Privacy & data
/// pane. Which app the decision belongs to is what decides whether this is a control or a
/// readout: installed beside the desktop app, that app answers for both and this toggle is
/// disabled with a line saying where to change it.
function TelemetrySection() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)

  useEffect(() => {
    let live = true
    void telemetryStatus().then(next => { if (live) setStatus(next) })
    return () => { live = false }
  }, [])

  if (!status) return null

  const fromDesktop = status.source === 'desktop'

  // Undecided and on its own: the question comes before the toggle, because nothing is
  // recorded or sent until it is answered.
  if (!status.onboarded && !fromDesktop) {
    return (
      <Group title={L('Privacy')}>
        <TelemetryNotice onDecided={setStatus} />
      </Group>
    )
  }

  const toggle = () => {
    void setTelemetryEnabled(!status.enabled).then(next => { if (next) setStatus(next) })
  }

  return (
    <Group title={L('Privacy')}>
      <Row
        label={L('Anonymous telemetry')}
        hint={L('Which parts of the app get opened, how the Capacity Dock is used, and errors. The daily report includes the names of the models, tools, skills and MCP servers you use alongside the bucketed counts. Never your prompts, your code, or your project and file names.')}
        control={
          <Switch
            ariaLabel={L('Anonymous telemetry')}
            on={status.enabled}
            disabled={fromDesktop}
            onToggle={toggle}
          />
        }
      />
      <Note>
        {fromDesktop ? (
          L("This is the CodeBurn desktop app's setting and it covers both apps. Change it there, under Privacy and data.")
        ) : (
          <>
            {L('Switching this off gives this install a new anonymous id, so nothing recorded before can be tied to anything after.')}{' '}
            <button type="button" className="consent-link" onClick={() => { void openUrl(TELEMETRY_DOCS_URL) }}>
              {L('What data we collect')}
            </button>
          </>
        )}
      </Note>
    </Group>
  )
}

/// The mac's CapacityDockSettingsSection. These preferences live in windows-dock.json beside
/// the rail's placement, because the dock reads that file from Rust before its page exists.
function CapacityDockSection({ quota }: { quota: QuotaState }) {
  const [prefs, setPrefs] = useState<DockPrefs>(DEFAULT_DOCK_PREFS)

  useEffect(() => {
    void loadDockPrefs().then(setPrefs)
    return onDockPrefsChanged(setPrefs)
  }, [])

  const apply = (patch: Partial<DockPrefs>) => {
    // Optimistic, so a slider stays under the pointer; the event corrects it either way.
    setPrefs(current => ({ ...current, ...patch }))
    void writeDockPrefs(patch).then(setPrefs)
  }

  const isConnected = (id: string) => {
    const summary = summaryFor(quota, id)
    return summary !== null && (summary.connection === 'connected' || summary.connection === 'stale')
  }
  const nameOf = (id: string) => quota.providers.find(p => p.id === id)?.name ?? id

  const all = quota.providers.map(p => p.id)
  const manageable = manageableProviders(all, prefs.providers, isConnected)
  // The rail can only rest on a provider it is actually showing. With nothing chosen yet it
  // shows everything connected, which is what an empty selection means.
  const restable = (prefs.providers.length > 0 ? prefs.providers : all).filter(isConnected)
  const resting = restable.includes(prefs.preferred ?? '') ? prefs.preferred! : restable[0] ?? ''

  const toggleProvider = (id: string, on: boolean) => {
    const base = prefs.providers.length > 0 ? prefs.providers : all.filter(isConnected)
    const next = on ? [...base.filter(p => p !== id), id] : base.filter(p => p !== id)
    // Ordered as the CLI reports them, so the rail reads the same top to bottom whichever
    // order the switches were flipped in.
    apply({ providers: all.filter(p => next.includes(p)), manualSelection: true })
  }

  return (
    <Group
      id="stg-dock"
      title={L('Capacity Dock')}
      footer={L('Connected providers, and anything already in the dock, appear here, so a provider can always be removed even after its connection fails.')}
    >
      <Row
        label={L('Show Capacity Dock')}
        hint={L('A slim quota rail docked to a screen edge.')}
        control={
          <Switch
            ariaLabel={L('Show Capacity Dock')}
            on={prefs.enabled}
            onToggle={() => apply({ enabled: !prefs.enabled })}
          />
        }
      />
      {restable.length > 0 && (
        <Row
          label={L('Resting provider')}
          hint={L('The one the rail shows before you hover it.')}
          control={
            <Select
              ariaLabel={L('Resting provider')}
              value={resting}
              options={restable.map(id => ({ id, label: nameOf(id) }))}
              onChange={preferred => apply({ preferred })}
            />
          }
        />
      )}
      <Row
        label={L('Size')}
        control={
          <>
            <Slider
              ariaLabel={L('Capacity Dock size')}
              value={prefs.scale}
              min={DOCK_SCALE_MIN}
              max={DOCK_SCALE_MAX}
              step={DOCK_SCALE_STEP}
              onChange={scale => apply({ scale })}
            />
            <span className="stg-readout">{Math.round(prefs.scale * 100)}%</span>
          </>
        }
      />
      <Row
        label={L('Appearance')}
        control={
          <Select
            ariaLabel={L('Capacity Dock appearance')}
            value={prefs.theme}
            options={DOCK_THEMES.map(t => ({ id: t.id, label: t.label() }))}
            onChange={theme => apply({ theme })}
          />
        }
      />
      <Row
        label={L('Gauge shape')}
        control={
          <Select
            ariaLabel={L('Capacity Dock gauge shape')}
            value={prefs.gaugeShape}
            options={DOCK_GAUGE_SHAPES.map(s => ({ id: s.id, label: s.label() }))}
            onChange={gaugeShape => apply({ gaugeShape })}
          />
        }
      />
      {manageable.length === 0 ? (
        <Note>{L('Connect a provider from its page in the sidebar to make it available here.')}</Note>
      ) : (
        manageable.map(id => {
          const on = prefs.providers.length > 0 ? prefs.providers.includes(id) : isConnected(id)
          return (
            <Row
              key={id}
              label={
                <span className="stg-provider">
                  <ProviderGlyph id={id} size={14} />
                  <span>{nameOf(id)}</span>
                  {!isConnected(id) && <span className="stg-attention">{L('Needs attention')}</span>}
                </span>
              }
              control={
                <Switch
                  ariaLabel={nameOf(id)}
                  on={on}
                  disabled={on && !canDeselect(id, prefs.providers.length > 0 ? prefs.providers : all.filter(isConnected), isConnected)}
                  onToggle={() => toggleProvider(id, !on)}
                />
              }
            />
          )
        })
      )}
    </Group>
  )
}

/// The mac's Terminal section. Only consoles that can hold a command open in a live window
/// are listed, and Rust says which of them are actually on this machine.
function TerminalSection({ settings }: { settings: AppSettings }) {
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null)

  useEffect(() => {
    invoke<Array<{ id: string; installed: boolean }>>('terminals')
      .then(list => setInstalled(Object.fromEntries(list.map(t => [t.id, t.installed]))))
      .catch(() => setInstalled({}))
  }, [])

  // Nothing to choose on Linux, where a terminal is found by probing at launch.
  if (installed === null || Object.keys(installed).length === 0) return null

  return (
    <Group title={L('Terminal')}>
      <Row
        label={L('Open commands in')}
        control={
          <Select
            ariaLabel={L('Terminal')}
            value={settings.terminal}
            options={TERMINALS.map(term => ({
              id: term.id,
              label: installed[term.id] === false ? Lf('%@ (not installed)', term.label()) : term.label(),
            }))}
            onChange={terminal => writeSettings({ terminal })}
          />
        }
      />
      <Note>
        {L('Where Full Report and Optimize open. If the chosen console is not installed, CodeBurn falls back to the Command Prompt, which always is.')}
      </Note>
    </Group>
  )
}

/// The mac's Alerts section. The budget tracks whatever the tray figure shows: money for the
/// Cost metric, tokens for the two token metrics. Both live in the CLI config, because the
/// tray reads them before any webview exists. The spend limit is the CLI's own `budget.daily`
/// and so is kept in the display currency, which is why the presets carry its symbol; the
/// token limit has no CLI counterpart and stays where this app put it.
const COST_PRESETS = [0, 25, 50, 100, 200, 500]
const TOKEN_PRESETS = [0, 1e6, 5e6, 10e6, 25e6, 50e6, 100e6]
const CUSTOM = -1

/// What `daily_budgets` answers; its `cost`, the same limit in dollars, is for the surfaces
/// that compare it against the payload rather than edit it.
type Budgets = { costDisplay: number | null; tokens: number | null }

function AlertsSection({ settings, currency }: { settings: AppSettings; currency: CurrencyState }) {
  const [budgets, setBudgets] = useState<Budgets>({ costDisplay: null, tokens: null })
  const [custom, setCustom] = useState(false)
  const [draft, setDraft] = useState('')

  const isTokens = settings.metric === 'tokens' || settings.metric === 'totalTokens'
  const stored = isTokens ? budgets.tokens : budgets.costDisplay
  const presets = isTokens ? TOKEN_PRESETS : COST_PRESETS
  const key = isTokens ? 'dailyTokenBudget' : 'dailyBudget'
  const unit = isTokens ? 1e6 : 1

  const read = () => {
    invoke<Budgets>('daily_budgets')
      .then(next => {
        setBudgets(next)
        const value = (settings.metric === 'tokens' || settings.metric === 'totalTokens') ? next.tokens : next.costDisplay
        const list = (settings.metric === 'tokens' || settings.metric === 'totalTokens') ? TOKEN_PRESETS : COST_PRESETS
        // A stored amount that is not one of the presets is a custom one, so the field opens
        // with it rather than the picker silently rounding it to a preset.
        if (value !== null && !list.includes(value)) {
          setCustom(true)
          setDraft(trim(value / ((settings.metric === 'tokens' || settings.metric === 'totalTokens') ? 1e6 : 1)))
        }
      })
      .catch(() => {})
  }
  useEffect(read, [settings.metric])

  const write = (amount: number | null) => {
    invoke('set_daily_budget', { key, amount })
      .then(() => setBudgets(current => ({ ...current, [isTokens ? 'tokens' : 'costDisplay']: amount })))
      .catch(() => {})
  }

  const choose = (value: number) => {
    if (value === CUSTOM) {
      setCustom(true)
      setDraft(stored ? trim(stored / unit) : '')
      return
    }
    setCustom(false)
    write(value > 0 ? value : null)
  }

  const applyDraft = (text: string) => {
    setDraft(text)
    const value = Number(text.trim())
    write(Number.isFinite(value) && value > 0 ? value * unit : null)
  }

  const label = (value: number) => {
    if (value === 0) return L('Off')
    return isTokens ? `${trim(value / 1e6)}M` : `${currency.symbol}${trim(value)}`
  }

  const armed = stored !== null && stored > 0
  const help = custom && !armed
    ? L('Enter an amount above, or the alert stays off.')
    : isTokens
      ? L("The tray flame turns yellow when today's tokens pass the daily budget.")
      : L("The tray flame turns yellow when today's cost passes the daily budget.")

  return (
    <Group title={L('Alerts')}>
      <Row
        label={L('Daily budget')}
        control={
          <Select
            ariaLabel={L('Daily budget')}
            value={custom ? CUSTOM : stored ?? 0}
            options={[
              ...presets.map(value => ({ id: value, label: label(value) })),
              { id: CUSTOM, label: L('Custom…') },
            ]}
            onChange={choose}
          />
        }
      />
      {custom && (
        <Row
          label={isTokens ? L('Millions of tokens') : Lf('Amount in %@', currency.code)}
          control={
            <Field
              ariaLabel={L('Custom daily budget')}
              placeholder={L('Amount')}
              value={draft}
              onChange={applyDraft}
              width={110}
            />
          }
        />
      )}
      <Note>{help}</Note>
    </Group>
  )
}

function trim(value: number): string {
  return value === Math.round(value) ? String(Math.round(value)) : String(value)
}
