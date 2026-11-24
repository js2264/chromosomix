/**
 * The curation stage's controller (SPECS §33.3): everything the stage knows and
 * does but draw — the method's answer for the binning as it stands, counted
 * again after every step; the order the genomes are laid out in, kept across
 * steps; what is selected and what is under the pointer; the suggestions on
 * offer, the one in review, the answers and what they teach; and the steps the
 * stage's acts make.
 *
 * Every step goes through the {@link CurationStore}, so the session hears of it
 * from one place; every count goes through a {@link CurateClient}, the worker in
 * the app and the method itself in the tests. An answer is taken only if it is
 * the answer to the last count asked, so a slow answer never paints over a
 * later step.
 */

import { UNBINNED, type Curation, type CurationStep, type GenomeKind } from '../genome/curation'
import type { CurationLearned, CurationStore, LearnedKind } from '../state/curation'
import type { CurationStateResult } from '../worker/curateProtocol'
import { AUTO_THRESHOLD, INITIAL_WEIGHTS, learn, LIKELY, OFFER_FLOOR } from './method'
import { dropPlan, type DropPlan } from './drop'
import { chainOrder, elementOrder, keepOrder } from './order'
import type { KindWeights, Suggestion } from './suggest'
import type { CurateDragged, CurateDropTarget } from './ui/context'

/** A request that can be called off: the reader's `cancellable`. */
export interface Cancellable<T> {
  promise: Promise<T>
  cancel(): void
}

/** How the stage counts: the worker in the app, the method in the tests. */
export interface CurateClient {
  state(curation: Curation | null, weights: KindWeights): Cancellable<CurationStateResult>
}

/** Who presses accept: the reader alone, the reader one suggestion at a time, or the stage for the sure ones. */
export type CurateMode = 'manual' | 'review' | 'auto'

/** What changed, for the stage to repaint only that. */
export type CurateChange = 'state' | 'counting' | 'selection' | 'hover' | 'mode' | 'current' | 'error'

/** What is selected: whole genomes by id, and contigs by index of the file's. */
export interface CurateSelection {
  genomes: readonly string[]
  contigs: readonly number[]
}

/** How a click adds to the selection. */
export type SelectHow = 'replace' | 'add' | 'toggle'

/** The most steps one press of auto makes. */
export const AUTO_MOST = 200

/** The prefix of the ids the stage mints for a genome a step creates. */
const MINTED = 'curated:'

export interface CurateModelOptions {
  /** How long after a step the count is asked, in ms: steps in a burst are counted once. */
  debounce?: number
  /** A timer, for tests: returns its own cancel. */
  schedule?: (run: () => void, ms: number) => () => void
}

/** Every step's word of what changed since the file, for the stage's running tally. */
export interface CurateTally {
  steps: number
  /** Contigs whose genome is not the file's. */
  contigsMoved: number
  basesMoved: number
  /** Genomes as in the file, changed, new, and gone. */
  asInFile: number
  changed: number
  created: number
  gone: number
  /** Links the file did not hold, and links of the file now gone. */
  linksAdded: number
  linksDropped: number
}

export class CurateModel {
  private answerHeld: CurationStateResult | null = null
  private ticket = 0
  private pending: Cancellable<CurationStateResult> | null = null
  private cancelTimer: (() => void) | null = null
  private staleHeld = true
  private errorHeld: string | null = null
  private orderHeld: string[] = []
  /** The genome each contig was in at the last answer, by id: where a new genome came from. */
  private previousOwner: Array<string | null> = []
  private previousKind = new Map<string, GenomeKind>()
  private selectionHeld: CurateSelection = { genomes: [], contigs: [] }
  private hoverGenome: string | null = null
  private hoverContig = -1
  private modeHeld: CurateMode = 'manual'
  private currentKey: string | null = null
  private autoRun: { stopped: boolean } | null = null
  private waiters: Array<() => void> = []
  private readonly listeners = new Set<(change: CurateChange) => void>()
  private readonly unsubscribe: () => void
  private readonly debounce: number
  private readonly schedule: (run: () => void, ms: number) => () => void
  private disposed = false

  constructor(
    private readonly store: CurationStore,
    private readonly client: CurateClient,
    options: CurateModelOptions = {},
  ) {
    this.debounce = options.debounce ?? 30
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      })
    this.unsubscribe = store.subscribe(() => this.recount())
    this.recount(0)
  }

  // -------------------------------------------------------------------------
  // Listening.
  // -------------------------------------------------------------------------

  subscribe(listener: (change: CurateChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: CurateChange): void {
    for (const listener of this.listeners) listener(change)
  }

  /** Stop listening and counting; an auto run in progress stops. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.pending?.cancel()
    this.pending = null
    this.cancelTimer?.()
    this.cancelTimer = null
    if (this.autoRun !== null) this.autoRun.stopped = true
    this.release()
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // Counting.
  // -------------------------------------------------------------------------

  /** The method's answer for the binning as it stands; the last one while a count runs. */
  get answer(): CurationStateResult | null {
    return this.answerHeld
  }

  /** Whether a step has been made since the answer: the stage says it is weighing. */
  get stale(): boolean {
    return this.staleHeld
  }

  /** Why the last count failed, or `null`. */
  get error(): string | null {
    return this.errorHeld
  }

  /** The weights the suggestions are counted with: what the review taught, else the initial ones. */
  get weights(): KindWeights {
    return { ...this.store.learned.weights }
  }

  /** Count again: after a step, an answer, or an undo. */
  recount(delay = this.debounce): void {
    if (this.disposed) return
    const ticket = ++this.ticket
    this.pending?.cancel()
    this.pending = null
    this.cancelTimer?.()
    const wasStale = this.staleHeld
    this.staleHeld = true
    if (!wasStale) this.emit('counting')
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      if (ticket !== this.ticket || this.disposed) return
      const request = this.client.state(this.store.curation, this.weights)
      this.pending = request
      request.promise.then(
        (answer) => {
          if (ticket !== this.ticket || this.disposed) return
          this.pending = null
          this.take(answer)
        },
        (error: unknown) => {
          if (ticket !== this.ticket || this.disposed) return
          this.pending = null
          this.staleHeld = false
          this.errorHeld = error instanceof Error ? error.message : String(error)
          if (this.autoRun !== null) this.autoRun.stopped = true
          this.release()
          this.emit('error')
        },
      )
    }, delay)
  }

  /** A promise kept once the answer is the binning's as it stands. */
  settled(): Promise<void> {
    if (!this.staleHeld) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const waiting = this.waiters
    this.waiters = []
    for (const resolve of waiting) resolve()
  }

  private take(answer: CurationStateResult): void {
    const first = this.answerHeld === null
    this.answerHeld = answer
    this.staleHeld = false
    this.errorHeld = null
    if (first) this.orderHeld = this.freshOrder(answer)
    else this.orderHeld = this.keptOrder(answer)
    this.previousOwner = Array.from(answer.genomeOf, (g) => (g < 0 ? null : answer.genomes[g].id))
    this.previousKind = new Map(answer.genomes.map((genome) => [genome.id, genome.kind]))
    this.pruneSelection(answer)
    this.release()
    this.emit('state')
  }

  // -------------------------------------------------------------------------
  // The order.
  // -------------------------------------------------------------------------

  /** The genomes' ids in the order the stage lays them out: MAGs, then elements. */
  get order(): readonly string[] {
    return this.orderHeld
  }

  /** The order as indices of the answer's genomes. */
  orderIndices(): number[] {
    const answer = this.answerHeld
    if (answer === null) return []
    const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
    return this.orderHeld.map((id) => index.get(id)).filter((g): g is number => g !== undefined)
  }

  /** Lay the genomes out afresh: densest pairs side by side (`curate/order.ts`). */
  reorder(): void {
    if (this.answerHeld === null) return
    this.orderHeld = this.freshOrder(this.answerHeld)
    this.emit('state')
  }

  private freshOrder(answer: CurationStateResult): string[] {
    const size = (g: number): number => answer.genomes[g].length
    const mags: number[] = []
    const elements: number[] = []
    answer.genomes.forEach((genome, g) => (genome.kind === 'mag' ? mags : elements).push(g))
    const magOrder = chainOrder(mags, answer.pairs, size)
    const elementsOrder = elementOrder(elements, magOrder, answer.pairs, size)
    return [...magOrder, ...elementsOrder].map((g) => answer.genomes[g].id)
  }

  private keptOrder(answer: CurationStateResult): string[] {
    // A genome whose kind changed goes to its new kind's block, as new.
    const before = this.orderHeld.filter((id) => {
      const genome = answer.genomes.find((g) => g.id === id)
      return genome === undefined || this.previousKind.get(id) === genome.kind
    })
    const from = new Map<string, string[]>()
    answer.genomeOf.forEach((g, c) => {
      if (g < 0) return
      const id = answer.genomes[g].id
      const was = this.previousOwner[c] ?? null
      if (was === null || was === id) return
      const list = from.get(id)
      if (list === undefined) from.set(id, [was])
      else if (!list.includes(was)) list.push(was)
    })
    const kept = keepOrder(
      before,
      answer.genomes.map((genome) => ({ id: genome.id, kind: genome.kind, from: from.get(genome.id) ?? [] })),
    )
    // MAGs stay ahead of the elements, whatever a source's place.
    const kind = new Map(answer.genomes.map((genome) => [genome.id, genome.kind]))
    return [...kept.filter((id) => kind.get(id) === 'mag'), ...kept.filter((id) => kind.get(id) === 'element')]
  }

  // -------------------------------------------------------------------------
  // Selection and hover.
  // -------------------------------------------------------------------------

  get selection(): CurateSelection {
    return this.selectionHeld
  }

  /** Select genomes by id. */
  selectGenomes(ids: Iterable<string>, how: SelectHow = 'replace'): void {
    this.setSelection({ genomes: combine(this.selectionHeld.genomes, [...ids], how), contigs: how === 'replace' ? [] : this.selectionHeld.contigs })
  }

  /** Select contigs by index of the file's. */
  selectContigs(contigs: Iterable<number>, how: SelectHow = 'replace'): void {
    const next = combine(this.selectionHeld.contigs, [...contigs], how).sort((a, b) => a - b)
    this.setSelection({ genomes: how === 'replace' ? [] : this.selectionHeld.genomes, contigs: next })
  }

  /** Select exactly these genomes and contigs. */
  select(selection: CurateSelection): void {
    this.setSelection({ genomes: [...new Set(selection.genomes)], contigs: [...new Set(selection.contigs)].sort((a, b) => a - b) })
  }

  clearSelection(): void {
    this.setSelection({ genomes: [], contigs: [] })
  }

  private setSelection(next: CurateSelection): void {
    const now = this.selectionHeld
    if (sameList(now.genomes, next.genomes) && sameList(now.contigs, next.contigs)) return
    this.selectionHeld = next
    this.emit('selection')
  }

  /** Drop from the selection what no longer exists. */
  private pruneSelection(answer: CurationStateResult): void {
    const ids = new Set(answer.genomes.map((genome) => genome.id))
    const genomes = this.selectionHeld.genomes.filter((id) => ids.has(id))
    if (genomes.length !== this.selectionHeld.genomes.length) this.selectionHeld = { genomes, contigs: this.selectionHeld.contigs }
  }

  /** What is under the pointer: a genome by id, a contig by index, or nothing. */
  hover(genome: string | null, contig = -1): void {
    if (genome === this.hoverGenome && contig === this.hoverContig) return
    this.hoverGenome = genome
    this.hoverContig = contig
    this.emit('hover')
  }

  get hovered(): { genome: string | null; contig: number } {
    return { genome: this.hoverGenome, contig: this.hoverContig }
  }

  // -------------------------------------------------------------------------
  // Suggestions.
  // -------------------------------------------------------------------------

  get mode(): CurateMode {
    return this.modeHeld
  }

  setMode(mode: CurateMode): void {
    if (mode === this.modeHeld) return
    this.modeHeld = mode
    if (mode !== 'auto' && this.autoRun !== null) this.autoRun.stopped = true
    this.currentKey = mode === 'review' ? (this.offered()[0]?.key ?? null) : null
    this.emit('mode')
  }

  /**
   * The suggestions on offer — at {@link OFFER_FLOOR} or more and not turned
   * down — in the order a curator answers them: the likely ones first, and
   * among them the merges, then the moves, the recruits and the host links,
   * since a merge changes every affinity of the genome it makes (on MM133 one
   * merge answers eighteen moves between three fragments); the surest first
   * within a kind.
   */
  offered(): Suggestion[] {
    const answer = this.answerHeld
    if (answer === null) return []
    const rejected = new Set(this.store.learned.rejected)
    return answer.suggestions.filter((s) => s.confidence >= OFFER_FLOOR && !rejected.has(s.key)).sort(queueOrder)
  }

  /** The suggestions on offer at {@link LIKELY} or more. */
  likely(): Suggestion[] {
    return this.offered().filter((s) => s.confidence >= LIKELY)
  }

  /** The suggestions auto would take: at {@link AUTO_THRESHOLD} or more. */
  sure(): Suggestion[] {
    return this.offered().filter((s) => s.confidence >= AUTO_THRESHOLD)
  }

  /** The keys turned down, with the suggestion where it is still made. */
  declined(): Array<{ key: string; suggestion: Suggestion | null }> {
    const answer = this.answerHeld
    const byKey = new Map((answer?.suggestions ?? []).map((s) => [s.key, s]))
    return this.store.learned.rejected.map((key) => ({ key, suggestion: byKey.get(key) ?? null }))
  }

  /** The suggestion in review: the one chosen if it is still on offer, else the surest. */
  get current(): Suggestion | null {
    if (this.modeHeld !== 'review') return null
    const offered = this.offered()
    return offered.find((s) => s.key === this.currentKey) ?? offered[0] ?? null
  }

  /** Review the suggestion with this key. */
  setCurrent(key: string): void {
    if (key === this.currentKey) return
    this.currentKey = key
    this.emit('current')
  }

  /** The next suggestion on offer in review, or the previous one; wraps. */
  moveCurrent(by: 1 | -1): void {
    const offered = this.offered()
    if (offered.length === 0) return
    const at = Math.max(0, offered.findIndex((s) => s.key === this.current?.key))
    this.currentKey = offered[(at + by + offered.length) % offered.length].key
    this.emit('current')
  }

  /** Take a suggestion: its step, marked as the suggestion's, and the answer learned. */
  accept(suggestion: Suggestion, by: 'suggestion' | 'auto' = 'suggestion'): void {
    const learned = this.learnedFrom(suggestion, true)
    this.store.apply(suggestion.step, by, describeSuggestion(suggestion))
    this.store.keepLearned(learned)
    if (this.modeHeld === 'review' && this.currentKey === suggestion.key) this.currentKey = null
  }

  /** Turn a suggestion down: it is not offered again, and the answer is learned. */
  reject(suggestion: Suggestion): void {
    const learned = this.learnedFrom(suggestion, false)
    if (!learned.rejected.includes(suggestion.key)) learned.rejected = [...learned.rejected, suggestion.key]
    if (this.modeHeld === 'review' && this.currentKey === suggestion.key) {
      // The next one along, before this one leaves the list.
      const offered = this.offered()
      const at = offered.findIndex((s) => s.key === suggestion.key)
      this.currentKey = offered[at + 1]?.key ?? offered[at - 1]?.key ?? null
    }
    this.store.keepLearned(learned)
  }

  /** Offer a suggestion turned down again. */
  restore(key: string): void {
    const learned = this.store.learned
    if (!learned.rejected.includes(key)) return
    this.store.keepLearned({ ...learned, rejected: learned.rejected.filter((k) => k !== key) })
  }

  /** Forget what the answers taught: the initial weights, nothing turned down. */
  forgetLearned(): void {
    this.store.keepLearned({ weights: {}, answers: 0, rejected: [] })
  }

  /** How many answers taught the weights. */
  get answers(): number {
    return this.store.learned.answers
  }

  private learnedFrom(suggestion: Suggestion, accepted: boolean): CurationLearned {
    const learned = this.store.learned
    // An unlink is a link's confidence the other way round: taking one says the
    // link was wrong.
    const kind: LearnedKind = suggestion.kind === 'unlink' ? 'link' : suggestion.kind
    const yes = suggestion.kind === 'unlink' ? !accepted : accepted
    const weights = learned.weights[kind] ?? INITIAL_WEIGHTS[kind]
    return {
      weights: { ...learned.weights, [kind]: learn(kind, weights, suggestion.features, yes) },
      answers: learned.answers + 1,
      rejected: [...learned.rejected],
    }
  }

  /** Whether auto is taking suggestions. */
  get running(): boolean {
    return this.autoRun !== null
  }

  /**
   * Take every suggestion at {@link AUTO_THRESHOLD} or more, the surest first,
   * one step each, counting again between two — what one takes changes what
   * the next is. Stops when none is left, at {@link AUTO_MOST} steps, or when
   * stopped; never takes one suggestion twice.
   *
   * @returns The steps it made.
   */
  async runAuto(most = AUTO_MOST): Promise<number> {
    if (this.autoRun !== null) return 0
    const run = { stopped: false }
    this.autoRun = run
    this.emit('mode')
    const taken = new Set<string>()
    let steps = 0
    try {
      while (!run.stopped && steps < most) {
        await this.settled()
        if (run.stopped || this.disposed || this.errorHeld !== null) break
        const best = this.sure().find((s) => !taken.has(s.key))
        if (best === undefined) break
        taken.add(best.key)
        this.accept(best, 'auto')
        steps++
      }
    } finally {
      if (this.autoRun === run) this.autoRun = null
      if (!this.disposed) this.emit('mode')
    }
    return steps
  }

  /** Stop an auto run after the step it is making. */
  stopAuto(): void {
    if (this.autoRun !== null) this.autoRun.stopped = true
  }

  // -------------------------------------------------------------------------
  // Acts: each one step, made by the reader.
  // -------------------------------------------------------------------------

  private genome(id: string): CurationStateResult['genomes'][number] | undefined {
    return this.answerHeld?.genomes.find((genome) => genome.id === id)
  }

  private namesOf(contigs: readonly number[]): string[] {
    const names = this.store.file.names
    return contigs.map((c) => names[c]).filter((name): name is string => name !== undefined)
  }

  /** Move the selected contigs to a genome, or to the pool (`null`). */
  moveSelected(to: string | null): boolean {
    const contigs = this.selectionHeld.contigs
    if (contigs.length === 0) return false
    if (to !== null && this.genome(to) === undefined) return false
    this.store.apply({ op: 'move', contigs: this.namesOf(contigs), to })
    this.selectionHeld = { genomes: to === null ? [] : [to], contigs }
    this.emit('selection')
    return true
  }

  /** Make a new genome of the selected contigs. */
  createFromSelected(kind: GenomeKind, name?: string): string | null {
    const contigs = this.selectionHeld.contigs
    if (contigs.length === 0) return null
    const minted = this.mint(kind)
    const wanted = name !== undefined && name.trim() !== '' ? name.trim() : minted.name
    this.store.apply({ op: 'create', id: minted.id, name: wanted, kind, contigs: this.namesOf(contigs) })
    this.selectionHeld = { genomes: [minted.id], contigs }
    this.emit('selection')
    return minted.id
  }

  /** A fresh id for a genome a step would create, and the name it would get. */
  mint(kind: GenomeKind): { id: string; name: string } {
    const id = this.mintId()
    return { id, name: `curated_${kind === 'mag' ? 'MAG' : 'element'}_${id.slice(MINTED.length)}` }
  }

  /** What dropping `dragged` on `target` would make (`curate/drop.ts`); `null` before the first count. */
  dropPlan(dragged: CurateDragged, target: CurateDropTarget): DropPlan | null {
    if (this.answerHeld === null) return null
    return dropPlan(dragged, target, this.answerHeld, this.store.file.names, (kind) => this.mint(kind))
  }

  /** Drop `dragged` on `target`: its steps made, the selection on what they leave. */
  drop(dragged: CurateDragged, target: CurateDropTarget): boolean {
    const plan = this.dropPlan(dragged, target)
    if (plan === null || plan.refused !== undefined) return false
    const steps = plan.steps
    if (steps.length === 1) this.store.apply(steps[0])
    else this.store.applyAll(steps.map((step) => ({ step })))
    const first = steps[0]
    let next: CurateSelection
    if (dragged.kind === 'contigs') {
      const genome = first.op === 'move' ? first.to : first.op === 'create' ? first.id : null
      next = { genomes: genome === null ? [] : [genome], contigs: [...dragged.contigs] }
    } else if (first.op === 'merge') next = { genomes: [first.into], contigs: [] }
    else if (first.op === 'dissolve') next = { genomes: [], contigs: [] }
    else next = { genomes: [...dragged.ids], contigs: [] }
    this.select(next)
    return true
  }

  /** Merge the selected genomes into the longest of them, which keeps its name. */
  mergeSelected(into?: string): boolean {
    const ids = this.selectionHeld.genomes.filter((id) => this.genome(id) !== undefined)
    if (ids.length < 2) return false
    const survivor = into !== undefined && ids.includes(into) ? into : [...ids].sort((a, b) => (this.genome(b)?.length ?? 0) - (this.genome(a)?.length ?? 0))[0]
    this.store.apply({ op: 'merge', into: survivor, genomes: ids.filter((id) => id !== survivor) })
    this.selectionHeld = { genomes: [survivor], contigs: [] }
    this.emit('selection')
    return true
  }

  /** Send the selected genomes' contigs to the pool. */
  dissolveSelected(): boolean {
    const ids = this.selectionHeld.genomes.filter((id) => this.genome(id) !== undefined)
    if (ids.length === 0) return false
    this.store.applyAll(ids.map((genome) => ({ step: { op: 'dissolve', genome } as CurationStep })))
    this.selectionHeld = { genomes: [], contigs: [] }
    this.emit('selection')
    return true
  }

  /** Rename a genome; refused, with the reason, for a name {@link nameRefusal} refuses. */
  rename(id: string, name: string): string | null {
    const wanted = name.trim()
    const refused = nameRefusal(wanted, this.answerHeld?.genomes.filter((genome) => genome.id !== id).map((genome) => genome.name) ?? [])
    if (refused !== null) return refused
    if (this.genome(id)?.name === wanted) return null
    this.store.apply({ op: 'rename', genome: id, name: wanted })
    return null
  }

  /** Make the selected genomes MAGs, or elements. */
  retypeSelected(kind: GenomeKind): boolean {
    const ids = this.selectionHeld.genomes.filter((id) => {
      const genome = this.genome(id)
      return genome !== undefined && genome.kind !== kind
    })
    if (ids.length === 0) return false
    this.store.applyAll(ids.map((genome) => ({ step: { op: 'retype', genome, kind } as CurationStep })))
    return true
  }

  /** Link an element to a MAG, or undo a link. */
  link(element: string, mag: string, on: boolean): boolean {
    const e = this.genome(element)
    const m = this.genome(mag)
    if (e?.kind !== 'element' || m?.kind !== 'mag') return false
    const linked = this.answerHeld?.links.some((link) => link.element === element && link.mag === mag) ?? false
    if (linked === on) return false
    this.store.apply(on ? { op: 'link', element, mag } : { op: 'unlink', element, mag })
    return true
  }

  undo(): void {
    this.store.undo()
  }

  redo(): void {
    this.store.redo()
  }

  goTo(count: number): void {
    this.store.goTo(count)
  }

  /** A fresh id for a genome a step creates: one no genome of the file and no step has. */
  private mintId(): string {
    const taken = new Set(this.store.file.genomes.map((genome) => genome.name))
    for (const entry of this.store.curation.history) if (entry.step.op === 'create') taken.add(entry.step.id)
    for (let n = 1; ; n++) if (!taken.has(`${MINTED}${n}`)) return `${MINTED}${n}`
  }

  // -------------------------------------------------------------------------
  // The tally.
  // -------------------------------------------------------------------------

  /** What the curation changed since the file, for the stage's running tally. */
  tally(): CurateTally | null {
    const answer = this.answerHeld
    if (answer === null) return null
    const file = this.store.file
    let contigsMoved = 0
    let basesMoved = 0
    answer.genomeOf.forEach((g, c) => {
      const now = g < 0 ? null : answer.genomes[g].id
      const was = file.genomeOf[c] < 0 ? null : file.genomes[file.genomeOf[c]].name
      if (now !== was) {
        contigsMoved++
        basesMoved += file.lengths[c] ?? 0
      }
    })
    const fileIds = new Set(file.genomes.map((genome) => genome.name))
    const liveIds = new Set(answer.genomes.map((genome) => genome.id))
    const fileLinks = new Set(file.links.map((link) => `${link.element}\t${link.mag}`))
    const liveLinks = new Set(answer.links.map((link) => `${link.element}\t${link.mag}`))
    return {
      steps: this.store.applied,
      contigsMoved,
      basesMoved,
      asInFile: answer.genomes.filter((genome) => genome.asInFile).length,
      changed: answer.genomes.filter((genome) => !genome.asInFile && fileIds.has(genome.id)).length,
      created: answer.genomes.filter((genome) => !fileIds.has(genome.id)).length,
      gone: [...fileIds].filter((id) => !liveIds.has(id)).length,
      linksAdded: [...liveLinks].filter((key) => !fileLinks.has(key)).length,
      linksDropped: [...fileLinks].filter((key) => !liveLinks.has(key)).length,
    }
  }
}

/**
 * Why a genome cannot have this name, or `null`: metacooler takes ASCII names
 * only, metaTOR's host lists split on commas, and a word a table means *no
 * genome* by (`NA`, `nan`, `-1`, `__unbinned__`, …, in any case) would be read
 * by `metacooler reassign` as the pool.
 */
export function nameRefusal(name: string, others: readonly string[]): string | null {
  if (name === '') return 'A genome needs a name.'
  if (UNBINNED_WORDS.has(name.toLowerCase())) return `${name} is how a table says unbinned: metacooler would read this genome as none.`
  if (/[^\x21-\x7e]/.test(name)) return 'Names go to metacooler, which takes ASCII letters, digits and signs, without spaces.'
  if (name.includes(',')) return 'A name holds no comma: metaTOR lists genomes with them.'
  if (others.includes(name)) return `Another genome is named ${name}.`
  return null
}

/** The words a contigs table means *no genome* by (metacooler's `_UNBINNED_SENTINELS`). */
const UNBINNED_WORDS = new Set([UNBINNED.toLowerCase(), 'na', 'nan', 'n/a', 'nd', 'n/d', '-1'])

/** Where each kind is answered in the queue: what changes the most first. */
const KIND_RANK: Record<Suggestion['kind'], number> = { merge: 0, move: 1, recruit: 2, link: 3, unlink: 3 }

/** The queue's order (see {@link CurateModel.offered}). */
export function queueOrder(a: Suggestion, b: Suggestion): number {
  const likelyA = a.confidence >= LIKELY ? 0 : 1
  const likelyB = b.confidence >= LIKELY ? 0 : 1
  return likelyA - likelyB || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.confidence - a.confidence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

/** A suggestion as the history keeps it: its words, its confidence, what it rested on. */
export function describeSuggestion(suggestion: Suggestion): string {
  const parts = [suggestion.words, `${displayPercent(suggestion.confidence)}%`, ...suggestion.evidence]
  return parts.join(' · ')
}

/** A confidence as a whole percent, never 100 — no suggestion is certain. */
export function displayPercent(confidence: number): number {
  return Math.min(99, Math.max(0, Math.round(confidence * 100)))
}

function combine<T>(now: readonly T[], given: readonly T[], how: SelectHow): T[] {
  if (how === 'replace') return [...new Set(given)]
  const out = [...now]
  const present = new Set(now)
  for (const item of given) {
    if (present.has(item)) {
      if (how === 'toggle') {
        const at = out.indexOf(item)
        if (at >= 0) out.splice(at, 1)
        present.delete(item)
      }
    } else {
      out.push(item)
      present.add(item)
    }
  }
  return out
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, k) => item === b[k])
}
