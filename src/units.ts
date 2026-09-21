/**
 * Every quantity the app prints, formatted once.
 *
 * Bin sizes, spans, counts, bytes, percentages, durations and clock times were
 * each written by two or three formatters in two or three files — `1 kb`,
 * `1.0 kb` and `1000 bp` for one resolution; bytes in 1024s here and 1000s
 * there — and a reader comparing two surfaces was comparing two spellings. This
 * module holds the one spelling of each, and nothing else: no DOM, no `ui/`
 * import, so the annotations worker and the g3d parser can print the same
 * number the cards print. `ui/dom.ts` re-exports `fmt` and `trimNumber` so the
 * views keep their one import.
 */

const INTEGER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const DECIMAL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 })
/**
 * Three *significant* digits, for values too small to have three decimal ones.
 *
 * A balanced cell is a fraction — the whole matrix sums to about one contact
 * per bin — so at 5 kb on a bacterial genome the typical value is a few times
 * `1e-4` and every number in the readout rounded to `0` or `0.001`. Two cells
 * three-fold apart printed the same string, and a reader checking a ratio
 * against the counts under it was shown a pair that could not produce it.
 */
const SIGNIFICANT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 })
/** One formatter per decimal count, built on demand — see {@link fmt.fixed}. */
const FIXED = new Map<number, Intl.NumberFormat>()

export const fmt = {
  /** `4573673` → `4,573,673`. */
  int(value: number): string {
    if (!Number.isFinite(value)) return '—'
    return INTEGER.format(value)
  },
  /**
   * Compact but honest: integers keep their separators, floats keep 3 places —
   * and floats too small for three decimal places keep three significant ones
   * instead, down to `1e-7`, below which the digits go in an exponent rather
   * than behind a run of zeros nobody can count.
   */
  num(value: number): string {
    if (!Number.isFinite(value)) return '—'
    if (Number.isInteger(value)) return INTEGER.format(value)
    const size = Math.abs(value)
    if (size >= 1e-3) return DECIMAL.format(value)
    return size >= 1e-7 ? SIGNIFICANT.format(value) : value.toExponential(2)
  },
  /**
   * A number with a *fixed* number of decimal places, grouped — `1.07`, `1.00`.
   *
   * For a table column, which is the one place {@link num}'s "as many places as
   * this value needs" is the wrong answer: a completeness column came out
   * `0.99`, `1`, `1.1`, `1.07`, so the digits did not stand under one another
   * and `1` read as a different kind of value from `0.99` — in a column a
   * reader ranks MAGs by, by eye, with `tabular-nums` asked for and then
   * wasted. The caller measures the column once and every cell in it is
   * printed to the same width.
   */
  fixed(value: number, digits: number): string {
    if (!Number.isFinite(value)) return '—'
    let format = FIXED.get(digits)
    if (format === undefined) {
      format = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
      FIXED.set(digits, format)
    }
    return format.format(value)
  },
  /** `0.083` → `8.3%`. */
  pct(fraction: number, digits = 1): string {
    if (!Number.isFinite(fraction)) return '—'
    return `${(fraction * 100).toFixed(digits)}%`
  },
  /**
   * A base-pair coordinate written out in full — `1,224,000`.
   *
   * For the readout under the pointer, where {@link bp}'s `1.22 Mb` names a
   * ten-kilobase neighbourhood of a cell that is one kilobase wide: a reader
   * comparing two cells three bins apart was shown the same string for both.
   */
  pos(value: number): string {
    if (!Number.isFinite(value)) return '—'
    return INTEGER.format(Math.round(value))
  },
  /**
   * A measured span with a unit — `400.0 kb`, `1.22 Mb`, `47 bp`.
   *
   * The decimals stay: a length is a measurement and `1.0 kb` says it was
   * measured to the hundred bases. A *bin size* is not a measurement, and takes
   * {@link resolutionLabel} instead.
   */
  bp(value: number): string {
    if (!Number.isFinite(value)) return '—'
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)} Mb`
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)} kb`
    return `${INTEGER.format(value)} bp`
  },
  /**
   * Byte counts — `18.1 MB`.
   *
   * Decimal, in thousands, because that is what the OS and every browser's
   * download dialog show the same reader about the same file; a viewer that
   * called the 18.1 MB download `17.3 MB` was reporting a second size for it.
   */
  bytes(value: number): string {
    if (!Number.isFinite(value)) return '—'
    const units = ['B', 'kB', 'MB', 'GB', 'TB']
    let scaled = value
    let unit = 0
    while (scaled >= 1000 && unit < units.length - 1) {
      scaled /= 1000
      unit++
    }
    return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`
  },
}

/**
 * A number as the *starting point for an edit*, rather than as a readout.
 *
 * `fmt.num` is for text a reader reads; this is for what goes inside a number
 * box they are about to nudge. `-4.678` is something to nudge,
 * `-4.678039550781250` — which is what `String(value)` gives for a float that
 * came off a colour scale or out of a bigWig header — is not.
 *
 * Four significant digits, without the exponent `toPrecision` would print for an
 * ordinary number, and the exponent form kept for the magnitudes where the
 * alternative is a box reading `0` or fifteen digits of integer.
 *
 * @param maxDecimals A cap on the places kept, for a box whose value is read off
 * a lane 44 pixels tall: past three, the digits are below what the picture can
 * show and they cost the box its whole width. Uncapped by default, which is what
 * the colour clip wants — its units are the transform's, not the data's.
 */
export function trimNumber(value: number, maxDecimals = Number.POSITIVE_INFINITY): string {
  if (!Number.isFinite(value)) return ''
  const abs = Math.abs(value)
  // Below the first bound a fixed-point rendering is all zeroes and above the
  // second it is a wall of digits; in both, the exponent is the shorter true
  // answer. Checked before the cap, so `maxDecimals` never turns 1.2e-7 into 0.
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return value.toExponential(3)
  const rounded = Number(value.toPrecision(4))
  if (!Number.isFinite(maxDecimals)) return String(rounded)
  return String(Number(rounded.toFixed(Math.max(0, maxDecimals))))
}

/**
 * `1 kb`, `50 kb`, `1 Mb` — a bin size, written the way a reader says it.
 *
 * Not `fmt.bp`, and the difference is the decimal: that formatter is for
 * measured lengths and always carries one, so a 1 kb rung came out `1.0 kb` and
 * a 1 Mb one `1.00 Mb`. A resolution is a round number by construction — it is
 * what `cooler zoomify` was given — so the places are trimmed and only the ones
 * that say something survive: `12.5 kb` keeps its half, `1 kb` does not gain a
 * zero. Falls back to base pairs below a kilobase, which is where a Micro-C
 * ladder starts.
 */
export function resolutionLabel(bp: number): string {
  if (!Number.isFinite(bp) || bp <= 0) return '—'
  if (bp >= 1e6) return `${trim(bp / 1e6)} Mb`
  if (bp >= 1e3) return `${trim(bp / 1e3)} kb`
  return `${trim(bp)} bp`
}

/** Two places at most, and none where they would all be zeros. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * How long a run took, in the largest unit that still says something.
 *
 * Milliseconds below a second, because the difference between 40 ms and 900 ms
 * is the difference between free and noticeable; one decimal of a second up to
 * a minute; minutes and seconds past that, since `112.4 s` is a number a reader
 * has to divide.
 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`
}

/**
 * When a run finished, as a clock on the wall — `20:49:46`.
 *
 * The ISO string a result carries is for the provenance a reader copies out; on
 * screen it is twenty-four characters of which the reader wants six. Local time,
 * because the question is "was that before lunch".
 *
 * **Twenty-four hour, in every locale.** The reader's own locale decided this at
 * first, which on `en-US` is a twelve-hour clock: a run finished *at 03:29:24 PM*
 * beside one *computed in 776 ms*, where the eight characters that say the hour
 * carry three of punctuation and a word, and two runs an hour apart in the
 * afternoon and the small hours sort the same. A duration and a clock time sit
 * on one line here and the line is read as a measurement; `hourCycle` is the one
 * thing about a clock that is not a matter of locale but of what the number is
 * for. The separators stay the locale's.
 */
export function runClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}
