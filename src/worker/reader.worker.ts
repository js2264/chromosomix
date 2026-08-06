/**
 * The reader worker — the only thread that performs I/O.
 *
 * Everything the app reads (the HDF5 mount, every range request, the optional
 * sidecar edge list) happens here, so a click on the main thread never waits on
 * a byte. The counterpart is that the main thread holds no reader object at all:
 * it sees {@link WorkerResponse} payloads and nothing else.
 *
 * This is the only module in `src/worker/` and `src/ui/` that names
 * `MetaCooler`; everything else codes against the protocol.
 */

import { UNBINNED_NAME } from '../constants'
import { ViewerError } from '../errors'
import { getH5 } from '../h5/bootstrap'
import { DENSE_HINTS } from '../metacooler/matrix'
import { MetaCooler } from '../metacooler/MetaCooler'
import {
  POOLED_CELL_CAP,
  poolPlan,
  type BinPooling,
  type PoolPlan,
} from '../metacooler/pooling'
import { parseMetacoolerRange } from '../metacooler/range'
import type { ByteSource, DenseMatrix, Extent, SourceStats } from '../types'
import {
  aggregatedAxes,
  aggregatedGenomeRuns,
  binContigArray,
  binGenomeArray,
  contigRuns,
  genomeRuns,
  idRuns,
} from './groups'
import { overviewUnitCap, poolUnits, TriangleAccumulator, type UnitPooling } from './overview'
import { deviceDenseBudgetBytes } from '../metacooler/matrix'
import {
  serialiseError,
  tableToPayload,
  transfersFor,
  type AxisGroup,
  type ContigsResult,
  type DeepValidation,
  type GenomesResult,
  type MatrixResult,
  type OpenResult,
  type OverviewResult,
  type SourceKind,
  type StatsResult,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol'
import { createSource, releaseSources } from './sources'
import { LOAD_REPORT_MS, startBusyProbe } from '../perf/busy'

/**
 * `lib` includes both DOM and WebWorker, so `self` is typed as a window here.
 * One cast, at the top, rather than a cast per `postMessage`.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope

// Start fetching and instantiating h5wasm *now*, while the user is still
// choosing a file.
//
// The runtime is a separate async chunk — 4.8 MB raw, ~766 kB brotli, with the
// wasm binary inlined — and `getH5()` is otherwise not reached until an open
// begins, so its download, parse and instantiate sat squarely between the click
// and the first byte of the file. Nothing waits on this promise: `getH5()`
// memoises its result and un-memoises a failure (`h5/bootstrap.ts`), so the
// open path calls it exactly as before and either finds it ready or awaits the
// same in-flight promise. A rejection here is deliberately swallowed — the open
// path will re-run it and report it in context.
void getH5().catch(() => undefined)

/** Pixels per chunk during the full scan; the order of magnitude Python uses. */
const SCAN_CHUNK = 1_000_000

interface Session {
  mc: MetaCooler
  source: ByteSource
  sourceKind: SourceKind
}

let session: Session | null = null
let calls = 0
let lastOp: SourceStats = { requests: 0, bytes: 0 }
const cancelled = new Set<number>()

function requireSession(): Session {
  if (session === null) throw new Error('no file is open in the reader worker')
  return session
}

function post(response: WorkerResponse, transfers: Transferable[] = []): void {
  ctx.postMessage(response, transfers)
}

/** Raised when the user cancels a scan; the client maps it to a quiet no-op. */
/**
 * The bar and the way out, for the reads that walk a whole file.
 *
 * The same two hooks the overview scan has had all along, handed to the pooled
 * read and to the roll-up — the three are one operation seen three ways, and a
 * progress bar on one of them and not the others was a difference in the
 * plumbing rather than in the wait.
 */
function scanHooks(id: number): { cancelled: () => boolean; onProgress: (done: number, total: number) => void } {
  return {
    cancelled: () => cancelled.has(id),
    onProgress: (done, total) => post({ type: 'progress', id, done, total }),
  }
}

function abortError(): Error {
  const err = new Error('cancelled')
  err.name = 'AbortError'
  return err
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOpen(request: Extract<WorkerRequest, { kind: 'open' }>): Promise<OpenResult> {
  session?.mc.close()
  session = null
  // A cancel that arrives after its target finished leaves its id behind, since
  // the `finally` that would have removed it has already run. Harmless
  // individually and unbounded over a session, so it is cleared with the file
  // the ids belonged to.
  cancelled.clear()

  const source = await createSource(request.source)
  const mc = await MetaCooler.open(request.uri, source)
  session = { mc, source, sourceKind: request.source.kind }

  return {
    uri: mc.uri,
    layout: mc.layout,
    info: mc.info,
    metadata: mc.metadata,
    binsize: mc.binsize,
    shape: mc.shape,
    nGenomes: mc.nGenomes,
    nContigs: mc.nContigs,
    nBins: mc.nBins,
    unassigned: mc.unassignedStats(),
    entries: mc.entries,
    entryGroup: mc.entryGroup,
    hasGenomes: mc.hasGenomes,
    hasWeights: mc.hasWeights,
    sourceBytes: source.size,
    sourceKind: request.source.kind,
  }
}

function handleGenomes(): GenomesResult {
  const { mc } = requireSession()
  // The *full* table, with every metadata column the creator joined in — that
  // is what this view exists to show. The open path reads only the four the
  // reader itself needs, so the taxonomy and the quality metrics arrive here,
  // when they are about to be displayed, rather than before the file is even
  // known to be openable.
  const genomes = mc.fullGenomes()
  // A plain cooler has no genome layer, and answers with an empty table rather
  // than a fabricated row. The app never asks — it lands on the contigs table —
  // but a hand-edited URL can, and an empty table is the honest answer.
  if (genomes === null) {
    return {
      table: { columns: [], length: 0, data: {} },
      display: new Int32Array(0),
      density: new Float64Array(0),
    }
  }
  const display = Int32Array.from(mc.displayGenomes())
  // One read of the index, then two array lookups per genome (§4). This used to
  // be two *HDF5 reads* per genome — 8,788 of them on the reference file, each a
  // dataset open, a metadata fetch, a malloc and a hyperslab read, all before
  // the landing table could paint.
  const density = mc.genomeDensities()
  return { table: tableToPayload(genomes), display, density }
}

function handleContigs(): ContigsResult {
  return { table: tableToPayload(requireSession().mc.fullContigs()) }
}

function binLevelResult(mc: MetaCooler, dense: DenseMatrix, genomes = false): MatrixResult {
  // Asked for, and possible: a plain cooler has no genome layer to report, and
  // answering with a fabricated one would put a name in the tooltip that is not
  // in the file.
  const withGenomes = genomes && mc.hasGenomes
  return {
    nrows: dense.nrows,
    ncols: dense.ncols,
    values: dense.values,
    rowExtent: dense.rowExtent,
    colExtent: dense.colExtent,
    rowGroups: contigRuns(mc, dense.rowExtent),
    colGroups: contigRuns(mc, dense.colExtent),
    ...(withGenomes
      ? {
          rowGenomes: genomeRuns(mc, dense.rowExtent),
          colGenomes: genomeRuns(mc, dense.colExtent),
        }
      : {}),
    level: 'bin',
  }
}

/** The hint the CLI would print for this shape of selection (§10). */
function hintFor(rows: Extent, cols: Extent): string {
  return rows[0] === cols[0] && rows[1] === cols[1] ? DENSE_HINTS.binSelection : DENSE_HINTS.range
}

async function handleMatrix(
  request: Extract<WorkerRequest, { kind: 'matrix' }>,
): Promise<MatrixResult> {
  const { mc } = requireSession()
  const cols = request.cols ?? request.rows
  const asked = planOf(request.binsPerCell, request.contigsPerCell)
  if (asked.binsPerCell > 1 || asked.contigsPerCell > 1) {
    return pooledResult(mc, request, request.rows, cols, asked)
  }
  const planned = fitPlan(mc, request.rows, cols)
  if (planned !== null) {
    return pooledResult(
      mc,
      request,
      snapToGrid(mc, request.rows, planned),
      snapToGrid(mc, cols, planned),
      planned,
    )
  }
  const dense = await mc.matrix(
    {
      rows: request.rows,
      cols,
      ...(request.balance === true ? { balance: true } : {}),
      ...(request.budgetBytes === undefined ? {} : { budgetBytes: request.budgetBytes }),
    },
    hintFor(request.rows, cols),
  )
  return binLevelResult(mc, dense, request.genomes === true)
}

/**
 * The same block at a coarser bin size, accumulated from the stored pixels.
 *
 * Still `level: 'bin'`, because that is what it is: the cells are bins of a
 * grid `binsPerCell` times coarser, each one inside a single contig, and the
 * axis runs are the contigs over them exactly as they are over the file's own
 * bins. What the UI does with that is multiply its bin size by `binsPerCell`.
 *
 * No `unitStart`: a contig starts a fresh cell here by construction, so a
 * group's own `start` is where it begins and the block-relative arithmetic is
 * already right. `unitLength` is sent, because the last cell of a contig is
 * partial and a selection that runs to the end of the sequence must clamp to the
 * sequence rather than to a multiple of the coarse bin.
 */
async function pooledResult(
  mc: MetaCooler,
  request: Extract<WorkerRequest, { kind: 'matrix' }>,
  rows: Extent,
  cols: Extent,
  aim: PoolPlan,
): Promise<MatrixResult> {
  const id = request.id
  const pooled = await mc.pooledMatrix(
    { rows, cols, ...(request.balance === true ? { balance: true } : {}) },
    aim,
    scanHooks(id),
  )
  if (cancelled.has(id)) throw abortError()
  const runs = (ids: Int32Array): AxisGroup[] =>
    idRuns(
      ids,
      (id) => mc.chromnames[id] ?? String(id),
      undefined,
      (id) => mc.coords.contigLengths[id],
    )
  const withGenomes = request.genomes === true && mc.hasGenomes
  return {
    nrows: pooled.nrows,
    ncols: pooled.ncols,
    values: Float32Array.from(pooled.values),
    rowExtent: rows,
    colExtent: cols,
    rowGroups: withMembers(mc, anchor(mc, runs(pooled.rowIds), rows, pooled.binsPerCell), pooled.rowMembers),
    colGroups: withMembers(mc, anchor(mc, runs(pooled.colIds), cols, pooled.binsPerCell), pooled.colMembers),
    ...(withGenomes
      ? {
          rowGenomes: aggregatedGenomeRuns(mc, pooled.rowIds),
          colGenomes: aggregatedGenomeRuns(mc, pooled.colIds),
        }
      : {}),
    level: 'bin',
    binsPerCell: pooled.binsPerCell,
    contigsPerCell: pooled.contigsPerCell,
    rowContigs: contigSpan(mc, rows),
    colContigs: contigSpan(mc, cols),
  }
}

/**
 * Name every sequence in a group whose cells hold more than one.
 *
 * A group spans cells `[start, end)` and is *labelled* with the first sequence
 * in it. Where the small ones shared a cell the rest have no label anywhere, and
 * a reader looking at the pixel or scanning the sequence list beside the map
 * would never learn they are there — the list appeared to hold every other
 * contig, which is exactly what it was doing.
 */
function withMembers(mc: MetaCooler, groups: AxisGroup[], pooling: BinPooling): AxisGroup[] {
  if (pooling.contigsPerCell <= 1) return groups
  return groups.map((group) => {
    const from = pooling.memberStart[group.start]
    const to = pooling.memberStart[group.end]
    // Distinct sequences, not one entry per cell. A group is *one* sequence
    // however many cells it spans — a contig longer than the capacity has
    // several — and walking the cells listed it once each, which is how a name
    // came to appear twice in a list of names and how a cell holding one
    // sequence came to describe itself as holding two.
    const members: Array<{ label: string; unitLength: number }> = []
    for (let i = from; i < to; i++) {
      const id = pooling.members[i]
      if (i > from && id === pooling.members[i - 1]) continue
      members.push({
        label: mc.chromnames[id] ?? String(id),
        unitLength: mc.coords.contigLengths[id] ?? 0,
      })
    }
    return members.length > 1 ? { ...group, merged: members } : group
  })
}

/**
 * Where the axis's first sequence begins, when the block does not begin with it.
 *
 * A pooled axis is measured in cells, and `bpWithin` reads a position as
 * `(blockStart + offset − unitStart) × cellSize`. With the grid anchored to the
 * contig ({@link snapToGrid}) the block may open partway along one, and the cells
 * of it that fall before the block are exactly what `unitStart` has to discount —
 * otherwise a region opened at 320 kb calls its first cell 0 bp, which is the
 * `unitStart` failure the dense path already avoids by carrying the contig's own
 * start bin.
 *
 * Only the first run can need it: every later sequence begins where its own cells
 * do, and there the default — the run's block-local start — is already right.
 */
function anchor(mc: MetaCooler, runs: AxisGroup[], [lo]: Extent, k: number): AxisGroup[] {
  if (runs.length === 0 || k <= 1) return runs
  const [start] = mc.coords.contigBinExtent(mc.coords.contigOfBin(lo))
  const before = Math.floor((lo - start) / k)
  if (before <= 0) return runs
  return [{ ...runs[0], unitStart: lo + runs[0].start - before }, ...runs.slice(1)]
}

/** How many sequences an extent covers, for a summary that counts assemblies. */
function contigSpan(mc: MetaCooler, [lo, hi]: Extent): number {
  if (hi <= lo) return 0
  return mc.coords.contigOfBin(hi - 1) - mc.coords.contigOfBin(lo) + 1
}

/**
 * A request's two pooling numbers as a plan, defaulted and sanitised.
 *
 * The wire carries them separately because a request is JSON and a plan is not,
 * and either may be absent — an unpooled read sends neither.
 */
/**
 * The plan a block needs, whether or not the caller worked one out.
 *
 * A view that knows its size sends one; a view that asks for a bin range
 * without looking — the genome view, whose genome may be four contigs or four
 * thousand — sends nothing, and used to get a dense block of whatever size the
 * range implied. Past the renderer's cap that block was pooled on arrival, flat
 * and contig-blind, which is the straddling this module exists to prevent; and
 * past two gigabytes it was refused outright, which is how a mammalian
 * chromosome at 10 kb became an error message.
 *
 * So the reader plans it. It is the side that knows where the contigs fall, and
 * the plan it used is in the response, which is where the view reads its
 * resolution from.
 *
 * Only for a block that **begins on a contig boundary** — every whole-file,
 * whole-genome and whole-contig read. A region starting mid-contig carries a
 * `unitStart` the coarse grid has no cell for, so it is left dense and refused
 * by size as before rather than drawn against an origin that has quietly moved.
 *
 * **A balanced block is planned like any other, and that is a known
 * approximation.** Summing balanced values is not balancing at a coarser
 * resolution: a cell of `k × k` bin pairs comes out about `k` times a single
 * balanced value once the marginals are accounted for, which is why `cooler
 * zoomify --balance` re-balances every level from raw counts rather than summing
 * the level below. It also loses a diagnostic — a filtered bin carries a `NaN`
 * weight, the dense path multiplies it through so the whole row draws
 * transparent (§6.4: "a blank row is an unbalanced row"), and `pixelAccumulator`
 * drops `NaN` contributions instead, so that row comes back as an ordinary
 * number. Both are accepted rather than fixed here: the alternative was keeping
 * balanced blocks dense, which refuses a mammalian chromosome outright and draws
 * the rest through a contig-blind raster. Balancing at the read's own
 * resolution, and taking a coarser rung of a laddered file where one exists, are
 * the real answers and are not attempted.
 */
function fitPlan(mc: MetaCooler, rows: Extent, cols: Extent): PoolPlan | null {
  const spans = rows[0] === cols[0] && rows[1] === cols[1] ? [rows] : [rows, cols]
  if (spans.every((span) => fits(mc, span, 1))) return null
  // The smallest grid that fits, shared by both axes because the panel has one
  // bin size: the finer axis is coarsened to the other's cell rather than given
  // a resolution the labels down the side contradict. Exact rather than
  // `poolPlan`'s bound, since the contig extents are right here — the bound is
  // for a caller that has to name the resolution before anything is read.
  for (const [lo, hi] of spans) {
    const contigs = mc.coords.contigOfBin(hi - 1) - mc.coords.contigOfBin(lo) + 1
    if (contigs > POOLED_CELL_CAP) {
      return { binsPerCell: 1, contigsPerCell: Math.ceil(contigs / POOLED_CELL_CAP) }
    }
  }
  let low = 2
  let high = 2
  const ok = (k: number): boolean =>
    spans.every((span) => fits(mc, snapToGrid(mc, span, { binsPerCell: k, contigsPerCell: 1 }), k))
  while (!ok(high)) high *= 2
  while (low < high) {
    const mid = (low + high) >> 1
    if (ok(mid)) high = mid
    else low = mid + 1
  }
  return { binsPerCell: low, contigsPerCell: 1 }
}

/** Whether an extent comes to at most a picture's worth of cells at `k`. */
function fits(mc: MetaCooler, [lo, hi]: Extent, k: number): boolean {
  return cellsIn(mc, [lo, hi], k) <= POOLED_CELL_CAP
}

/** Cells an extent needs, from the contig extents — no per-bin array. */
function cellsIn(mc: MetaCooler, [lo, hi]: Extent, k: number): number {
  if (hi <= lo) return 0
  let cells = 0
  const last = mc.coords.contigOfBin(hi - 1)
  for (let c = mc.coords.contigOfBin(lo); c <= last; c++) {
    const [cs, ce] = mc.coords.contigBinExtent(c)
    cells += Math.ceil((Math.min(hi, ce) - Math.max(lo, cs)) / k)
  }
  return cells
}

/**
 * An extent widened to the **contig's own** cell edges.
 *
 * The grid is a property of the sequence, not of the question: cells fall at
 * `contigStart + m·k` whatever range was asked for. That is what makes a region
 * behave like the chromosome it is cut from — the same base pair lands in the
 * same cell, holding the same sum, in every view of it — and it is what gives
 * the first cell a place in the contig's coordinates, which is the thing a block
 * anchored at its own left edge does not have.
 *
 * Widening rather than trimming, because a cell that holds only the part of
 * itself inside the request is a cell whose value moves when you pan. At most
 * `k − 1` bins are added at each end, and the extent that comes back is the one
 * reported, so the summary names what was drawn.
 */
function snapToGrid(mc: MetaCooler, [lo, hi]: Extent, plan: PoolPlan): Extent {
  if (hi <= lo) return [lo, hi]
  const [firstStart] = mc.coords.contigBinExtent(mc.coords.contigOfBin(lo))
  const [lastStart, lastEnd] = mc.coords.contigBinExtent(mc.coords.contigOfBin(hi - 1))
  // A cell of whole sequences snaps to whole sequences; there is no finer edge
  // for it to land on.
  if (plan.contigsPerCell > 1) return [firstStart, lastEnd]
  const k = plan.binsPerCell
  if (k <= 1) return [lo, hi]
  return [
    firstStart + Math.floor((lo - firstStart) / k) * k,
    Math.min(lastEnd, lastStart + Math.ceil((hi - lastStart) / k) * k),
  ]
}

function planOf(binsPerCell?: number, contigsPerCell?: number): PoolPlan {
  return {
    binsPerCell: Math.max(1, Math.trunc(binsPerCell ?? 1)),
    contigsPerCell: Math.max(1, Math.trunc(contigsPerCell ?? 1)),
  }
}

/**
 * Contig- or genome-level roll-up of a bounded block.
 *
 * Accumulated **from the stored pixels**, not from a dense block. The sum
 * accumulates in `Float64Array` — the format widens counts to int64 precisely
 * because summation overflows int32 — and is narrowed to `Float32` only at the
 * boundary, for display.
 *
 * This used to load the block at bin level first, on the grounds from §5.2 that
 * the level toggle inside a genome is free because the data is already there.
 * That is true of a MAG and false of everything larger: a whole yeast genome at
 * 500 bp is 2.4 GB and two seconds to produce a 17 × 17 answer, and the dense
 * guard refused it outright — including as the escape hatch offered by its own
 * refusal message. The sparse path costs the pixels the selection actually
 * holds and produces output identical to the last bit.
 */
async function handleAggregate(
  request: Extract<WorkerRequest, { kind: 'aggregate' }>,
): Promise<MatrixResult> {
  const { mc } = requireSession()
  const cols = request.cols ?? request.rows
  const aggregated = await mc.aggregateSparse(
    { rows: request.rows, cols, ...(request.balance === true ? { balance: true } : {}) },
    request.level,
    scanHooks(request.id),
  )
  if (cancelled.has(request.id)) throw abortError()
  const axes = aggregatedAxes(mc, aggregated)
  // Only a contig-level roll-up has a genome to name over it: at genome level
  // the axis already *is* the genome, and repeating it in the tooltip would be
  // the same word twice.
  const withGenomes = request.genomes === true && mc.hasGenomes && request.level === 'contig'
  return {
    nrows: aggregated.nrows,
    ncols: aggregated.ncols,
    values: Float32Array.from(aggregated.values),
    rowExtent: request.rows,
    colExtent: cols,
    rowGroups: axes.rows,
    colGroups: axes.cols,
    ...(withGenomes
      ? {
          rowGenomes: aggregatedGenomeRuns(mc, aggregated.rowIds),
          colGenomes: aggregatedGenomeRuns(mc, aggregated.colIds),
        }
      : {}),
    level: request.level,
    contigsPerCell: aggregated.contigsPerCell,
    rowContigs: contigSpan(mc, request.rows),
    colContigs: contigSpan(mc, cols),
  }
}

/**
 * One map of several chosen sequences (§5.5's plural).
 *
 * The axis is the selection, in the order the file lays it out rather than the
 * order it was ticked in: a matrix whose rows jump about is a picture of the
 * clicking, and the diagonal of a Hi-C map is only readable when the sequences
 * are where the file put them.
 *
 * A genome resolves to its contigs, which is what makes ticking four MAGs and
 * ticking their contigs the same picture. Names that match nothing are dropped
 * rather than refused — a link outlives the file it was made from, and the
 * sequences that *are* there still make a map.
 */
async function handleSelection(
  request: Extract<WorkerRequest, { kind: 'selection' }>,
): Promise<MatrixResult> {
  const { mc } = requireSession()
  const id = request.id
  const units = selectedContigs(mc, request.unit, request.names)
  if (units.length === 0) {
    // `unknown-label` is the code the reader already uses for a name this file
    // does not have; a selection of them is the same failure, several times.
    throw new ViewerError(
      'unknown-label',
      `None of the ${request.unit === 'genome' ? 'genomes' : 'sequences'} named are in this ` +
        'file, so there is nothing to draw. They may belong to another map.',
      { unit: request.unit, names: request.names },
    )
  }
  const aim = planOf(request.binsPerCell, request.contigsPerCell)
  // The caller chooses the plan, because the caller labels the axis in the
  // matching units — but it chooses it from counts it worked out itself, and a
  // plan that is too fine is a matrix the size of its own square. Coarsened
  // here rather than refused: the axis is named sequences either way, and a
  // selection of six thousand contigs is a picture of six thousand contigs,
  // three to a cell, rather than an error message. What was used is reported
  // back, so the summary above the map cannot claim a resolution the picture
  // does not have.
  const bins = units.reduce((sum, unit) => sum + (unit.extent[1] - unit.extent[0]), 0)
  const floor = poolPlan(bins, units.length, POOLED_CELL_CAP)
  const plan: PoolPlan = {
    binsPerCell: Math.max(aim.binsPerCell, floor.binsPerCell),
    contigsPerCell: Math.max(aim.contigsPerCell, floor.contigsPerCell),
  }
  const selected = await mc.selectionMatrix(units, plan, {
    ...scanHooks(id),
    ...(request.balance === true ? { balance: true } : {}),
  })
  if (cancelled.has(id)) throw abortError()

  const runs = idRuns(
    selected.ids,
    (contig) => mc.chromnames[contig] ?? String(contig),
    undefined,
    (contig) => mc.coords.contigLengths[contig],
  )
  const withGenomes = mc.hasGenomes
  return {
    nrows: selected.nrows,
    ncols: selected.ncols,
    values: Float32Array.from(selected.values),
    // The axis is not a bin range, so the extent is the axis itself: cell 0 is
    // where it starts. `unitStart` is absent for the same reason, and the
    // coordinate arithmetic falls back to the group's own start, which is right.
    rowExtent: [0, selected.nrows],
    colExtent: [0, selected.ncols],
    rowGroups: runs,
    colGroups: runs,
    ...(withGenomes
      ? {
          rowGenomes: aggregatedGenomeRuns(mc, selected.ids),
          colGenomes: aggregatedGenomeRuns(mc, selected.ids),
        }
      : {}),
    level: 'bin',
    binsPerCell: selected.binsPerCell,
    contigsPerCell: selected.contigsPerCell,
  }
}

/**
 * The contigs a selection names, in file order, with their bin extents.
 *
 * File order — by where the bins are — rather than the order given: see
 * {@link handleSelection}. Duplicates collapse, so a genome ticked alongside one
 * of its own contigs draws that contig once.
 */
function selectedContigs(
  mc: MetaCooler,
  unit: 'genome' | 'contig',
  names: readonly string[],
): Array<{ id: number; extent: Extent }> {
  const ids = new Set<number>()
  for (const name of names) {
    if (unit === 'contig') {
      const id = mc.chromnames.indexOf(name)
      if (id >= 0) ids.add(id)
      continue
    }
    const genome = mc.genomeNames.indexOf(name)
    if (genome < 0) continue
    for (let contig = 0; contig < mc.nContigs; contig++) {
      if (mc.contigGenomeIds[contig] === genome) ids.add(contig)
    }
  }
  return [...ids]
    .map((id) => ({ id, extent: mc.contigExtent(id) }))
    .sort((a, b) => a.extent[0] - b.extent[0])
}

/**
 * The genome × genome (or contig × contig) overview, by full pixel scan.
 *
 * The one expensive operation in the app (§4) and the reason it is gated rather
 * than automatic (§7.3). `__unbinned__` is excluded, which is required (§7.4)
 * and incidentally makes the picture readable, since it otherwise dominates its
 * own row and column.
 *
 * Where there are more units than the machine will draw, they are **pooled**,
 * not dropped: see `worker/overview.ts`. Nothing is excluded except
 * `__unbinned__`, and no unit is chosen over another.
 */
async function handleOverview(
  request: Extract<WorkerRequest, { kind: 'overview' }>,
): Promise<OverviewResult> {
  const { mc } = requireSession()
  const id = request.id
  const level = request.level ?? 'genome'

  if (level === 'genome' && !mc.hasGenomes) {
    throw new ViewerError(
      'unsupported',
      'This file is a plain cooler and has no genomes, so there is no genome × genome view of ' +
        'it. The contig level is the same scan over the axes this file does have.',
      { level },
    )
  }

  // The unit of both axes: a genome, or a contig. `__unbinned__` is excluded at
  // either level — at contig level that means excluding *its* contigs, which is
  // the same rule (§7.4) applied one level down, not a different one.
  const displayed = level === 'genome' ? mc.displayGenomes() : displayableContigs(mc)
  const cap = Math.max(1, Math.trunc(request.maxUnits ?? overviewUnitCap(deviceDenseBudgetBytes())))

  // At contig level the coarser structure is the genome, and slots are snapped
  // to it so a pooled row never straddles two genomes — which is the whole
  // point of the contig picture, since the genome blocks are what it shows.
  const groupOf =
    level === 'contig' && mc.hasGenomes
      ? (position: number) => mc.contigGenomeIds[displayed[position]]
      : undefined
  const pooling = poolUnits(displayed.length, cap, groupOf)
  const n = pooling.slots

  const unitCount = level === 'genome' ? mc.nGenomes : mc.nContigs
  const slot = new Int32Array(unitCount).fill(-1)
  for (let i = 0; i < displayed.length; i++) slot[displayed[i]] = pooling.slotOf[i]

  const binUnit = level === 'genome' ? binGenomeArray(mc) : binContigArray(mc)
  const mirror = mc.storageMode === 'symmetric-upper'
  const triangle = mirror ? new TriangleAccumulator(n) : null
  const square = mirror ? null : new Float64Array(n * n)

  await mc.scanPixels({
    chunkSize: SCAN_CHUNK,
    onChunk: (chunk) => {
      if (cancelled.has(id)) return false
      if (triangle !== null) {
        for (let k = 0; k < chunk.length; k++) {
          const a = slot[binUnit[chunk.bin1[k]]]
          if (a < 0) continue
          const b = slot[binUnit[chunk.bin2[k]]]
          if (b < 0) continue
          triangle.add(a, b, chunk.count[k])
        }
      } else {
        // `square` storage holds both triangles independently, so each stored
        // pixel is placed once and nothing is mirrored.
        for (let k = 0; k < chunk.length; k++) {
          const a = slot[binUnit[chunk.bin1[k]]]
          if (a < 0) continue
          const b = slot[binUnit[chunk.bin2[k]]]
          if (b < 0) continue
          square![a * n + b] += chunk.count[k]
        }
      }
      return true
    },
    onProgress: (done, total) => post({ type: 'progress', id, done, total }),
  })

  if (cancelled.has(id)) throw abortError()

  const names = level === 'genome' ? mc.genomeNames : mc.chromnames
  const axis = axisLabels(displayed, pooling, (unit) => names[unit])
  return {
    level,
    labels: axis.labels,
    unitNames: axis.unitNames,
    ...(level === 'contig' && mc.hasGenomes
      ? {
          // The *genome* of each slot, for the heavier dividers. Slots are
          // snapped to genome boundaries, so this is exact rather than the
          // genome of whichever contig happened to come first.
          groups: axisLabels(displayed, pooling, (unit) => mc.genomeNames[mc.contigGenomeIds[unit]])
            .unitNames,
        }
      : {}),
    values: triangle !== null ? triangle.toSquare() : Float32Array.from(square!),
    n,
    source: 'scan',
    pooled: pooling.pooled,
    unitsPerSlot: pooling.pooled ? displayed.length / n : 1,
    totalUnits: displayed.length,
  }
}

/**
 * One label per slot: the name of its first unit, plus a count when the slot
 * holds more than one.
 *
 * The first rather than a synthesised range, because a slot's units are
 * consecutive and share a genome — so "NODE_7431_len_134871 +15" names where the
 * row starts and says how wide it is, which is what a reader hovering it needs.
 */
function axisLabels(
  displayed: readonly number[],
  pooling: UnitPooling,
  nameOf: (unit: number) => string,
): { labels: string[]; unitNames: string[] } {
  const first: number[] = new Array<number>(pooling.slots)
  const size = new Int32Array(pooling.slots)
  for (let i = 0; i < displayed.length; i++) {
    const s = pooling.slotOf[i]
    if (size[s] === 0) first[s] = displayed[i]
    size[s] += 1
  }
  const unitNames = Array.from(
    { length: pooling.slots },
    (_, s) => nameOf(first[s]) ?? String(first[s]),
  )
  return {
    labels: unitNames.map((name, s) => (size[s] > 1 ? `${name} +${size[s] - 1}` : name)),
    unitNames,
  }
}

/**
 * Contig indices that may be displayed: every contig except those belonging to
 * `__unbinned__`.
 *
 * Nothing is renumbered to achieve this (§7.4) — the excluded contigs keep
 * their ids, and the ids are what index `slot` above.
 */
function displayableContigs(mc: MetaCooler): number[] {
  const unbinned = mc.genomeNames.indexOf(UNBINNED_NAME)
  const out: number[] = []
  for (let i = 0; i < mc.nContigs; i++) {
    // With no genome layer there is nothing to exclude: every contig of a plain
    // cooler is displayable, and `contigGenomeIds` is empty rather than zeroed.
    if (!mc.hasGenomes || mc.contigGenomeIds[i] !== unbinned) out.push(i)
  }
  return out
}

/**
 * The overview from a `metacooler network --level genome` edge list.
 *
 * A `node1 / node2 / value` TSV, a few KB for a few hundred MAGs: one `fetch`
 * instead of downloading the file (§7.3). The header line is optional, so it is
 * detected rather than assumed.
 */
async function handleOverviewSidecar(
  request: Extract<WorkerRequest, { kind: 'overviewSidecar' }>,
): Promise<OverviewResult> {
  const { mc } = requireSession()
  const response = await fetch(request.url)
  if (!response.ok) {
    throw new ViewerError(
      'remote-cors',
      `The genome edge list at ${request.url} could not be read (HTTP ${response.status}).`,
      { url: request.url, status: response.status },
    )
  }
  const text = await response.text()

  const displayed = new Set(mc.displayGenomes().map((genome) => mc.genomeNames[genome]))
  const labels: string[] = []
  const seen = new Set<string>()
  const edges: Array<[string, string, number]> = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const fields = trimmed.split('\t')
    if (fields.length < 3) continue
    const value = Number(fields[2])
    // The optional --header line is the only row whose third field is not a
    // number, so no flag has to be threaded through the catalog.
    if (!Number.isFinite(value)) continue
    const [a, b] = fields
    // An edge naming __unbinned__ is dropped rather than plotted (§7.4).
    if (!displayed.has(a) || !displayed.has(b)) continue
    for (const name of [a, b]) {
      if (!seen.has(name)) {
        seen.add(name)
        labels.push(name)
      }
    }
    edges.push([a, b, value])
  }

  labels.sort()
  const index = new Map(labels.map((name, position) => [name, position]))
  const n = labels.length
  const values = new Float32Array(n * n)
  for (const [a, b, value] of edges) {
    const i = index.get(a)
    const j = index.get(b)
    if (i === undefined || j === undefined) continue
    values[i * n + j] = value
    values[j * n + i] = value
  }

  // A `network --level genome` sidecar is genome-level by construction.
  return {
    level: 'genome',
    labels,
    unitNames: labels,
    values,
    n,
    source: 'edge-list',
    pooled: false,
    unitsPerSlot: 1,
    totalUnits: displayed.size,
  }
}

async function handleValidateDeep(
  request: Extract<WorkerRequest, { kind: 'validateDeep' }>,
): Promise<DeepValidation> {
  const id = request.id
  // The same shape as the overview: the same pass over every pixel, so the same
  // right to a progress bar and a cancel. It had neither, and on a
  // reference-scale file it is minutes of uninterruptible worker behind a static
  // label.
  const result = await requireSession().mc.validateDeep({
    cancelled: () => cancelled.has(id),
    onProgress: (done, total) => post({ type: 'progress', id, done, total }),
  })
  if (cancelled.has(id)) throw abortError()
  return result
}

function handleStats(): StatsResult {
  const { source } = requireSession()
  return { total: source.stats(), lastOp: { ...lastOp }, calls }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** `true` for requests whose byte cost is worth reporting separately (§12). */
function isViewRequest(kind: WorkerRequest['kind']): boolean {
  return (
    kind === 'matrix' || kind === 'aggregate' || kind === 'overview' || kind === 'selection'
  )
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.kind) {
    case 'open':
      return handleOpen(request)
    case 'genomes':
      return handleGenomes()
    case 'contigs':
      return handleContigs()
    case 'range':
      return parseMetacoolerRange(requireSession().mc, request.range)
    case 'matrix':
      return handleMatrix(request)
    case 'aggregate':
      return handleAggregate(request)
    case 'selection':
      return handleSelection(request)
    case 'overview':
      return handleOverview(request)
    case 'overviewSidecar':
      return handleOverviewSidecar(request)
    case 'validateDeep':
      return handleValidateDeep(request)
    case 'stats':
      return handleStats()
    case 'cancel':
      cancelled.add(request.target)
      return null
    case 'close':
      session?.mc.close()
      session = null
      cancelled.clear()
      // The handle's `close` returns the *borrowed* source; this is what
      // actually releases the mount and its chunk cache (`worker/sources.ts`).
      releaseSources()
      return null
  }
}

async function handle(request: WorkerRequest): Promise<void> {
  calls++
  const before = session?.source.stats()
  try {
    const payload = await dispatch(request)
    if (isViewRequest(request.kind) && before && session) {
      const after = session.source.stats()
      lastOp = { requests: after.requests - before.requests, bytes: after.bytes - before.bytes }
    }
    post({ type: 'result', id: request.id, kind: request.kind, payload }, transfersFor(payload))
  } catch (err) {
    post({ type: 'error', id: request.id, error: serialiseError(err) })
  } finally {
    cancelled.delete(request.id)
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  void handle(event.data)
}

// How busy this thread has been, once a second, unasked. The status bar's CPU
// figure is about the tab, and the tab's expensive moments happen here: a
// whole-genome scan pins this worker for minutes while the main thread sits
// idle, and a reading taken only on the main thread would call that 0%.
const probe = startBusyProbe()
setInterval(() => post({ type: 'busy', fraction: probe.busy() }), LOAD_REPORT_MS)
