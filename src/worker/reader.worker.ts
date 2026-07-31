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
import { DENSE_HINTS } from '../metacooler/matrix'
import { MetaCooler } from '../metacooler/MetaCooler'
import { parseMetacoolerRange } from '../metacooler/range'
import type { ByteSource, DenseMatrix, Extent, SourceStats } from '../types'
import { aggregatedAxes, binContigArray, binGenomeArray, contigRuns } from './groups'
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
import { createSource } from './sources'

/**
 * `lib` includes both DOM and WebWorker, so `self` is typed as a window here.
 * One cast, at the top, rather than a cast per `postMessage`.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope

/** Pixels per chunk during the full scan; the order of magnitude Python uses. */
const SCAN_CHUNK = 1_000_000

/**
 * Cap on the genome × genome overview. A dense `G × G` accumulator is `8·G²`
 * bytes: 2048 genomes is 34 MB, 4395 (the reference file) would be 154 MB for a
 * picture with 19 million cells that no screen can show. Above the cap the
 * densest genomes are kept and the UI says so.
 */
const OVERVIEW_MAX_UNITS = 2048

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
    sourceBytes: source.size,
    sourceKind: request.source.kind,
  }
}

function handleGenomes(): GenomesResult {
  const { mc } = requireSession()
  const display = Int32Array.from(mc.displayGenomes())
  const density = new Float64Array(mc.genomes.length)
  // Two lookups per genome into an index already in memory (§4). Doing it once
  // here rather than lazily per sort keeps the column free at every later click.
  for (const index of display) density[index] = mc.genomeDensity(index)
  return { table: tableToPayload(mc.genomes), display, density }
}

function handleContigs(): ContigsResult {
  return { table: tableToPayload(requireSession().mc.contigs) }
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
  const dense = await mc.matrix({ rows: request.rows, cols }, hintFor(request.rows, cols))
  return binLevelResult(mc, dense)
}

/**
 * Contig- or genome-level roll-up of a bounded block.
 *
 * The block is loaded at bin level and summed locally (spec §5.2): the level
 * toggle inside a genome is free because the data is already there. The sum
 * accumulates in `Float64Array` — the format widens counts to int64 precisely
 * because summation overflows int32 — and is narrowed to `Float32` only at the
 * boundary, for display.
 */
async function handleAggregate(
  request: Extract<WorkerRequest, { kind: 'aggregate' }>,
): Promise<MatrixResult> {
  const { mc } = requireSession()
  const cols = request.cols ?? request.rows
  const dense = await mc.matrix({ rows: request.rows, cols }, hintFor(request.rows, cols))
  const aggregated = mc.aggregate(dense, request.level)
  const axes = aggregatedAxes(mc, aggregated)
  return {
    nrows: aggregated.nrows,
    ncols: aggregated.ncols,
    values: Float32Array.from(aggregated.values),
    rowExtent: dense.rowExtent,
    colExtent: dense.colExtent,
    rowGroups: axes.rows,
    colGroups: axes.cols,
    level: request.level,
  }
}

/**
 * The genome × genome overview by full pixel scan.
 *
 * The one expensive operation in the app (§4) and the reason it is gated rather
 * than automatic (§7.3). `__unbinned__` is excluded, which is required (§7.4)
 * and incidentally makes the picture readable, since it otherwise dominates its
 * own row and column.
 */
async function handleOverview(
  request: Extract<WorkerRequest, { kind: 'overview' }>,
): Promise<OverviewResult> {
  const { mc } = requireSession()
  const id = request.id
  const level = request.level ?? 'genome'
  const cap = request.maxUnits ?? OVERVIEW_MAX_UNITS

  // The unit of both axes: a genome, or a contig. `__unbinned__` is excluded at
  // either level — at contig level that means excluding *its* contigs, which is
  // the same rule (§7.4) applied one level down, not a different one.
  const displayed =
    level === 'genome' ? mc.displayGenomes() : displayableContigs(mc)
  const density =
    level === 'genome'
      ? (unit: number) => mc.genomeDensity(unit)
      : contigDensityLookup(mc)

  let selected = displayed
  const restricted = displayed.length > cap
  if (restricted) {
    selected = [...displayed]
      .sort((a, b) => density(b) - density(a))
      .slice(0, cap)
      .sort((a, b) => a - b)
  }

  const n = selected.length
  const unitCount = level === 'genome' ? mc.nGenomes : mc.nContigs
  const slot = new Int32Array(unitCount).fill(-1)
  selected.forEach((unit, index) => {
    slot[unit] = index
  })
  const binUnit = level === 'genome' ? binGenomeArray(mc) : binContigArray(mc)
  const acc = new Float64Array(n * n)
  const mirror = mc.storageMode === 'symmetric-upper'

  await mc.scanPixels({
    chunkSize: SCAN_CHUNK,
    onChunk: (chunk) => {
      if (cancelled.has(id)) return false
      for (let k = 0; k < chunk.length; k++) {
        const a = slot[binUnit[chunk.bin1[k]]]
        if (a < 0) continue
        const b = slot[binUnit[chunk.bin2[k]]]
        if (b < 0) continue
        const value = chunk.count[k]
        acc[a * n + b] += value
        if (mirror && a !== b) acc[b * n + a] += value
      }
      return true
    },
    onProgress: (done, total) => post({ type: 'progress', id, done, total }),
  })

  if (cancelled.has(id)) throw abortError()

  const names = level === 'genome' ? mc.genomeNames : mc.chromnames
  return {
    level,
    labels: selected.map((unit) => names[unit]),
    values: Float32Array.from(acc),
    n,
    source: 'scan',
    restricted,
    totalUnits: displayed.length,
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
    if (mc.contigGenomeIds[i] !== unbinned) out.push(i)
  }
  return out
}

/**
 * Per-contig non-zero pixel counts, from **one** read of `bin1_offset`.
 *
 * `MetaCooler.genomeDensity` does two tiny reads per call, which is right for a
 * few thousand genomes and wrong for 154 k contigs. The caller is about to scan
 * every pixel anyway, so one 3 MB read to pick the axis set is cheap by
 * comparison. Not a contact count, exactly as in §4.
 */
function contigDensityLookup(mc: MetaCooler): (contig: number) => number {
  const offsets = mc.handle.readNumeric('indexes/bin1_offset')
  return (contig: number) => {
    const [lo, hi] = mc.contigExtent(contig)
    if (hi <= lo) return 0
    return offsets[hi] - offsets[lo]
  }
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
    values,
    n,
    source: 'edge-list',
    restricted: false,
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
