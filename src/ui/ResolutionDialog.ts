/**
 * Asking for a resolution the file does not store (§3.4).
 *
 * The `+` at the coarse end of the ladder opens this, and what it has to do is
 * narrower than it looks: the arithmetic is one line (`metacooler/coarsen.ts`)
 * and the dialog is almost entirely about **saying which number would work**.
 *
 * That is the whole design. A reader on a `1 / 2 / 5 / 10 kb` ladder who types
 * `2.5 kb` has not made a mistake anybody could have warned them about in
 * advance — it is a perfectly reasonable thing to want, and the reason it cannot
 * be given is a fact about how a contact map is stored rather than about this
 * application. So the answer arrives **as they type**, under the box, naming
 * what would have to change: *not a whole number of bins of any resolution this
 * file carries*. Type `3 kb` and the same line becomes *three 1 kb bins added
 * up*, which is both the confirmation and the explanation.
 *
 * ## The unit
 *
 * bp, kb and Mb as radios rather than a suffix to parse, for the reason the
 * resolution picker itself is a slider rather than a text box: a reader thinks
 * in kilobases, the file thinks in base pairs, and the one number that has to be
 * unambiguous is the one being stored. `10` with `kb` ticked is `10000`, and the
 * line under the box says so in base pairs so there is nowhere for a factor of a
 * thousand to hide.
 *
 * ## The caveat that is always shown
 *
 * Raw counts coarsen **exactly** — a contact is in one fine bin and therefore in
 * one coarse bin, so the sum is the count. Balanced values do not:
 * `cooler zoomify --balance` sums the raw counts and then balances the coarse
 * matrix at its own resolution, while this applies the fine weights and adds the
 * results. That is what every aggregation in this field does and it is a good
 * estimate; it is not the same number, and a reader comparing a derived 10 kb
 * map against a colleague's `zoomify`d one deserves to know which of the two
 * they are holding. One sentence, always on — not a warning that appears when
 * balancing happens to be on, because the resolution outlives the switch.
 */

import { button, el } from './dom'
import { Modal } from './Modal'
import { derivable, isDerived, type DerivedRung, type Rung } from '../metacooler/coarsen'
import { resolutionLabel } from './Breadcrumb'

export interface ResolutionDialogProps {
  /** The file's own rungs — what a target has to be a whole number of. */
  rungs: readonly Rung[]
  /** Bin sizes the reader has already added, so a repeat is told it is one. */
  declared: readonly number[]
  fileLabel: string
  /** Accepted. The dialog has closed; the caller adds it and navigates. */
  onConfirm(derived: DerivedRung): void
}

/** The units the box offers, coarsest last — the direction the ladder goes. */
const UNITS: ReadonlyArray<{ label: string; bp: number }> = [
  { label: 'bp', bp: 1 },
  { label: 'kb', bp: 1_000 },
  { label: 'Mb', bp: 1_000_000 },
]

let groups = 0

export function openResolutionDialog(props: ResolutionDialogProps): Modal {
  return new Modal({
    title: 'Add a resolution',
    body: (close) =>
      dialogBody(props, (derived) => {
        close()
        props.onConfirm(derived)
      }),
  })
}

function dialogBody(
  props: ResolutionDialogProps,
  done: (derived: DerivedRung) => void,
): HTMLElement {
  const coarsest = props.rungs.reduce((most, rung) => Math.max(most, rung.binsize), 0)
  // Opened on something that *works*, which on any ladder is twice its coarsest
  // rung: the reader's commonest errand is "a bit coarser than this file goes",
  // and a dialog whose first state is a refusal reads as broken.
  const seeded = coarsest > 0 ? coarsest * 2 : 10_000
  const unitAt = seeded % 1_000_000 === 0 ? 2 : seeded % 1_000 === 0 ? 1 : 0

  const box = el('input', {
    class: 'input input-num res-ask',
    type: 'number',
    value: String(seeded / UNITS[unitAt].bp),
    attrs: { min: '1', step: 'any', 'aria-label': 'Resolution' },
  }) as HTMLInputElement

  const group = `metacooler-res-unit-${groups++}`
  const units = el('div', { class: 'res-units', attrs: { role: 'radiogroup', 'aria-label': 'Unit' } })
  const radios: HTMLInputElement[] = []
  for (const [index, unit] of UNITS.entries()) {
    const radio = el('input', {
      class: 'res-unit-radio',
      type: 'radio',
      attrs: { name: group, value: unit.label },
    }) as HTMLInputElement
    radio.checked = index === unitAt
    radio.addEventListener('change', () => {
      if (radio.checked) refresh()
    })
    radios.push(radio)
    units.appendChild(
      el('label', { class: 'res-unit' }, radio, el('span', { text: unit.label })),
    )
  }

  const verdict = el('p', { class: 'hint res-verdict' })
  const add = button('add', () => submit(), { class: 'btn btn-primary' })

  /** What is in the box, in base pairs — the one number anything is decided on. */
  const asked = (): number => {
    const typed = Number(box.value)
    const unit = UNITS[radios.findIndex((radio) => radio.checked)] ?? UNITS[0]
    return typed * unit.bp
  }

  let answer: DerivedRung | null = null

  const refresh = (): void => {
    const target = asked()
    const judged = derivable(target, props.rungs, props.declared)
    if (isDerived(judged)) {
      answer = judged
      verdict.classList.remove('is-bad')
      // The arithmetic, spelled out, because it is the reassurance: a reader
      // who can see *three 1 kb bins* knows exactly what they are getting and
      // can tell at a glance that nothing was rounded.
      verdict.textContent =
        `${target.toLocaleString('en-US')} bp — ${judged.factor.toLocaleString('en-US')} of ` +
        `this file’s ${resolutionLabel(judged.from.binsize)} bins, added up.`
      add.disabled = false
      return
    }
    answer = null
    verdict.classList.add('is-bad')
    verdict.textContent = judged.why
    add.disabled = true
  }

  const submit = (): void => {
    if (answer !== null) done(answer)
  }
  box.addEventListener('input', refresh)
  box.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault()
      submit()
    }
  })
  refresh()

  return el(
    'div',
    { class: 'modal-body res-body' },
    // Two sentences over a box that takes one number: which bins the file has,
    // and what it costs to ask for a multiple of them. The arithmetic used to
    // be spelled out here as well, which is what the verdict line under the box
    // says about the number actually typed.
    el('p', {
      class: 'hint',
      text:
        `${props.fileLabel} carries ${describeRungs(props.rungs)}, and any whole multiple of one ` +
        'of those can be drawn, computed as it is read — nothing written, nothing downloaded.',
    }),
    el('div', { class: 'res-ask-row' }, box, units),
    verdict,
    // The one caveat §3.4 requires, always printed — and in one sentence, which
    // is what that section asks for. The paragraph it replaces argued the case
    // as well as stating it, in front of a reader who wanted 5 kb.
    el('p', {
      class: 'hint',
      text:
        'Counts add up exactly; balanced values are an estimate, since cooler zoomify --balance ' +
        'rebalances each resolution on its own.',
    }),
    el('div', { class: 'modal-actions' }, add),
  )
}

/** `1, 2, 5 and 10 kb`, or `1 kb bins` for a file with one resolution. */
function describeRungs(rungs: readonly Rung[]): string {
  const labels = [...rungs]
    .sort((a, b) => a.binsize - b.binsize)
    .map((rung) => resolutionLabel(rung.binsize))
  if (labels.length === 0) return 'no resolution this build can read'
  if (labels.length === 1) return `${labels[0]} bins`
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
