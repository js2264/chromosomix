/**
 * The words a runner puts on a lane.
 *
 * One function, and it is here rather than repeated because four tasks name
 * their output after a distance — `Insulation · 10 kb`, `DI · 2 Mb`,
 * `HiC score · 200 kb`, the scalogram's quantiles — and four copies of the same
 * three lines is four chances for one of them to round differently from the
 * others. A reader comparing two lanes in the same stack reads the labels as
 * numbers, and two labels that disagree about whether 1,500,000 bp is `1.5 Mb`
 * or `1500 kb` are two lanes that look like they were computed by different
 * tools.
 *
 * Not `src/format.ts`, which is the Python-repr module the CLI command builder
 * uses, and not `ui/labels.ts`, which is main-thread and names the DOM.
 */

/** `2 Mb`, `10 kb`, `500 bp` — a distance, as a lane is labelled with one. */
export function formatBp(bp: number): string {
  if (bp >= 1e6) return `${trim(bp / 1e6)} Mb`
  if (bp >= 1e3) return `${trim(bp / 1e3)} kb`
  return `${Math.round(bp)} bp`
}

/** Two decimals at most, and no trailing zeros: `1.5`, not `1.50`. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)))
}
