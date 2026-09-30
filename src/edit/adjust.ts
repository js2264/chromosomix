/**
 * A suggestion with one of its ends dragged (SPECS §27.6): in review, before
 * answering it, the stretch it turns or moves begun or ended elsewhere, or the
 * point it splits at moved — snapped, as every point on the stage is.
 *
 * The step, the words and the marks follow the end; the confidence stays as
 * the method gave it, since the method weighed the suggestion and not the
 * hand's version of it, and `adjusted` is added to what it rests on so the
 * history says whose ends they were. The key stays too: an answer to the
 * adjusted suggestion is an answer to the suggestion, and taught as one.
 *
 * Pure, over the lens: it is tested without a stage.
 */

import type { EditStep } from '../genome/edit'
import type { LensGrid } from './grid'
import { stretchBetween, stretchUnits } from './gestures'
import { edgeBp, type Suggestion } from './suggest'
import { stepText } from './words'

/** Whether a suggestion has ends a hand can drag: a stretch turned or moved, or a split's point. */
export function adjustable(suggestion: Suggestion): boolean {
  return suggestion.kind === 'split' || (suggestion.stretch !== null && (suggestion.step.op === 'invert' || suggestion.step.op === 'move'))
}

/**
 * The ends a drag can take hold of, in units of the edited axis: a stretch's
 * two ends, or a split's one point.
 */
export function adjustableEnds(suggestion: Suggestion): number[] {
  if (!adjustable(suggestion)) return []
  if (suggestion.kind === 'split') return suggestion.breaks.slice(0, 1)
  return suggestion.stretch === null ? [] : [suggestion.stretch[0], suggestion.stretch[1]]
}

/**
 * The suggestion with its end `end` — `0` the low one, `1` the high one; a
 * split's only one is `0` — at `unit`, or `null` where that names no step: a
 * stretch of nothing, a split at a sequence's edge, a move whose place in its
 * own sequence would be inside the stretch it moves.
 */
export function adjustSuggestion(grid: LensGrid, suggestion: Suggestion, end: 0 | 1, unit: number): Suggestion | null {
  const step = suggestion.step
  if (suggestion.kind === 'split' && step.op === 'split') {
    const at = suggestion.breaks[0]
    const sequence = at === undefined ? null : grid.sequenceAt(Math.min(grid.n - 1, Math.max(0, at)))
    if (sequence === null || !(unit > sequence.from && unit < sequence.to)) return null
    const bp = edgeBp(grid, sequence, unit)
    if (!(bp > 0 && bp < sequence.length)) return null
    return adjusted(suggestion, { ...step, at: bp }, { breaks: [unit], extent: [unit, unit], stretch: null })
  }
  const held = suggestion.stretch
  if (held === null || !adjustable(suggestion)) return null
  const other = held[1 - end]
  const stretch = stretchBetween(grid, other, unit)
  if (stretch === null) return null
  const units = stretchUnits(grid, stretch)
  if (units === null) return null
  let next: EditStep
  if (step.op === 'invert') {
    next = { op: 'invert', sequence: stretch.sequence, from: stretch.from, to: stretch.to }
  } else if (step.op === 'move') {
    if (stretch.sequence !== step.sequence) return null
    let at = step.at
    // In its own sequence, the place it goes is measured with the stretch
    // taken out: kept where it was on the sequence as it stands, and refused
    // where the stretch would now hold it.
    if (step.into === step.sequence) {
      const place = step.at < step.from ? step.at : step.at + (step.to - step.from)
      if (place > stretch.from && place < stretch.to) return null
      at = place <= stretch.from ? place : place - (stretch.to - stretch.from)
    }
    next = { ...step, from: stretch.from, to: stretch.to, at }
  } else {
    return null
  }
  const target = suggestion.target
  const lo = Math.min(units[0], target ?? units[0])
  const hi = Math.max(units[1], target ?? units[1])
  return adjusted(suggestion, next, { breaks: [units[0], units[1]], extent: [lo, hi], stretch: units })
}

function adjusted(
  suggestion: Suggestion,
  step: EditStep,
  where: Pick<Suggestion, 'breaks' | 'extent' | 'stretch'>,
): Suggestion {
  return {
    ...suggestion,
    ...where,
    step,
    words: stepText(step),
    // Where the ends it would join now are is the hand's to say, not the
    // method's corners, which were for the ends it found.
    corners: [],
    evidence: handled(suggestion.evidence),
  }
}

/** What an adjusted suggestion rests on: its ends are the hand's now, not the finer rungs' (§27.5). */
function handled(evidence: readonly string[]): string[] {
  const kept = evidence.filter((chip) => !chip.startsWith('refined at '))
  return kept.includes('adjusted') ? kept : [...kept, 'adjusted']
}
