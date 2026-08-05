/**
 * Which sequences of a genome are being looked at.
 *
 * A genome browser opened on a yeast shows sixteen chromosomes end to end, and
 * that is the right default: it is the only view from which the shape of the
 * assembly is visible at all. It is the wrong view for almost everything after
 * the first ten seconds. Panning along chromosome IV runs off its right-hand end
 * into chromosome V without saying so, and the only way back is to know where
 * the boundary was.
 *
 * So a subset can be *chosen*, and the choice is the axis rather than a filter
 * over one: {@link restrict} returns the assembly narrowed to the ticked
 * sequences, from which the browser builds its {@link LocusAxis} exactly as it
 * builds the whole-genome one. Nothing downstream knows a restriction happened —
 * the axis simply has four segments instead of sixteen, and a pan cannot leave
 * them because there is nothing outside them to leave to (§8.4: one mapping).
 *
 * An empty selection means *all of them*, rather than none. That is the one
 * convention worth stating: it makes the default state and the "show everything
 * again" state the same state, and it means a stored selection naming sequences
 * a later assembly does not have degrades to the whole genome rather than to an
 * empty axis with nothing on it.
 */

import type { Assembly } from './assembly'

export class SequenceSelection {
  private chosen: string[]
  private readonly listeners = new Set<() => void>()

  constructor(
    initial: readonly string[] = [],
    /** Called with the new set whenever it changes; the session persists it. */
    private readonly persist: (names: string[]) => void = () => {},
  ) {
    this.chosen = [...new Set(initial)]
  }

  /** The ticked names. Empty means the whole genome. */
  get names(): readonly string[] {
    return this.chosen
  }

  /** `true` when nothing is ticked, which is what "show everything" looks like. */
  get isWhole(): boolean {
    return this.chosen.length === 0
  }

  has(name: string): boolean {
    return this.chosen.includes(name)
  }

  set(names: readonly string[]): void {
    const next = [...new Set(names)]
    if (next.length === this.chosen.length && next.every((name, i) => name === this.chosen[i])) {
      return
    }
    this.chosen = next
    this.persist(next)
    for (const listener of [...this.listeners]) listener()
  }

  toggle(name: string, on: boolean): void {
    if (on === this.has(name)) return
    this.set(on ? [...this.chosen, name] : this.chosen.filter((held) => held !== name))
  }

  /**
   * Make sure a sequence is on the axis, ticking it if it is not.
   *
   * What "go to chrXII" has to mean when chrXII is not in the selection. The
   * alternative is refusing a coordinate the reader typed, or that a link
   * carried, because of a tick box they may have set an hour ago — and a browser
   * that silently declines to go where it was told reads as broken. Ticking is
   * visible in the card, which is the difference between widening the view and
   * doing something behind the reader's back.
   *
   * A no-op while nothing is ticked, since everything is already on the axis.
   */
  ensure(name: string): void {
    if (this.isWhole || this.has(name)) return
    this.set([...this.chosen, name])
  }

  clear(): void {
    this.set([])
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The assembly narrowed to what is ticked — or the assembly itself.
   *
   * Returned *by identity* when nothing is ticked, when everything is, or when
   * the selection names nothing this assembly has: the caller compares axes to
   * decide whether to rebuild, and a fresh object equal in every field would
   * make every notification a rebuild.
   */
  restrict(assembly: Assembly): Assembly {
    if (this.isWhole) return assembly
    const wanted = new Set(this.chosen)
    const contigs = assembly.contigs.filter((contig) => wanted.has(contig.name))
    if (contigs.length === 0 || contigs.length === assembly.contigs.length) return assembly
    return {
      ...assembly,
      contigs,
      total: contigs.reduce((sum, contig) => sum + contig.length, 0),
    }
  }
}
