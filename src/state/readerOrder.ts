/**
 * The reader's order of a metagenome's genomes, and of the contigs within each
 * genome (§7.6): set by dragging a genome along the circle — or a contig along
 * its genome's band — and followed by every square map of the file, the circle,
 * and every list of its genomes and contigs.
 *
 * **An order, not an edit.** The file is still read as it is stored, genome
 * then length (C4); what moves is where each whole genome, and each whole contig
 * within its genome, is drawn and listed. A contig never changes genome here —
 * that is the reference editor's *send* (§27.10), which this is not.
 *
 * Kept per file in session memory beside the file's other choices, so it is
 * carried by a saved workspace and a shared link as they are (`SessionConfig`).
 * Names, not indices: a workspace opened against a file with a genome more or
 * fewer still puts the rest where the reader put them, and whatever it names
 * that the file does not have is dropped.
 */

import { recall, remember } from './UiMemory'

/** The `UiMemory` scope this is kept under. Also in `SessionConfig`'s table. */
export const ORDER_SCOPE = 'map:order'

export interface ReaderOrder {
  /**
   * Genomes in the reader's order, or `null` for the file's. Only those the
   * reader has placed need be named: the file's others follow, in its order.
   */
  readonly genomes: readonly string[] | null
  /** A genome's contigs in the reader's order, for each genome whose contigs were moved. */
  readonly contigs: Readonly<Record<string, readonly string[]>>
}

/** The file's own order: nothing moved. */
export const FILE_ORDER: ReaderOrder = Object.freeze({ genomes: null, contigs: Object.freeze({}) })

/** Whether nothing has been moved. */
export function isFileOrder(order: ReaderOrder): boolean {
  return order.genomes === null && Object.keys(order.contigs).length === 0
}

/**
 * The file's names in the reader's order: those the reader placed that the
 * file has, as placed, then the file's others in the file's order. A name
 * placed twice is placed where it first is.
 */
export function arrange(file: readonly string[], placed: readonly string[] | null | undefined): string[] {
  if (placed === null || placed === undefined || placed.length === 0) return [...file]
  const known = new Set(file)
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of placed) {
    if (!known.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  for (const name of file) if (!seen.has(name)) out.push(name)
  return out
}

/** Which side of its neighbour a moved name lands. */
export type Side = 'before' | 'after'

/**
 * `names` with `moved` taken out and put back together, in the order they
 * were in, just before or after `anchor` — a neighbour where they were
 * dropped, which is what a picture of only some of them can say: a circle of
 * five ticked genomes knows the genome it was dropped beside, not where that
 * genome is among a thousand. Unchanged where the anchor is one of them or
 * not there.
 */
export function moveBeside(names: readonly string[], moved: readonly string[], anchor: string, side: Side): string[] {
  const taken = new Set(moved)
  if (taken.has(anchor)) return [...names]
  const rest = names.filter((name) => !taken.has(name))
  let at = rest.indexOf(anchor)
  if (at < 0) return [...names]
  if (side === 'after') at += 1
  rest.splice(at, 0, ...names.filter((name) => taken.has(name)))
  return rest
}

/**
 * The order with genomes moved beside another, together — one genome, or a
 * slot of several where a file has more genomes than a picture has cells.
 */
export function withGenomesMoved(
  order: ReaderOrder,
  fileGenomes: readonly string[],
  genomes: readonly string[],
  anchor: string,
  side: Side,
): ReaderOrder {
  const next = moveBeside(arrange(fileGenomes, order.genomes), genomes, anchor, side)
  return sameNames(next, fileGenomes) ? { ...order, genomes: null } : { ...order, genomes: next }
}

/**
 * The order with contigs moved beside another of their genome's — one, or
 * every contig a cell of the whole metagenome holds. Within the genome only:
 * a contig stays the genome's.
 */
export function withContigsMoved(
  order: ReaderOrder,
  genome: string,
  fileContigs: readonly string[],
  contigs: readonly string[],
  anchor: string,
  side: Side,
): ReaderOrder {
  const next = moveBeside(arrange(fileContigs, order.contigs[genome]), contigs, anchor, side)
  const kept = { ...order.contigs }
  if (sameNames(next, fileContigs)) delete kept[genome]
  else kept[genome] = next
  return { ...order, contigs: kept }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

/**
 * An order as storage or a workspace holds it, checked: anything that is not a
 * list of names is dropped rather than trusted, and an empty one is the file's.
 */
export function readOrder(stored: unknown): ReaderOrder {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return FILE_ORDER
  const record = stored as Record<string, unknown>
  const names = (value: unknown): string[] | null =>
    Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string' && name !== '')
      ? (value as string[])
      : null
  const genomes = names(record['genomes'])
  const contigs: Record<string, string[]> = {}
  const rawContigs = record['contigs']
  if (rawContigs !== null && typeof rawContigs === 'object' && !Array.isArray(rawContigs)) {
    for (const [genome, list] of Object.entries(rawContigs as Record<string, unknown>)) {
      const valid = names(list)
      if (genome !== '' && valid !== null) contigs[genome] = valid
    }
  }
  return genomes === null && Object.keys(contigs).length === 0 ? FILE_ORDER : { genomes, contigs }
}

/** What storage and a workspace hold: `null` for the file's order, which is nothing to keep. */
export function storedOrder(order: ReaderOrder): { genomes?: string[]; contigs?: Record<string, string[]> } | null {
  if (isFileOrder(order)) return null
  return {
    ...(order.genomes === null ? {} : { genomes: [...order.genomes] }),
    ...(Object.keys(order.contigs).length === 0
      ? {}
      : { contigs: Object.fromEntries(Object.entries(order.contigs).map(([genome, list]) => [genome, [...list]])) }),
  }
}

/**
 * Where each genome and contig goes, as a block's runs are ranked
 * (`render/blockOrder.ts`): lower first, and `undefined` for one the reader
 * never placed, which keeps its place after the placed ones.
 */
export interface OrderRanks {
  genomeRank(genome: string): number | undefined
  /** `undefined` for a genome whose contigs keep the file's order. */
  contigRanks(genome: string): ReadonlyMap<string, number> | undefined
}

/** The ranks an order gives, built once per order. */
export function ranksOf(order: ReaderOrder): OrderRanks {
  const genomes = order.genomes === null ? null : new Map(order.genomes.map((name, i) => [name, i]))
  const contigs = new Map<string, Map<string, number>>()
  for (const [genome, list] of Object.entries(order.contigs)) {
    contigs.set(genome, new Map(list.map((name, i) => [name, i])))
  }
  return {
    genomeRank: (genome) => genomes?.get(genome),
    contigRanks: (genome) => contigs.get(genome),
  }
}

/**
 * One file's order, in session memory, told to whoever draws or lists by it.
 *
 * Every change is written as it is made, on the rule every store under
 * `SessionConfig` follows: what storage holds *is* the session.
 */
export class OrderStore {
  private order: ReaderOrder
  private ranks: OrderRanks | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string) {
    this.order = readOrder(recall<unknown>(key, ORDER_SCOPE))
  }

  get current(): ReaderOrder {
    return this.order
  }

  /** The ranks of the order now, the same object until it changes. */
  get currentRanks(): OrderRanks {
    this.ranks ??= ranksOf(this.order)
    return this.ranks
  }

  set(order: ReaderOrder): void {
    if (order === this.order) return
    this.order = isFileOrder(order) ? FILE_ORDER : order
    this.ranks = null
    remember(this.key, ORDER_SCOPE, storedOrder(this.order))
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
