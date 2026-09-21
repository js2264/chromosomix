/**
 * The `‹ ›` pair that walks to the neighbouring genome or contig.
 *
 * Going from one MAG to the next is the most common navigation there is, and
 * doing it through the table means leaving the picture, finding the row you
 * were on, and clicking the one below it. Two buttons beside the heading do the
 * same thing without losing your place.
 *
 * The neighbour's *name* is the tooltip rather than "next": at either end there
 * is nothing to go to, and a disabled button that says which name it would have
 * opened is the difference between "broken" and "you are at the last one".
 *
 * Both wear `[` and `]`, the keys that do the same thing — see `ui/commands.ts`
 * on why a tooltip is where a shortcut is actually found.
 */

import { el } from './dom'
import { KEYS, withKey } from './commands'
import { iconButton, type IconName } from './icons'

export interface StepperProps {
  /** The names one step away; `null` disables that side. */
  neighbours: { prev: string | null; next: string | null }
  onStep(delta: number): void
  /** What is being stepped through, for the tooltips. */
  noun: string
}

export function stepper(props: StepperProps): HTMLElement {
  const make = (glyph: IconName, delta: number, name: string | null): HTMLButtonElement => {
    const node = iconButton(
      glyph,
      // The key belongs in the tooltip of the button that performs the action,
      // which is where a reader who is already pointing at it will read it —
      // and `[` / `]` step through exactly this, so a stepper that did not print
      // them left the app's most-used shortcut discoverable only in a dialog.
      // Not on the dead end: "No next genome (])" offers a key for a thing
      // there is none of.
      name === null
        ? `No ${delta < 0 ? 'previous' : 'next'} ${props.noun}`
        : withKey(
            `${delta < 0 ? 'Previous' : 'Next'} ${props.noun}: ${name}`,
            delta < 0 ? KEYS.previous : KEYS.next,
          ),
      () => props.onStep(delta),
      { class: 'btn btn-step', size: 15 },
    )
    node.disabled = name === null
    node.setAttribute('aria-label', `${delta < 0 ? 'previous' : 'next'} ${props.noun}`)
    return node
  }
  return el(
    'div',
    { class: 'stepper' },
    make('chevron-left', -1, props.neighbours.prev),
    make('chevron-right', 1, props.neighbours.next),
  )
}
