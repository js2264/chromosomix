/**
 * Every control a figure has, as the column that sits beside it.
 *
 * Built from a spec and a style and nothing else: the controls read the style,
 * write a new one, and hand it back — they never touch the chart, and they hold
 * no state of their own. That is what lets the same column serve the figure in
 * the drawer and the same figure enlarged in a dialog, and what makes the
 * picture, the exported PNG and the exported PDF unable to disagree about what
 * the reader has set.
 *
 * The cards, and why they are the cards they are:
 *
 * - **Chart** — what the marks look like. The one control a reader reaches for
 *   first is the *mark*, because it is the difference between a line through
 *   points that have no order and a scatter of them.
 * - **Axes** — scale, window, names, grid. The window is here as numbers as
 *   well as under the pointer, because "from 10 kb to 1 Mb" is a thing a reader
 *   knows and a thing a wheel cannot be asked for precisely.
 * - **Series** — one row each: shown, colour, name. A figure of four thousand
 *   sequences would be four thousand rows, so the list is capped and says so.
 * - **Text** — the title, the type size, where the legend goes.
 * - **Colour** (a matrix) and **Rows** (a table) replace the first three where
 *   the figure is not a chart of series. Not Colour on a dot plot, whose lines
 *   are red and blue whatever it would say (§28.2): Text is its one card.
 *
 * Laid out with the same `settingsField` rows and `controls-card` heads as the
 * annotation cards and the 3D model's settings, because they are the same kind
 * of thing and a reader who has learned one has learned all of them.
 */

import { button, el, trimNumber } from '../ui/dom'
import { cardTitle, iconButton } from '../ui/icons'
import { settingsField } from '../ui/laneSettings'
import { COLORMAP_NAMES } from '../render/colormaps'
import { drawnAsChart } from './matrixOption'
import { figureFit, seriesColour, type FigureTheme } from './option'
import { histogram } from './stats'
import {
  DISTRIBUTION_MARKS,
  XY_MARKS,
  numberedColumns,
  numericColumns,
  type FigureSpec,
  type MarkKind,
  type TableFigureSpec,
  type XyFigureSpec,
  xyOfTable,
} from './spec'
import type { FigureStyle, LegendPlace } from './style'

/** Past this many series the list is a wall rather than a control. */
const SERIES_ROWS = 24

export interface FigureSettingsProps {
  spec: FigureSpec
  /** The style as it stands; read fresh on every rebuild. */
  style: () => FigureStyle
  /** A control moved. The caller applies it, stores it, and rebuilds. */
  onChange: (style: FigureStyle) => void
  /** Back to the picture the task returned. */
  onReset: () => void
  theme: () => FigureTheme
  /** The buttons that take the figure out of the application. */
  exports?: HTMLElement[]
}

export interface FigureSettings {
  el: HTMLElement
  /** Rebuild the controls from the style as it now stands. */
  refresh(): void
}

export function figureSettings(props: FigureSettingsProps): FigureSettings {
  const host = el('div', { class: 'controls-card figure-settings' })

  const set = (patch: Partial<FigureStyle>): void => {
    props.onChange({ ...props.style(), ...patch })
  }

  const refresh = (): void => {
    const style = props.style()
    const cards: HTMLElement[] =
      props.spec.kind === 'xy'
        ? [
            chartCard(props.spec, style, set),
            axesCard(props.spec, style, set),
            seriesCard(props.spec, style, set, props.theme()),
            textCard(style, set),
          ]
        : props.spec.kind === 'matrix'
          ? // A dot plot's figure is its streaks, red and blue whatever a
            // colormap says (§28.2): a Colour card beside it changed nothing on
            // screen, and the rebuild its every pick asked for threw the zoom away.
            // A matrix the painter draws — a list's heatmap, a picture past
            // the chart's ceiling — has no readout under the pointer, so it
            // is offered no switch for one (§8.5).
            props.spec.output.streaks !== undefined
            ? [textCard(style, set, drawnAsChart(props.spec.output))]
            : [colourCard(style, set), textCard(style, set, drawnAsChart(props.spec.output))]
          : [rowsCard(props.spec, style, set), ...scatterAxes(props.spec, style, set), textCard(style, set)]

    host.replaceChildren(
      cardTitle('Figure', 'chart-line', 'controls-title'),
      el(
        'div',
        { class: 'panel-controls' },
        ...cards,
        el(
          'div',
          { class: 'figure-actions' },
          button('reset', () => props.onReset(), {
            class: 'btn btn-quiet',
            title: 'Back to the figure the task returned, and forget what was set here',
          }),
          ...(props.exports ?? []),
        ),
      ),
    )
  }

  refresh()
  return { el: host, refresh }
}

// ---------------------------------------------------------------------------
// The small controls
// ---------------------------------------------------------------------------

type Apply = (patch: Partial<FigureStyle>) => void

function group(label: string, ...rows: Array<HTMLElement | false>): HTMLElement {
  return el(
    'div',
    { class: 'figure-group' },
    el('h4', { class: 'figure-group-head', text: label }),
    ...rows.filter((row): row is HTMLElement => row !== false),
  )
}

function choice<T extends string>(
  values: readonly T[],
  current: T,
  onPick: (value: T) => void,
  titles?: Partial<Record<T, string>>,
): HTMLSelectElement {
  const select = el('select', { class: 'select' })
  for (const value of values) {
    const option = el('option', { value, text: value })
    const hint = titles?.[value]
    if (hint !== undefined) option.title = hint
    select.appendChild(option)
  }
  select.value = current
  select.addEventListener('change', () => onPick(select.value as T))
  return select
}

/**
 * A boolean, as the same `on`/`off` button the parameter form and the lane
 * settings use.
 *
 * It was a `<input type=checkbox>`, and that made **three** shapes for one
 * question inside one drawer: the form's bordered word button, this tick box,
 * and the strip's lit `log x`. A reader had to learn which of three meant a
 * switch. Two survive, and each has a job §26.6 can state: a *named parameter*
 * is a label and a control, like every other row of a settings column; a
 * *compact set of named things* — the axis scales, the table's columns, the
 * overlay marks — is a row of buttons each carrying its own name and lighting
 * when it is on ({@link markToggle}). A tick box was neither, and it was eleven
 * pixels of signal in a column of words.
 */
function toggle(label: string, on: boolean, onPick: (next: boolean) => void, hint: string): HTMLElement {
  const labelId = `figure-toggle-${(toggles += 1)}`
  const node = button(on ? 'on' : 'off', () => onPick(!on), {
    class: 'btn btn-toggle',
    title: hint,
  })
  node.setAttribute('aria-pressed', String(on))
  // `aria-labelledby` and not an `aria-label`: the button's visible text is
  // `on`, and the word beside it is its name — a `<label for>` cannot name a
  // button, so the row is a div and the word carries the id.
  node.setAttribute('aria-labelledby', labelId)
  return el(
    'div',
    { class: 'field ann-field figure-check' },
    el('span', { class: 'field-label', text: label, id: labelId, title: hint }),
    node,
  )
}

/** One of a compact set, as a button carrying its own name (see {@link toggle}). */
function markToggle(label: string, on: boolean, onPick: (next: boolean) => void, hint: string): HTMLElement {
  const node = button(label, () => onPick(!on), { class: 'btn btn-toggle', title: hint })
  node.setAttribute('aria-pressed', String(on))
  return node
}

/** Ids for the words that name the buttons above; one form, one counter. */
let toggles = 0

/**
 * A number box that means "leave it alone" when it is empty.
 *
 * Empty is `null`, which is the difference between *fit the data* and *pin it
 * to zero* — and a control that could only say a number would have no way to
 * ask for the first.
 */
function numberBox(
  value: number | null,
  onSet: (next: number | null) => void,
  hint: string,
  step?: number,
): HTMLInputElement {
  const box = el('input', {
    class: 'input input-num',
    type: 'number',
    title: hint,
    placeholder: 'auto',
  }) as HTMLInputElement
  box.value = value === null ? '' : trimNumber(value, 6)
  if (step !== undefined) box.step = String(step)
  const commit = (): void => {
    const text = box.value.trim()
    if (text === '') {
      onSet(null)
      return
    }
    const next = Number(text)
    onSet(Number.isFinite(next) ? next : null)
  }
  box.addEventListener('change', commit)
  return box
}

function textBox(value: string, onSet: (next: string) => void, hint: string, placeholder: string): HTMLInputElement {
  const box = el('input', { class: 'input', type: 'text', title: hint, placeholder }) as HTMLInputElement
  box.value = value
  box.addEventListener('change', () => onSet(box.value))
  return box
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

const MARK_HINTS: Partial<Record<MarkKind, string>> = {
  line: 'Joined samples — a claim that something is between them',
  area: 'A line with the space under it filled',
  step: 'Held between samples, for a quantity that changes at them',
  points: 'One mark per sample and nothing between, for an x that is not an ordering',
  bars: 'One bar per sample',
  histogram: 'The y values counted into bins; x is ignored',
  box: 'Quartiles and Tukey whiskers per series; x is ignored',
  violin: 'A kernel density per series, every violin to one scale; x is ignored',
}

function chartCard(spec: XyFigureSpec, style: FigureStyle, set: Apply): HTMLElement {
  const marks: readonly MarkKind[] = [...XY_MARKS, ...DISTRIBUTION_MARKS]
  const banded = spec.series.some((series) => series.low !== undefined)
  const line = style.mark === 'line' || style.mark === 'area' || style.mark === 'step'
  return group(
    'chart',
    settingsField('mark', choice(marks, style.mark, (mark) => set({ mark }), MARK_HINTS)),
    line &&
      settingsField(
        'line width',
        numberBox(style.lineWidth, (value) => set({ lineWidth: value ?? 1.8 }), 'In CSS pixels', 0.25),
      ),
    (style.mark === 'points' || style.jitter || style.mark === 'box') &&
      settingsField(
        'point size',
        numberBox(style.pointSize, (value) => set({ pointSize: value ?? 6 }), 'In CSS pixels', 1),
      ),
    line && toggle('smooth', style.smooth, (smooth) => set({ smooth }), 'A curve through the samples rather than straight segments — a claim about what is between them'),
    line && toggle('fill under', style.fillArea, (fillArea) => set({ fillArea }), 'Shade the space between the line and the axis'),
    banded && toggle('band', style.bands, (bands) => set({ bands }), 'The spread the task computed, drawn around each line'),
    style.mark === 'histogram' &&
      settingsField(
        'bins',
        numberBox(style.bins === 0 ? null : style.bins, (value) => set({ bins: value === null ? 0 : Math.round(value) }), 'Empty chooses the width from the data (Freedman–Diaconis)', 1),
      ),
    (style.mark === 'box' || style.mark === 'violin') &&
      toggle('points', style.jitter, (jitter) => set({ jitter }), 'Every observation beside the summary, so a summary of six points does not read like one of six thousand'),
  )
}

/**
 * The data's own end of an axis, over the series that are drawn.
 *
 * Read off the axes as drawn: where the axis is fitted (`option.figureFit`),
 * the end of the fit — the end the picture had on that side, room and all, so
 * typing the other end moves only that one; and where the library fits it, a
 * histogram's abscissa is the series' values, from its first bin's edge to its
 * last, and its ordinate the counts.
 */
function dataEnd(spec: XyFigureSpec, style: FigureStyle, which: 'x' | 'y', at: 0 | 1): number | null {
  const fit = figureFit(spec, style, which)
  if (fit !== null) return fit[at]
  const log = style[which].scale === 'log'
  const histo = style.mark === 'histogram'
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const series of spec.series) {
    if (style.hidden.includes(series.id)) continue
    const bins = histo ? histogram(series.y, style.bins) : null
    const values =
      bins !== null
        ? which === 'x'
          ? bins.edges
          : [0, ...bins.counts]
        : which === 'x'
          ? series.y.map((_, i) => series.x[i] ?? i)
          : series.y
    for (const value of values) {
      if (!Number.isFinite(value) || (log && value <= 0)) continue
      if (value < low) low = value
      if (value > high) high = value
    }
  }
  if (low > high) return null
  return at === 0 ? low : high
}

function axisRows(
  which: 'x' | 'y',
  spec: XyFigureSpec,
  style: FigureStyle,
  set: Apply,
): HTMLElement[] {
  const axis = style[which]
  const patch = (next: Partial<FigureStyle['x']>): void => set({ [which]: { ...axis, ...next } } as Partial<FigureStyle>)
  const domain = axis.domain
  const edge = (at: 0 | 1): HTMLInputElement =>
    numberBox(
      domain === null ? null : domain[at],
      (value) => {
        if (value === null) {
          patch({ domain: null })
          return
        }
        // An axis on *auto* has no window yet, so the end not typed is the
        // data's own on that side: one end typed is a window, where it used to
        // wait for the other and keep the number in its box without drawing it.
        const other = domain === null ? dataEnd(spec, style, which, at === 0 ? 1 : 0) : domain[at === 0 ? 1 : 0]
        if (other === null) return
        const pair: [number, number] = at === 0 ? [value, other] : [other, value]
        patch({ domain: pair[0] < pair[1] ? pair : null })
      },
      at === 0 ? 'The low end of the window; empty fits the data' : 'The high end of the window; empty fits the data',
    )
  return [
    settingsField(
      `${which} scale`,
      choice(['linear', 'log'] as const, axis.scale, (scale) => patch({ scale }), {
        log: 'A log axis has no place for a zero: values at or below it become gaps',
      }),
    ),
    settingsField(
      `${which} name`,
      textBox(axis.label ?? '', (label) => patch({ label: label === '' ? null : label }), 'What the axis is called; empty is the task’s own name', which === 'x' ? spec.xLabel : spec.yLabel),
    ),
    // `to` is a label too, and wears the class: bare, it sat in the label column
    // under `x from` at the body's size rather than the labels', the one word in
    // the card set larger than its neighbours.
    el('div', { class: 'field ann-field figure-range' }, el('span', { class: 'field-label', text: `${which} from` }), edge(0), el('span', { class: 'field-label', text: 'to' }), edge(1)),
    toggle(`${which} grid`, axis.grid, (grid) => patch({ grid }), 'Rules across the plot at the ticks'),
  ]
}

/**
 * A table drawn as a scatter has a curve's axes card, read off the scatter it
 * becomes: the names its columns give — `number in Map` — as the placeholders a
 * reader replaces with what the axes are, its scales and its windows.
 */
function scatterAxes(spec: TableFigureSpec, style: FigureStyle, set: Apply): HTMLElement[] {
  const plot = style.plot
  if (plot === null || plot.x === null) return []
  return [axesCard(xyOfTable(spec, plot.x, plot.y, plot.mark, plot.fit, style.x.domain), style, set)]
}

function axesCard(spec: XyFigureSpec, style: FigureStyle, set: Apply): HTMLElement {
  return group(
    'axes',
    ...axisRows('x', spec, style, set),
    ...axisRows('y', spec, style, set),
    el(
      'div',
      { class: 'figure-actions' },
      button('fit', () => set({ x: { ...style.x, domain: null }, y: { ...style.y, domain: null } }), {
        class: 'btn btn-quiet',
        title: 'Both axes back to the whole of the data',
      }),
    ),
  )
}

/**
 * One row per series: shown, colour, name.
 *
 * The colour input is a swatch rather than a text box because a colour is a
 * thing you point at. Its value is always the *resolved* colour — what the
 * reader set, or what the task said, or the palette — so the swatch shows what
 * is on the picture rather than an empty box meaning "whatever".
 */
function seriesCard(
  spec: XyFigureSpec,
  style: FigureStyle,
  set: Apply,
  theme: FigureTheme,
): HTMLElement {
  const rows = spec.series.slice(0, SERIES_ROWS).map((series, index) => {
    const hidden = style.hidden.includes(series.id)
    const eye = iconButton(
      hidden ? 'eye-off' : 'eye',
      hidden ? `Show ${series.name}` : `Hide ${series.name}`,
      () =>
        set({
          hidden: hidden
            ? style.hidden.filter((id) => id !== series.id)
            : [...style.hidden, series.id],
        }),
      { class: 'btn btn-icon btn-toggle ann-eye', size: 13 },
    )
    eye.setAttribute('aria-pressed', String(!hidden))
    const swatch = el('input', { class: 'figure-swatch', type: 'color' }) as HTMLInputElement
    swatch.value = hex(seriesColour(series, index, style, theme))
    swatch.title = `The colour of ${series.name}`
    swatch.addEventListener('change', () =>
      set({ colours: { ...style.colours, [series.id]: swatch.value } }),
    )
    return el(
      'div',
      { class: 'figure-series-row' },
      eye,
      swatch,
      el('span', { class: 'figure-series-name', text: series.name, title: series.name }),
      series.n === undefined || !Number.isFinite(series.n)
        ? el('span')
        : el('span', { class: 'figure-series-n', text: `n = ${series.n}` }),
    )
  })
  const over = spec.series.length - rows.length
  return group(
    'series',
    el('div', { class: 'figure-series' }, ...rows),
    over > 0 &&
      el('p', {
        class: 'hint',
        text: `…and ${over} more, all of them drawn. Only the first ${SERIES_ROWS} are listed.`,
      }),
    el(
      'div',
      { class: 'figure-actions' },
      button('show all', () => set({ hidden: [] }), {
        class: 'btn btn-quiet',
        title: 'Every series back on the picture',
      }),
      // *reset colours*, not *Colours*: a noun on a button says what the
      // button is about rather than what pressing it does, and this one throws
      // away every swatch the reader has set.
      button('reset colours', () => set({ colours: {} }), {
        class: 'btn btn-quiet',
        title: 'Back to the task’s own colours and the palette',
      }),
    ),
  )
}

const PLACES: readonly LegendPlace[] = ['right', 'top', 'bottom', 'none']

function textCard(style: FigureStyle, set: Apply, readout = true): HTMLElement {
  return group(
    'text',
    settingsField(
      'title',
      textBox(style.title ?? '', (title) => set({ title: title === '' ? null : title }), 'Printed on the figure itself, so it survives the export; empty is no title', 'none'),
    ),
    settingsField(
      'type size',
      numberBox(style.fontSize, (value) => set({ fontSize: value ?? 11 }), 'In CSS pixels, for every word on the figure', 1),
    ),
    settingsField('legend', choice(PLACES, style.legend, (legend) => set({ legend }))),
    ...(readout
      ? [toggle('tooltip', style.tooltip, (tooltip) => set({ tooltip }), 'The readout that follows the pointer')]
      : []),
  )
}

function colourCard(style: FigureStyle, set: Apply): HTMLElement {
  const names = ['auto', ...COLORMAP_NAMES]
  return group(
    'colour',
    settingsField(
      'colormap',
      choice(names, style.colormap ?? 'auto', (name) => set({ colormap: name === 'auto' ? null : name })),
    ),
    el(
      'div',
      { class: 'field ann-field figure-range' },
      el('span', { class: 'field-label', text: 'scale' }),
      numberBox(style.vmin, (vmin) => set({ vmin }), 'The value the lowest colour means; empty fits the data'),
      el('span', { class: 'field-label', text: 'to' }),
      numberBox(style.vmax, (vmax) => set({ vmax }), 'The value the highest colour means; empty fits the data'),
    ),
  )
}

/**
 * A table's own controls, and the one that turns it into a chart.
 *
 * `plot` is here rather than in the Chart card because for a table it is a
 * question about the *columns*: which one is the abscissa and which the
 * ordinate is the whole of what makes a table a picture.
 */
function rowsCard(spec: TableFigureSpec, style: FigureStyle, set: Apply): HTMLElement {
  const numbers = numericColumns(spec)
  // An abscissa may be a column of names that carry numbers — a time course's
  // maps — read at the number in each; an ordinate is always measured.
  const abscissae = [...numbers, ...numberedColumns(spec)]
  const plot = style.plot
  const keys = spec.columns.map((column) => column.key)
  const shown = style.columns ?? keys
  return group(
    'rows',
    settingsField(
      'filter',
      textBox(style.filter, (filter) => set({ filter }), 'Rows whose text contains this, anywhere', 'every row'),
    ),
    settingsField(
      'sort by',
      choice(['—', ...keys], style.sortKey ?? '—', (key) => set({ sortKey: key === '—' ? null : key })),
    ),
    style.sortKey !== null &&
      toggle('descending', style.sortDown, (sortDown) => set({ sortDown }), 'Largest or last first'),
    el(
      'div',
      { class: 'figure-columns' },
      ...spec.columns.map((column) => {
        const on = shown.includes(column.key)
        return markToggle(
          column.label,
          on,
          (next) =>
            set({
              columns: next
                ? keys.filter((key) => shown.includes(key) || key === column.key)
                : shown.filter((key) => key !== column.key),
            }),
          column.hint ?? `Show the ${column.label} column`,
        )
      }),
    ),
    numbers.length > 0 &&
      settingsField(
        'plot',
        choice(
          ['table', ...numbers.map((column) => column.key)],
          plot === null ? 'table' : plot.y,
          (key) =>
            set({
              plot:
                key === 'table'
                  ? null
                  : { x: plot?.x ?? null, y: key, mark: plot?.mark ?? 'histogram', fit: plot?.fit ?? false },
            }),
        ),
        'A column drawn instead of the rows: its distribution on its own, or against another column',
      ),
    plot !== null &&
      settingsField(
        'against',
        choice(
          ['—', ...abscissae.map((column) => column.key)],
          plot.x ?? '—',
          (key) =>
            set({
              plot: {
                ...plot,
                x: key === '—' ? null : key,
                mark: key === '—' ? 'histogram' : 'points',
              },
            }),
        ),
        'The abscissa; on its own the column is drawn as a distribution. A column of names is ' +
          'read at the first number in each, and a row whose name has none is left out',
      ),
    plot !== null &&
      plot.x !== null &&
      toggle(
        'least squares',
        plot.fit,
        (fit) => set({ plot: { ...plot, fit } }),
        'The straight line fitted through the points, its equation, r² and n in the legend',
      ),
    plot !== null &&
      settingsField(
        'as',
        choice(
          plot.x === null ? DISTRIBUTION_MARKS : XY_MARKS,
          plot.mark,
          (mark) => set({ plot: { ...plot, mark } }),
          MARK_HINTS,
        ),
      ),
  )
}

/**
 * A CSS colour as the six digits a `<input type="color">` will accept.
 *
 * Anything it would refuse comes back black, which is a visible wrong answer
 * rather than a swatch that silently shows the last colour it held.
 */
function hex(colour: string): string {
  const value = colour.trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const long = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(value)
  if (long !== null) return `#${long[1]}`
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (rgb !== null) {
    const parts = rgb[1].split(/[,/\s]+/).filter((piece) => piece !== '')
    const byte = (at: number): string => {
      const number = Math.round(Number.parseFloat(parts[at] ?? '0'))
      const clamped = Number.isFinite(number) ? Math.max(0, Math.min(255, number)) : 0
      return clamped.toString(16).padStart(2, '0')
    }
    return `#${byte(0)}${byte(1)}${byte(2)}`
  }
  return '#000000'
}
