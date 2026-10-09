/**
 * A called set's two dropdowns (§18.7): its **display** — a 1D track beside the
 * map, or an overlay on it — and, on the map, the **look** of a set of places.
 *
 * One row and one choice, where there used to be two rows and a switch on each:
 * a run of insulation listed its boundaries twice and its domains twice, and
 * with both switches on — which is how every set arrived — drew each of them
 * twice. The display is the row's own (`analysis/surfaces.ts`'s `setDisplay`),
 * so a session remembers it with the row and a set run again keeps it.
 *
 * Offered in the drawer under the run that called the set and at the head of the
 * row's settings, which is where a reader looking at one surface asks for the
 * other. Not where there is no map: in the 1D browser a set is a track whatever
 * it is on a map, and a choice with one answer is not a control.
 */

import type { AnnotationStore } from '../annotations/store'
import { POINT_LOOKS, overlayShapeOf, type AnnotationEntry, type OverlayShape } from '../annotations/types'
import {
  displayOf,
  isCalledSet,
  offersLook,
  setDisplay,
  setLook,
  type CalledDisplay,
} from '../analysis/surfaces'
import { el } from './dom'
import { settingsField } from './laneSettings'

/** The display's two answers, in the words of the dropdown. */
const DISPLAYS: readonly CalledDisplay[] = ['lane', 'overlay']

function displayWords(entry: AnnotationEntry, display: CalledDisplay): { label: string; hint: string } {
  if (display === 'lane') {
    return {
      label: '1D track',
      hint:
        entry.kind === 'pairs' || entry.payload?.kind === 'pairs'
          ? 'Both ends of every pair, as segments beside the map and in the 1D browser.'
          : 'Segments beside the map and in the 1D browser, each as wide as its call.',
    }
  }
  return {
    label: 'map overlay',
    hint:
      entry.kind === 'pairs' || entry.payload?.kind === 'pairs'
        ? 'A ring round each pair on the map it was called from.'
        : offersLook(entry)
          ? 'On the diagonal of the map it was called from, in the look beside it.'
          : 'The corner of each one’s square along the diagonal of the map it was called from.',
  }
}

/** A set of places' two looks on the map, in the words of the dropdown. */
const LOOK_WORDS: Readonly<Record<string, { label: string; hint: string }>> = {
  point: { label: 'point', hint: 'A dot on the diagonal at each place.' },
  border: {
    label: 'short diagonal marker',
    hint: 'A short rule across the diagonal at each place, which leaves the diagonal itself uncovered.',
  },
}

/**
 * The look of a set of places on the map: a point, or the short marker across
 * the diagonal. Rebuilt by {@link calledSetFields} whenever the display moves,
 * since it means nothing while the set is a track.
 */
function lookField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const select = el('select', { class: 'select', attrs: { 'data-field': 'look' } })
  for (const look of POINT_LOOKS) {
    const words = LOOK_WORDS[look]
    select.appendChild(el('option', { value: look, text: words.label, title: words.hint }))
  }
  const current = overlayShapeOf(entry.style)
  select.value = current
  select.title = LOOK_WORDS[current]?.hint ?? ''
  select.addEventListener('change', () => {
    const picked: OverlayShape = POINT_LOOKS.find((look) => look === select.value) ?? current
    select.title = LOOK_WORDS[picked]?.hint ?? ''
    setLook(store, entry.id, picked)
  })
  return settingsField('look', select)
}

/**
 * The display, and the look beside it while the set is on the map — or `null`
 * for a row that is not a called set, and where there is no map to choose.
 *
 * @param options.map Whether there is a map here to draw an overlay on.
 * @param options.onDisplay Told after the display has moved, with its select:
 *   the Tracks card rebuilds the row's settings around it, since a track and an
 *   overlay have different controls.
 */
export function calledSetFields(
  store: AnnotationStore,
  entry: AnnotationEntry,
  options: { map: boolean; onDisplay?: (select: HTMLSelectElement) => void },
): HTMLElement | null {
  if (!isCalledSet(entry) || !options.map) return null
  const look = el('span', { class: 'ann-called-look' })
  const fillLook = (): void => {
    const live = store.byId(entry.id) ?? entry
    look.replaceChildren(
      ...(displayOf(live) === 'overlay' && offersLook(live) ? [lookField(store, live)] : []),
    )
  }

  const select = el('select', {
    class: 'select',
    attrs: { 'data-field': 'display', 'data-display': entry.id },
  })
  const title = (display: CalledDisplay): string => displayWords(store.byId(entry.id) ?? entry, display).hint
  for (const display of DISPLAYS) {
    const words = displayWords(entry, display)
    select.appendChild(el('option', { value: display, text: words.label, title: words.hint }))
  }
  const current = displayOf(entry)
  select.value = current
  select.title = title(current)
  select.addEventListener('change', () => {
    const picked: CalledDisplay = DISPLAYS.find((display) => display === select.value) ?? current
    setDisplay(store, entry.id, picked)
    select.title = title(picked)
    fillLook()
    options.onDisplay?.(select)
  })
  fillLook()
  return el('div', { class: 'ann-called' }, settingsField('display', select), look)
}
