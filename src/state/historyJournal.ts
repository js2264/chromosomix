/**
 * The steps this window's history holds, for the header's list of them (§5.5).
 *
 * Back and forward in the header are the browser's own, and the browser keeps
 * its stack to itself: Chromium's Navigation API lists the entries, and no
 * other engine says anything about them but whether there is one either way.
 * So the app keeps its own record of every entry it writes — the hash, which
 * is the whole of what an entry is here (§5.5) — and each entry carries its
 * place in that record in `history.state`, so a Back, a Forward or a jump the
 * browser performs tells the record where it now stands. The record lives in
 * `sessionStorage`, the window's own, so a reload keeps it as the browser keeps
 * the stack, and it goes with the window.
 *
 * Every step is numbered when it is made, and an entry carries its number
 * rather than its place: the record is capped, and a place would shift under
 * every entry when the oldest is let go. An entry the record cannot find — one
 * written before it existed, or one the reader made in the address bar —
 * starts the record again from where the browser is.
 */

/** One entry of the window's history, as this app wrote it. */
export interface HistoryStep {
  /** The fragment it wrote, with its `#`, or empty for no view. */
  hash: string
}

/** A step behind the one the window is on, and how far behind. */
export interface StepBack {
  step: HistoryStep
  /** What `history.go` is handed to reach it: −1 for the one before. */
  delta: number
}

/** The mark an entry carries in `history.state`. */
interface Mark {
  journal: string
  step: number
}

interface Stored {
  id: string
  next: number
  at: number
  steps: Array<{ n: number; hash: string }>
}

const KEY = 'chromosomix:history'
/** The field of `history.state` the mark is under, so nothing else's state is read as one. */
const FIELD = 'chromosomixStep'
/** How many steps are kept: past this, the oldest go, which no list could show anyway. */
export const MAX_STEPS = 200

export class HistoryJournal {
  private id: string
  private next: number
  private at: number
  private steps: Array<{ n: number; hash: string }>

  /**
   * The record for this window, picked up where a reload left it when the
   * entry the browser is on carries a mark the record knows, and begun afresh
   * otherwise.
   */
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    current: { hash: string; state: unknown },
  ) {
    const stored = readStored(storage)
    const mark = markOf(current.state)
    const index = stored === null || mark === null || mark.journal !== stored.id ? -1 : stored.steps.findIndex((s) => s.n === mark.step)
    if (stored !== null && index >= 0) {
      this.id = stored.id
      this.next = stored.next
      this.steps = stored.steps
      this.at = index
      // The address bar is the truth about the entry the window is on.
      this.steps[index] = { n: this.steps[index].n, hash: current.hash }
    } else {
      this.id = freshId()
      this.next = 1
      this.steps = [{ n: 0, hash: current.hash }]
      this.at = 0
    }
    this.save()
  }

  /** What the entry the window is on carries, for `replaceState` when the app starts. */
  currentState(): Record<string, Mark> {
    return this.stateOf(this.steps[this.at].n)
  }

  /**
   * A new entry, after the one the window is on: what is ahead of it is gone,
   * as it is from the browser's stack. Returns the state `pushState` is given.
   */
  push(hash: string): Record<string, Mark> {
    const n = this.next++
    this.steps = this.steps.slice(0, this.at + 1)
    this.steps.push({ n, hash })
    if (this.steps.length > MAX_STEPS) this.steps = this.steps.slice(this.steps.length - MAX_STEPS)
    this.at = this.steps.length - 1
    this.save()
    return this.stateOf(n)
  }

  /** The entry the window is on, rewritten in place. Returns the state `replaceState` is given. */
  replace(hash: string): Record<string, Mark> {
    const step = this.steps[this.at]
    this.steps[this.at] = { n: step.n, hash }
    this.save()
    return this.stateOf(step.n)
  }

  /**
   * The browser has moved — Back, Forward, a jump, an edit of the address bar —
   * and this is the state of the entry it arrived at.
   *
   * @returns the state to put on that entry where it carried none the record
   * knows: it is then a new step after the one the window was on, which is
   * what an edited address bar is, and `null` where it carried one.
   */
  arrived(state: unknown, hash: string): Record<string, Mark> | null {
    const mark = markOf(state)
    const index = mark === null || mark.journal !== this.id ? -1 : this.steps.findIndex((s) => s.n === mark.step)
    if (index >= 0) {
      this.at = index
      this.save()
      return null
    }
    return this.push(hash)
  }

  /** Every step behind the one the window is on, the nearest first. */
  back(limit = MAX_STEPS): StepBack[] {
    const out: StepBack[] = []
    for (let index = this.at - 1; index >= 0 && out.length < limit; index--) {
      out.push({ step: { hash: this.steps[index].hash }, delta: index - this.at })
    }
    return out
  }

  private stateOf(n: number): Record<string, Mark> {
    return { [FIELD]: { journal: this.id, step: n } }
  }

  private save(): void {
    const value: Stored = { id: this.id, next: this.next, at: this.at, steps: this.steps }
    try {
      this.storage?.setItem(KEY, JSON.stringify(value))
    } catch {
      // A storage that refuses holds nothing: the record lasts this page.
    }
  }
}

function markOf(state: unknown): Mark | null {
  if (typeof state !== 'object' || state === null) return null
  const mark = (state as Record<string, unknown>)[FIELD]
  if (typeof mark !== 'object' || mark === null) return null
  const { journal, step } = mark as { journal?: unknown; step?: unknown }
  return typeof journal === 'string' && typeof step === 'number' ? { journal, step } : null
}

function readStored(storage: Pick<Storage, 'getItem'> | null): Stored | null {
  try {
    const raw = storage?.getItem(KEY)
    if (raw === null || raw === undefined) return null
    const value = JSON.parse(raw) as Partial<Stored>
    if (typeof value.id !== 'string' || typeof value.next !== 'number' || !Array.isArray(value.steps)) return null
    const steps = value.steps.filter(
      (s): s is { n: number; hash: string } =>
        typeof s === 'object' && s !== null && typeof s.n === 'number' && typeof s.hash === 'string',
    )
    if (steps.length === 0) return null
    return { id: value.id, next: value.next, at: 0, steps }
  } catch {
    return null
  }
}

function freshId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
