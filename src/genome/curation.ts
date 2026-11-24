/**
 * A curation of a metagenome's binning, and the curated binning it folds into
 * (SPECS §33.2).
 *
 * The **original** is the file's binning: each contig in the genome
 * `/contigs/genome_id` names or in none (`__unbinned__`, the **pool**), each
 * genome a **MAG** or a mobile **element**, and the host links metaTOR found
 * between them. A **curation** is what the reader has done to it — a history of
 * **steps** with a cursor — and the **curated binning** is its fold: every
 * contig's genome, every genome's name and kind, every host link.
 *
 * **Exclusive by construction**: a contig's genome is one value, so it is in
 * one MAG, one element or the pool, never two. A host link joins an element to
 * a MAG and is never a membership.
 *
 * **Steps name contigs and genome ids, never indices**, so a step means what it
 * meant when it was made, and the history replays from the file's binning in
 * one pass. A genome of the file has its stored name for an id, for as long as
 * it exists, whatever it is renamed; a genome a step creates carries the id that
 * step minted. A step that no longer applies — a genome since merged away, a
 * contig the file does not have, an op a newer build wrote — changes nothing.
 *
 * Pure: no DOM, no worker. The stage folds it, the reader's worker presents the
 * map through it (`metacooler/curationLens.ts`), the exports write it.
 */

import { readEntry, appliedSteps, fnvHash, pushStep, stepBack, stepForward, type HistoryEntryOf, type StepAuthor } from './history'

/** The name the format gives no genome (§7.4). */
export const UNBINNED = '__unbinned__'

/** A MAG, or a mobile genetic element. */
export type GenomeKind = 'mag' | 'element'

/** One step of a curation. */
export type CurationStep =
  /** Contigs moved to a genome, or to the pool (`to: null`). */
  | { op: 'move'; contigs: string[]; to: string | null }
  /** A new genome of these contigs, taken from wherever they were. */
  | { op: 'create'; id: string; name: string; kind: GenomeKind; contigs: string[] }
  /** Genomes of one kind made one, under `into`'s id and name. */
  | { op: 'merge'; into: string; genomes: string[] }
  /** A genome's contigs sent to the pool, the genome gone. */
  | { op: 'dissolve'; genome: string }
  | { op: 'rename'; genome: string; name: string }
  /** A MAG declared an element, or an element a MAG: its links go. */
  | { op: 'retype'; genome: string; kind: GenomeKind }
  /** An element hosted by a MAG. */
  | { op: 'link'; element: string; mag: string }
  | { op: 'unlink'; element: string; mag: string }

/** Every op a step may have: what this build knows. */
export const CURATION_OPS: ReadonlySet<string> = new Set(['move', 'create', 'merge', 'dissolve', 'rename', 'retype', 'link', 'unlink'])

export type CurationEntry = HistoryEntryOf<CurationStep>

/**
 * The binning a curation was made against, as a fingerprint: the contigs, their
 * names and lengths, which genome each is in, and the links. O(genomes) to keep
 * and to carry — a link to a workspace of twenty thousand contig names would be
 * hundreds of kilobytes — and enough to name what differs.
 */
export interface FileBinning {
  contigs: number
  /** FNV-1a of every contig's name and length, in the file's order. */
  names: string
  /** FNV-1a of every contig's genome, in the file's order, and of every link. */
  assignment: string
  /** Every genome of the file, in its order, the pool left out. */
  genomes: ReadonlyArray<{ name: string; contigs: number; kind: GenomeKind }>
}

/** A curation as it is kept. */
export interface Curation {
  version: 1
  original: FileBinning
  history: CurationEntry[]
  /** How many of {@link history} are applied; undo moves it back. */
  cursor: number
}

/** The file's binning itself, which the fold starts from: read from the file, never kept. */
export interface BaseBinning {
  /** Every contig of the file, in its order. */
  names: readonly string[]
  lengths: readonly number[]
  /** Each contig's genome, an index into {@link genomes}; `-1` for the pool. */
  genomeOf: Int32Array
  /** Every genome of the file but the pool, in its order. Its id is its name. */
  genomes: ReadonlyArray<{ name: string; kind: GenomeKind }>
  /** The host links the file holds, by genome name. */
  links: ReadonlyArray<{ element: string; mag: string }>
}

/** A genome of the curated binning. */
export interface CuratedGenome {
  /** Stable: the file's name for a genome of the file, the id its step minted for one created. */
  id: string
  /** What it is called now. */
  name: string
  kind: GenomeKind
  /** Its contigs, as indices of the file's, in the file's order. */
  contigs: number[]
  /** The index of the file's genome it is, `-1` for one a step created. */
  file: number
  /** The same contigs as the file's genome of the same id, of the same kind. */
  asInFile: boolean
}

/** A host link of the curated binning. */
export interface CuratedLink {
  element: string
  mag: string
  /** The file had it. */
  fromFile: boolean
}

// ---------------------------------------------------------------------------
// The file's binning, fingerprinted
// ---------------------------------------------------------------------------

/** The fingerprint of a file's binning. */
export function fileBinning(base: BaseBinning): FileBinning {
  let names = 2166136261
  let assignment = 2166136261
  const counts = new Int32Array(base.genomes.length)
  for (let c = 0; c < base.names.length; c++) {
    names = fnvHash(`${base.names[c]}\t${base.lengths[c]}\n`, names)
    const g = base.genomeOf[c]
    assignment = fnvHash(`${g >= 0 ? base.genomes[g].name : UNBINNED}\n`, assignment)
    if (g >= 0) counts[g]++
  }
  for (const link of [...base.links].sort((x, y) => (x.element + '\t' + x.mag < y.element + '\t' + y.mag ? -1 : 1))) {
    assignment = fnvHash(`${link.element}\t${link.mag}\n`, assignment)
  }
  return {
    contigs: base.names.length,
    names: (names >>> 0).toString(36),
    assignment: (assignment >>> 0).toString(36),
    genomes: base.genomes.map((genome, g) => ({ name: genome.name, contigs: counts[g], kind: genome.kind })),
  }
}

/**
 * Whether a curation applies to a file's binning. `null` when it does;
 * otherwise what differs first, for the refusal to name (§10): the contigs, a
 * genome, or which contigs the genomes hold.
 */
export function curationMismatch(curation: Curation, file: FileBinning): string | null {
  const kept = curation.original
  if (kept.contigs !== file.contigs) return `the curation was made on ${kept.contigs.toLocaleString('en-US')} contigs and this file has ${file.contigs.toLocaleString('en-US')}`
  if (kept.names !== file.names) return 'its contigs are not this file’s: their names or lengths differ'
  const n = Math.max(kept.genomes.length, file.genomes.length)
  for (let g = 0; g < n; g++) {
    const a = kept.genomes[g]
    const b = file.genomes[g]
    if (a === undefined) return `this file has a genome the curation does not know, ${b.name}`
    if (b === undefined) return `the curation names a genome this file does not have, ${a.name}`
    if (a.name !== b.name) return `genome ${g + 1} is ${a.name} in the curation and ${b.name} here`
    if (a.contigs !== b.contigs) return `${a.name} held ${a.contigs.toLocaleString('en-US')} contigs when the curation was made and holds ${b.contigs.toLocaleString('en-US')} here`
    if (a.kind !== b.kind) return `${a.name} was ${kindWord(a.kind)} when the curation was made and is ${kindWord(b.kind)} here`
  }
  if (kept.assignment !== file.assignment) return 'the same genomes hold other contigs, or other host links, in this file'
  return null
}

function kindWord(kind: GenomeKind): string {
  return kind === 'mag' ? 'a MAG' : 'a mobile element'
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** A curation that has done nothing yet. */
export function emptyCuration(original: FileBinning): Curation {
  return { version: 1, original: { ...original, genomes: original.genomes.map((genome) => ({ ...genome })) }, history: [], cursor: 0 }
}

export function withCurationStep(curation: Curation, step: CurationStep, by: StepAuthor, when: number, suggestion?: string, gesture?: string): Curation {
  return pushStep(curation, step, by, when, suggestion, gesture)
}

export function curationUndone(curation: Curation): Curation {
  return stepBack(curation)
}

export function curationRedone(curation: Curation): Curation {
  return stepForward(curation)
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface Slot {
  id: string
  name: string
  kind: GenomeKind
  file: number
  /** Merged into another, or dissolved: no step may name it again. */
  gone: boolean
}

/** The curated binning: a curation folded over a file's binning. */
export class CuratedBinning {
  /** Each contig's genome, an index into {@link genomes}; `-1` for the pool. */
  readonly genomeOf: Int32Array
  /**
   * The genomes that hold contigs, in the order the lens lays them out: the
   * MAGs, then the elements; of each, the file's in the file's order — a merged
   * genome where the one it was merged into was — then the created ones, in the
   * order they were made.
   */
  readonly genomes: readonly CuratedGenome[]
  readonly links: readonly CuratedLink[]
  /** The steps applied: nought for the file's binning as it is. */
  readonly applied: number
  private readonly byId: Map<string, number>
  private readonly byName: Map<string, number>

  private constructor(genomeOf: Int32Array, genomes: CuratedGenome[], links: CuratedLink[], applied: number) {
    this.genomeOf = genomeOf
    this.genomes = genomes
    this.links = links
    this.applied = applied
    this.byId = new Map(genomes.map((genome, g) => [genome.id, g]))
    this.byName = new Map(genomes.map((genome, g) => [genome.name, g]))
  }

  /** The file's binning through a curation, or as it is with none. */
  static of(base: BaseBinning, curation: Curation | null): CuratedBinning {
    const slots: Slot[] = base.genomes.map((genome, g) => ({ id: genome.name, name: genome.name, kind: genome.kind, file: g, gone: false }))
    const slotOf = new Map(slots.map((slot, s) => [slot.id, s]))
    const contigOf = new Map(base.names.map((name, c) => [name, c]))
    const genomeOf = Int32Array.from(base.genomeOf)
    const links = new Map<string, CuratedLink>()
    const linkKey = (element: string, mag: string): string => `${element}\t${mag}`
    for (const link of base.links) {
      const e = slotOf.get(link.element)
      const m = slotOf.get(link.mag)
      if (e === undefined || m === undefined || slots[e].kind !== 'element' || slots[m].kind !== 'mag') continue
      links.set(linkKey(link.element, link.mag), { element: link.element, mag: link.mag, fromFile: true })
    }
    const live = (id: string | null): number | undefined => {
      if (id === null) return undefined
      const s = slotOf.get(id)
      return s === undefined || slots[s].gone ? undefined : s
    }
    const contigsNamed = (names: readonly string[]): number[] => {
      const out: number[] = []
      for (const name of names) {
        const c = contigOf.get(name)
        if (c !== undefined) out.push(c)
      }
      return out
    }
    const dropLinksOf = (id: string): void => {
      for (const [key, link] of links) if (link.element === id || link.mag === id) links.delete(key)
    }
    const steps = curation === null ? [] : appliedSteps(curation)
    for (const step of steps) {
      switch (step.op) {
        case 'move': {
          if (step.to === null) {
            for (const c of contigsNamed(step.contigs)) genomeOf[c] = -1
            break
          }
          const target = live(step.to)
          if (target === undefined) break
          for (const c of contigsNamed(step.contigs)) genomeOf[c] = target
          break
        }
        case 'create': {
          // An id already taken — a step replayed twice — makes nothing.
          if (slotOf.has(step.id)) break
          const s = slots.length
          slots.push({ id: step.id, name: freeName(step.name, slots), kind: step.kind === 'element' ? 'element' : 'mag', file: -1, gone: false })
          slotOf.set(step.id, s)
          for (const c of contigsNamed(step.contigs)) genomeOf[c] = s
          break
        }
        case 'merge': {
          const into = live(step.into)
          if (into === undefined) break
          for (const id of step.genomes) {
            const from = live(id)
            if (from === undefined || from === into || slots[from].kind !== slots[into].kind) continue
            for (let c = 0; c < genomeOf.length; c++) if (genomeOf[c] === from) genomeOf[c] = into
            // Its links are the merged genome's now.
            for (const [key, link] of [...links]) {
              if (link.element !== slots[from].id && link.mag !== slots[from].id) continue
              links.delete(key)
              const element = link.element === slots[from].id ? slots[into].id : link.element
              const mag = link.mag === slots[from].id ? slots[into].id : link.mag
              const next = linkKey(element, mag)
              if (!links.has(next)) links.set(next, { element, mag, fromFile: false })
            }
            slots[from].gone = true
          }
          break
        }
        case 'dissolve': {
          const s = live(step.genome)
          if (s === undefined) break
          for (let c = 0; c < genomeOf.length; c++) if (genomeOf[c] === s) genomeOf[c] = -1
          dropLinksOf(slots[s].id)
          slots[s].gone = true
          break
        }
        case 'rename': {
          const s = live(step.genome)
          if (s === undefined || step.name === '' || step.name === UNBINNED) break
          if (slots.some((slot, t) => t !== s && !slot.gone && slot.name === step.name)) break
          slots[s].name = step.name
          break
        }
        case 'retype': {
          const s = live(step.genome)
          if (s === undefined || (step.kind !== 'mag' && step.kind !== 'element') || slots[s].kind === step.kind) break
          slots[s].kind = step.kind
          dropLinksOf(slots[s].id)
          break
        }
        case 'link': {
          const e = live(step.element)
          const m = live(step.mag)
          if (e === undefined || m === undefined || slots[e].kind !== 'element' || slots[m].kind !== 'mag') break
          const key = linkKey(step.element, step.mag)
          if (!links.has(key)) links.set(key, { element: step.element, mag: step.mag, fromFile: false })
          break
        }
        case 'unlink':
          links.delete(linkKey(step.element, step.mag))
          break
        default:
          // An op this build does not know, kept in the history and not applied.
          break
      }
    }
    // The genomes that hold contigs, in the lens's order.
    const members: number[][] = slots.map(() => [])
    for (let c = 0; c < genomeOf.length; c++) if (genomeOf[c] >= 0) members[genomeOf[c]].push(c)
    const changed = new Uint8Array(slots.length)
    for (let c = 0; c < genomeOf.length; c++) {
      if (genomeOf[c] === base.genomeOf[c]) continue
      if (genomeOf[c] >= 0) changed[genomeOf[c]] = 1
      if (base.genomeOf[c] >= 0) changed[base.genomeOf[c]] = 1
    }
    // MAGs, then elements — each the file's in its order, then the created ones
    // in the order they were made — so every MAG × element block of the lensed
    // map is one rectangle off the diagonal (§33.4).
    const order: number[] = []
    for (const kind of ['mag', 'element'] as const) {
      for (let s = 0; s < slots.length; s++) if (!slots[s].gone && members[s].length > 0 && slots[s].kind === kind) order.push(s)
    }
    const index = new Int32Array(slots.length).fill(-1)
    order.forEach((s, g) => {
      index[s] = g
    })
    const genomes: CuratedGenome[] = order.map((s) => ({
      id: slots[s].id,
      name: slots[s].name,
      kind: slots[s].kind,
      contigs: members[s],
      file: slots[s].file,
      asInFile: slots[s].file >= 0 && changed[s] === 0 && slots[s].kind === base.genomes[slots[s].file].kind,
    }))
    for (let c = 0; c < genomeOf.length; c++) genomeOf[c] = genomeOf[c] >= 0 ? index[genomeOf[c]] : -1
    // A link survives only between two genomes that still hold contigs.
    const kept = [...links.values()].filter((link) => {
      const e = slotOf.get(link.element)
      const m = slotOf.get(link.mag)
      return e !== undefined && m !== undefined && index[e] >= 0 && index[m] >= 0
    })
    return new CuratedBinning(genomeOf, genomes, kept, steps.length)
  }

  /** The genome of this id, as an index into {@link genomes}. */
  indexOfId(id: string): number | undefined {
    return this.byId.get(id)
  }

  /** The genome called this, as an index into {@link genomes}. */
  indexOfName(name: string): number | undefined {
    return this.byName.get(name)
  }

  /** Whether the curated binning is the file's. */
  get isIdentity(): boolean {
    return this.applied === 0
  }

  /**
   * A short name for the binning itself — which genome each contig is in, each
   * genome's id, name and kind — that two histories reaching one binning share:
   * the lens and a task's framing are keyed by it. The links move no contact
   * and are left out.
   */
  fingerprint(): string {
    let hash = 2166136261
    for (const genome of this.genomes) hash = fnvHash(`${genome.id}\t${genome.name}\t${genome.kind}\n`, hash)
    const view = new Uint8Array(this.genomeOf.buffer, this.genomeOf.byteOffset, this.genomeOf.byteLength)
    for (let i = 0; i < view.length; i++) {
      hash ^= view[i]
      hash = Math.imul(hash, 16777619)
    }
    return `${this.genomes.length}:${(hash >>> 0).toString(36)}`
  }
}

/** A name no live genome has: `name`, else `name_2`, `name_3`, … */
function freeName(name: string, slots: readonly Slot[]): string {
  const taken = new Set(slots.filter((slot) => !slot.gone).map((slot) => slot.name))
  const wanted = name === '' || name === UNBINNED ? 'genome' : name
  if (!taken.has(wanted)) return wanted
  for (let k = 2; ; k++) if (!taken.has(`${wanted}_${k}`)) return `${wanted}_${k}`
}

/**
 * A curation read back from storage, a workspace or a link: untrusted, so
 * every field is checked, and an op this build does not know is kept and not
 * applied (§29.4) rather than refusing the record.
 */
export function readCuration(stored: unknown): Curation | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  const value = stored as Record<string, unknown>
  if (value['version'] !== 1) return null
  const original = value['original'] as Record<string, unknown> | undefined
  if (original === undefined || original === null || typeof original !== 'object') return null
  const { contigs, names, assignment, genomes } = original
  if (typeof contigs !== 'number' || !Number.isInteger(contigs) || contigs < 0) return null
  if (typeof names !== 'string' || typeof assignment !== 'string' || !Array.isArray(genomes)) return null
  const kept: FileBinning['genomes'][number][] = []
  for (const genome of genomes) {
    if (genome === null || typeof genome !== 'object') return null
    const { name, contigs: count, kind } = genome as Record<string, unknown>
    if (typeof name !== 'string' || typeof count !== 'number' || !Number.isInteger(count) || (kind !== 'mag' && kind !== 'element')) return null
    kept.push({ name, contigs: count, kind })
  }
  const history = value['history']
  if (!Array.isArray(history)) return null
  const entries: CurationEntry[] = []
  for (const item of history) {
    const entry = readEntry<CurationStep>(item)
    if (entry === null) return null
    entries.push(entry)
  }
  const cursor = value['cursor']
  return {
    version: 1,
    original: { contigs, names, assignment, genomes: kept },
    history: entries,
    cursor: typeof cursor === 'number' && Number.isInteger(cursor) ? Math.max(0, Math.min(entries.length, cursor)) : entries.length,
  }
}

/**
 * The fingerprint of the steps a curation applies: two curations with one
 * applied history share it. What a kept record and the lens compare by first;
 * the binning's own {@link CuratedBinning.fingerprint} is the finer test.
 */
export function curationFingerprint(curation: Curation): string {
  let hash = 2166136261
  hash = fnvHash(JSON.stringify(appliedSteps(curation)), hash)
  return `${curation.cursor}:${(hash >>> 0).toString(36)}`
}
