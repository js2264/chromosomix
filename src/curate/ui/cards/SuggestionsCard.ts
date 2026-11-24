/**
 * The inspector's suggestions card (SPECS §33.3, §33.5, §33.6): the review's
 * **questions** — the suggestions on offer grouped as a curator answers them,
 * one organism's fragments one question — in the queue's order, the likely
 * ones first, numbered as the review's band numbers them.
 *
 * Each row: its number, its kind, its words in the names the stage prints, its
 * confidence, what it rests on, `take` and `turn down`; a question of several
 * suggestions opens on them, each with its own answer. The pointer resting on
 * a row draws the pictures as it would leave the binning, and lights what it
 * names; a press frames it, and in review makes it the question asked. The
 * question in review is marked, and its answers wear their keys.
 *
 * Under them, what was turned down, to offer again, and what the answers
 * taught; in auto, the run — `apply 12 at 80% or more`, then `applying… ·
 * stop` — and after it, what it held back and why.
 */

import { el } from '../../../ui/dom'
import { icon, type IconName } from '../../../ui/icons'
import { keyBadge, withKey } from '../../../ui/commands'
import { fmt } from '../../../units'
import type { CurationStep } from '../../../genome/curation'
import type { CurationStateResult } from '../../../worker/curateProtocol'
import { AUTO_THRESHOLD, LIKELY, type SuggestionKind } from '../../method'
import { displayPercent, type CurateChange } from '../../model'
import type { Question } from '../../questions'
import type { Suggestion } from '../../suggest'
import { declinedWords, shortWords } from '../../words'
import type { CurateContext } from '../context'
import { act, card } from './card'

/** What the stage does for the card. */
export interface SuggestionsHooks {
  /** Show a suggestion where its evidence is, on every picture. */
  frame(s: Suggestion): void
}

/** Rows drawn at most: the rest are counted, and the question in review is always among those drawn. */
export const SUGGESTION_ROWS = 200

/** How long the pointer rests on a row before the pictures draw it taken, in ms. */
const PREVIEW_DELAY = 150

/** The room left above a row scrolled to, in CSS pixels: a glimpse of the question before it. */
const REVEAL_MARGIN = 24

/** The kinds, in the queue's order, each with its mark. */
const KINDS: readonly SuggestionKind[] = ['merge', 'move', 'recruit', 'link', 'unlink']
const KIND_ICON: Record<SuggestionKind, IconName> = { merge: 'merge', move: 'move', recruit: 'plus', link: 'link', unlink: 'unlink' }

/** What a piece of evidence says that a reader should look at before trusting the step. */
const WORRY = /within the background|it has already|markers? shared/

/** A row drawn, kept by its question's key while the question reads the same. */
interface RowView {
  key: string
  node: HTMLElement
  signature: string
  genomes: ReadonlySet<string>
  contigs: ReadonlySet<number>
  number: HTMLElement
  answers: HTMLButtonElement[]
  members: Array<{ key: string; node: HTMLElement; answers: HTMLButtonElement[] }>
  details: HTMLDetailsElement | null
}

/** A suggestion's words as a sentence starts: for a title. */
function capitalise(text: string): string {
  return text === '' ? text : `${text[0].toUpperCase()}${text.slice(1)}`
}

export class SuggestionsCard {
  readonly element: HTMLElement
  private readonly head: HTMLElement
  private readonly autoSlot: HTMLElement
  private readonly kinds: HTMLElement
  private readonly empty: HTMLElement
  private readonly list: HTMLOListElement
  private readonly more: HTMLElement
  private readonly declinedSlot: HTMLElement
  private readonly learnedSlot: HTMLElement
  /** The kind the list is narrowed to, or every kind. */
  private kind: SuggestionKind | null = null
  /** The questions open on their suggestions, by key. */
  private readonly opened = new Set<string>()
  private declinedOpen = false
  private rows = new Map<string, RowView>()
  /** The genomes' names printed short, once an answer. */
  private names: { answer: CurationStateResult; short: Map<string, string> } | null = null
  /** The row under the pointer, and the step it prices. */
  private hovering: string | null = null
  private previewTimer: ReturnType<typeof setTimeout> | null = null
  private pricing: { key: string; before: CurationStep | null; drawn: boolean } | null = null
  private shownCurrent: string | null = null
  private dirty = { all: true, marks: false }
  private frame = 0
  private disposed = false
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly ctx: CurateContext,
    private readonly hooks: SuggestionsHooks,
  ) {
    const built = card('suggestions')
    this.element = built.element
    this.head = built.head
    this.element.classList.add('curate-suggestions-card')
    this.autoSlot = el('div', { class: 'curate-suggestions-auto hidden' })
    this.kinds = el('div', { class: 'curate-suggestions-kinds hidden', attrs: { role: 'group', 'aria-label': 'Show only' } })
    this.empty = el('p', { class: 'edit-empty curate-suggestions-empty hidden' })
    this.list = el('ol', {
      class: 'edit-suggestions curate-suggestions-list',
      attrs: { 'aria-label': 'Questions' },
      on: { pointerleave: () => this.endHover() },
    })
    this.more = el('p', { class: 'edit-note curate-suggestions-more hidden' })
    this.declinedSlot = el('div', { class: 'curate-suggestions-declined-slot' })
    this.learnedSlot = el('div', { class: 'curate-suggestions-learned-slot' })
    built.body.append(this.autoSlot, this.kinds, this.empty, this.list, this.more, this.declinedSlot, this.learnedSlot)
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.schedule('all')
  }

  /** What changed: the questions again, or only the marks — once a frame, however many came. */
  update(change: CurateChange): void {
    switch (change) {
      case 'mode':
        // Review prices the question asked: the stage's preview, not a row's.
        this.forgetPreview()
        this.schedule('all')
        return
      case 'state':
      case 'counting':
      case 'error':
        this.schedule('all')
        return
      case 'current':
        this.forgetPreview()
        this.schedule('marks')
        return
      case 'hover':
        this.schedule('marks')
        return
      default:
        return
    }
  }

  dispose(): void {
    this.endHover()
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const off of this.unsubscribe) off()
  }

  private schedule(what: 'all' | 'marks'): void {
    if (this.disposed) return
    this.dirty[what] = true
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paint())
  }

  private paint(): void {
    if (this.disposed) return
    const dirty = this.dirty
    this.dirty = { all: false, marks: false }
    if (dirty.all) this.paintAll()
    this.paintMarks()
  }

  // -------------------------------------------------------------------------
  // Names.
  // -------------------------------------------------------------------------

  /** Every genome's whole name and the short one the stage prints, once an answer. */
  private shortNames(answer: CurationStateResult): Map<string, string> {
    if (this.names?.answer === answer) return this.names.short
    const short = new Map<string, string>()
    for (const genome of answer.genomes) {
      const printed = this.ctx.shortName(genome.id)
      if (printed !== genome.name) short.set(genome.name, printed)
    }
    this.names = { answer, short }
    return short
  }

  /** Words with the genomes they name printed short. */
  private short(words: string): string {
    const answer = this.ctx.model.answer
    return answer === null ? words : shortWords(words, this.shortNames(answer))
  }

  private idOf(g: number | undefined): string | null {
    const answer = this.ctx.model.answer
    if (answer === null || g === undefined) return null
    return answer.genomes[g]?.id ?? null
  }

  // -------------------------------------------------------------------------
  // The card.
  // -------------------------------------------------------------------------

  private paintAll(): void {
    const model = this.ctx.model
    const answer = model.answer
    if (answer !== null) this.shortNames(answer)
    const counted = answer !== null && answer.counted
    const queue = counted ? model.queue() : []
    const weighing = model.stale ? ' · weighing…' : ''
    this.head.replaceChildren(counted ? `suggestions · ${fmt.int(queue.length)} ${queue.length === 1 ? 'question' : 'questions'}${weighing}` : `suggestions${weighing}`)
    this.paintAuto(counted ? queue : [])
    this.paintKinds(queue)
    const shown = this.kind === null ? queue : queue.filter((q) => q.kind === this.kind)
    // Nothing of the kind chosen is left: every kind again.
    if (shown.length === 0 && this.kind !== null) {
      this.kind = null
      this.paintAll()
      return
    }
    const declined = counted ? model.declined() : []
    let empty: string | null = null
    if (answer === null) empty = model.error === null ? 'Weighing the binning…' : `The count failed: ${model.error}`
    else if (!counted) empty = 'The suggestions come once the contacts are read: every merge, move, recruit and link they support.'
    else if (queue.length === 0) empty = declined.length > 0 ? 'Nothing left to answer: what was turned down is below, to offer again.' : 'Nothing to suggest at 15% or more: drag contigs onto a genome to move them by hand.'
    this.empty.textContent = empty ?? ''
    this.empty.classList.toggle('hidden', empty === null)
    this.paintList(queue, shown)
    this.paintDeclined(declined)
    this.paintLearned()
  }

  /** In auto: the run, and what the last run held back. */
  private paintAuto(queue: readonly Question[]): void {
    const model = this.ctx.model
    if (model.mode !== 'auto') {
      this.autoSlot.classList.add('hidden')
      this.autoSlot.replaceChildren()
      return
    }
    const parts: HTMLElement[] = []
    if (model.running) {
      const stop = act('stop', 'circle-stop', 'Stop the run after the step it is making: every step it made stays, to undo like any other', () => model.stopAuto())
      stop.classList.add('curate-suggestions-stop')
      parts.push(el('div', { class: 'edit-acts curate-suggestions-run' }, el('span', { class: 'curate-suggestions-running', text: 'applying…', attrs: { role: 'status' } }), stop))
    } else {
      const sure = queue.filter((q) => q.confidence >= AUTO_THRESHOLD).length
      const threshold = `${Math.round(AUTO_THRESHOLD * 100)}%`
      const apply = act(
        sure === 0 ? `none at ${threshold} or more` : `apply ${fmt.int(sure)} at ${threshold} or more`,
        'play',
        `Take every question at ${threshold} or more, in the queue’s order, counting again between two: each a step to undo like any other, and any that would lower a MAG’s grade held back`,
        () => void model.runAuto(),
      )
      apply.classList.add('curate-suggestions-apply')
      if (sure === 0) {
        apply.disabled = true
        apply.title = `None at ${threshold} or more: review the rest one by one`
      } else apply.classList.add('btn-primary')
      parts.push(el('div', { class: 'edit-acts curate-suggestions-run' }, apply))
      const held = model.heldBack
      if (held.length > 0) {
        const list = el('ul', { class: 'curate-suggestions-held-list' })
        for (const item of held) {
          const question = queue.find((q) => q.key === item.key)
          const words = el('span', { class: 'curate-suggestions-held-words', text: this.short(item.words), title: item.words })
          const why = el('span', { class: 'curate-suggestions-held-why', text: this.short(item.why), title: item.why })
          const node =
            question === undefined
              ? el('li', { class: 'curate-suggestions-held' }, words, why)
              : el(
                  'li',
                  { class: 'curate-suggestions-held' },
                  el('button', { class: 'curate-suggestions-held-button', title: 'Frame it on the pictures', attrs: { type: 'button' }, on: { click: () => this.press(question) } }, words, why),
                )
          list.appendChild(node)
        }
        parts.push(el('h4', { class: 'edit-card-sub curate-suggestions-sub', text: `held back · ${fmt.int(held.length)}` }), list)
      }
    }
    this.autoSlot.replaceChildren(...parts)
    this.autoSlot.classList.remove('hidden')
  }

  /** The kinds, counted in questions, one lit: every kind, or one. */
  private paintKinds(queue: readonly Question[]): void {
    const counts = new Map<SuggestionKind, number>()
    for (const q of queue) counts.set(q.kind, (counts.get(q.kind) ?? 0) + 1)
    if (counts.size < 2) {
      this.kinds.classList.add('hidden')
      this.kinds.replaceChildren()
      return
    }
    const chip = (kind: SuggestionKind | null, label: string, title: string): HTMLButtonElement =>
      el('button', {
        class: 'btn btn-toggle btn-chip curate-suggestions-kind',
        text: label,
        title,
        attrs: { type: 'button', 'aria-pressed': String(this.kind === kind), 'data-kind': kind ?? 'all' },
        on: {
          click: () => {
            this.kind = kind
            this.schedule('all')
          },
        },
      })
    const chips = [chip(null, 'all', 'Every question')]
    for (const kind of KINDS) {
      const n = counts.get(kind)
      if (n !== undefined) chips.push(chip(kind, `${kind} ${fmt.int(n)}`, `Only the ${kind === 'link' ? 'host links' : kind === 'unlink' ? 'links to undo' : `${kind}s`}`))
    }
    this.kinds.replaceChildren(...chips)
    this.kinds.classList.remove('hidden')
  }

  /**
   * The rows, numbered as the review's band numbers them — the likely ones from
   * 1, the less sure from 1 again under their own head —, kept where their
   * question reads the same, so a row under the pointer or the keyboard stays.
   */
  private paintList(queue: readonly Question[], shown: readonly Question[]): void {
    const likely = queue.filter((q) => q.confidence >= LIKELY).length
    const numberOf = new Map(queue.map((q, k) => [q.key, k < likely ? k + 1 : k - likely + 1]))
    // The window drawn: from the first, or around the question in review.
    const current = this.ctx.model.mode === 'review' ? (this.ctx.model.currentQuestion?.key ?? null) : null
    const at = current === null ? -1 : shown.findIndex((q) => q.key === current)
    const start = at >= SUGGESTION_ROWS ? Math.max(0, Math.min(shown.length - SUGGESTION_ROWS, at - Math.floor(SUGGESTION_ROWS / 2))) : 0
    const end = Math.min(shown.length, start + SUGGESTION_ROWS)
    const next = new Map<string, RowView>()
    const nodes: HTMLElement[] = []
    if (start > 0) nodes.push(el('li', { class: 'curate-suggestions-divider is-more', text: `${fmt.int(start)} before` }))
    const lessSure = shown.filter((q) => q.confidence < LIKELY).length
    for (let k = start; k < end; k++) {
      const q = shown[k]
      if (q.confidence < LIKELY && (k === 0 || shown[k - 1].confidence >= LIKELY)) {
        nodes.push(el('li', { class: 'curate-suggestions-divider', text: `less sure · ${fmt.int(lessSure)}`, title: `Under ${Math.round(LIKELY * 100)}%: asked after the likely ones` }))
      }
      const number = numberOf.get(q.key) ?? k + 1
      const signature = this.signatureOf(q)
      let view = this.rows.get(q.key)
      if (view === undefined || view.signature !== signature) view = this.row(q, signature)
      view.number.textContent = String(number)
      next.set(q.key, view)
      nodes.push(view.node)
    }
    this.rows = next
    this.list.replaceChildren(...nodes)
    this.list.classList.toggle('hidden', nodes.length === 0)
    const after = shown.length - end
    this.more.textContent = after > 0 ? `and ${fmt.int(after)} more${this.kind === null ? '' : ` ${this.kind === 'link' ? 'host links' : `${this.kind}s`}`}: answer these, or narrow the list by kind` : ''
    this.more.classList.toggle('hidden', after === 0)
    // The row under the pointer is gone: let go of what it lit and drew.
    if (this.hovering !== null && !this.rowKnown(this.hovering)) this.endHover()
    this.shownCurrent = null
  }

  /** Whether a question or one of its suggestions is drawn. */
  private rowKnown(key: string): boolean {
    for (const view of this.rows.values()) if (view.key === key || view.members.some((member) => member.key === key)) return true
    return false
  }

  /** What a row shows: drawn again only when it changes. */
  private signatureOf(q: Question): string {
    const members = q.members.map((m) => `${m.key}:${displayPercent(m.confidence)}:${m.words}`).join(';')
    return [q.words, displayPercent(q.confidence), q.evidence.join('|'), q.genomes.join(','), q.contigs.length, members].join('\n')
  }

  private row(q: Question, signature: string): RowView {
    const model = this.ctx.model
    const words = this.short(q.words)
    const percent = `${displayPercent(q.confidence)}%`
    const number = el('span', { class: 'edit-suggestion-n curate-suggestions-n' })
    const main = el(
      'button',
      {
        class: 'edit-suggestion-main curate-suggestions-main',
        title: `${capitalise(q.words)} · ${percent}: press to frame it on the pictures`,
        attrs: { type: 'button' },
        on: {
          click: () => this.press(this.fresh(q)),
          focus: () => this.light(q),
          blur: () => {
            if (this.hovering === q.key) this.endHover()
          },
        },
      },
      number,
      icon(KIND_ICON[q.kind], { size: 14 }),
      el('span', { class: 'edit-suggestion-words curate-suggestions-words', text: words }),
      el('span', { class: 'edit-suggestion-confidence curate-suggestions-confidence', text: percent }),
    )
    const chips = el(
      'div',
      { class: 'edit-suggestion-chips curate-suggestions-chips' },
      ...q.evidence.map((chip) => el('span', { class: `edit-chip curate-suggestions-chip${WORRY.test(chip) ? ' is-warn' : ''}`, text: this.short(chip), title: chip })),
    )
    const many = q.members.length > 1
    const take = this.answerButton('take', 'check', many ? `Take it whole: its ${fmt.int(q.steps.length)} ${q.steps.length === 1 ? 'step' : 'steps'}, one gesture` : 'Take it: its step, made', `Take ${words}`, () => model.accept(this.fresh(q)), 'y')
    const down = this.answerButton('turn down', 'x', many ? `Turn down every one of its ${fmt.int(q.members.length)} suggestions: none is offered again, and each is learned from` : 'Turn it down: never offered again, and learned from', `Turn down ${words}`, () => model.reject(this.fresh(q)), 'n')
    const node = el(
      'li',
      {
        class: `edit-suggestion curate-suggestions-row is-${q.kind}`,
        attrs: { 'data-key': q.key, 'data-kind': q.kind },
        on: {
          pointerenter: () => this.startHover(q, q.steps),
          pointerleave: () => this.endHover(),
        },
      },
      main,
      el('div', { class: 'edit-suggestion-foot curate-suggestions-foot' }, chips, el('div', { class: 'edit-suggestion-acts curate-suggestions-acts' }, take, down)),
    )
    const view: RowView = {
      key: q.key,
      node,
      signature,
      genomes: new Set(q.genomes.map((g) => this.idOf(g)).filter((id): id is string => id !== null)),
      contigs: new Set(q.contigs),
      number,
      answers: [take, down],
      members: [],
      details: null,
    }
    if (many) {
      const details = el('details', { class: 'curate-suggestions-members' })
      details.open = this.opened.has(q.key)
      details.addEventListener('toggle', () => {
        if (details.open) this.opened.add(q.key)
        else this.opened.delete(q.key)
      })
      const list = el('ul', { class: 'curate-suggestions-member-list' })
      q.members.forEach((member) => {
        const made = this.memberRow(q, member)
        view.members.push(made)
        list.appendChild(made.node)
      })
      details.append(el('summary', { class: 'curate-suggestions-members-head', text: `one by one · ${fmt.int(q.members.length)}`, title: 'Its suggestions, each with its own answer' }), list)
      view.details = details
      node.appendChild(details)
    }
    return view
  }

  /**
   * What one of a question's suggestions says that the others do not: a
   * recruit's or a move's contig, a merge's genomes, a link's MAG — the
   * question says the rest once.
   */
  private memberLabel(member: Suggestion): string {
    const step = member.step
    const short = (id: string): string => this.ctx.shortName(id)
    switch (step.op) {
      case 'move': {
        const names = this.ctx.data.file.names
        return member.contigs.length === 1 ? (names[member.contigs[0]] ?? step.contigs[0] ?? '') : `${fmt.int(member.contigs.length)} contigs`
      }
      case 'merge':
        return `${step.genomes.map(short).join(', ')} into ${short(step.into)}`
      case 'link':
        return `link to ${short(step.mag)}`
      case 'unlink':
        return `unlink from ${short(step.mag)}`
      default:
        return this.short(member.words)
    }
  }

  /** One suggestion of a question, with its own answer. */
  private memberRow(q: Question, member: Suggestion): { key: string; node: HTMLElement; answers: HTMLButtonElement[] } {
    const model = this.ctx.model
    const words = this.short(member.words)
    const take = this.answerButton('take', 'check', 'Take this one alone: its step, made', `Take ${words}`, () => model.accept(this.freshMember(q, member)), 'y', true)
    const down = this.answerButton('turn down', 'x', 'Turn this one down alone: never offered again, and learned from', `Turn down ${words}`, () => model.reject(this.freshMember(q, member)), 'n', true)
    const node = el(
      'li',
      {
        class: 'curate-suggestions-member',
        title: `${capitalise(member.words)} · ${displayPercent(member.confidence)}%${member.evidence.length === 0 ? '' : ` · ${member.evidence.join(' · ')}`}`,
        attrs: { 'data-key': member.key },
        on: {
          pointerenter: () => this.startHover(member, [member.step]),
          // Back on its question, which the pointer is still on.
          pointerleave: () => this.startHover(q, q.steps),
          click: () => this.press(this.freshMember(q, member)),
        },
      },
      el('span', { class: 'curate-suggestions-member-words', text: this.memberLabel(member) }),
      el('span', { class: 'curate-suggestions-member-confidence', text: `${displayPercent(member.confidence)}%` }),
      take,
      down,
    )
    return { key: member.key, node, answers: [take, down] }
  }

  /**
   * `take` or `turn down`: its mark, its word, and — on the question in review
   * — its key; a question's suggestion's, its mark alone.
   */
  private answerButton(label: string, mark: IconName, title: string, aria: string, run: () => void, keys: string, small = false): HTMLButtonElement {
    const button = el('button', {
      class: `btn edit-suggestion-act curate-suggestions-act${small ? ' is-small' : ''}`,
      title,
      attrs: { type: 'button', 'aria-label': aria },
      on: {
        click: (event: MouseEvent) => {
          event.stopPropagation()
          run()
        },
      },
    })
    button.append(icon(mark, { size: 13 }), el('span', { class: small ? 'curate-suggestions-act-word' : '', text: label }), keyBadge(keys, { class: 'kbd-inline' }))
    button.dataset.title = title
    button.dataset.keys = keys
    return button
  }

  /** What was turned down, each to offer again. */
  private paintDeclined(declined: ReadonlyArray<{ key: string; suggestion: Suggestion | null }>): void {
    if (declined.length === 0) {
      this.declinedSlot.replaceChildren()
      return
    }
    const details = el('details', { class: 'edit-declined curate-suggestions-declined' })
    details.open = this.declinedOpen
    details.addEventListener('toggle', () => {
      this.declinedOpen = details.open
    })
    const list = el('ul', { class: 'edit-declined-list curate-suggestions-declined-list' })
    for (const { key, suggestion } of declined) {
      const words = suggestion === null ? declinedWords(key, (id) => this.ctx.shortName(id)) : this.short(suggestion.words)
      list.appendChild(
        el(
          'li',
          { attrs: { 'data-key': key } },
          el('span', {
            class: `edit-declined-words${suggestion === null ? ' is-gone' : ''}`,
            text: words,
            title: suggestion === null ? 'The binning as it stands no longer suggests it' : `${capitalise(suggestion.words)} · ${displayPercent(suggestion.confidence)}%`,
          }),
          el('button', { class: 'btn-link curate-suggestions-restore', text: 'offer again', title: 'Offer it again', attrs: { type: 'button' }, on: { click: () => this.ctx.model.restore(key) } }),
        ),
      )
    }
    details.append(el('summary', { text: `turned down · ${fmt.int(declined.length)}` }), list)
    this.declinedSlot.replaceChildren(details)
  }

  /** What the answers taught the ranking, and the way back to the stated weights. */
  private paintLearned(): void {
    const answers = this.ctx.model.answers
    if (answers === 0) {
      this.learnedSlot.replaceChildren()
      return
    }
    this.learnedSlot.replaceChildren(
      el(
        'p',
        { class: 'edit-note curate-suggestions-learned' },
        `ranked by what ${fmt.int(answers)} ${answers === 1 ? 'answer' : 'answers'} taught it · `,
        el('button', { class: 'btn-link', text: 'forget', title: 'Back to the stated weights, with nothing turned down', attrs: { type: 'button' }, on: { click: () => this.ctx.model.forgetLearned() } }),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // The marks: the question in review, what the pointer lights elsewhere.
  // -------------------------------------------------------------------------

  private paintMarks(): void {
    const model = this.ctx.model
    const question = model.mode === 'review' ? model.currentQuestion : null
    const current = question?.key ?? null
    // The question asked is drawn: every kind again, or the window moved to it.
    if (current !== null && !this.rows.has(current) && this.ctx.model.queue().some((q) => q.key === current)) {
      if (this.kind !== null && question?.kind !== this.kind) this.kind = null
      this.dirty.all = false
      this.paintAll()
    }
    const member = model.member
    const { genome, contig } = model.hovered
    const pointed = this.hovering
    for (const view of this.rows.values()) {
      const here = view.key === current
      view.node.classList.toggle('is-current', here)
      // The pointer on a row lights that row; on a picture or the list, every question naming what it is on.
      const lit =
        pointed !== null
          ? view.key === pointed || view.members.some((made) => made.key === pointed)
          : (genome !== null && view.genomes.has(genome)) || (contig >= 0 && view.contigs.has(contig))
      view.node.classList.toggle('is-lit', lit)
      this.keyed(view.answers, here && member === null)
      if (here && member !== null && view.details !== null && !view.details.open) {
        view.details.open = true
        this.opened.add(view.key)
      }
      view.members.forEach((made, k) => {
        const asked = here && member !== null && member.at === k
        made.node.classList.toggle('is-current', asked)
        this.keyed(made.answers, asked)
      })
    }
    if (current !== this.shownCurrent) {
      this.shownCurrent = current
      const view = current === null ? undefined : this.rows.get(current)
      if (view !== undefined) this.reveal(view.node)
    }
  }

  /** An answer's key, worn while it is what the key answers; `take` then filled, the answer the review invites. */
  private keyed(buttons: readonly HTMLButtonElement[], on: boolean): void {
    buttons[0]?.classList.toggle('btn-primary', on)
    for (const button of buttons) {
      button.classList.toggle('is-keyed', on)
      const title = button.dataset.title ?? button.title
      button.title = on ? withKey(title, button.dataset.keys) : title
    }
  }

  /**
   * Scroll the list, and only the list, so the question asked is in view:
   * where it is out of view, at the top, the questions after it under it —
   * review moves on to them.
   */
  private reveal(node: HTMLElement): void {
    const list = this.list
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return
    list.scrollTop = Math.max(0, top - REVEAL_MARGIN)
  }

  // -------------------------------------------------------------------------
  // The hand.
  // -------------------------------------------------------------------------

  /**
   * A question as the queue asks it now: a row kept across counts holds the
   * question it was drawn from, which an answer would learn from as it was.
   */
  private fresh(q: Question): Question {
    return this.ctx.model.queue().find((now) => now.key === q.key) ?? q
  }

  private freshMember(q: Question, member: Suggestion): Suggestion {
    return this.fresh(q).members.find((now) => now.key === member.key) ?? member
  }

  /** A press on a question or one of its suggestions: framed, and in review asked. */
  private press(s: Suggestion): void {
    const model = this.ctx.model
    if (model.mode === 'review') model.setCurrent(s.key)
    this.hooks.frame(s)
  }

  /** Light what a suggestion names, on every picture and list, and say it in the readout. */
  private light(s: Suggestion): void {
    if (this.ctx.dragging !== null) return
    this.hovering = s.key
    this.ctx.model.hover(this.idOf(s.genomes[0]), s.contigs.length === 1 ? s.contigs[0] : -1)
    const evidence = s.evidence.map((chip) => this.short(chip))
    this.ctx.say([`${this.short(s.words)} · ${displayPercent(s.confidence)}%`, ...evidence].join(' · '))
    this.schedule('marks')
  }

  /** The pointer on a row: what it names lit at once, the binning as it would leave it drawn once it rests. */
  private startHover(s: Suggestion, steps: readonly CurationStep[]): void {
    if (this.ctx.dragging !== null) return
    this.light(s)
    this.clearTimer()
    if (steps.length !== 1) {
      // Several steps are one gesture, and a preview is of one: nothing drawn.
      this.endPreview()
      return
    }
    const step = steps[0]
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      this.startPreview(step)
    }, PREVIEW_DELAY)
  }

  private endHover(): void {
    this.clearTimer()
    this.endPreview()
    if (this.hovering === null) return
    this.hovering = null
    this.ctx.model.hover(null)
    this.ctx.say(null)
    this.schedule('marks')
  }

  private clearTimer(): void {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer)
    this.previewTimer = null
  }

  /**
   * Leave the preview to the stage: in review it prices the question asked,
   * and a row the pointer rests on draws nothing more until it is entered again.
   */
  private forgetPreview(): void {
    this.clearTimer()
    this.pricing = null
  }

  private startPreview(step: CurationStep): void {
    if (this.disposed) return
    const model = this.ctx.model
    const key = JSON.stringify(step)
    if (this.pricing === null) this.pricing = { key, before: model.previewStep, drawn: model.previewing }
    else this.pricing.key = key
    model.preview(step, true)
  }

  /** Let go of the step a row drew: the preview held before it — the review's price — is held again. */
  private endPreview(): void {
    const held = this.pricing
    this.pricing = null
    if (held === null) return
    const model = this.ctx.model
    if (JSON.stringify(model.previewStep) === held.key) model.preview(held.before, held.drawn)
  }
}
