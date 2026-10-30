/**
 * A `?` that carries a footnote, and the one tip behind every one of them.
 *
 * Drawn first on the Analysis column's rows, for what a task re-implements
 * (`taskReference.ts`), and on the landing page's example sessions for what
 * each one opens (§24.11): one mark and one tip, so that a reader who has
 * learnt what the `?` does in one place knows it in the other.
 *
 * **A mark, not a control.** It has nothing to do: it is a `<span>`, not in
 * the caret's walk, and a press on it is not a press on the row or the button
 * it sits in — what a reader pointing at a footnote asked for is the footnote.
 * Its label carries the tip's words for a screen reader.
 *
 * **One tip for every mark, in the body.** The mark sits inside a button or a
 * `role="button"` row, and a link inside it would be a control inside a
 * control; so the tip is one element hung from the body, `position: fixed`
 * under the `?` as `connectHead.ts` places its own, and filled for whichever
 * `?` the pointer is on. It stays while the pointer is on either, so the
 * pointer can travel from the `?` into it to follow a link, and goes a moment
 * after it has left both. A touch screen has no hover: a tap on the `?` shows
 * it, and a tap anywhere else puts it away.
 */

import { el } from './dom'
import { icon } from './icons'

/** How long the tip waits, once the pointer has left, for it to arrive on the other of the two. */
const LINGER_MS = 180
/** The space between the `?` and the tip. */
const GAP = 4
/** What the tip keeps clear of the viewport's edges. */
const MARGIN = 8
/**
 * The mark's size, in whole pixels. Lucide's drawn `?` in a circle rather than
 * a typed `?` in a bordered ring: the glyph was centred on the font's line box,
 * not on itself, and at a fractional size each row rounded it differently, so
 * some sat off-centre.
 */
const SIZE = 16

let tip: HTMLElement | null = null
let owner: HTMLElement | null = null
let leaving: ReturnType<typeof setTimeout> | null = null

function hide(): void {
  if (leaving !== null) clearTimeout(leaving)
  leaving = null
  owner = null
  tip?.classList.add('hidden')
}

function linger(): void {
  if (leaving !== null) clearTimeout(leaving)
  leaving = setTimeout(hide, LINGER_MS)
}

function stay(): void {
  if (leaving !== null) clearTimeout(leaving)
  leaving = null
}

/** The one tip, made on first use and kept in the body. */
function theTip(): HTMLElement {
  if (tip !== null && tip.isConnected) return tip
  tip = el('div', { class: 'question-tip hidden', attrs: { role: 'tooltip' } })
  tip.addEventListener('pointerenter', stay)
  tip.addEventListener('pointerleave', linger)
  document.body.appendChild(tip)
  // Anything else pressed, the column scrolled or Escape: the tip is about a
  // place on screen that has moved or been left.
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Node | null
      if (tip?.contains(target) === true || owner?.contains(target) === true) return
      hide()
    },
    true,
  )
  document.addEventListener('scroll', () => hide(), true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && owner !== null) hide()
  })
  return tip
}

/** Under the `?`, its right edge on the `?`'s, or over it where there is no room below. */
function place(box: HTMLElement, mark: HTMLElement): void {
  const at = mark.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  box.style.right = `${Math.max(MARGIN, width - at.right)}px`
  box.style.left = 'auto'
  const below = window.innerHeight - at.bottom
  if (below >= box.offsetHeight + GAP + MARGIN || below >= at.top) {
    box.style.top = `${at.bottom + GAP}px`
    box.style.bottom = 'auto'
  } else {
    box.style.top = 'auto'
    box.style.bottom = `${window.innerHeight - at.top + GAP}px`
  }
}

function show(mark: HTMLElement, fill: (box: HTMLElement) => void): void {
  stay()
  const box = theTip()
  if (owner !== mark) fill(box)
  owner = mark
  box.classList.remove('hidden')
  place(box, mark)
}

/**
 * A `?`: its class, the words a screen reader is given for it, and what the
 * tip holds while it is the one pointed at — the first paragraph as its text,
 * anything after it as a quieter note (`question-tip-text`, `question-tip-note`).
 */
export function questionMark(options: {
  class: string
  label: string
  fill(box: HTMLElement): void
}): HTMLElement {
  const mark = el(
    'span',
    {
      class: options.class,
      // An empty title on the mark keeps the tooltip of what it sits in — what
      // a waiting task needs — from showing over this one.
      title: '',
      attrs: { role: 'img', 'aria-label': options.label },
    },
    icon('circle-question-mark', { size: SIZE }),
  )
  mark.addEventListener('pointerenter', () => show(mark, options.fill))
  mark.addEventListener('pointerleave', linger)
  // Nor does a press on it focus what it sits in: focus would scroll a column
  // to bring the row into view, and a scroll puts the tip away.
  mark.addEventListener('mousedown', (event) => event.preventDefault())
  mark.addEventListener('click', (event) => {
    event.stopPropagation()
    show(mark, options.fill)
  })
  return mark
}
