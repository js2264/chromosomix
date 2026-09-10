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
 * A **matrix** does not, and neither does a **table**. Four pileups are four
 * pictures and averaging them would be a fifth thing nobody asked for; four
 * tables stacked is a table with a map column, which is a real thing to want and
 * is what the TSV export already produces per map. Rather than inventing a
 * combination for them, the combined tab shows the curves and says plainly which
 * outputs are only available per map. Saying so is the feature: a tab that
 * silently held three of a task's five outputs would be read as the task having
 * three.
 */

import type { CurveOutput, CurveSeries, TaskOutput, TaskResult } from './types'

/** One map's result, with the label the tabs and the legend use. */
export interface MapResult {
  label: string
  result: TaskResult
}

export interface CombinedFigures {
  /** The curves, one per output id that at least two maps produced. */
  curves: CurveOutput[]
  /** Output labels that exist per map and cannot be folded into one picture. */
  perMapOnly: string[]
}

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

  const curves: CurveOutput[] = []
  const perMapOnly: string[] = []
  for (const id of order) {
    const group = byId.get(id) ?? []
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
    curves.push(mergeCurves(id, drawable))
  }
  return { curves, perMapOnly }
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
      })
    }
  }
  const first = group[0].curve
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
  }
}
