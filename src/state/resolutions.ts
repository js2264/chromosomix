/**
 * Resolutions the reader has added to a file's ladder (§3.4, §5.5).
 *
 * The file's own rungs are a fact about the file: whoever ran `cooler zoomify`
 * chose them, they are in the HDF5, and this application only ever lists them.
 * A *derived* rung is a fact about the reader — *I want to look at this map at
 * 10 kb* — and it is kept exactly where every other such fact is kept: per file,
 * for the session, carried in an exported workspace, alongside the sequences
 * somebody declared circular (`state/circular.ts`, whose argument this is and
 * which is worth reading beside this).
 *
 * **Not in the view state**, and the line between the two is the same one the
 * file's own ladder already draws. *Which rungs exist* is the ladder; *which one
 * you are standing on* is the picture. The stored ladder rides in the URI
 * (`file.mcool::resolutions/2000`) and a reader's addition rides here; which rung
 * is on screen rides in the hash either way — `ViewState.coarsen` for a derived
 * one, the URI's own entry for a stored one. So a link opens on the resolution
 * it was made at whether or not its recipient has ever added one, and the
 * recipient's own ladder is not rewritten by somebody else's link.
 *
 * **Bin sizes rather than names**, unlike the entry names the stored ladder uses.
 * A derived rung has no entry: there is nothing in the file called `3000` and
 * there never will be. What it has is a number of base pairs, which is the thing
 * that has to be re-checked against whatever ladder is actually open
 * (`metacooler/coarsen.ts`) — and re-checking is why the list is kept as the
 * reader's *request* rather than as a resolved plan. A `.mmetacool` entry with a
 * coarser ladder cannot serve a 3 kb rung; the declaration survives and is
 * simply not offered there, which is what happens when the reader navigates
 * back.
 */

import { recall, remember } from './UiMemory'

/** The `UiMemory` scope this is kept under. Also in `SessionConfig`'s table. */
export const RESOLUTIONS_SCOPE = 'map:resolutions'

/**
 * How many a reader may add to one file.
 *
 * The picker is a row of stops on a breadcrumb and already thins itself past six
 * (`ui/Breadcrumb.ts`); a ladder that could grow without limit would be a slider
 * with a hundred notches and a `+` button that never stopped promising. Twelve is
 * more than anybody has ever wanted and still a number, which is the point of
 * having one at all.
 */
export const MAX_DERIVED_RUNGS = 12

/**
 * The resolutions one open file has been given.
 *
 * One instance per file, held by the session, persisting on every change — so
 * what storage holds *is* the answer and a config built from storage cannot
 * drift from what a reload would restore.
 */
export class ResolutionStore {
  private sizes: number[]
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string) {
    this.sizes = clean(recall<unknown>(key, RESOLUTIONS_SCOPE))
  }

  /** Tell every mounted surface the list changed; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every added bin size, ascending — the order the picker draws them in. */
  list(): number[] {
    return [...this.sizes]
  }

  /** Whether the reader has added this one. */
  has(binsize: number): boolean {
    return this.sizes.includes(binsize)
  }

  /**
   * Add one. `false` where it was already there or the file is full.
   *
   * The caller has already asked {@link derivable} whether the arithmetic works
   * — this is storage and does not re-derive, because it has no ladder to derive
   * against and inventing one here would be a second answer to a question with
   * one right one.
   */
  add(binsize: number): boolean {
    if (!Number.isInteger(binsize) || binsize <= 0) return false
    if (this.sizes.includes(binsize)) return false
    if (this.sizes.length >= MAX_DERIVED_RUNGS) return false
    this.sizes = [...this.sizes, binsize].sort((a, b) => a - b)
    this.persist()
    return true
  }

  /** Take one back off. A no-op where it was not there, so no repaint. */
  remove(binsize: number): void {
    if (!this.sizes.includes(binsize)) return
    this.sizes = this.sizes.filter((size) => size !== binsize)
    this.persist()
  }

  /** Replace the whole list — how an imported workspace arrives. */
  replace(sizes: readonly number[]): void {
    this.sizes = clean(sizes)
    this.persist()
  }

  private persist(): void {
    remember(this.key, RESOLUTIONS_SCOPE, this.list())
    for (const listener of this.listeners) listener()
  }
}

/**
 * A stored list, made safe.
 *
 * Untrusted, like every recalled value: stored state outlives the code that
 * wrote it, and a hand-edited workspace file reaches here too. Sorted and
 * de-duplicated on the way in so that the order the picker draws and the order
 * the config carries are the same order, whatever the file said.
 */
function clean(stored: unknown): number[] {
  if (!Array.isArray(stored)) return []
  const seen = new Set<number>()
  for (const value of stored) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) continue
    seen.add(value)
    if (seen.size >= MAX_DERIVED_RUNGS) break
  }
  return [...seen].sort((a, b) => a - b)
}
