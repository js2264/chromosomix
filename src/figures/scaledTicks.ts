/**
 * The ticks of a scaled-region abscissa (§18.8): where a scaled metaplot's
 * axis is labelled, at the width it is drawn.
 *
 * The axis is a column index, which is a number nobody reads, so its ticks are
 * its landmarks instead (`analysis/run/labels.scaledLabel` spells them). Two
 * are always there — **`Start` and `End`**, the body's two edges, which are the
 * only points every feature in the set shares — and the rest are the finest
 * round steps that fit between them: a share of the body (`50%`, then quarters,
 * tenths…) and a distance out along each flank from its edge (`-5 kb`,
 * `-2.5 kb`, then every kilobase…). A wide figure and a window wheeled into
 * one part of the axis take finer steps than the drawer's column does, which
 * is why this is asked again for every width and every window rather than
 * decided once by the task.
 *
 * Pure, and no DOM: the width a label takes is the caller's to measure.
 */

import { scaledLabel } from '../analysis/run/labels'
import type { ScaledAxis } from '../analysis/types'

/** Steps through the body, in per cent of it. */
const BODY_STEPS = [50, 25, 10, 5, 1] as const

/** The digits a step along a flank is made of, in every decade of base pairs. */
const FLANK_DIGITS = [1, 2, 2.5, 5] as const

/** The least room between two labels' facing edges, in ems. */
const GAP = 1

/**
 * The least distance from one tick to the next, centre to centre, in ems.
 *
 * Labels that merely do not touch are a ruler; a scale is read at a glance, and
 * every kilobase of a 5 kb flank in a drawer column is nine labels a reader has
 * to look past to find `Start`.
 */
const PITCH = 6

/** How a candidate set of ticks is told apart from another that also fits. */
interface Candidate {
  ticks: number[]
  /** Whether its last tick is the flank's far end, which is then named. */
  whole: boolean
  /** The step, in the candidate's own unit: a coarser one is the calmer. */
  step: number
}

/**
 * The x of every tick a scaled abscissa takes in `window`, drawn `width`
 * pixels across.
 *
 * `measure` is how wide a label is drawn, in pixels; `em` the type's size.
 * `Start` and `End` are kept wherever they fall in the window, even when they
 * are near enough to touch — the whole point of the axis is lost without
 * either. Every other tick is one of a ladder per part — the body's and each
 * flank's — and of each ladder the rung with the most ticks in the window that
 * clear their neighbours (`GAP`, `PITCH`); among rungs with as many, one that
 * names the flank's end, then the coarser.
 *
 * A flank's steps are round numbers of base pairs, `1`, `2`, `2.5` or `5` of a
 * decade, never finer than a column; the body's are per cent, never finer than
 * a column either. Sorted, and empty when nothing fits.
 */
export function scaledTicks(
  axis: ScaledAxis,
  window: readonly [number, number],
  width: number,
  measure: (label: string) => number,
  em: number,
): number[] {
  const [low, high] = window
  if (!(high > low) || !(width > 0) || !(axis.end > axis.start)) return []
  const perUnit = width / (high - low)
  const slack = 1e-9 * Math.max(1, axis.to - axis.from)
  const inside = (x: number): boolean => x >= low - slack && x <= high + slack

  const widths = new Map<number, number>()
  const wide = (x: number): number => {
    let known = widths.get(x)
    if (known === undefined) {
      known = measure(scaledLabel(axis, x))
      widths.set(x, known)
    }
    return known
  }
  const clear = (a: number, b: number): boolean =>
    Math.abs(b - a) * perUnit + 1e-6 >= Math.max(PITCH * em, (wide(a) + wide(b)) / 2 + GAP * em)

  const chosen = [axis.start, axis.end].filter(inside)
  /** Whether `ticks` clear each other and every tick already chosen. */
  const fits = (ticks: number[]): boolean => {
    const all = [...chosen, ...ticks].sort((a, b) => a - b)
    for (let i = 1; i < all.length; i++) {
      // The two landmarks are kept however near they are: see above.
      const landmarks = chosen.includes(all[i - 1]) && chosen.includes(all[i])
      if (!landmarks && !clear(all[i - 1], all[i])) return false
    }
    return true
  }
  /** The candidate with the most ticks that fit; on a tie, the one naming the end, then the coarser. */
  const best = (candidates: Candidate[]): number[] => {
    let pick: Candidate | null = null
    for (const one of candidates) {
      if (one.ticks.length === 0 || !fits(one.ticks)) continue
      if (
        pick === null ||
        one.ticks.length > pick.ticks.length ||
        (one.ticks.length === pick.ticks.length &&
          (Number(one.whole) > Number(pick.whole) || (one.whole === pick.whole && one.step > pick.step)))
      ) {
        pick = one
      }
    }
    return pick === null ? [] : pick.ticks
  }

  // The body: a share of each feature, never finer than one of its columns.
  const body = axis.end - axis.start
  chosen.push(
    ...best(
      BODY_STEPS.filter((step) => (step / 100) * body >= 1).map((step) => {
        const ticks: number[] = []
        for (let k = 1; k * step < 100; k++) {
          const x = axis.start + ((k * step) / 100) * body
          if (inside(x)) ticks.push(x)
        }
        return { ticks, whole: false, step }
      }),
    ),
  )

  // Each flank: base pairs out from the body's edge, never finer than a column.
  const flanks = [
    { edge: axis.start, reach: (axis.start - axis.from) * axis.flankStep, sign: -1 },
    { edge: axis.end, reach: (axis.to - axis.end) * axis.flankStep, sign: 1 },
  ]
  for (const flank of flanks) {
    if (!(flank.reach > 0) || !(axis.flankStep > 0)) continue
    const candidates: Candidate[] = []
    for (const step of flankSteps(axis.flankStep, flank.reach)) {
      const ticks: number[] = []
      for (let k = 1; k * step <= flank.reach * (1 + 1e-12); k++) {
        const x = flank.edge + (flank.sign * k * step) / axis.flankStep
        if (inside(x)) ticks.push(x)
      }
      candidates.push({ ticks, whole: isMultiple(flank.reach, step), step })
    }
    chosen.push(...best(candidates))
  }
  return chosen.sort((a, b) => a - b)
}

/**
 * The round steps along a flank `reach` base pairs long whose columns are
 * `column` base pairs wide — every `1`, `2`, `2.5` and `5` of a decade from a
 * column to the whole flank — and the flank's own length, so that a flank of
 * no round length still has its end to name.
 */
function flankSteps(column: number, reach: number): number[] {
  const out = new Set<number>([reach])
  for (let power = Math.floor(Math.log10(column)); 10 ** power <= reach; power++) {
    for (const digit of FLANK_DIGITS) {
      const step = Number((digit * 10 ** power).toPrecision(12))
      if (step >= column * (1 - 1e-12) && step <= reach * (1 + 1e-12)) out.add(step)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** Whether `value` is a whole number of `step`s. */
function isMultiple(value: number, step: number): boolean {
  const steps = value / step
  return Math.abs(steps - Math.round(steps)) < 1e-9 * Math.max(1, steps)
}
