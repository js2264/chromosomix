/**
 * The overlay preference, shared by every heatmap on screen.
 *
 * It lives here rather than in `MatrixPanel` for two reasons. The panel is
 * rebuilt on every navigation, so an instance field would lose the choice on
 * the first click; and the command palette can toggle an overlay while a panel
 * is mounted, which needs a way to reach it that is not a DOM lookup. A tiny
 * store with subscribers answers both.
 *
 * `localStorage`, not the URL hash: §5.5 shares *what is being looked at*, and
 * whether the recipient likes guide lines is not that.
 */

import type { PlotOptions } from '../render/heatmap'
import type { IconName } from './icons'

/**
 * A new key, not a migration of the old one.
 *
 * The defaults below changed after the first build shipped, and a stored value
 * beats a default by design — so everyone who had already used the app would
 * have kept the old overlays and concluded the change did not land. Renaming
 * the key hands the new defaults to everybody exactly once, and costs a user
 * who had customised them one re-toggle.
 */
const KEY = 'metacooler-viewer:overlays'

/**
 * The app's defaults, deliberately not the renderer's.
 *
 * `render/heatmap.ts` defaults to `metacooler show` — dividers and labels on —
 * because that is the right default for a *figure*. On screen the crosshair is
 * what answers "which contig is this", continuously and without a click, while
 * dividers and labels on a 20 k-contig map are ink over data. Both defaults are
 * right for their own caller; neither is a copy of the other.
 */
export const DEFAULT_UI_PLOT_OPTIONS: PlotOptions = {
  text: true,
  fills: true,
  baseline: true,
  gutter: false,
  crosshair: true,
  dividers: false,
  breaks: true,
  labels: false,
  ticks: true,
}

export type PlotOptionKey = keyof PlotOptions

/**
 * Which picture each option is about.
 *
 * The store is one store on purpose — a reader who turns the crosshair off
 * beside a map means it off, and finding it back on in the browser is the app
 * disagreeing with itself — but a single undifferentiated row of eight toggles
 * beside a map is a row in which half the entries do nothing to the thing being
 * looked at. So they are stored together and *offered* apart.
 */
export const TRACK_OPTIONS: readonly PlotOptionKey[] = ['text', 'fills', 'baseline', 'crosshair']
export const MATRIX_OPTIONS: readonly PlotOptionKey[] = ['dividers', 'breaks', 'labels', 'ticks']

/**
 * The mark each option is drawn as, shared by both Plot cards.
 *
 * One table rather than one per card: these are the same eight preferences
 * about the same two pictures, and a toggle that is a word beside a map and a
 * glyph beside a browser is two controls as far as a reader is concerned. The
 * words survive in every tooltip, which is where {@link PLOT_OPTION_LABELS}
 * goes.
 */
export const PLOT_OPTION_ICONS: Record<PlotOptionKey, IconName> = {
  text: 'type',
  fills: 'chart-area',
  baseline: 'align-end-horizontal',
  gutter: 'align-right',
  crosshair: 'crosshair',
  dividers: 'grid-2x2',
  breaks: 'separator-vertical',
  labels: 'tag',
  ticks: 'ruler',
}

/** Label and one-line explanation, shared by the view card and the palette. */
export const PLOT_OPTION_LABELS: Record<PlotOptionKey, { label: string; hint: string }> = {
  text: {
    label: 'track text',
    hint: 'Track names, their value ranges and feature names. Off leaves the ink only.',
  },
  baseline: {
    label: 'track floor',
    hint:
      'A rule along the bottom edge of every track lane. What tells four stacked ' +
      'coverage tracks apart from one tall one.',
  },
  fills: {
    label: 'track fill',
    hint:
      'The area under a track’s line, filled. Off leaves the line alone, which is what ' +
      'several tracks in one lane usually want.',
  },
  gutter: {
    label: 'name column',
    hint:
      'Start the tracks after the widest track name, with the names right-aligned in the ' +
      'column that leaves. Off, a name is drawn over the data it belongs to.',
  },
  crosshair: { label: 'crosshair', hint: 'Guide lines through the cell under the pointer.' },
  dividers: { label: 'dividers', hint: 'Contig and genome boundaries, as `metacooler show` draws them.' },
  breaks: {
    label: 'breaks',
    hint: 'The same boundaries as ticks outside the plot, where they cost no data.',
  },
  labels: { label: 'labels', hint: 'Block names in the gutters. Off gives the gutters back to the plot.' },
  ticks: {
    label: 'ticks',
    hint: 'Base-pair coordinates along the axes, inside a block that has a single contig.',
  },
}

/**
 * The key that toggles each overlay.
 *
 * Here rather than in the command list, beside the label and the mark, because
 * three surfaces need it and only one of them is the command list: the two Plot
 * cards print it in the toggle's tooltip, which is where anybody actually finds
 * a shortcut, and `App.commands` binds it. Written twice, they drift, and the
 * one that drifts is always the tooltip — nothing fails when it is wrong.
 */
export const PLOT_OPTION_KEYS: Record<PlotOptionKey, string> = {
  text: 'n',
  fills: 'f',
  baseline: 'r',
  gutter: 'u',
  crosshair: 'x',
  dividers: 'd',
  breaks: 'e',
  labels: 'l',
  ticks: 'k',
}

let current: PlotOptions | null = null
const listeners = new Set<(options: PlotOptions) => void>()

/** Stored state outlives the code that wrote it, so every field is checked. */
function read(): PlotOptions {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return { ...DEFAULT_UI_PLOT_OPTIONS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_UI_PLOT_OPTIONS }
    const record = parsed as Record<string, unknown>
    const pick = (key: PlotOptionKey): boolean =>
      typeof record[key] === 'boolean' ? (record[key] as boolean) : DEFAULT_UI_PLOT_OPTIONS[key]
    return {
      text: pick('text'),
      fills: pick('fills'),
      baseline: pick('baseline'),
      gutter: pick('gutter'),
      crosshair: pick('crosshair'),
      dividers: pick('dividers'),
      breaks: pick('breaks'),
      labels: pick('labels'),
      ticks: pick('ticks'),
    }
  } catch {
    return { ...DEFAULT_UI_PLOT_OPTIONS }
  }
}

function write(options: PlotOptions): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(options))
  } catch {
    /* a browser that refuses storage still honours the toggle for this session */
  }
}

/** The overlays in force, as a copy. */
export function getPlotOptions(): PlotOptions {
  current ??= read()
  return { ...current }
}

/** Set one overlay and tell every mounted panel. */
export function setPlotOption(key: PlotOptionKey, value: boolean): void {
  const next = { ...getPlotOptions(), [key]: value }
  current = next
  write(next)
  for (const listener of listeners) listener({ ...next })
}

/**
 * Replace every option at once — what importing a session config does.
 *
 * Merged over the current values rather than assigned, so a config written by an
 * older build, which knew nothing of an option added since, leaves that option
 * alone instead of resetting it to `false` by omission.
 */
export function setPlotOptions(options: Partial<PlotOptions>): void {
  const next = { ...getPlotOptions() }
  for (const key of Object.keys(next) as PlotOptionKey[]) {
    const value = options[key]
    if (typeof value === 'boolean') next[key] = value
  }
  current = next
  write(next)
  for (const listener of listeners) listener({ ...next })
}

export function togglePlotOption(key: PlotOptionKey): boolean {
  const next = !getPlotOptions()[key]
  setPlotOption(key, next)
  return next
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribePlotOptions(listener: (options: PlotOptions) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
