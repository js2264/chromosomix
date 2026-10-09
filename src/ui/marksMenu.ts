/**
 * The *Marks* group every picture's right-click menu carries (§8.1): hide the
 * mark the hand is on, or every mark — on the map, beside it, in the 1D
 * browser, in a tracks cell and on a model alike.
 *
 * One builder for the five menus, because they are one act over one store:
 * the Manual annotations card lists the marks and every picture draws them, so
 * a mark hidden from a menu is hidden from all of them and its row's eye on
 * the card goes dark with it. Written once, the menus cannot come to disagree
 * about its words or about what hiding means.
 *
 * **What the hand is on comes first**, as a feature under the pointer does on
 * a lane's menu: a reader who right-clicks a rule they want gone is pointing at
 * it, and sending them to find its row on the card is sending them away from
 * the thing they are deciding about. Only drawn marks can be under a pointer —
 * a hidden one is not there to point at — so the row is always a *hide*; the
 * card's eye, `A` and the switch below bring marks back.
 */

import { describeMark, type ManualMark, type ManualStore } from '../annotations/manual'
import { KEYS, keyLabel, withKey } from './commands'
import type { MenuItem } from './Menu'

/** What one mark is called in a menu row: the card's three section names, singular. */
const KIND_WORDS: Record<ManualMark['kind'], string> = {
  line: 'line',
  arrowhead: 'arrowhead',
  rect: 'rectangle',
}

/**
 * How many marks under the pointer a menu names, nearest first.
 *
 * Three, because a place where more than three marks meet is a place where the
 * reader is looking at the marks rather than through them, and a menu that
 * grew a row per mark there would push *Hide every mark* — the row that
 * answers that moment — off the bottom.
 */
const UNDER_POINTER = 3

/**
 * How long a mark's coordinates may run in the hint column before they are
 * shortened to the first axis. A box off the diagonal is two loci, and the
 * hint column cuts what does not fit at the menu's edge — which cut the part
 * that tells two such boxes apart. The whole of it is in the row's tooltip.
 */
const HINT_CHARACTERS = 30

/**
 * The group, or nothing where there are no marks at all — a menu offering to
 * hide what was never drawn is a row a reader tries and then distrusts.
 *
 * @param under the drawn marks under the pointer, nearest first.
 */
export function marksMenu(store: ManualStore | undefined, under: readonly ManualMark[] = []): MenuItem[] {
  if (store === undefined || store.marks.length === 0) return []
  const items: MenuItem[] = [{ label: 'Marks' }]
  for (const mark of under.slice(0, UNDER_POINTER)) {
    const name = describeMark(mark)
    items.push({
      label: `Hide this ${KIND_WORDS[mark.kind]}`,
      hint: name.length > HINT_CHARACTERS ? `${name.split(' × ')[0]} × …` : name,
      title: `${name}, off every map, track and model; its eye on the Manual annotations card brings it back`,
      run: () => store.setShown(mark.id, false),
    })
  }
  items.push(allMarksItem(store))
  return items
}

/**
 * The switch for all of them: *hide every mark* while any is drawn, and *show
 * the marks* — exactly the ones it hid — once none is.
 *
 * Its key in the hint column, where every menu on the reader's machine prints
 * one: a row reached for while looking at the picture is the moment a reader
 * learns there is a faster way to do it.
 */
function allMarksItem(store: ManualStore): MenuItem {
  if (store.anyShown) {
    return {
      label: 'Hide every mark',
      hint: keyLabel(KEYS.marks),
      title: withKey('Every line, arrowhead and rectangle, off every map, track and model until shown again', KEYS.marks),
      run: () => store.hideAll(),
    }
  }
  return {
    label: 'Show the marks',
    hint: keyLabel(KEYS.marks),
    title: withKey(
      store.marks.some((mark) => mark.hidden === 'all')
        ? 'The marks hidden together, back where they were; one hidden on its own stays hidden'
        : 'Every mark, back on every map, track and model',
      KEYS.marks,
    ),
    run: () => store.showAll(),
  }
}
