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
import { devFeature } from '../state/devFeatures'
import type { IconName } from './icons'

/**
 * A new key, not a migration of the old one.
 *
 * The defaults below changed after the first build shipped, and a stored value
 * beats a default by design — so everyone who had already used the app would
 * have kept the old overlays and concluded the change did not land. Renaming
 * the key hands the new defaults to everybody exactly once, and costs a user
 * who had customised them one re-toggle.
 *
 * Bumped a second time when `outline` came on. The trade is the same one, made
 * the same way: a default that only reaches people who have never opened the app
 * is not a default, it is a decision about new users.
 */
const KEY = 'metacooler-viewer:overlays2'

/**
 * The app's defaults, deliberately not the renderer's.
 *
 * `render/heatmap.ts` defaults to `metacooler show` — dividers and labels on —
 * because that is the right default for a *figure*. On screen the crosshair is
 * what answers "which contig is this", continuously and without a click, while
 * dividers and labels on a 20 k-contig map are ink over data. Both defaults are
 * right for their own caller; neither is a copy of the other.
 *
 * `outline` is on. A filled track with no rule over it is a silhouette, and a
 * silhouette read against another silhouette in the lane below is two blocks of
 * ink with a boundary somewhere in the middle; the hairline is what makes each
 * of them a *shape* — it is where the values actually are, and the fill under it
 * is only shading. It was off because it is one more mark, which is the wrong
 * trade for the one mark that carries the data.
 */
export const DEFAULT_UI_PLOT_OPTIONS: PlotOptions = {
  text: true,
  fills: true,
  baseline: true,
  outline: true,
  gutter: false,
  crosshair: true,
  tooltip: true,
  dividers: false,
  breaks: true,
  labels: false,
  ticks: true,
  legend: true,
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
export const TRACK_OPTIONS: readonly PlotOptionKey[] = [
  'text',
  'fills',
  'outline',
  'baseline',
  'crosshair',
  'tooltip',
]
/**
 * The crosshair and the hover card are in **both** lists, because each is
 * genuinely about both pictures.
 *
 * The guide lines are drawn through the cell under the pointer on the matrix
 * *and* through the position under it in every lane, because they are one
 * pointer over one picture; the card is the same instrument. Offering them only
 * under `tracks` put them in the card about the lanes, where a reader looking
 * at the matrix could not find the control for the lines drawn across the
 * matrix — and putting them only under `matrix` would do the same to the reader
 * in the 1D browser, which has no Map card at all.
 *
 * Being in both lists is not being offered twice, and that is what
 * {@link TRACK_ONLY_OPTIONS} is for: a column with a Map card offers them there
 * and the Tracks card below it leaves them out.
 */
export const MATRIX_OPTIONS: readonly PlotOptionKey[] = [
  'dividers',
  'breaks',
  'labels',
  'ticks',
  'legend',
  'crosshair',
  'tooltip',
]

/**
 * What the **3D structure** reads (§25.3).
 *
 * A third list beside the two above, and here rather than in the cell that
 * reads them, because *which picture each preference is about* is one question
 * and this file is where it is answered. A control added to the store later is
 * assigned to its pictures in one place; a hardcoded copy in the structure
 * panel is a list that silently stops being the answer the day a fourth
 * preference is one the model honours.
 *
 * Exactly the three the renderer asks for: the key in the corner, the lines
 * and halo through what the pointer is on, and the card that follows it. The
 * rest are about a track's ink or a matrix's gutters, and a toggle that does
 * nothing to the picture it was pressed beside is worse than no toggle.
 */
export const STRUCTURE_OPTIONS: readonly PlotOptionKey[] = ['legend', 'crosshair', 'tooltip']

/**
 * What a Tracks card offers when a **Map card is above it**.
 *
 * Beside a map the two shared preferences appeared in both rows of one column,
 * ten lines apart and lit together — which reads as two settings, so a reader
 * turned one off, saw the other go dark, and was left wondering what else was
 * coupled. §5.8's rule about a second way to do a thing applies with force when
 * both ways are on screen at once: each control is offered once per column, in
 * the card about the picture it is mostly about. The 1D browser has no Map
 * card, so its Tracks card still offers {@link TRACK_OPTIONS} whole.
 */
export const TRACK_ONLY_OPTIONS: readonly PlotOptionKey[] = TRACK_OPTIONS.filter(
  (key) => !MATRIX_OPTIONS.includes(key),
)

/**
 * The mark each option is drawn as, shared by both Tracks cards.
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
  outline: 'chart-spline',
  baseline: 'align-end-horizontal',
  gutter: 'align-right',
  crosshair: 'crosshair',
  tooltip: 'message-square-text',
  dividers: 'grid-2x2',
  breaks: 'separator-vertical',
  labels: 'tag',
  ticks: 'ruler',
  legend: 'list',
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
      'A rule along the bottom edge of every track lane — what tells four stacked ' +
      'coverage tracks apart from one tall one.',
  },
  fills: {
    label: 'track fill',
    hint:
      'The area under a track’s line, filled. Off leaves the line alone, which is what ' +
      'several tracks in one lane usually want.',
  },
  outline: {
    label: 'track outline',
    hint:
      'A dark rule along the top of every track and round every feature’s box, over its own ' +
      'colour — what makes four stacked areas four legible shapes rather than four blocks of ink.',
  },
  gutter: {
    label: 'name column',
    // One line, because this string is a palette hint as well as a tooltip:
    // the paragraph that was here — how to drag the edge, what a long name
    // does, what a double click hands back — filled four lines of the palette
    // and pushed the commands under it off the list. The gestures are on the
    // edge itself, where a hand that is already there finds them.
    hint: 'Start the tracks after the widest name, right-aligned in the column that leaves.',
  },
  crosshair: { label: 'crosshair', hint: 'Guide lines through the cell under the pointer.' },
  tooltip: {
    label: 'tooltip',
    hint:
      'The card that follows the pointer, naming the cell and what every track is worth there. ' +
      'Off, the same reading stays in the status line under the window — where it covers none ' +
      'of the picture, which is what somebody framing a figure wants.',
  },
  dividers: {
    label: 'dividers',
    // Genomes, and the command line that draws them, are the multi-genome
    // format's — a dev feature (§29).
    hint: devFeature('metacool')
      ? 'Contig and genome boundaries, as the metacooler show command draws them.'
      : 'Sequence boundaries, drawn as lines across the map.',
  },
  breaks: {
    label: 'breaks',
    hint: 'The same boundaries as ticks outside the plot, where they cost no data.',
  },
  labels: { label: 'labels', hint: 'Block names in the gutters. Off gives the gutters back to the plot.' },
  ticks: {
    label: 'ticks',
    hint: 'Base-pair coordinates along the axes, inside a block that has a single contig.',
  },
  legend: {
    label: 'legend',
    hint:
      'The key in the corner of the map — what the cells hold, the bin size and the two ends ' +
      'of the colour scale. Off leaves the picture alone, which is what a figure with its own ' +
      'caption wants; the exported caption still states the range.',
  },
}

/**
 * The key that toggles each overlay, where it has one.
 *
 * Here rather than in the command list, beside the label and the mark, because
 * three surfaces need it and only one of them is the command list: the two Plot
 * cards print it in the toggle's tooltip, which is where anybody actually finds
 * a shortcut, and `App.commands` binds it. Written twice, they drift, and the
 * one that drifts is always the tooltip — nothing fails when it is wrong.
 *
 * **`fills` has `f` back.** It gave the letter to the Files panel when a fifth
 * panel arrived and the single-letter space was down to `q` and `z`; the panels
 * have since moved to the digit row, in the order they stand
 * (`ui/SidePanel.ts`), and the letter came home. **`breaks` is `m`**, for the
 * margin they are drawn in: `e` went to the O/E toggle (`KEYS.expected`), whose
 * letter it is.
 *
 * **`legend` has no key**, so a missing entry is a real state and every reader
 * of this table handles it: the tooltip prints the label alone, and
 * `App.commands` registers nothing.
 */
export const PLOT_OPTION_KEYS: Partial<Record<PlotOptionKey, string>> = {
  text: 'n',
  fills: 'f',
  outline: 'i',
  baseline: 'r',
  gutter: 'u',
  crosshair: 'x',
  tooltip: 'p',
  dividers: 'd',
  breaks: 'm',
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
      outline: pick('outline'),
      baseline: pick('baseline'),
      gutter: pick('gutter'),
      crosshair: pick('crosshair'),
      tooltip: pick('tooltip'),
      dividers: pick('dividers'),
      breaks: pick('breaks'),
      labels: pick('labels'),
      ticks: pick('ticks'),
      legend: pick('legend'),
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
