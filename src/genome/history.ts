/**
 * A history of steps with a cursor, as the reference edit (§27.2) and the
 * curation of a metagenome's binning (§33.2) both keep one: every step with who
 * made it and when, the steps past the cursor undone and kept to be redone, and
 * a new step dropping them. Pure values: each function returns a new history.
 */

/** Who made a step. */
export type StepAuthor = 'reader' | 'suggestion' | 'auto'

/** A step, with what the history keeps about it. */
export interface HistoryEntryOf<S> {
  step: S
  by: StepAuthor
  /** Milliseconds since the epoch. */
  when: number
  /** The suggestion it was, where it was one: its words, confidence and evidence. */
  suggestion?: string
}

/** A history and how much of it is applied. */
export interface HistoryOf<S> {
  history: HistoryEntryOf<S>[]
  /** How many of {@link history} are applied; undo moves it back. */
  cursor: number
}

/** The history with one more step, dropping any that had been undone. */
export function pushStep<S, H extends HistoryOf<S>>(held: H, step: S, by: StepAuthor, when: number, suggestion?: string): H {
  const history = held.history.slice(0, held.cursor)
  history.push({ step, by, when, ...(suggestion === undefined ? {} : { suggestion }) })
  return { ...held, history, cursor: history.length }
}

/** One step back, or unchanged at the start. */
export function stepBack<H extends HistoryOf<unknown>>(held: H): H {
  return held.cursor === 0 ? held : { ...held, cursor: held.cursor - 1 }
}

/** One step forward again, or unchanged at the end. */
export function stepForward<H extends HistoryOf<unknown>>(held: H): H {
  return held.cursor >= held.history.length ? held : { ...held, cursor: held.cursor + 1 }
}

/** The steps a history applies. */
export function appliedSteps<S>(held: HistoryOf<S>): S[] {
  return held.history.slice(0, held.cursor).map((entry) => entry.step)
}

/** FNV-1a, 32 bits, in base 36: a short name for a text that changes whenever it does. */
export function fnv1a(text: string, seed = 2166136261): string {
  return (fnvHash(text, seed) >>> 0).toString(36)
}

/** FNV-1a's running hash, to fold several texts into one without joining them. */
export function fnvHash(text: string, seed = 2166136261): number {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash
}

/**
 * A history entry read back from storage, a workspace or a link: untrusted, so
 * `by` and `when` fall back to what they would be, and a step that is not an
 * object with a string `op` refuses the whole record — the caller decides what
 * a known op is.
 */
export function readEntry<S>(entry: unknown): HistoryEntryOf<S> | null {
  if (entry === null || typeof entry !== 'object') return null
  const { step, by, when, suggestion } = entry as Record<string, unknown>
  if (step === null || typeof step !== 'object' || typeof (step as { op?: unknown }).op !== 'string') return null
  return {
    step: step as S,
    by: by === 'suggestion' || by === 'auto' ? by : 'reader',
    when: typeof when === 'number' && Number.isFinite(when) ? when : 0,
    ...(typeof suggestion === 'string' ? { suggestion } : {}),
  }
}
