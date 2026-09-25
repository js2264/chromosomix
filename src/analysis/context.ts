/**
 * What the panel and the drawer know before anything runs.
 *
 * Assembled on the **main thread**, from what the reader already sent when the
 * file was opened, and deliberately not by asking the worker for it. Three
 * things read this — `appliesTo`, which decides whether a task row exists at
 * all; the form, which fills its four entry dropdowns; and `estimate`, which
 * prices a run before the reader commits to it — and every one of them happens
 * while somebody is looking at a list. A round trip to price a row nobody has
 * clicked is a round trip that makes the panel feel slow for no result.
 *
 * The one number here that is derived rather than reported is `startBin`. It is
 * the §3.3 arithmetic — a fixed-bin file's `chrom_offset` is the running sum of
 * `ceil(length / binsize)` — and it is recomputed here rather than shipped
 * because the reader has never had a reason to send it and adding a field to
 * `OpenResult` for a panel is the wrong direction. Where the two could disagree
 * they cannot: this is the same expression `metacooler/coords.ts` evaluates, and
 * `test/unit/analysis-context.test.ts` checks it against a real file's offsets.
 */

import type { AnnotationEntry } from '../annotations/types'
import type { LayoutKind } from '../types'
import type {
  AnalysisContext,
  AnalysisFraming,
  ContextContig,
  ContextGenome,
  Params,
} from './types'

/** The parts of an open file this needs, named so nothing imports `Session`. */
export interface ContextInput {
  uri: string
  layout: LayoutKind
  binsize: number
  nBins: number
  hasGenomes: boolean
  hasWeights: boolean
  scoreColumns: string[]
  /** The `/contigs` table, flattened, as the reader sends it. */
  contigs: { length: number; columns: string[]; data: Record<string, string[] | Float64Array> } | null
  /** The `/genomes` table, likewise; `null` for a plain cooler. */
  genomes: { length: number; columns: string[]; data: Record<string, string[] | Float64Array> } | null
  /** Which genome rows may be shown. `__unbinned__` is not among them (§7.4). */
  displayGenomes: Int32Array | null
  entries: readonly AnnotationEntry[]
  framing: AnalysisFraming | null
  blockLoaded: boolean
  blockBytes: number
  /** Cells in a single-cell container (§3.8); absent or `0` for every other file. */
  cells?: number
  /** How many of them are ticked; absent means all of them. */
  activeCells?: number
  /** The ticked cells by name, where fewer than all of them are. */
  selectedCells?: readonly string[]
  /** The other maps of a deck, for a task that compares two files (§16). */
  peers?: Array<{ label: string; uri: string; binsize: number }>
  /** The resolution ladder in bp, finest first; absent or empty without one. */
  resolutions?: number[]
  /** The sequences declared circular, and the declared origins (§8.15). */
  circular?: readonly string[]
  origins?: Readonly<Record<string, number>>
}

function strings(
  table: ContextInput['contigs'],
  column: string,
): string[] | null {
  const value = table?.data[column]
  return Array.isArray(value) ? value : null
}

function numbers(table: ContextInput['contigs'], column: string): Float64Array | null {
  const value = table?.data[column]
  return value instanceof Float64Array ? value : null
}

/**
 * Bins one sequence occupies, at this bin size.
 *
 * `ceil`, because the last bin of a contig is partial — a sequence length is not
 * a multiple of the bin size — and the partial bin is a bin. Rounding down here
 * would shift `startBin` for every contig after the first and put every
 * subsequent estimate, region default and gate on the wrong sequence.
 */
export function binsForLength(length: number, binsize: number): number {
  if (!(binsize > 0) || !(length > 0)) return 0
  return Math.ceil(length / binsize)
}

/**
 * The same sequences, in the same order, each cut from its first base into bins
 * of `binsize` — the grid a vector at a bin size of its own is laid out over.
 *
 * Base composition is the task that makes one (§18.8): it reads at the map's
 * resolution unless told otherwise, and at 10 kb with no map, and a lane or a
 * file laid out over the map's grid at any other size gives every sequence after
 * the first the values of the one before it. A sequence with no length has no
 * bins, as on the session's own grid.
 */
export function gridAt(
  contigs: ReadonlyArray<{ name: string; length: number }>,
  binsize: number,
): Array<{ name: string; startBin: number; bins: number; length: number }> {
  const out: Array<{ name: string; startBin: number; bins: number; length: number }> = []
  let startBin = 0
  for (const contig of contigs) {
    const bins = binsForLength(contig.length, binsize)
    if (bins === 0) continue
    out.push({ name: contig.name, startBin, bins, length: contig.length })
    startBin += bins
  }
  return out
}

/** Assemble the context. Pure, so a test can build one without a worker. */
export function buildAnalysisContext(input: ContextInput): AnalysisContext {
  const names = strings(input.contigs, 'name') ?? []
  const lengths = numbers(input.contigs, 'length')
  const genomeIds = numbers(input.contigs, 'genome_id')

  const contigs: ContextContig[] = []
  let startBin = 0
  for (let i = 0; i < names.length; i++) {
    const length = lengths === null ? 0 : (lengths[i] ?? 0)
    const bins = binsForLength(length, input.binsize)
    contigs.push({
      name: names[i],
      length,
      startBin,
      bins,
      genome: genomeIds === null ? -1 : (genomeIds[i] ?? -1),
    })
    startBin += bins
  }

  const genomes = genomesOf(input, contigs)

  return {
    uri: input.uri,
    layout: input.layout,
    hasGenomes: input.hasGenomes,
    hasWeights: input.hasWeights,
    scoreColumns: input.scoreColumns,
    binsize: input.binsize,
    nBins: input.nBins,
    hasMap: input.binsize > 0 && input.nBins > 0,
    contigs,
    genomes,
    entries: input.entries,
    framing: input.framing,
    blockLoaded: input.blockLoaded,
    blockBytes: input.blockBytes,
    ...(input.resolutions === undefined || input.resolutions.length === 0
      ? {}
      : { resolutions: [...input.resolutions] }),
    // Absent rather than empty where nothing is declared, as on a framing.
    ...(input.circular === undefined || input.circular.length === 0
      ? {}
      : { circular: [...input.circular] }),
    ...(input.origins === undefined || Object.keys(input.origins).length === 0
      ? {}
      : { origins: { ...input.origins } }),
    // Absent rather than zero on a file with no cells, so that a task asking
    // `(context.cells ?? 0) > 0` reads the same on an old stored context as on a
    // fresh one.
    ...(input.cells === undefined || input.cells === 0
      ? {}
      : {
          cells: input.cells,
          activeCells: input.activeCells ?? input.cells,
          ...(input.selectedCells === undefined || input.selectedCells.length === 0
            ? {}
            : { selectedCells: input.selectedCells }),
        }),
    ...(input.peers === undefined || input.peers.length === 0 ? {} : { peers: input.peers }),
  }
}

/**
 * The genomes a task may be offered, with their bin extents.
 *
 * Built from the *contigs* rather than from a column of the genomes table,
 * because the extent of a genome is where its contigs are and §3.3's
 * `genome-then-length` ordering is what makes that one contiguous run. A genome
 * with no contigs in the table is dropped rather than given an empty extent —
 * an entry a task could select and then find nothing in is worse than one that
 * is not offered.
 *
 * `__unbinned__` never appears, and it is excluded by the reader's own
 * `display` list rather than by matching the name a second time here. §7.4 is
 * emphatic that it is matched by name in exactly one place; this is not that
 * place.
 */
function genomesOf(input: ContextInput, contigs: ContextContig[]): ContextGenome[] | null {
  if (!input.hasGenomes || input.genomes === null) return null
  const names = strings(input.genomes, 'name') ?? []
  const allowed =
    input.displayGenomes === null ? null : new Set(Array.from(input.displayGenomes))

  const spans = new Map<number, { from: number; to: number; contigs: number }>()
  for (const contig of contigs) {
    if (contig.genome < 0 || contig.bins === 0) continue
    const held = spans.get(contig.genome)
    if (held === undefined) {
      spans.set(contig.genome, {
        from: contig.startBin,
        to: contig.startBin + contig.bins,
        contigs: 1,
      })
    } else {
      held.from = Math.min(held.from, contig.startBin)
      held.to = Math.max(held.to, contig.startBin + contig.bins)
      held.contigs++
    }
  }

  const out: ContextGenome[] = []
  for (const [id, span] of [...spans.entries()].sort((a, b) => a[1].from - b[1].from)) {
    if (allowed !== null && !allowed.has(id)) continue
    const name = names[id]
    if (name === undefined) continue
    out.push({ name, extent: [span.from, span.to], contigs: span.contigs })
  }
  return out
}

/**
 * The sequences a `kind: 'sequences'` parameter names, as rows of the table.
 *
 * **Never answered is every one of them**, which is the convention
 * `SequencesParam` states and the one the runners already read with
 * `Array.isArray`: the form ticks them all on the way in, so a value that is not
 * an array is a job that never went through a form — a stored session, or a
 * `metacooler-run` line with no `--sequences` — and what those mean is the whole
 * file. An **empty array** is a different answer and not a narrower one: it is a
 * reader who pressed *None*, and it prices as nothing to read.
 *
 * A ticked name this file has not got is dropped rather than counted, because a
 * deck holds files of different assemblies on purpose and a batch asks every
 * panel of it for one reader's list (§5.9). What is priced is what this file can
 * answer.
 */
export function tickedContigs(
  context: AnalysisContext,
  params: Params,
  key: string,
): ContextContig[] {
  const value = params[key]
  if (!Array.isArray(value)) return [...context.contigs]
  const names = new Set(value.filter((name): name is string => typeof name === 'string'))
  return context.contigs.filter((contig) => names.has(contig.name))
}

/**
 * The bin extent a set of sequences spans, for the *is the block enough* question.
 *
 * The outer bounds rather than a list of runs, which is what `framingCovers`
 * takes and is the conservative reading of it: a framing that covers the span
 * from the first ticked sequence to the last covers every one in between, and
 * one that does not cannot be used for any of them.
 */
export function extentOf(contigs: readonly ContextContig[]): [number, number] {
  let from = Number.POSITIVE_INFINITY
  let to = 0
  for (const contig of contigs) {
    from = Math.min(from, contig.startBin)
    to = Math.max(to, contig.startBin + contig.bins)
  }
  return Number.isFinite(from) ? [from, to] : [0, 0]
}

/** The contig of that name, or `undefined`. */
export function contigNamed(
  context: AnalysisContext,
  name: string,
): ContextContig | undefined {
  return context.contigs.find((contig) => contig.name === name)
}

/**
 * Whether the framing already covers `extent`, so a task can use the block.
 *
 * Both axes, and both must be on-diagonal-or-wider: a task that wants
 * `chrIV × chrIV` cannot take it from a block showing `chrIV × chrXII`, and the
 * cheapest way to get that wrong is to check the rows and assume the columns.
 */
export function framingCovers(
  framing: AnalysisFraming | null,
  extent: readonly [number, number],
): boolean {
  if (framing === null) return false
  return (
    framing.rows[0] <= extent[0] &&
    framing.rows[1] >= extent[1] &&
    framing.cols[0] <= extent[0] &&
    framing.cols[1] >= extent[1]
  )
}
