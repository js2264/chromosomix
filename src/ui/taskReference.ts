/**
 * The `?` on a task's row that names what the task re-implements
 * (`analysis/references.ts`), and the tip behind it.
 *
 * **A mark, not a control.** It has nothing to do: it is a `<span>`, not in
 * the caret's walk, and a press on it is not a press on the row it sits in —
 * opening a task's form is not what a reader pointing at its citation asked
 * for. Its colour is the answer at a glance — green where the validation found
 * the task identical or equivalent to its reference, the text's own colour
 * where it is untested — and its label carries the tip's words for a screen
 * reader, as part of the row's own name.
 *
 * **One tip for every row, in the body.** The row is `role="button"`, and a
 * link inside it would be a control inside a control; so the tip — the method,
 * how it came out, and the DOI as a link — is one element hung from the body,
 * `position: fixed` under the `?` as `connectHead.ts` places its own, and
 * filled for whichever `?` the pointer is on. It stays while the pointer is on
 * either, so the pointer can travel from the `?` into it to follow the DOI,
 * and goes a moment after it has left both. A touch screen has no hover: a tap
 * on the `?` shows it, and a tap anywhere else puts it away.
 */

import { isValidated, type TaskReference } from '../analysis/references'
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

const STATUS: Record<TaskReference['agreement'], string> = {
  identical: 'Identical in the validation',
  equivalent: 'Equivalent in the validation',
  untested: 'Not validated yet',
}

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
  tip = el('div', { class: 'task-ref-tip hidden', attrs: { role: 'tooltip' } })
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

/** The tip's words: the method, then how it came out and its DOI. */
function fill(box: HTMLElement, reference: TaskReference): void {
  box.replaceChildren(
    el('p', { class: 'task-ref-method', text: reference.method }),
    el(
      'p',
      { class: 'task-ref-status' },
      `${STATUS[reference.agreement]} · `,
      el('a', {
        text: `doi:${reference.doi}`,
        attrs: { href: `https://doi.org/${reference.doi}`, target: '_blank', rel: 'noopener noreferrer' },
      }),
    ),
  )
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

function show(mark: HTMLElement, reference: TaskReference): void {
  stay()
  const box = theTip()
  if (owner !== mark) fill(box, reference)
  owner = mark
  box.classList.remove('hidden')
  place(box, mark)
}

/** The `?` for a task that re-implements `reference`. */
export function referenceMark(reference: TaskReference): HTMLElement {
  const words = `${reference.method} ${STATUS[reference.agreement]}.`
  const mark = el(
    'span',
    {
      class: `task-ref${isValidated(reference) ? ' is-validated' : ''}`,
      // An empty title on the mark keeps the row's own tooltip — what a waiting
      // task needs — from showing over this one.
      title: '',
      attrs: { role: 'img', 'aria-label': words },
    },
    icon('circle-question-mark', { size: SIZE }),
  )
  mark.addEventListener('pointerenter', () => show(mark, reference))
  mark.addEventListener('pointerleave', linger)
  // Nor does a press on it focus the row: focus would scroll the column to
  // bring the row into view, and a scroll puts the tip away.
  mark.addEventListener('mousedown', (event) => event.preventDefault())
  mark.addEventListener('click', (event) => {
    event.stopPropagation()
    show(mark, reference)
  })
  return mark
}
