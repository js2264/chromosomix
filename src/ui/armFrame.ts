/**
 * The arms of a circular chromosome, as the map reads them (§8.15).
 *
 * A bacterial chromosome folds along two diagonals — the main one, and a second
 * through its origin, where the two arms meet — and the arm-frame O/E divides by
 * the decay along both. The panel offers it as a toggle, `arms`, with an action
 * beside it, `ori`; the session owns the setting, and the panel is handed it on
 * every render as a presentation ({@link ArmsPresentation}).
 *
 * What is here is the arithmetic of reading that presentation against a block:
 * where each row and column of the block stands on the arms, carried over to
 * whatever grid the block was read on; whether the origin is in the middle of
 * the picture; which arms are in force under the `arm decay` score; and the key
 * a derivation's caches are held under, so that an origin moved under them is a
 * change of what is drawn. Pure, and out of `ui/MatrixPanel.ts` for that reason:
 * the tests that pin it build a block and a frame, not a panel.
 */

import type { Derivation } from '../render/derive'
import { bpAt, locusAxisFrom } from '../render/locus'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
import type { ArmsPresentation, DerivePresentation } from './MatrixPanel'

/** The window the arms control turns on at, in bins — the compartments task's default. */
export const DEFAULT_ARM_WINDOW = 50

/** What identifies an arms setting, for the caches a derivation is keyed on. */
export function armsKey(arms: ArmsPresentation | undefined): string {
  if (arms === undefined || arms.window === undefined || arms.frame === null) return ''
  const { startBin, n, origin, circular } = arms.frame
  return `${arms.window}:${startBin}:${n}:${origin}:${circular ? 'o' : '-'}`
}

/**
 * The arms a derivation is read against: the presentation's own, and under
 * `arm decay` the same frame at the window `arms` turns on at while the toggle
 * is off — that baseline is read along the arms whatever the toggle says
 * (§8.15).
 *
 * One function for the read and for every key it is cached on, so an origin
 * moved under that baseline with the toggle off is a change of what is drawn:
 * keyed on the presentation's own arms, it was `''` before and after, and the
 * map kept the arms of the old origin.
 */
export function armsInForce(derive: DerivePresentation | undefined): ArmsPresentation | undefined {
  const arms = derive?.arms
  if (arms === undefined || derive?.baseline !== true || derive.alongArms !== true) return arms
  return arms.window === undefined ? { ...arms, window: DEFAULT_ARM_WINDOW } : arms
}

/**
 * Whether a circle's origin is in the middle of the picture, to within
 * `tolerance` base pairs — what lights `ori` (§8.15).
 *
 * `middle` is the locus at the centre of the visible domain, read off the scale
 * rather than off the window the view note prints: that window is widened to
 * whole bins at both ends, which moves its middle by up to a bin however exactly
 * the picture is centred. Measured round the circle, so an origin a few
 * kilobases before the sequence's first base is in the middle of a view that
 * crosses the junction there.
 */
export function originInMiddle(
  middle: { contig: string; bp: number } | null,
  frame: { circular: boolean; length: number; originBp: number },
  tolerance: number,
): boolean {
  if (middle === null || !frame.circular || !(frame.length > 0)) return false
  const apart = Math.abs(middle.bp - frame.originBp) % frame.length
  return Math.min(apart, frame.length - apart) <= tolerance
}

/**
 * The arm frame for this block, where the arms are on and there is one.
 *
 * **In the block's own cells**, which are not the open map's bins in general: a
 * pooled read sums several of them, and a read from a sibling rung of an
 * `.mcool` is on another grid altogether, with extents in that grid's bins.
 * Each row is placed by where it is *in base pairs* — through the same axis
 * runs the ticks are placed by, which is also what folds a block read round a
 * circle (`worker/wrap.ts`) back onto the sequence — and the frame and its
 * window are carried over to the block's resolution. A frame kept at the open
 * rung placed a coarse block's rows as the first stretch of a longer sequence,
 * all on one arm, and sized its tables for a resolution nobody was drawing.
 */
export function armsFor(
  data: MatrixResult,
  arms: ArmsPresentation | undefined,
  bpPerCell: number,
): Derivation['arms'] | undefined {
  if (arms === undefined || arms.window === undefined || arms.frame === null) return undefined
  if (arms.refusal !== null || data.level !== 'bin') return undefined
  const { n, origin, circular, binsize, length } = arms.frame
  if (!(n > 0) || !(binsize > 0) || !(bpPerCell > 0) || !(length > 0)) return undefined
  const cells = Math.max(1, Math.ceil(length / bpPerCell))
  const originCell = Math.min(cells - 1, Math.floor(((origin + 0.5) * binsize) / bpPerCell))
  const place = (runs: AxisGroup[], blockStart: number, count: number): Int32Array => {
    const axis = locusAxisFrom({ runs, blockStart, level: 'bin', binsize: bpPerCell, contigLength: () => length })
    const out = new Int32Array(count)
    for (const segment of axis?.segments ?? []) {
      for (let i = Math.max(0, segment.unitStart); i < Math.min(count, segment.unitEnd); i++) {
        const bp = bpAt(segment, i + 0.5)
        const cell = Math.floor(bp / bpPerCell)
        out[i] = ((cell % cells) + cells) % cells
      }
    }
    return out
  }
  return {
    frame: { n: cells, origin: originCell, circular },
    rowBins: place(data.rowGroups, data.rowExtent[0], data.nrows),
    colBins: place(data.colGroups, data.colExtent[0], data.ncols),
    // The same stretch of the arms, counted in the block's cells.
    window: arms.window > 0 ? Math.max(1, Math.round((arms.window * binsize) / bpPerCell)) : 0,
  }
}
