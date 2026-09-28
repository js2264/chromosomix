/**
 * One figure out of several maps' results.
 *
 * §18.9 declines a *differential* APA and a *differential* insulation, and the
 * argument it gives is precise and still correct: subtracting one track from
 * another is a worse version of a picture the app can already make. **This is
 * not that.** Overlaying four libraries' P(s) curves on one axis is not a
 * subtraction, derives nothing, and is the single most-drawn figure in the Hi-C
 * literature — the one people leave a browser for. The two claims were never the
 * same and only the first was argued.
 *
 * The machinery for it was already here and unconnected. `CurveOutput` has been
 * multi-series since it was written, with a legend, per-series colours and band
 * drawing; `runAll` has computed one result per panel since the deck existed.
 * What was missing is the two sentences of code that hand the first the second's
 * output — and, before that, a result store that did not overwrite panel three
 * with panel four (`runner.ts`).
 *
 * ## What combines, and what says it does not
 *
 * A **curve** combines: the series of every map, prefixed by the map's name.
 * A **profile** combines by becoming a curve first, which is the same conversion
 * the drawer already does where there is no lane to put one in.
 *
 * A **table** combines by stacking: one table, every map's rows in the deck's
 * order, under a first column naming the map each came from. It used to stay
 * per map on the argument that four tables stacked was not a picture — but it
 * is the one form in which the numbers of a comparison can be read, sorted and
 * exported together, and a batch run over eight libraries is run *for* that
 * table: the inter-arm enrichment of every map, side by side, rather than eight
 * tabs to copy one row out of each.
 *
 * An output that **already compares every map** — a reproducibility run's lines,
 * matrix and tables ({@link CurveOutput.acrossMaps}) — is shown once, from the
 * run that compared the most maps: every map's run of it computes the same pairs,
 * and overlaying or stacking them drew each pair once per map under the name of
 * whichever map the run was about.
 *
 * A **matrix** does not combine. Four pileups are four pictures and averaging
 * them would be a fifth thing nobody asked for. The combined tab says plainly
 * which outputs are only available per map. Saying so is the feature: a tab that
 * silently held three of a task's five outputs would be read as the task having
 * three.
 */

import type { CurveOutput, CurveSeries, TableColumn, TableOutput, TaskOutput, TaskResult } from './types'

/** One map's result, with the label the tabs and the legend use. */
export interface MapResult {
  label: string
  result: TaskResult
}

export interface CombinedFigures {
  /**
   * What the all-maps tab draws, in the order the task returns its outputs: a
   * curve per output id that at least two maps drew, a table per output id any
   * map returned, and each output that already compares every map once.
   */
  outputs: TaskOutput[]
  /** Output labels that exist per map and cannot be folded into one picture. */
  perMapOnly: string[]
}

/** The key of the column a stacked table names each row's map in. */
export const MAP_COLUMN = 'map'

/**
 * Fold several maps' results into the figures that can hold all of them.
 *
 * Grouped by output **id**, not by label or by position: a task may emit its
 * outputs conditionally — an APA emits its per-feature table only when there is
 * one — so the third output of one run is not necessarily the third of another.
 * Matching by id is the only thing that cannot line the wrong two up.
 */
export function combineResults(
  results: readonly MapResult[],
  toCurve: (output: TaskOutput) => CurveOutput | null,
): CombinedFigures {
  const byId = new Map<string, Array<{ label: string; output: TaskOutput }>>()
  const order: string[] = []
  for (const entry of results) {
    for (const output of entry.result.outputs) {
      if (!byId.has(output.id)) {
        byId.set(output.id, [])
        order.push(output.id)
      }
      byId.get(output.id)?.push({ label: entry.label, output })
    }
  }

  const outputs: TaskOutput[] = []
  const perMapOnly: string[] = []
  for (const id of order) {
    const group = byId.get(id) ?? []
    if (group.some((entry) => acrossMaps(entry.output))) {
      outputs.push(widest(id, group))
      continue
    }
    const tables = group.filter(
      (entry): entry is { label: string; output: TableOutput } => entry.output.kind === 'table',
    )
    if (tables.length > 0 && tables.length === group.length) {
      outputs.push(stackTables(id, tables))
      continue
    }
    const converted = group.map((entry) => ({
      label: entry.label,
      curve: toCurve(entry.output),
      output: entry.output,
    }))
    const drawable = converted.filter(
      (entry): entry is { label: string; curve: CurveOutput; output: TaskOutput } =>
        entry.curve !== null,
    )
    if (drawable.length < 2) {
      // One map's worth is not a comparison, and a "combined" tab holding a
      // single line is the same picture as its own tab wearing a different name.
      if (group.length > 0 && drawable.length !== group.length) {
        perMapOnly.push(group[0].output.label)
      } else if (group.length > 1) {
        perMapOnly.push(group[0].output.label)
      }
      continue
    }
    outputs.push(mergeCurves(id, drawable))
  }
  return { outputs, perMapOnly }
}

/** Whether an output already compares every map; see {@link CurveOutput.acrossMaps}. */
function acrossMaps(output: TaskOutput): boolean {
  return (
    (output.kind === 'curve' || output.kind === 'matrix' || output.kind === 'table') &&
    output.acrossMaps === true
  )
}

/**
 * An output every map's run computed whole, once: from the run that compared
 * the most maps — the most lines, rows or cells a side — and the first of those
 * in the deck's order. Two maps at another bin size are left out of each other's
 * runs, so the runs of one deck need not all hold the same pairs.
 */
function widest(id: string, group: ReadonlyArray<{ label: string; output: TaskOutput }>): TaskOutput {
  const reach = (output: TaskOutput): number =>
    output.kind === 'curve'
      ? output.series.length
      : output.kind === 'matrix'
        ? output.nrows
        : output.kind === 'table'
          ? output.rows.length
          : 0
  let best = group[0].output
  for (const entry of group) {
    if (reach(entry.output) > reach(best)) best = entry.output
  }
  return { ...best, id: `${id}__all`, label: `${best.label} — all maps` }
}

/**
 * Several maps' tables as one: every map's rows, in the deck's order, under a
 * first column naming the map.
 *
 * The columns are every map's, in the order they were first met, so a task that
 * returns a column only where it has something to put in it — a haplotype, an
 * IDR threshold — loses nothing on the maps that have one; a map that has not
 * shows no value there, which the table draws as a dash.
 */
function stackTables(
  id: string,
  group: ReadonlyArray<{ label: string; output: TableOutput }>,
): TableOutput {
  const columns: TableColumn[] = []
  const seen = new Set<string>()
  for (const entry of group) {
    for (const column of entry.output.columns) {
      if (seen.has(column.key)) continue
      seen.add(column.key)
      columns.push(column)
    }
  }
  // A task's own column keyed `map` keeps its key, and the deck's is the one
  // that moves out of its way: the task's key is the stable name a script reads.
  let key = MAP_COLUMN
  while (seen.has(key)) key = `${key}_`
  const rows: Array<Record<string, string | number>> = []
  for (const entry of group) {
    for (const row of entry.output.rows) rows.push({ [key]: entry.label, ...row })
  }
  const first = group[0].output
  return {
    kind: 'table',
    id: `${id}__all`,
    label: `${first.label} — all maps`,
    columns: [
      { key, label: 'Map', kind: 'text', hint: 'The map this row was measured on, by the name the deck gives it.' },
      ...columns,
    ],
    rows,
  }
}

/**
 * Several maps' curves as one.
 *
 * The series are renamed rather than recoloured here, and the distinction
 * matters: a series that carries no colour of its own is given one **by its
 * index in the list it is drawn as part of** — `ui/analysisPlots.ts`'s
 * `resolveSeriesColours`, which the interactive figure applies to the full list
 * before anything is hidden — so leaving the colours off is what makes four maps
 * four *different* colours instead of four copies of the first task's palette.
 * The merged list below is that list, and the four maps are four consecutive
 * positions in it. A series that carried its own colour keeps it — a task that
 * coloured its lines meant something by it — but the map's name goes in front
 * either way, because a legend reading `cis, cis, cis, cis` is a legend that
 * names nothing.
 *
 * **A stack is per map for the same reason the name is.** Two series that share
 * a stack are one bar split in two (§18.13); four maps' worth sharing one would
 * be a single bar four maps tall, with each library's cis fraction standing on
 * the sum of the ones before it. Prefixing the stack with the map's label makes
 * it four bars per sequence, each split where that library splits, which is the
 * comparison the tab exists for.
 *
 * **A named abscissa survives only where every map names it the same way.** The
 * names are positional — the fourth name belongs to the fourth bar — so taking
 * the first map's list as the scales are taken would be safe for four libraries
 * of one genome and a mislabelling for two different assemblies, which is a deck
 * this app allows. Where the lists disagree the names go and the axis falls back
 * to its numbers, which says nothing rather than something untrue.
 */
function mergeCurves(
  id: string,
  group: ReadonlyArray<{ label: string; curve: CurveOutput }>,
): CurveOutput {
  const single = group.every((entry) => entry.curve.series.length === 1)
  const series: CurveSeries[] = []
  for (const entry of group) {
    for (const line of entry.curve.series) {
      series.push({
        ...line,
        // With one line per map the map's name *is* the series name; with
        // several, both are needed and the map comes first because that is the
        // axis being compared.
        name: single ? entry.label : `${entry.label} · ${line.name}`,
        // Dropped deliberately: see above.
        ...(line.colour === undefined ? {} : { colour: line.colour }),
        ...(line.stack === undefined ? {} : { stack: `${entry.label} · ${line.stack}` }),
      })
    }
  }
  const first = group[0].curve
  const names = first.xTicks
  const shared =
    names !== undefined &&
    group.every((entry) => entry.curve.xTicks?.join('\u0000') === names.join('\u0000'))
  return {
    kind: 'curve',
    id: `${id}__all`,
    label: `${first.label} — all maps`,
    series,
    xLabel: first.xLabel,
    yLabel: first.yLabel,
    // The first map's scales, which are the task's own: every map ran the same
    // task, so they agree, and taking the first is taking the only answer.
    xScale: first.xScale,
    yScale: first.yScale,
    ...(shared ? { xTicks: [...names] } : {}),
  }
}
