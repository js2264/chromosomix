/**
 * The curated binning's lens in the reader (SPECS §33.4): the file presented as
 * the map `metacooler reassign --layout genome-then-length` writes from the
 * curation's contig → genome table, so that every view, table and task reads
 * the curated genomes and nothing above the reader knows there is a curation.
 *
 * ## The order is metacooler's
 *
 * The contigs are laid out as `reassign` re-groups them (`io/create.py`,
 * `_genome_id_order` and `_build_contig_order`): the pool, `__unbinned__`,
 * first where it holds a contig — matched by name, never by index (§7.4) — then
 * every genome by its name in code-point order, as Python's `sorted` orders
 * text (never a locale's collation, which puts `MetaTOR_*` before `MM133_*`),
 * and each genome's contigs longest first, a tie by name. So a session drawn
 * through a curation is the map its contig → genome table makes of the file,
 * bin for bin, and the tests hold it to `reassign`'s own output.
 *
 * ## Pixels
 *
 * Contigs move whole and forward: every bin of the curated map is one stored
 * bin, and every stored bin lands once — a permutation of bins, the special
 * case of a reference edit's lens (`lens.ts`) in which every piece is a whole
 * original sequence. A pixel keeps its count and its two bins, which take new
 * indices and are swapped into the upper triangle where two contigs' order
 * turned: nothing is summed, nothing is re-sorted, every count is the integer
 * the file stored. Bins per contig are the file's own (`chrom_offset`).
 *
 * ## The genome layer
 *
 * Replaced: each genome's `length`, `n_contigs` and `n_bins` counted; a `kind`
 * (MAG or element) and a `curation` (as in the file, changed, new) column; the
 * file's other columns kept for a genome whose contigs and kind are the file's
 * and left empty for any other, since a completeness or a taxonomy measured on
 * other contigs describes a genome that is no longer there; metaTOR's `mge`,
 * `n_mges` and `mges` written again from the curated kinds and links; the
 * `qc_*` tallies dropped (`reassign` measures them again from the pixels); and where the map holds the
 * contigs' marker genes, miComplete's four numbers recomputed for every MAG.
 * The `/contigs` columns are every one of the file's, carried with their
 * contigs, and a weight that depends on the assignment is hidden.
 */

import { UNBINNED, type BaseBinning, type CuratedBinning, type GenomeKind } from '../genome/curation'
import { bestQuality, type ContigMarkers } from '../curate/quality'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import { makeTable } from '../h5/readTable'
import type { Column, Extent, PixelChunk, Table } from '../types'
import type { ReadPlan, SpanScanOptions } from './matrix'
import type { PixelStore, ScanAllOptions } from './store'
import type { BinLens } from './lens'

/** What a curated map knows of its curation, for the reader's own requests. */
export interface CuratedMap {
  /** The curated binning's fingerprint: what the map is drawn through, and what it is keyed by. */
  key: string
  /** Steps applied. */
  steps: number
  /** Each of the file's contigs, as a contig of the curated map. */
  inverse: Int32Array
  /** The `/genomes` columns the curation writes: `kind`, `curation`, and metaTOR's where the file has them. */
  owned: string[]
  /** The `/genomes` columns recomputed from the contigs' markers. */
  recomputed: string[]
}

/** A genome of the curated map, in its order. */
export interface LensGenome {
  name: string
  /** The genome of the curated binning it is; `-1` for the pool. */
  curated: number
  kind: GenomeKind | null
}

/** Where every contig of a map goes under a curated binning. */
export interface CurationLayout {
  /** Each contig of the curated map, as the file's contig it is. */
  order: Int32Array
  /** Each of the file's contigs, as the curated map's. */
  inverse: Int32Array
  /** The pool first where it holds a contig, then every curated genome by name. */
  genomes: LensGenome[]
  /** The first contig of each genome, and one past the last: `genomes.length + 1` long. */
  genomeOffset: Float64Array
  /** Each contig of the curated map, its genome: an index into {@link genomes}. */
  genomeOf: Int32Array
}

/** The miComplete numbers metaTOR writes per bin, by column. */
const QUALITY_COLUMNS = ['Completeness', 'Redundancy', 'Weighted completeness', 'Weighted redundancy'] as const

/** metaTOR's columns of a bin's mobile elements, which follow the curated kinds and links. */
const METATOR_COLUMNS = ['mge', 'n_mges', 'mges'] as const

/** The columns a genome's own contigs give, counted. */
const CORE_COLUMNS = ['name', 'length', 'n_contigs', 'n_bins'] as const

/** The words of the `curation` column. */
export const CURATION_STATES = { kept: 'as in the file', changed: 'changed', created: 'new' } as const

/**
 * Two texts in code-point order — Python's `sorted`, and numpy's on the `<U`
 * text `_build_contig_order` sorts by. JavaScript's `<` compares UTF-16 code
 * units, which agree but for a character past the Basic Multilingual Plane
 * against one in U+E000–U+FFFF; the units are moved so those order as their
 * code points do. A metacooler name is ASCII, so the move is a guard.
 */
export function codePointCompare(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i)
    let y = b.charCodeAt(i)
    if (x === y) continue
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000
    }
    return x - y
  }
  return a.length - b.length
}

/**
 * The curated map's layout: `reassign --layout genome-then-length` over the
 * curated binning's contig → genome table.
 *
 * @param names The file's contigs, in its order.
 * @param lengths Their lengths, in the same order.
 */
export function curationLayout(names: readonly string[], lengths: ArrayLike<number>, binning: CuratedBinning): CurationLayout {
  const n = names.length
  let pooled = false
  for (let c = 0; c < n; c++) {
    if (binning.genomeOf[c] < 0) {
      pooled = true
      break
    }
  }
  const byName = binning.genomes.map((_, g) => g).sort((a, b) => codePointCompare(binning.genomes[a].name, binning.genomes[b].name))
  const genomes: LensGenome[] = [
    ...(pooled ? [{ name: UNBINNED, curated: -1, kind: null }] : []),
    ...byName.map((g) => ({ name: binning.genomes[g].name, curated: g, kind: binning.genomes[g].kind })),
  ]
  const first = pooled ? 1 : 0
  const rank = new Int32Array(binning.genomes.length)
  byName.forEach((g, r) => {
    rank[g] = first + r
  })
  const genomeOfFile = new Int32Array(n)
  for (let c = 0; c < n; c++) genomeOfFile[c] = binning.genomeOf[c] < 0 ? 0 : rank[binning.genomeOf[c]]
  const order = new Int32Array(n)
  for (let c = 0; c < n; c++) order[c] = c
  order.sort((a, b) => genomeOfFile[a] - genomeOfFile[b] || lengths[b] - lengths[a] || codePointCompare(names[a], names[b]))
  const inverse = new Int32Array(n)
  const genomeOf = new Int32Array(n)
  const genomeOffset = new Float64Array(genomes.length + 1)
  for (let l = 0; l < n; l++) {
    inverse[order[l]] = l
    genomeOf[l] = genomeOfFile[order[l]]
    genomeOffset[genomeOf[l] + 1]++
  }
  for (let g = 0; g < genomes.length; g++) genomeOffset[g + 1] += genomeOffset[g]
  return { order, inverse, genomes, genomeOffset, genomeOf }
}

/**
 * The curated map's bins: each contig's own, in its new place — so its
 * `chrom_offset`, and the stored bin each of its bins shows.
 *
 * @param chromOffset The file's `indexes/chrom_offset`.
 */
export function curatedBins(order: Int32Array, chromOffset: ArrayLike<number>): { chromOffset: Float64Array; toOriginal: Int32Array } {
  const n = order.length
  const offsets = new Float64Array(n + 1)
  for (let l = 0; l < n; l++) offsets[l + 1] = offsets[l] + (chromOffset[order[l] + 1] - chromOffset[order[l]])
  const toOriginal = new Int32Array(offsets[n])
  for (let l = 0; l < n; l++) {
    const from = chromOffset[order[l]]
    const at = offsets[l]
    const count = offsets[l + 1] - at
    for (let k = 0; k < count; k++) toOriginal[at + k] = from + k
  }
  return { chromOffset: offsets, toOriginal }
}

/** A column carried with its rows: `order[r]` is the source row of row `r`. */
export function gatherColumn(column: Column, order: ArrayLike<number>): Column {
  if (Array.isArray(column) && (column.length === 0 || typeof column[0] === 'string')) {
    const text = column as string[]
    return Array.from({ length: order.length }, (_, r) => text[order[r]] ?? '')
  }
  const out = new Float64Array(order.length)
  const values = column as ArrayLike<number | bigint>
  for (let r = 0; r < order.length; r++) out[r] = Number(values[order[r]])
  return out
}

/** Whether a column holds text. */
function isText(column: Column | undefined): column is string[] {
  return Array.isArray(column) && (column.length === 0 || typeof column[0] === 'string')
}

/** A table's rows `[lo, hi)` and the columns asked, as `readTable` answers them. */
export function sliceTable(table: Table, lo?: number, hi?: number, columns?: readonly string[]): Table {
  const start = Math.max(0, Math.min(table.length, Math.trunc(lo ?? 0)))
  const stop = Math.max(start, Math.min(table.length, Math.trunc(hi ?? table.length)))
  const wanted = columns === undefined ? null : new Set(columns)
  const names = table.columns.filter((name) => wanted === null || wanted.has(name))
  const whole = start === 0 && stop === table.length
  const data: Record<string, Column> = {}
  for (const name of names) {
    const column = table.data[name]
    data[name] = whole ? column : isText(column) ? column.slice(start, stop) : (column as Float64Array).slice(start, stop)
  }
  return makeTable(stop - start, names, data)
}

/** The file's `/contigs` (or `/chroms`) in the curated map's order, its `genome_id` the curated map's. */
export function curatedContigs(table: Table, layout: CurationLayout): Table {
  const data: Record<string, Column> = {}
  for (const name of table.columns) {
    data[name] = name === 'genome_id' ? Float64Array.from(layout.genomeOf) : gatherColumn(table.data[name], layout.order)
  }
  const columns = table.columns.includes('genome_id') ? [...table.columns] : [...table.columns, 'genome_id']
  if (data['genome_id'] === undefined) data['genome_id'] = Float64Array.from(layout.genomeOf)
  return makeTable(layout.order.length, columns, data)
}

/** Everything the curated `/genomes` is made from. */
export interface CuratedGenomesInput {
  layout: CurationLayout
  binning: CuratedBinning
  /** The file's binning the curation folded from: each genome's stored name and kind. */
  base: BaseBinning
  /** The file's `/genomes`, every column. */
  file: Table
  /** The file's contigs' genomes, as rows of {@link file}. */
  fileGenomeOf: ArrayLike<number>
  /** Each of the file's contigs, its length and its bins. */
  lengths: ArrayLike<number>
  bins: ArrayLike<number>
  /** The contigs' markers, one table per set, where the map holds them. */
  markers: readonly ContigMarkers[]
}

/**
 * The curated `/genomes`: the counted four, `kind` and `curation`, then the
 * file's columns, each kept, written again or recomputed as the module's
 * header says.
 */
export function curatedGenomes(input: CuratedGenomesInput): { table: Table; owned: string[]; recomputed: string[] } {
  const { layout, binning, base, file, fileGenomeOf, lengths, bins, markers } = input
  const n = layout.genomes.length
  const fileRows = new Map<string, number>()
  const fileNames = file.columns.includes('name') ? file.strings('name') : []
  fileNames.forEach((name, r) => fileRows.set(name, r))
  const fileCount = new Float64Array(fileNames.length)
  for (let c = 0; c < fileGenomeOf.length; c++) if (fileGenomeOf[c] >= 0 && fileGenomeOf[c] < fileCount.length) fileCount[fileGenomeOf[c]]++

  // Each genome counted, and the file's row it is, where it is one.
  const length = new Float64Array(n)
  const contigs = new Float64Array(n)
  const binCount = new Float64Array(n)
  const row = new Int32Array(n).fill(-1)
  const sameKind = new Uint8Array(n)
  layout.genomes.forEach((genome, g) => {
    if (genome.curated < 0) {
      row[g] = fileRows.get(UNBINNED) ?? -1
      sameKind[g] = 1
      return
    }
    const curated = binning.genomes[genome.curated]
    const stored = curated.file >= 0 ? base.genomes[curated.file] : undefined
    row[g] = stored === undefined ? -1 : (fileRows.get(stored.name) ?? -1)
    sameKind[g] = stored !== undefined && stored.kind === curated.kind ? 1 : 0
  })
  // Whether a genome holds exactly the contigs of the file's genome it is.
  const matching = new Float64Array(n)
  for (let l = 0; l < layout.order.length; l++) {
    const g = layout.genomeOf[l]
    const c = layout.order[l]
    length[g] += lengths[c]
    binCount[g] += bins[c]
    contigs[g]++
    if (row[g] >= 0 && fileGenomeOf[c] === row[g]) matching[g]++
  }
  const state: string[] = layout.genomes.map((_, g) =>
    row[g] < 0
      ? CURATION_STATES.created
      : sameKind[g] === 1 && matching[g] === contigs[g] && fileCount[row[g]] === contigs[g]
        ? CURATION_STATES.kept
        : CURATION_STATES.changed,
  )
  const kept = (g: number): number => (state[g] === CURATION_STATES.kept ? row[g] : -1)

  const columns: string[] = [...CORE_COLUMNS, 'kind', 'curation']
  const data: Record<string, Column> = {
    name: layout.genomes.map((genome) => genome.name),
    length,
    n_contigs: contigs,
    n_bins: binCount,
    kind: layout.genomes.map((genome) => (genome.kind === null ? '' : genome.kind === 'mag' ? 'MAG' : 'element')),
    curation: state,
  }
  const owned = ['kind', 'curation']
  const recomputed: string[] = []

  // The links, by genome: a MAG's elements under their names now.
  const elementsOf = new Map<string, string[]>()
  for (const link of binning.links) {
    const e = binning.indexOfId(link.element)
    const m = binning.indexOfId(link.mag)
    if (e === undefined || m === undefined) continue
    const list = elementsOf.get(binning.genomes[m].name) ?? []
    list.push(binning.genomes[e].name)
    elementsOf.set(binning.genomes[m].name, list)
  }
  for (const list of elementsOf.values()) list.sort(codePointCompare)

  // miComplete's numbers, for every MAG, where the map holds the markers.
  const quality = markers.length === 0 ? null : layout.genomes.map((genome) => (genome.kind === 'mag' ? bestQuality(markers, binning.genomes[genome.curated].contigs) : null))
  const qualityValue = (g: number, column: (typeof QUALITY_COLUMNS)[number]): number => {
    const q = quality?.[g] ?? null
    if (q === null) return Number.NaN
    switch (column) {
      case 'Completeness':
        return q.completeness
      case 'Redundancy':
        return q.redundancy
      case 'Weighted completeness':
        return q.weightedCompleteness
      case 'Weighted redundancy':
        return q.weightedRedundancy
    }
  }

  for (const name of file.columns) {
    if ((CORE_COLUMNS as readonly string[]).includes(name)) continue
    // Contact tallies over the file's assignment: stale, as `reassign` drops them.
    if (name.startsWith('qc_')) continue
    const column = file.data[name]
    const text = isText(column)
    // A creator's own column of one of the curation's names, kept beside it.
    const label = name === 'kind' || name === 'curation' ? `${name} (file)` : name
    columns.push(label)
    if ((METATOR_COLUMNS as readonly string[]).includes(name)) {
      owned.push(label)
      data[label] = metatorColumn(name as (typeof METATOR_COLUMNS)[number], text, layout.genomes, elementsOf)
      continue
    }
    if (quality !== null && (QUALITY_COLUMNS as readonly string[]).includes(name)) {
      recomputed.push(label)
      data[label] = Float64Array.from(layout.genomes, (_, g) => qualityValue(g, name as (typeof QUALITY_COLUMNS)[number]))
      continue
    }
    if (text) {
      const values = column as string[]
      data[label] = layout.genomes.map((_, g) => (kept(g) >= 0 ? (values[kept(g)] ?? '') : ''))
    } else {
      const values = column as ArrayLike<number | bigint>
      data[label] = Float64Array.from(layout.genomes, (_, g) => (kept(g) >= 0 ? Number(values[kept(g)]) : Number.NaN))
    }
  }
  // The four numbers where the map holds markers and the file did not write them.
  if (quality !== null) {
    for (const name of QUALITY_COLUMNS) {
      if (file.columns.includes(name)) continue
      columns.push(name)
      recomputed.push(name)
      data[name] = Float64Array.from(layout.genomes, (_, g) => qualityValue(g, name))
    }
  }
  return { table: makeTable(n, columns, data), owned, recomputed }
}

/** metaTOR's `mge`, `n_mges` and `mges` of every genome, from the curated kinds and links. */
function metatorColumn(name: (typeof METATOR_COLUMNS)[number], text: boolean, genomes: readonly LensGenome[], elementsOf: ReadonlyMap<string, string[]>): Column {
  switch (name) {
    case 'mge':
      // `True` and `False` as metaTOR writes them; nothing for the pool.
      return text
        ? genomes.map((genome) => (genome.kind === null ? '' : genome.kind === 'element' ? 'True' : 'False'))
        : Float64Array.from(genomes, (genome) => (genome.kind === null ? Number.NaN : genome.kind === 'element' ? 1 : 0))
    case 'n_mges': {
      const count = (genome: LensGenome): number => (genome.kind === 'mag' ? (elementsOf.get(genome.name)?.length ?? 0) : Number.NaN)
      return text ? genomes.map((genome) => (genome.kind === 'mag' ? String(count(genome)) : '')) : Float64Array.from(genomes, count)
    }
    case 'mges':
      return text
        ? genomes.map((genome) => (genome.kind === 'mag' ? (elementsOf.get(genome.name) ?? []).join(',') : ''))
        : Float64Array.from(genomes, () => Number.NaN)
  }
}

/** The narrow table of the named columns, as the reader's open reads them. */
export function narrowTable(table: Table, columns: readonly string[]): Table {
  return sliceTable(table, undefined, undefined, columns)
}

/** Whether a `/bins` column depends on the contigs' genomes (metacooler's `depends_on`): stale under a curation. */
export function dependsOnAssignment(attrs: Record<string, AttrValue>): boolean {
  const value = attrs['depends_on']
  const entries = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : []
  return entries.some((entry) => entry.trim() === 'genome_id')
}

/** What the curated map's handle answers from. */
export interface CuratedHandleInit {
  lens: BinLens
  layout: CurationLayout
  attrs: Record<string, AttrValue>
  genomes: Table
  /** The file's `/contigs`, every column, as the curated map lays them out: read once, when first asked. */
  contigs: () => Table
}

/**
 * The file's handle, answering for the curated map where a question is about
 * contigs, genomes or bins: `/contigs` (and `/chroms`) with every column carried
 * and `genome_id` the curated map's; `/genomes` curated; both offset indexes;
 * `/bins` carried with the bins, `chrom` renumbered, and a weight that depends
 * on the assignment hidden; the root's attributes. `/pixels`, `/clusters` and
 * every other path are the file's own, as stored.
 */
export function curatedHandle(handle: Hdf5Handle, init: CuratedHandleInit): Hdf5Handle {
  const { lens, layout, attrs, genomes } = init
  let contigTable: Table | null = null
  const contigs = (): Table => {
    contigTable ??= init.contigs()
    return contigTable
  }
  const numeric = new Map<string, Float64Array>()
  const text = new Map<string, string[]>()
  const stale = new Map<string, boolean>()
  const strip = (path: string): string => path.replace(/^\/+/, '')
  const columnOf = (path: string, group: string): string | null => (path.startsWith(`${group}/`) ? path.slice(group.length + 1) : null)
  const contigColumn = (path: string): string | null => columnOf(path, 'contigs') ?? columnOf(path, 'chroms')
  /** Whether a `/bins` column is a weight the curation leaves stale: asked of its attributes once, when first named. */
  const hidden = (column: string): boolean => {
    let known = stale.get(column)
    if (known === undefined) {
      known = handle.has(`bins/${column}`) && dependsOnAssignment(handle.attrsAt(`bins/${column}`))
      stale.set(column, known)
    }
    return known
  }
  /** A `/bins` column in the curated map's order, read whole once: `chrom` renumbered as the contigs are. */
  const binNumbers = (column: string, lo?: number, hi?: number): Float64Array => {
    let all = numeric.get(column)
    if (all === undefined) {
      all = handle.readNumeric(`bins/${column}`)
      if (column === 'chrom') all = Float64Array.from(all, (c) => (c >= 0 && c < layout.inverse.length ? layout.inverse[c] : c))
      numeric.set(column, all)
    }
    return lens.gather(all, lo ?? 0, hi ?? lens.nBins)
  }
  const binStrings = (column: string, lo?: number, hi?: number): string[] => {
    let all = text.get(column)
    if (all === undefined) {
      all = handle.readStrings(`bins/${column}`)
      text.set(column, all)
    }
    return lens.gatherText(all, lo ?? 0, hi ?? lens.nBins)
  }
  const missing = (path: string): Error => new Error(`${handle.uri} has no dataset ${path}`)
  const numbers = (table: Table, column: string, path: string, lo?: number, hi?: number): Float64Array => {
    const values = table.data[column]
    if (values === undefined || isText(values)) throw missing(path)
    const all = values instanceof Float64Array ? values : Float64Array.from(values as ArrayLike<number>)
    return all.slice(lo ?? 0, hi ?? table.length)
  }
  const strings = (table: Table, column: string, path: string, lo?: number, hi?: number): string[] => {
    const values = table.data[column]
    if (!isText(values)) throw missing(path)
    return values.slice(lo ?? 0, hi ?? table.length)
  }
  /** The numbers at a path, where the curated map answers for it; `null` where the file does. */
  const curatedNumbers = (at: string, lo?: number, hi?: number): Float64Array | null => {
    if (at === 'indexes/chrom_offset') return lens.chromOffset.slice(lo ?? 0, hi ?? lens.chromOffset.length)
    if (at === 'indexes/genome_offset') return layout.genomeOffset.slice(lo ?? 0, hi ?? layout.genomeOffset.length)
    const genome = columnOf(at, 'genomes')
    if (genome !== null) return numbers(genomes, genome, at, lo, hi)
    const contig = contigColumn(at)
    if (contig !== null) return numbers(contigs(), contig, at, lo, hi)
    const bin = columnOf(at, 'bins')
    if (bin !== null) return binNumbers(bin, lo, hi)
    return null
  }
  const binsTable = (lo?: number, hi?: number, columns?: readonly string[]): Table => {
    const start = Math.max(0, Math.min(lens.nBins, Math.trunc(lo ?? 0)))
    const stop = Math.max(start, Math.min(lens.nBins, Math.trunc(hi ?? lens.nBins)))
    const names: string[] = []
    const data: Record<string, Column> = {}
    for (const name of handle.keys('bins')) {
      if (hidden(name) || (columns !== undefined && !columns.includes(name))) continue
      const dtype = handle.dtype(`bins/${name}`)
      try {
        data[name] = /^[ASU]/.test(dtype) ? binStrings(name, start, stop) : binNumbers(name, start, stop)
        names.push(name)
      } catch {
        // A column this reader cannot decode is left out, as `readTable` leaves it.
      }
    }
    return makeTable(stop - start, names, data)
  }
  return new Proxy(handle, {
    get(target, property) {
      switch (property) {
        case 'attrs':
          return (): Record<string, AttrValue> => ({ ...attrs })
        case 'attrsAt':
          return (path: string): Record<string, AttrValue> => (strip(path) === '' ? { ...attrs } : target.attrsAt(path))
        case 'has':
          return (path: string): boolean => {
            const at = strip(path)
            const genome = columnOf(at, 'genomes')
            if (genome !== null) return genomes.columns.includes(genome)
            const bin = columnOf(at, 'bins')
            if (bin !== null) return target.has(at) && !hidden(bin)
            return target.has(at)
          }
        case 'keys':
          return (path: string): string[] => {
            const at = strip(path)
            if (at === 'genomes') return [...genomes.columns]
            if (at === 'bins') return target.keys(at).filter((column) => !hidden(column))
            return target.keys(at)
          }
        case 'datasetLength':
          return (path: string): number => {
            const at = strip(path)
            if (columnOf(at, 'genomes') !== null) return genomes.length
            if (at === 'indexes/genome_offset') return layout.genomeOffset.length
            return target.datasetLength(at)
          }
        case 'dtype':
          return (path: string): string => {
            const at = strip(path)
            const genome = columnOf(at, 'genomes')
            if (genome !== null) return isText(genomes.data[genome]) ? 'S' : '<d'
            return target.dtype(at)
          }
        case 'readNumeric':
          return (path: string, lo?: number, hi?: number): Float64Array => {
            const at = strip(path)
            return curatedNumbers(at, lo, hi) ?? target.readNumeric(at, lo, hi)
          }
        case 'readInt32':
          return (path: string, lo?: number, hi?: number): Int32Array => {
            const at = strip(path)
            const answered = curatedNumbers(at, lo, hi)
            return answered === null ? target.readInt32(at, lo, hi) : Int32Array.from(answered)
          }
        case 'readStrings':
          return (path: string, lo?: number, hi?: number): string[] => {
            const at = strip(path)
            const genome = columnOf(at, 'genomes')
            if (genome !== null) return strings(genomes, genome, at, lo, hi)
            const contig = contigColumn(at)
            if (contig !== null) return strings(contigs(), contig, at, lo, hi)
            const bin = columnOf(at, 'bins')
            if (bin !== null) return binStrings(bin, lo, hi)
            return target.readStrings(at, lo, hi)
          }
        case 'readTable':
          return (path: string, lo?: number, hi?: number, columns?: readonly string[]): Table => {
            const at = strip(path)
            if (at === 'contigs' || at === 'chroms') return sliceTable(contigs(), lo, hi, columns)
            if (at === 'genomes') return sliceTable(genomes, lo, hi, columns)
            if (at === 'bins') return binsTable(lo, hi, columns)
            return target.readTable(at, lo, hi, columns)
          }
        default: {
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        }
      }
    },
  })
}

/**
 * A store that answers from whatever store the map beneath holds now: the
 * file's pixels as stored, or drawn to a total (§6.5). The curated map is
 * resampled beneath its lens — the draw is the file's, in the file's bins, and
 * the lens carries every pixel it makes — so a resample through the curation
 * loses none: drawn above the lens it would read a contig's rows in its own
 * batch and drop every pair the lens had turned.
 */
export function followingStore(of: () => PixelStore): PixelStore {
  return {
    get nnz(): number | null {
      return of().nnz
    },
    get countKind(): 'i' | 'u' | 'f' {
      return of().countKind
    },
    get rectangular(): boolean | undefined {
      return of().rectangular
    },
    scoreColumns: () => of().scoreColumns(),
    binOffsets: () => of().binOffsets(),
    forEachWindow: (rows: Extent, cols: Extent, plan: ReadPlan, onChunk: (chunk: PixelChunk) => void, options?: SpanScanOptions) =>
      of().forEachWindow(rows, cols, plan, onChunk, options),
    forEachBands: (bands: readonly Extent[], onChunk: (chunk: PixelChunk) => void, options?: SpanScanOptions) => of().forEachBands(bands, onChunk, options),
    scanAll: (options: ScanAllOptions) => of().scanAll(options),
  }
}
