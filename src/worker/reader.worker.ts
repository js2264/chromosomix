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
import { parseMetacoolerRange } from '../metacooler/range'
import type { ByteSource, DenseMatrix, Extent, SourceStats } from '../types'
import { aggregatedAxes, binContigArray, binGenomeArray, contigRuns } from './groups'
import { overviewUnitCap, poolUnits, TriangleAccumulator, type UnitPooling } from './overview'
import { deviceDenseBudgetBytes } from '../metacooler/matrix'
import {
  serialiseError,
  tableToPayload,
  transfersFor,
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

function binLevelResult(mc: MetaCooler, dense: DenseMatrix): MatrixResult {
  return {
    nrows: dense.nrows,
    ncols: dense.ncols,
    values: dense.values,
    rowExtent: dense.rowExtent,
    colExtent: dense.colExtent,
    rowGroups: contigRuns(mc, dense.rowExtent),
    colGroups: contigRuns(mc, dense.colExtent),
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
  const dense = await mc.matrix(
    {
      rows: request.rows,
      cols,
      ...(request.balance === true ? { balance: true } : {}),
      ...(request.budgetBytes === undefined ? {} : { budgetBytes: request.budgetBytes }),
    },
    hintFor(request.rows, cols),
  )
  return binLevelResult(mc, dense)
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
  )
  const axes = aggregatedAxes(mc, aggregated)
  return {
    nrows: aggregated.nrows,
    ncols: aggregated.ncols,
    values: Float32Array.from(aggregated.values),
    rowExtent: request.rows,
    colExtent: cols,
    rowGroups: axes.rows,
    colGroups: axes.cols,
    level: request.level,
  }
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

async function handleValidateDeep(): Promise<DeepValidation> {
  return requireSession().mc.validateDeep()
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
  return kind === 'matrix' || kind === 'aggregate' || kind === 'overview'
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
    case 'overview':
      return handleOverview(request)
    case 'overviewSidecar':
      return handleOverviewSidecar(request)
    case 'validateDeep':
      return handleValidateDeep()
    case 'stats':
      return handleStats()
    case 'cancel':
      cancelled.add(request.target)
      return null
    case 'close':
      session?.mc.close()
      session = null
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
