/**
 * Which sequences of the open file join their own ends.
 *
 * A `.cool` cannot say. The format stores bins from zero to the last one and
 * stops, and there is no field anywhere in it for *and then it starts again* —
 * so a bacterial chromosome, a plasmid, a mitochondrion and a phage all arrive
 * looking exactly like a linear chromosome that happens to be short. Everything
 * the app does with one is then correct and slightly wrong: the map has two
 * artificial corners, the diagonal runs into a wall at each end, every window
 * near either end is dropped by every task for want of a whole window, and the
 * contacts joining the last bin to the first — which on a circle are the most
 * local contacts there are — sit in the far corner of the square.
 *
 * Nobody can infer it from the data either. A circular chromosome's map has a
 * bright far corner; so does a map with a translocation, so does an assembly
 * error, and so does nothing at all if the sample is not very deep. The one
 * thing that reliably knows is **the reader**, who chose the organism.
 *
 * So it is a declaration, and this is where it is kept: a set of sequence names,
 * per file, remembered for the session and carried in an exported workspace. Not
 * in the view state — a bare `#`-hash link names a place and a colour scale
 * (§5.5), and this is a fact about the assembly rather than about the window,
 * in the same category as the tracks somebody loaded and for the same reason it
 * travels in `#session=` rather than beside `region=`.
 *
 * **Names rather than ids**, like everything else this app persists: an id is
 * meaningless against a different rung of the same `.mcool`, and the reader who
 * declares `chrI` circular at 10 kb means it at 1 kb too.
 */

import { recall, remember } from './UiMemory'

/** The `UiMemory` scope this is kept under. Also in `SessionConfig`'s table. */
export const CIRCULAR_SCOPE = 'map:circular'

/**
 * The declared-circular sequences of one open file.
 *
 * One instance per file, held by the session, and it persists on every change —
 * so what storage holds *is* the answer, and a config built from storage cannot
 * drift from what a reload would restore (`state/SessionConfig.ts`).
 */
export class CircularStore {
  private names: Set<string>
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string) {
    const stored = recall<unknown>(key, CIRCULAR_SCOPE)
    // Untrusted, like every recalled value: stored state outlives the code that
    // wrote it, and a hand-edited workspace file reaches here too.
    this.names = new Set(
      Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : [],
    )
  }

  /** Tell every mounted surface the set changed; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Whether the reader has declared this sequence circular. */
  has(name: string): boolean {
    return this.names.has(name)
  }

  /** Every declared name, sorted — which is what goes into a provenance line. */
  list(): string[] {
    return [...this.names].sort()
  }

  /** Declare, or undeclare. A no-op where nothing changes, so no repaint. */
  set(name: string, on: boolean): void {
    if (this.names.has(name) === on) return
    if (on) this.names.add(name)
    else this.names.delete(name)
    this.persist()
  }

  /** Replace the whole set — how an imported workspace arrives. */
  replace(names: readonly string[]): void {
    this.names = new Set(names)
    this.persist()
  }

  private persist(): void {
    remember(this.key, CIRCULAR_SCOPE, this.list())
    for (const listener of this.listeners) listener()
  }
}
