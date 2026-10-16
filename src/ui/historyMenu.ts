/**
 * The header's list of steps back (§5.5): what each step behind the one on
 * screen was, read off the hash it wrote.
 *
 * A step is a hash and nothing else, because that is the whole of what an
 * entry of this window's history is (§5.5) — so what it is called is worked
 * out from the view state when the list opens rather than recorded when the
 * step was taken, and two steps a list cannot tell apart are two states that
 * differ only in something the hash does not carry. Each row names the place,
 * as the breadcrumb's last crumb or the view's heading would, and beside it,
 * quietly, the file and what the step set on it — the resolution, the O/E, a
 * comparison — which is how a row that names the same window as the one above
 * it says what changed.
 */

import { pairLabel, regionLabel } from '../genome/assembly'
import type { StepBack } from '../state/historyJournal'
import { parseViewState } from '../state/ViewState'
import type { ViewState } from '../types'
import { resolutionLabel } from '../units'
import { entryLabel, fileBaseLabel } from './labels'
import type { MenuItem } from './Menu'

/** How many steps back the list shows, nearest first: a menu longer than this is a page. */
export const HISTORY_ROWS = 20

/**
 * The rows of the list, each going back to its step.
 *
 * `here` is the file on screen: a step in it does not say so, since every row
 * of a list that does reads the same name down its right-hand side and the
 * one row on another file is the one that has to stand out.
 */
export function historyItems(
  back: readonly StepBack[],
  go: (delta: number) => void,
  here?: string,
): MenuItem[] {
  return back.slice(0, HISTORY_ROWS).map(({ step, delta }) => {
    const state = step.hash === '' ? null : parseViewState(step.hash)
    const label = state === null ? 'Nothing open' : stepPlace(state)
    const hint = state === null ? '' : stepDetail(state, here)
    return {
      label,
      ...(hint === '' ? {} : { hint }),
      title: `${-delta} step${delta === -1 ? '' : 's'} back${hint === '' ? '' : ` · ${hint}`}`,
      run: () => go(delta),
    }
  })
}

/** Where a step was: the window, the table or the picture it opened. */
export function stepPlace(state: ViewState): string {
  switch (state.view) {
    case 'region':
      if (state.region === undefined) return 'A window'
      if (state.region2 !== undefined) return pairLabel(state.region, state.region2)
      return regionLabel(state.focus ?? state.region)
    case 'browser':
      return state.locus ?? 'Whole genome'
    case 'whole':
      return 'Whole genome'
    case 'overview':
      return 'Whole metagenome'
    case 'contigs':
      return state.genome !== undefined ? `${state.genome} · contigs` : isMetacool(state.uri) ? 'Contigs' : 'Chromosomes'
    case 'genomes':
      return 'Genomes'
    case 'cells':
      return 'Cells'
    case 'genome':
      return state.genome ?? 'A genome'
    case 'pair':
      return state.genome !== undefined && state.genome2 !== undefined ? `${state.genome} × ${state.genome2}` : 'Two genomes'
    case 'selection': {
      const names = (state.regions ?? state.genomes ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
      if (names.length === 0) return 'A selection'
      return names.length <= 3 ? names.join(' × ') : `${names.length} ${state.genomes !== undefined ? 'genomes' : 'sequences'}`
    }
    default:
      return state.view
  }
}

/**
 * The file a step was on — unless it is `here`, the file on screen — and what
 * it set there that a place does not say.
 */
export function stepDetail(state: ViewState, here?: string): string {
  const parts = here !== undefined && fileBaseLabel(here) === fileBaseLabel(state.uri) ? [] : [fileBaseLabel(state.uri)]
  const entry = entryLabel(state.uri)
  const rung = entry !== undefined && /^\d+$/.test(entry) ? Number(entry) : null
  if (state.coarsen !== undefined) parts.push(`${resolutionLabel(state.coarsen)}*`)
  else if (rung !== null) parts.push(resolutionLabel(rung))
  if (state.view === 'browser') parts.push('tracks')
  if (state.score !== undefined) parts.push(state.score)
  if (state.oe === true) parts.push('O/E')
  if (state.op !== undefined) parts.push(state.op)
  if (state.flip === true) parts.push('turned')
  if (state.smooth !== undefined && state.smooth !== '0') parts.push('smoothed')
  return parts.join(' · ')
}

function isMetacool(uri: string): boolean {
  return /\.m?metacool(?:$|::|[?#])/i.test(uri)
}
