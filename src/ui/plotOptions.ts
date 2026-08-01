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
  crosshair: true,
  dividers: false,
  labels: false,
}

export type PlotOptionKey = keyof PlotOptions

/** Label and one-line explanation, shared by the view card and the palette. */
export const PLOT_OPTION_LABELS: Record<PlotOptionKey, { label: string; hint: string }> = {
  crosshair: { label: 'crosshair', hint: 'Guide lines through the cell under the pointer.' },
  dividers: { label: 'dividers', hint: 'Contig and genome boundaries, as `metacooler show` draws them.' },
  labels: { label: 'labels', hint: 'Block names in the gutters. Off gives the gutters back to the plot.' },
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
    return { crosshair: pick('crosshair'), dividers: pick('dividers'), labels: pick('labels') }
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
