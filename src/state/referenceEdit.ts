/**
 * The edit of one open file's reference (SPECS §27.2): its history, where the
 * cursor stands in it, and the edited assembly it folds into.
 *
 * A fact about the file, like its circular declarations and its origins
 * (`state/circular.ts`, `state/origins.ts`), and kept the same way: per file,
 * remembered for the session, carried in an exported workspace, and **not** in
 * the view state — it is about the molecule rather than the window. Everything
 * a step does goes through here, so the stage, the heading's chip and the
 * console hear of it from one place.
 *
 * **Kept, not applied, where it does not fit.** An edit carries the names and
 * lengths of the assembly it was made on; a stored one that does not match the
 * file it is keyed under — a workspace imported onto another build of the same
 * library — is held untouched and reported ({@link EditStore.refusal}), never
 * applied and never overwritten until the reader starts a new one.
 *
 * **A dev feature** (§29): nothing reads or writes this while the switch is off,
 * and the record it left stays in storage untouched, so turning the switch on
 * brings it back.
 */

import {
  EditedAssembly,
  emptyEdit,
  mismatch,
  redone,
  undone,
  withStep,
  type EditStep,
  type HistoryEntry,
  type OriginalAssembly,
  type ReferenceEdit,
  type StepAuthor,
} from '../genome/edit'
import { recall, remember } from './UiMemory'

/** The `UiMemory` scope this is kept under. Also in `SessionConfig`'s table. */
export const EDIT_SCOPE = 'map:edit'

/**
 * The key one genome's edit of a metagenome is kept under (§27.10): the
 * file's, and the genome — so every genome has an edit of its own, and none
 * is the file's.
 */
export function genomeEditKey(fileKey: string, genome: string): string {
  return `${fileKey}#genome=${genome}`
}

/** The scope what review mode learned about a file is kept under (§27.6). */
export const LEARNED_SCOPE = 'map:edit-learned'

/**
 * What the reader's answers taught the stage about one file (§27.6): the
 * confidence model's weights, how many answers moved them, and the suggestions
 * turned down, by their keys — kept per file beside the edit, so a suggestion
 * turned down stays turned down, and what a curation taught is there next time.
 */
export interface Learned {
  /** `null` for the initial weights: nothing has been answered. */
  weights: number[] | null
  answers: number
  rejected: string[]
}

/** A stored record of what was learned, checked on the way in; nothing learned where it will not read. */
export function readLearned(stored: unknown): Learned {
  const none: Learned = { weights: null, answers: 0, rejected: [] }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return none
  const value = stored as Record<string, unknown>
  const weights = value['weights']
  const answers = value['answers']
  const rejected = value['rejected']
  return {
    weights:
      Array.isArray(weights) && weights.length > 0 && weights.every((w) => typeof w === 'number' && Number.isFinite(w))
        ? (weights as number[])
        : null,
    answers: typeof answers === 'number' && Number.isInteger(answers) && answers >= 0 ? answers : 0,
    rejected: Array.isArray(rejected) ? rejected.filter((key): key is string => typeof key === 'string') : [],
  }
}

/**
 * A stored edit, checked field by field on the way in: storage outlives code,
 * and a workspace is a file somebody may have written by hand.
 */
export function readEdit(stored: unknown): ReferenceEdit | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  const value = stored as Record<string, unknown>
  if (value['version'] !== 1) return null
  const original = value['original'] as Record<string, unknown> | undefined
  const names = original?.['names']
  const lengths = original?.['lengths']
  if (!Array.isArray(names) || !Array.isArray(lengths) || names.length !== lengths.length) return null
  if (!names.every((name) => typeof name === 'string')) return null
  if (!lengths.every((length) => typeof length === 'number' && Number.isFinite(length) && length >= 0)) return null
  const history = value['history']
  if (!Array.isArray(history)) return null
  const entries: HistoryEntry[] = []
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object') return null
    const { step, by, when, suggestion } = entry as Record<string, unknown>
    if (step === null || typeof step !== 'object' || typeof (step as { op?: unknown }).op !== 'string') return null
    entries.push({
      step: step as EditStep,
      by: by === 'suggestion' || by === 'auto' ? by : 'reader',
      when: typeof when === 'number' && Number.isFinite(when) ? when : 0,
      ...(typeof suggestion === 'string' ? { suggestion } : {}),
    })
  }
  const cursor = value['cursor']
  const genome = original?.['genome']
  const listed = original?.['elsewhere']
  const elsewhere = Array.isArray(listed)
    ? listed.flatMap((item: unknown) => {
        if (item === null || typeof item !== 'object') return []
        const { name, length, genome: of } = item as Record<string, unknown>
        return typeof name === 'string' && typeof of === 'string' && typeof length === 'number' && Number.isFinite(length) && length > 0
          ? [{ name, length, genome: of }]
          : []
      })
    : []
  return {
    version: 1,
    original: {
      names: names as string[],
      lengths: lengths as number[],
      ...(typeof genome === 'string' ? { genome } : {}),
      ...(elsewhere.length > 0 ? { elsewhere } : {}),
    },
    history: entries,
    cursor:
      typeof cursor === 'number' && Number.isInteger(cursor) ? Math.max(0, Math.min(entries.length, cursor)) : entries.length,
  }
}

/** The edit of one open file. */
export class EditStore {
  private held: ReferenceEdit
  private folded: EditedAssembly | null = null
  private readonly listeners = new Set<() => void>()
  /** Why a stored edit is not applied here, or `null`. */
  readonly refusal: string | null

  /**
   * @param original What a new edit is made on: the file's sequences, or one
   *   genome's of a metagenome.
   * @param file The file's own sequences, which a kept edit is checked
   *   against — `original`, where the edit is of the whole file.
   */
  constructor(
    private readonly key: string,
    original: OriginalAssembly,
    private readonly clock: () => number = () => Date.now(),
    file: OriginalAssembly = original,
  ) {
    const stored = readEdit(recall<unknown>(key, EDIT_SCOPE))
    const wrong =
      stored === null
        ? null
        : stored.original.genome !== original.genome
          ? `it is of ${stored.original.genome ?? 'the whole file'}, and this of ${original.genome ?? 'the whole file'}`
          : mismatch(stored, file.names, file.lengths)
    this.refusal = wrong === null ? null : `The edit kept for this file was made on another assembly: ${wrong}.`
    this.held = stored !== null && wrong === null ? stored : emptyEdit(original)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The edit as it stands, history and cursor. */
  get edit(): ReferenceEdit {
    return this.held
  }

  /** The edited assembly the applied steps fold into. */
  get assembly(): EditedAssembly {
    this.folded ??= EditedAssembly.of(this.held)
    return this.folded
  }

  /** Steps applied — what the heading's chip counts. */
  get applied(): number {
    return this.held.cursor
  }

  /** Whether there is a step to undo, and one to redo. */
  get canUndo(): boolean {
    return this.held.cursor > 0
  }
  get canRedo(): boolean {
    return this.held.cursor < this.held.history.length
  }

  /** The edit with one more step, as a preview — nothing is kept. */
  tentative(step: EditStep): ReferenceEdit {
    return withStep(this.held, step, 'reader', this.clock())
  }

  /**
   * Make a step. Any steps that had been undone are dropped, as every editor
   * drops them.
   *
   * @param suggestion For a step a suggestion made, the suggestion as the
   *   history keeps it: what it was, and what it rested on.
   */
  apply(step: EditStep, by: StepAuthor = 'reader', suggestion?: string): void {
    this.set(withStep(this.held, step, by, this.clock(), suggestion))
  }

  /**
   * Bring a contig of another genome into this genome's edit (§27.10): it is
   * made one the edit may name, and a step brings it in, whole, after the
   * others — undone as any step is, and the contig stays one the edit knows.
   */
  bring(contig: { name: string; length: number; genome: string }, by: StepAuthor = 'reader', suggestion?: string): void {
    const original = this.held.original
    if (original.genome === undefined) return
    const known = original.names.includes(contig.name) || (original.elsewhere ?? []).some((held) => held.name === contig.name)
    const edit = known ? this.held : { ...this.held, original: { ...original, elsewhere: [...(original.elsewhere ?? []), { ...contig }] } }
    this.set(withStep(edit, { op: 'bring', sequence: contig.name }, by, this.clock(), suggestion))
  }

  /** What the reader's answers have taught the stage about this file (§27.6). */
  get learned(): Learned {
    return readLearned(recall<unknown>(this.key, LEARNED_SCOPE))
  }

  /** Keep what was learned; nothing at all where nothing was. */
  keepLearned(learned: Learned): void {
    const empty = learned.weights === null && learned.answers === 0 && learned.rejected.length === 0
    remember(this.key, LEARNED_SCOPE, empty ? null : learned)
  }

  undo(): void {
    this.set(undone(this.held))
  }

  redo(): void {
    this.set(redone(this.held))
  }

  /** Move the cursor to just after `count` steps — a row of the history, pressed. */
  goTo(count: number): void {
    const cursor = Math.max(0, Math.min(this.held.history.length, Math.trunc(count)))
    if (cursor === this.held.cursor) return
    this.set({ ...this.held, cursor })
  }

  /**
   * Back to the file: every step undone, and kept to be redone — the heading
   * chip's *revert to the file* is one more undo, not a loss.
   */
  revert(): void {
    this.goTo(0)
  }

  /** Replace the lot — how an imported workspace arrives. */
  replace(edit: ReferenceEdit): void {
    this.set(edit)
  }

  private set(next: ReferenceEdit): void {
    if (next === this.held) return
    this.held = next
    this.folded = null
    // An empty history is not kept at all, so a file nobody edited leaves no
    // record — and a workspace from it carries no `edit` field.
    remember(this.key, EDIT_SCOPE, next.history.length === 0 ? null : next)
    for (const listener of this.listeners) listener()
  }
}

/** Whether the record kept for a file holds any steps — without applying them. */
export function hasStoredEdit(key: string): boolean {
  const stored = readEdit(recall<unknown>(key, EDIT_SCOPE))
  return stored !== null && stored.history.length > 0
}

/** Re-export for callers that only persist. */
export type { ReferenceEdit }
