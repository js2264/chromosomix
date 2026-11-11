/**
 * The `?` on a task's row that names what the task re-implements
 * (`analysis/references.ts`), and what its tip says.
 *
 * The mark and the tip are `questionMark.ts`'s, which the landing page's
 * example sessions share. What is the row's own is the colour — the answer at
 * a glance, green where the validation found the task identical or equivalent
 * to its reference, the text's own colour where it is untested — and the
 * tip's words: the method, how it came out, and the DOI as a link.
 */

import { isValidated, type TaskReference } from '../analysis/references'
import { el } from './dom'
import { questionMark } from './questionMark'

const STATUS: Record<TaskReference['agreement'], string> = {
  identical: 'Identical in the validation',
  equivalent: 'Equivalent in the validation',
  untested: 'Not validated yet',
}

/** The tip's words: the method, then how it came out and its DOI. */
function fill(box: HTMLElement, reference: TaskReference): void {
  box.replaceChildren(
    el('p', { class: 'question-tip-text', text: reference.method }),
    el(
      'p',
      { class: 'question-tip-note' },
      `${STATUS[reference.agreement]} · `,
      el('a', {
        text: `doi:${reference.doi}`,
        attrs: { href: `https://doi.org/${reference.doi}`, target: '_blank', rel: 'noopener noreferrer' },
      }),
    ),
  )
}

/** The `?` for a task that re-implements `reference`. */
export function referenceMark(reference: TaskReference): HTMLElement {
  return questionMark({
    class: `task-ref${isValidated(reference) ? ' is-validated' : ''}`,
    label: `${reference.method} ${STATUS[reference.agreement]}.`,
    fill: (box) => fill(box, reference),
  })
}
