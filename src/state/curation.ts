/**
 * The curation of one open metagenome's binning (SPECS §33.2): its history,
 * where the cursor stands in it, and the curated binning it folds into.
 *
 * A fact about the file, kept as the reference edit is (`state/referenceEdit.ts`):
 * per file in `UiMemory`, carried in an exported workspace and a shared link, and
 * not in the view state. Everything a step does goes through here, so the stage,
 * the heading's word on the genomes and the session hear of it from one place.
 *
 * **Kept, not applied, where it does not fit.** A curation carries the
 * fingerprint of the binning it was made on; a stored one that does not match
 * the file it is keyed under — a `reassign` since, another run of the binner —
 * is held untouched and reported ({@link CurationStore.refusal}), never applied
 * and never overwritten until the reader makes a new step.
 *
 * **A dev feature** (§29): nothing reads or writes this while the switch is off,
 * and the record it left stays in storage untouched.
 */

import {
  CuratedBinning,
  curationMismatch,
  curationRedone,
  curationUndone,
  emptyCuration,
  readCuration,
  withCurationStep,
  type BaseBinning,
  type Curation,
  type CurationStep,
  type FileBinning,
} from '../genome/curation'
import type { StepAuthor } from '../genome/history'
import { recall, remember } from './UiMemory'

/** The `UiMemory` scope a curation is kept under. Also in `SessionConfig`'s table. */
export const CURATION_SCOPE = 'map:curation'

/** The scope what the review taught about a file is kept under (§33.6). */
export const CURATION_LEARNED_SCOPE = 'map:curation-learned'

/** The kinds of suggestion whose confidence the review re-tunes. */
export type LearnedKind = 'merge' | 'recruit' | 'move' | 'link'

/**
 * What the reader's answers taught the stage about one file's binning: each
 * kind's weights where answers moved them, how many answers, and the
 * suggestions turned down, by their keys — so one turned down stays turned
 * down after another step, and what a curation taught is there next time.
 */
export interface CurationLearned {
  weights: Partial<Record<LearnedKind, number[]>>
  answers: number
  rejected: string[]
}

const KINDS: readonly LearnedKind[] = ['merge', 'recruit', 'move', 'link']

/** A stored record of what was learned, checked on the way in. */
export function readCurationLearned(stored: unknown): CurationLearned {
  const none: CurationLearned = { weights: {}, answers: 0, rejected: [] }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return none
  const value = stored as Record<string, unknown>
  const weights: CurationLearned['weights'] = {}
  const kept = value['weights']
  if (kept !== null && typeof kept === 'object' && !Array.isArray(kept)) {
    for (const kind of KINDS) {
      const w = (kept as Record<string, unknown>)[kind]
      if (Array.isArray(w) && w.length > 0 && w.every((x) => typeof x === 'number' && Number.isFinite(x))) weights[kind] = w as number[]
    }
  }
  const answers = value['answers']
  const rejected = value['rejected']
  return {
    weights,
    answers: typeof answers === 'number' && Number.isInteger(answers) && answers >= 0 ? answers : 0,
    rejected: Array.isArray(rejected) ? rejected.filter((key): key is string => typeof key === 'string') : [],
  }
}

/** Whether a learned record holds nothing: none is kept then. */
export function learnedNothing(learned: CurationLearned): boolean {
  return Object.keys(learned.weights).length === 0 && learned.answers === 0 && learned.rejected.length === 0
}

/** The curation of one open file. */
export class CurationStore {
  private held: Curation
  private folded: CuratedBinning | null = null
  private readonly listeners = new Set<() => void>()
  /** Why a stored curation is not applied here, or `null`. */
  readonly refusal: string | null

  /**
   * @param base The file's binning, read from the file itself — never from
   *   tables already answered through a curation's lens.
   * @param file Its fingerprint, which a kept curation is checked against.
   */
  constructor(
    private readonly key: string,
    private readonly base: BaseBinning,
    file: FileBinning,
    private readonly clock: () => number = () => Date.now(),
  ) {
    const stored = readCuration(recall<unknown>(key, CURATION_SCOPE))
    const wrong = stored === null ? null : curationMismatch(stored, file)
    this.refusal = wrong === null ? null : `The curation kept for this file was made on another binning: ${wrong}.`
    this.held = stored !== null && wrong === null ? stored : emptyCuration(file)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The curation as it stands, history and cursor. */
  get curation(): Curation {
    return this.held
  }

  /** The curated binning the applied steps fold into. */
  get binning(): CuratedBinning {
    this.folded ??= CuratedBinning.of(this.base, this.held)
    return this.folded
  }

  /** The file's binning, which the steps fold from. */
  get file(): BaseBinning {
    return this.base
  }

  /** Steps applied — what the heading's word counts. */
  get applied(): number {
    return this.held.cursor
  }

  get canUndo(): boolean {
    return this.held.cursor > 0
  }

  get canRedo(): boolean {
    return this.held.cursor < this.held.history.length
  }

  /** The binning with one more step, as a preview: nothing is kept. */
  tentative(step: CurationStep): CuratedBinning {
    return CuratedBinning.of(this.base, withCurationStep(this.held, step, 'reader', this.clock()))
  }

  /**
   * Make a step. Steps that had been undone are dropped, as every editor drops them.
   *
   * @param suggestion For a step a suggestion made, the suggestion as the
   *   history keeps it: what it was, and what it rested on.
   */
  apply(step: CurationStep, by: StepAuthor = 'reader', suggestion?: string): void {
    this.set(withCurationStep(this.held, step, by, this.clock(), suggestion))
  }

  /** Several steps as one history entry each, told to the listeners once. */
  applyAll(steps: ReadonlyArray<{ step: CurationStep; by?: StepAuthor; suggestion?: string }>): void {
    let next = this.held
    for (const { step, by, suggestion } of steps) next = withCurationStep(next, step, by ?? 'reader', this.clock(), suggestion)
    this.set(next)
  }

  undo(): void {
    this.set(curationUndone(this.held))
  }

  redo(): void {
    this.set(curationRedone(this.held))
  }

  /** Move the cursor to just after `count` steps — a row of the history, pressed. */
  goTo(count: number): void {
    const cursor = Math.max(0, Math.min(this.held.history.length, Math.trunc(count)))
    if (cursor === this.held.cursor) return
    this.set({ ...this.held, cursor })
  }

  /** Back to the file's binning: every step undone, and kept to be redone. */
  revert(): void {
    this.goTo(0)
  }

  /** Replace the lot — how an imported workspace arrives. */
  replace(curation: Curation): void {
    this.set(curation)
  }

  /** What the review has taught the stage about this file (§33.6). */
  get learned(): CurationLearned {
    return readCurationLearned(recall<unknown>(this.key, CURATION_LEARNED_SCOPE))
  }

  /** Keep what was learned; nothing at all where nothing was. */
  keepLearned(learned: CurationLearned): void {
    remember(this.key, CURATION_LEARNED_SCOPE, learnedNothing(learned) ? null : learned)
    for (const listener of this.listeners) listener()
  }

  private set(next: Curation): void {
    if (next === this.held) return
    this.held = next
    this.folded = null
    // An empty history is not kept at all, so a file nobody curated leaves no
    // record — and a workspace from it carries no `curation` field.
    remember(this.key, CURATION_SCOPE, next.history.length === 0 ? null : next)
    for (const listener of this.listeners) listener()
  }
}

/** The curation kept for a file with steps applied, read without being checked — what an open asks to draw. */
export function keptCuration(key: string): Curation | null {
  const stored = readCuration(recall<unknown>(key, CURATION_SCOPE))
  return stored !== null && stored.cursor > 0 ? stored : null
}
