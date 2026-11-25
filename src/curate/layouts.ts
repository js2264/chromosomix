/**
 * The curated genomes as their edits of the reference lay them out (SPECS
 * §27.10, §33.4): what the session draws of each, the edit a genome's stage
 * opens on, and the curation steps that keep a genome's contigs what its edit
 * holds.
 *
 * ## Which contigs a genome has is the curation's
 *
 * A genome's edit orders, turns, joins, cuts and sets aside its contigs; which
 * contigs the genome *has*, the curation says (§33.2). Of what an edit does:
 *
 * - a contig with a stretch **placed** in a sequence, or set aside as
 *   **unplaced**, is the genome's;
 * - a contig every stretch of which is set aside as **debris**, a
 *   **contaminant** or a **haplotig** leaves it, whole: for the genome it was
 *   sent to, or for the pool;
 * - a contig only part of which is set aside stays: membership is per whole
 *   contig, and the stretch is one of the genome's AGP's asides.
 *
 * A step of an edit that changes what it holds is made a curation step as well
 * ({@link mirroredMoves}); a curation step that changes a genome's contigs
 * leaves its edit as it was, and what is drawn follows the curation
 * ({@link drawnLayouts}).
 *
 * ## What is drawn
 *
 * Each genome as its own edit lays it out, kept to the contigs the curation
 * gives it: a sequence is broken where a contig that left was, so that no two
 * stretches are drawn together that the edit did not put together. The
 * layouts of genomes merged away or emptied follow their contigs into the
 * genomes that hold them now, each a block after the genome's own; a contig no
 * layout holds is drawn whole, last, longest first, as the curated map draws
 * every contig (`metacooler/curationLens.ts`). One layout draws a contig, never
 * two — a stretch an edit duplicated is drawn twice, as that edit drew it. A
 * stretch set aside as unplaced is a sequence of its own, named as the AGP
 * names it (`edit/exports.ts`), so that what is drawn is what is written.
 *
 * Pure: no DOM, no worker.
 */

import { UNBINNED, type CuratedBinning, type Curation, type CurationStep } from '../genome/curation'
import {
  EditedAssembly,
  baseName,
  emptyEdit,
  isGap,
  lengthsOf,
  partsLength,
  type Aside,
  type LayoutPart,
  type LayoutStep,
  type Part,
  type Piece,
  type ReferenceEdit,
} from '../genome/edit'
import { fnvHash } from '../genome/history'
import { codePointCompare } from '../metacooler/curationLens'

/** A sequence of a genome as it is drawn: stretches of the file's contigs, and runs of `N`. */
export interface DrawnSequence {
  name: string
  parts: Part[]
  /** Base pairs, gaps included. */
  length: number
  /** A stretch set aside as unplaced, drawn on its own as the AGP writes it. */
  unplaced?: true
}

/** A curated genome drawn otherwise than as its contigs, whole, longest first. */
export interface DrawnLayout {
  /** The id its edit is kept under: the curated genome's (`CuratedGenome.id`). */
  id: string
  /** Its index among the curated binning's genomes. */
  genome: number
  sequences: DrawnSequence[]
  /** Stretches of its contigs set aside as debris, contaminants or haplotigs: drawn nowhere, the AGP's asides. */
  aside: Aside[]
}

/** What an edit holds of its genome's contigs, and which it lets go, whole. */
export interface LayoutMembership {
  /** Contigs with a stretch placed, or set aside as unplaced. */
  held: ReadonlySet<string>
  /**
   * Contigs every stretch of which is set aside otherwise, each with the genome
   * it was sent to, by name — that of its longest stretch, where they differ —
   * or `null` for none.
   */
  released: ReadonlyMap<string, string | null>
}

/** What an edit's assembly holds, and lets go (the module's rules). */
export function layoutMembership(assembly: EditedAssembly): LayoutMembership {
  const held = new Set<string>()
  for (const sequence of assembly.sequences) for (const part of sequence.parts) if (!isGap(part)) held.add(part.sequence)
  for (const item of assembly.aside) if (item.why === 'unplaced') held.add(item.piece.sequence)
  const longest = new Map<string, { length: number; genome: string | null }>()
  for (const item of assembly.aside) {
    const name = item.piece.sequence
    if (held.has(name)) continue
    const length = item.piece.end - item.piece.start
    const best = longest.get(name)
    if (best !== undefined && best.length >= length) continue
    longest.set(name, { length, genome: genomeWord(item.genome) })
  }
  return { held, released: new Map([...longest].map(([name, { genome }]) => [name, genome])) }
}

/** A genome as an aside or a brought contig names it, or `null` for none. */
function genomeWord(genome: string | undefined): string | null {
  return genome === undefined || genome === '' || genome === UNBINNED ? null : genome
}

/** Everything the drawing is made of. */
export interface LayoutInput {
  binning: CuratedBinning
  /** Every contig of the file, in its order. */
  names: readonly string[]
  lengths: ArrayLike<number>
  /** Each genome's kept edit, by the id it is kept under. */
  edits: ReadonlyMap<string, ReferenceEdit>
}

/** A sequence on its way to being drawn: its name is given once every genome's are known. */
interface Pending {
  parts: Part[]
  /** The name it asks for: its edit's, for a sequence's first stretch drawn; `null` for a fresh one. */
  wanted: string | null
  /** The edit's name it descends from, for a fresh one. */
  from: string
  /** Named by the reader, so kept where it can be. */
  named: boolean
  /** The contig of a stretch set aside as unplaced. */
  unplaced: string | null
}

/**
 * Every curated genome drawn otherwise than as its contigs, whole, longest
 * first (the module's rules), in the curated binning's order of genomes, each
 * sequence with a name no other drawn sequence and no other contig of the file
 * has. Empty where no edit changes what is drawn.
 */
export function drawnLayouts(input: LayoutInput): DrawnLayout[] {
  const { binning, names, lengths, edits } = input
  if (edits.size === 0) return []
  const contigIndex = new Map(names.map((name, c) => [name, c]))
  const lengthOf = (name: string): number | undefined => {
    const c = contigIndex.get(name)
    return c === undefined ? undefined : lengths[c]
  }
  // Every edit that folds and applies to the file: one made on another build
  // of the assembly is held untouched by its own stage, and drawn by nobody.
  // `mismatch`'s test, by the index already in hand: it would build one an edit.
  const applies = (edit: ReferenceEdit): boolean => {
    for (const [name, length] of lengthsOf(edit.original)) if (lengthOf(name) !== length) return false
    return true
  }
  const folded = new Map<string, EditedAssembly>()
  for (const [id, edit] of edits) {
    if (edit.cursor === 0 || edit.original.genome !== id) continue
    if (!applies(edit)) continue
    let assembly: EditedAssembly
    try {
      assembly = EditedAssembly.of(edit)
    } catch {
      continue
    }
    if (!assembly.isIdentity) folded.set(id, assembly)
  }
  if (folded.size === 0) return []
  const genomeOfName = (name: string): number => {
    const c = contigIndex.get(name)
    return c === undefined ? -1 : binning.genomeOf[c]
  }
  // The layouts of genomes no longer in the binning, and the genomes now holding their contigs.
  const orphans = [...folded.keys()]
    .filter((id) => binning.indexOfId(id) === undefined)
    .sort(codePointCompare)
    .map((id) => {
      const assembly = folded.get(id) as EditedAssembly
      const into = new Set<number>()
      for (const sequence of assembly.sequences) for (const part of sequence.parts) if (!isGap(part)) into.add(genomeOfName(part.sequence))
      for (const item of assembly.aside) into.add(genomeOfName(item.piece.sequence))
      return { assembly, into }
    })

  const drafts: Array<{ id: string; genome: number; sequences: Pending[]; aside: Aside[] }> = []
  binning.genomes.forEach((genome, g) => {
    const own = folded.get(genome.id)
    const sources = [...(own === undefined ? [] : [own]), ...orphans.filter((orphan) => orphan.into.has(g)).map((orphan) => orphan.assembly)]
    if (sources.length === 0) return
    const claimed = new Map<string, number>()
    const sequences: Pending[] = []
    const aside: Aside[] = []
    sources.forEach((assembly, s) => {
      // A contig of this genome, and not drawn by a layout before this one.
      const mine = (name: string): boolean => genomeOfName(name) === g && (claimed.get(name) ?? s) === s
      const took = new Set<string>()
      for (const sequence of assembly.sequences) {
        const named = sequence.named === true
        // Drawn whole, a sequence keeps its name; broken, a stretch of it is
        // named for its first contig — but for the first of a sequence the
        // reader named, which keeps theirs.
        const intact = sequence.parts.every((part) => isGap(part) || mine(part.sequence))
        let run: Part[] = []
        let drawn = 0
        const close = (): void => {
          while (run.length > 0 && isGap(run[run.length - 1])) run.pop()
          const first = run.find((part) => !isGap(part))
          if (first !== undefined && !isGap(first)) {
            const keeps = intact || (named && drawn === 0)
            sequences.push({ parts: run, wanted: keeps ? sequence.name : null, from: named || intact ? sequence.name : first.sequence, named: named && drawn === 0, unplaced: null })
            drawn++
          }
          run = []
        }
        for (const part of sequence.parts) {
          if (isGap(part)) {
            if (run.length > 0) run.push(part)
            continue
          }
          if (!mine(part.sequence)) {
            close()
            continue
          }
          took.add(part.sequence)
          run.push(part)
        }
        close()
      }
      for (const item of assembly.aside) {
        const name = item.piece.sequence
        if (!mine(name)) continue
        took.add(name)
        if (item.why === 'unplaced') sequences.push({ parts: [{ ...item.piece, strand: 1 }], wanted: null, from: name, named: false, unplaced: name })
        else aside.push(item)
      }
      for (const name of took) if (!claimed.has(name)) claimed.set(name, s)
    })
    // What no layout holds: whole, last, as the curated map draws every contig.
    const order = membersInOrder(binning, g, names, lengths)
    for (let i = 0; i < order.names.length; i++) {
      const name = order.names[i]
      if (claimed.has(name)) continue
      sequences.push({ parts: [{ id: name, sequence: name, start: 0, end: order.lengths[i], strand: 1 }], wanted: name, from: name, named: false, unplaced: null })
    }
    // Drawn as every genome is drawn — a name the reader gave is not.
    const plain =
      aside.length === 0 &&
      sequences.length === order.names.length &&
      sequences.every((sequence, i) => sequence.unplaced === null && !sequence.named && wholeContig(sequence.parts, lengthOf) === order.names[i])
    if (!plain) drafts.push({ id: genome.id, genome: g, sequences, aside })
  })

  // Names: a contig's own for a sequence that is that contig whole, forward;
  // the edit's where no contig of the file and no sequence drawn before has
  // it; a fresh one otherwise, as the stage would give it.
  const used = new Set<string>()
  const free = (name: string): boolean => !contigIndex.has(name) && !used.has(name)
  const fresh = (base: string): string => {
    for (let n = 1; ; n++) {
      const name = `${base}_e${n}`
      if (free(name)) return name
    }
  }
  const unplacedCount = new Map<string, number>()
  return drafts.map((draft) => ({
    id: draft.id,
    genome: draft.genome,
    aside: draft.aside,
    sequences: draft.sequences.map((pending): DrawnSequence => {
      let name: string
      if (pending.unplaced !== null) {
        // `edit/exports.ts`'s `assemblyObjects`: `IV_unplaced1`, `IV_unplaced2`, …
        const base = `${pending.unplaced}_unplaced`
        let k = unplacedCount.get(base) ?? 0
        do {
          k += 1
          name = `${base}${k}`
        } while (!free(name))
        unplacedCount.set(base, k)
      } else {
        const whole = pending.named ? null : wholeContig(pending.parts, lengthOf)
        if (whole !== null && !used.has(whole)) name = whole
        else if (pending.wanted !== null && free(pending.wanted)) name = pending.wanted
        else name = fresh(baseName(pending.from))
      }
      used.add(name)
      return { name, parts: pending.parts, length: partsLength(pending.parts), ...(pending.unplaced === null ? {} : { unplaced: true as const }) }
    }),
  }))
}

/** The contig a run of parts is, whole and forward, or `null`: cut marks do not count, as the stage's own test has it. */
function wholeContig(parts: readonly Part[], lengthOf: (name: string) => number | undefined): string | null {
  let name: string | null = null
  let expected = 0
  for (const part of parts) {
    if (isGap(part) || part.strand !== 1 || part.start !== expected) return null
    if (name !== null && part.sequence !== name) return null
    name = part.sequence
    expected = part.end
  }
  return name !== null && expected === lengthOf(name) ? name : null
}

/** A curated genome's contigs as the curated map lays them out: longest first, a tie by name (§33.4). */
export function membersInOrder(binning: CuratedBinning, genome: number, names: readonly string[], lengths: ArrayLike<number>): { names: string[]; lengths: number[] } {
  const contigs = [...(binning.genomes[genome]?.contigs ?? [])].sort((a, b) => lengths[b] - lengths[a] || codePointCompare(names[a], names[b]))
  return { names: contigs.map((c) => names[c]), lengths: contigs.map((c) => lengths[c]) }
}

/** A short name for what the layouts draw, which changes whenever a drawn sequence does; empty for none. */
export function layoutsFingerprint(layouts: readonly DrawnLayout[]): string {
  if (layouts.length === 0) return ''
  let hash = 2166136261
  for (const layout of layouts) {
    hash = fnvHash(`${layout.id}\n`, hash)
    for (const sequence of layout.sequences) {
      hash = fnvHash(`${sequence.name}\t`, hash)
      for (const part of sequence.parts) {
        hash = fnvHash(isGap(part) ? `N${part.gap},` : `${part.sequence}:${part.start}-${part.end}${part.strand === 1 ? '+' : '-'},`, hash)
      }
      hash = fnvHash('\n', hash)
    }
  }
  return `${layouts.length}:${(hash >>> 0).toString(36)}`
}

/** What a genome's stage opens on, where it is not the kept edit as it is. */
export interface RebaseInput {
  /** The genome's id: the key its edit is kept under. */
  id: string
  /** Its name now, for the history's word on the step. */
  name: string
  /** Its contigs as the curation holds them, in the curated map's order ({@link membersInOrder}). */
  members: { names: readonly string[]; lengths: readonly number[] }
  /** Its kept edit, as its store holds it. */
  kept: ReferenceEdit
  /** How it is drawn ({@link drawnLayouts}), or `null` for its contigs whole, longest first. */
  drawn: DrawnLayout | null
  when: number
}

/**
 * The edit a genome's stage opens on (§27.10): `null` where its kept edit holds
 * exactly the contigs the curation gives it, which the stage opens on as it
 * is, history and all. Otherwise an edit made on those contigs, in the curated
 * map's order, whose one step lays them out as they are drawn — the kept edit
 * kept to them, any genome merged in after, the rest whole — so that the stage
 * shows what the map does, and the history made there goes on from it.
 */
export function rebasedEdit(input: RebaseInput): ReferenceEdit | null {
  const { id, members, kept, drawn } = input
  // An edit of another genome under this one's key is its store's to refuse.
  if (kept.original.genome !== id) return null
  let held: ReadonlySet<string>
  try {
    held = layoutMembership(EditedAssembly.of(kept)).held
  } catch {
    held = new Set()
  }
  if (held.size === members.names.length && members.names.every((name) => held.has(name))) return null
  const fresh = emptyEdit({ names: [...members.names], lengths: [...members.lengths], genome: id })
  if (drawn === null) return fresh
  const layoutPart = (part: Part): LayoutPart => (isGap(part) ? { gap: part.gap } : { sequence: part.sequence, start: part.start, end: part.end, strand: part.strand })
  const asideOf = (piece: Piece, why: Aside['why'], genome?: string): LayoutStep['aside'][number] => ({
    sequence: piece.sequence,
    start: piece.start,
    end: piece.end,
    why,
    ...(genome === undefined ? {} : { genome }),
  })
  const step: LayoutStep = {
    op: 'layout',
    from: `${input.name} as the curation holds it`,
    sequences: drawn.sequences.filter((sequence) => sequence.unplaced !== true).map((sequence) => ({ name: sequence.name, parts: sequence.parts.map(layoutPart) })),
    aside: [
      ...drawn.sequences.filter((sequence) => sequence.unplaced === true).flatMap((sequence) => sequence.parts.flatMap((part) => (isGap(part) ? [] : [asideOf(part, 'unplaced')]))),
      ...drawn.aside.map((item) => asideOf(item.piece, item.why, item.genome)),
    ],
  }
  return { ...fresh, history: [{ step, by: 'auto', when: input.when }], cursor: 1 }
}

/** What a change of a genome's edit is mirrored from. */
export interface MirrorInput {
  /** The genome's id. */
  here: string
  /** What the edit held before the change, and after it ({@link layoutMembership}). */
  before: LayoutMembership
  after: LayoutMembership
  /** The genome each contig the edit brought in came from, by name, as the edit keeps it. */
  origin: ReadonlyMap<string, string>
  /** The curated binning as it stands. */
  binning: CuratedBinning
  /** Every contig of the file, by name. */
  contigIndex: ReadonlyMap<string, number>
}

/**
 * The curation steps a change of a genome's edit makes (§33.2): a contig it
 * now holds moved to the genome; one it let go, whole, moved to the genome it
 * was sent to or to the pool; one it brought in and no longer knows — a bring
 * undone — moved back to where it came from. A move to a genome no longer
 * called what the edit says goes to the pool. A contig the curation has put
 * elsewhere since is the curation's, and left where it is. One step a target.
 */
export function mirroredMoves(input: MirrorInput): CurationStep[] {
  const { here, before, after, origin, binning, contigIndex } = input
  const now = (contig: string): string | null | undefined => {
    const c = contigIndex.get(contig)
    if (c === undefined) return undefined
    const g = binning.genomeOf[c]
    return g < 0 ? null : binning.genomes[g].id
  }
  const target = (name: string | null | undefined): string | null => {
    const word = genomeWord(name ?? undefined)
    return word === null ? null : (binning.idOfName(word) ?? null)
  }
  const moves = new Map<string | null, string[]>()
  const send = (contig: string, to: string | null): void => {
    const at = now(contig)
    if (at === undefined || at === to) return
    const list = moves.get(to) ?? []
    if (!list.includes(contig)) list.push(contig)
    moves.set(to, list)
  }
  for (const contig of after.held) if (!before.held.has(contig)) send(contig, here)
  for (const [contig, to] of after.released) {
    if (before.released.has(contig) && before.released.get(contig) === to) continue
    if (now(contig) === here) send(contig, target(to))
  }
  for (const contig of new Set([...before.held, ...before.released.keys()])) {
    if (after.held.has(contig) || after.released.has(contig)) continue
    if (now(contig) === here) send(contig, target(origin.get(contig)))
  }
  return [...moves].map(([to, contigs]): CurationStep => ({ op: 'move', contigs, to }))
}

/**
 * What a curated map is keyed by (§33.4): its binning's fingerprint, and what
 * its layouts draw — two histories that draw one map share it, and a layout
 * changed is another map.
 */
export function curatedMapKey(binning: CuratedBinning, layouts: readonly DrawnLayout[]): string {
  const drawn = layoutsFingerprint(layouts)
  return drawn === '' ? binning.fingerprint() : `${binning.fingerprint()}+${drawn}`
}

/**
 * What a metagenome's map is drawn through (§33.4): a curation of its binning,
 * or none, and its genomes' edits of the reference that lay them out (§27.10).
 * What an open, a rung and a task's mount are asked to draw, and what the
 * session holds of what it drew.
 */
export interface CurationDrawn {
  /** What the map is named by: {@link curatedMapKey}, or the steps' own name before a reader has folded them. */
  key: string
  /** The curation, or `null` for the file's binning with its genomes laid out. */
  held: Curation | null
  /** Each genome's edit with a step applied, by the curated genome id it is kept under. */
  layouts?: Record<string, ReferenceEdit>
}

/** The edits a drawing lays genomes out by, as `MetaCooler.withCuration` takes them. */
export function layoutEdits(drawn: CurationDrawn): ReadonlyMap<string, ReferenceEdit> | undefined {
  return drawn.layouts === undefined ? undefined : new Map(Object.entries(drawn.layouts))
}
