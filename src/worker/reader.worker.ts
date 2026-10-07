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
import { POOLED_CELL_CAP, type BinPooling, type PoolPlan } from '../metacooler/pooling'
import { ScoolStore } from '../metacooler/scool'
import { PICTURE_CELLS, depthFloor, depthStride, displayRange, pictureLayout, pictureStride, type PictureContacts } from '../metacooler/picture'
import { findCorners, type FileCorner } from '../edit/corners'
import { LensGrid } from '../edit/grid'
import { METHOD_GATHER, expectedOf, type Expected } from '../edit/method'
import { REFINE_REACH, REFINE_WINDOW, refineChain, refinePoint, type ReadSquare, type RefinedPoint } from '../edit/refine'
import { suggest, type Suggested } from '../edit/suggest'
import { crossResolution } from '../metacooler/coords'
import { parseMetacoolerRange } from '../metacooler/range'
import type { ResampleSpec } from '../metacooler/resample'
import { EditedAssembly, editFingerprint, type ReferenceEdit } from '../genome/edit'
import type { NameContext, NameMatch } from '../genome/naming'
import { parseUri } from '../uri'
import type { ByteSource, DenseMatrix, Extent, SourceStats } from '../types'
import {
  aggregatedAxes,
  aggregatedGenomeRuns,
  binContigArray,
  binGenomeArray,
  contigRuns,
  genomeRuns,
  idRuns,
  selectionDrawsGenomes,
} from './groups'
import { overviewUnitCap, poolUnits, TriangleAccumulator, type UnitPooling } from './overview'
import { needsWrapping } from './wrap'
import { readWrapped, type WrapEnv } from './wrappedMatrix'
import { denseCellCap, deviceDenseBudgetBytes } from '../metacooler/matrix'
import {
  serialiseError,
  tableToPayload,
  transfersFor,
  type AxisGroup,
  type BinColumnResult,
  type BinColumnsResult,
  type CellsResult,
  type CellsSelectedResult,
  type ContigsResult,
  type DeepValidation,
  type GenomesResult,
  type MatrixResult,
  type LiftedExport,
  type McoolExport,
  type OpenResult,
  type OverviewResult,
  type PairsBinning,
  type PairsImportSummary,
  type PairsProbeResult,
  type GenomeLinksResult,
  type PictureResult,
  type ResampleResult,
  type SourceKind,
  type StageWindowSide,
  type StatsResult,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol'
import type { WindowRead, WindowRun } from '../edit/paint'
import { createSource, openIndexSource, releaseSources } from './sources'
import { importPairs, probePairs, rungInImport, suggestBase, type PairsImport } from '../pairs/import'
import { mcoolNameFor } from '../pairs/mcoolName'
import { writeMcool } from '../pairs/write'
import type { BinnedPixels } from '../pairs/bin'
import type { PairsHeader } from '../pairs/format'
import { liftedTable } from '../edit/liftedContacts'
import { VERSION } from '../version'
import { openMap } from './open'
import { LOAD_REPORT_MS, startBusyProbe } from '../perf/busy'
import { Foreground } from './foreground'
import { resolutionLabel } from '../units'

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
  /**
   * Sibling rungs of this file, opened on demand and keyed by entry name.
   *
   * The worker has always held exactly one map, and for a *navigation* that is
   * still right — opening somewhere else means the last place is finished with.
   * A zoom is not a navigation: a reader pulling back from a 1 kb window to a
   * whole chromosome wants the 10 kb rung for one frame and the 1 kb rung again
   * a second later, and re-opening the file each way round would throw away the
   * contig table and the `bin1_offset` cache twice for a picture that never
   * left the same file.
   *
   * So the rungs a zoom touches are *retained*, over the same mounted bytes —
   * `createSource` hands back the very same `ByteSource` for the same URL or the
   * same `File` (`worker/sources.ts`), so a second rung costs one `h5.File` and
   * that rung's own metadata, and no download at all. Bounded, because an
   * eleven-level `.mcool` should not end up with eleven HDF5 handles open: the
   * least recently used is closed past {@link MAX_RUNGS}.
   */
  rungs: Map<string, MetaCooler>
  /** Rung names, most recently used first — the eviction order. */
  recent: string[]
  /**
   * The imported `.pairs` this session was built from, when it was one.
   *
   * Held because it *is* the file: an imported map has no bytes to go back to,
   * so a sibling rung is served from `tables` rather than re-opened, and the
   * `.mcool` export is written from the same arrays the map is drawn from.
   */
  pairs: PairsImport | null
  /**
   * The total the reader drew this map to, or `null` for the file as stored
   * (§6.5). Held on the session rather than only on the open map so that a
   * sibling rung opened later for a zoom is drawn to it as well: a picture that
   * went back to the stored counts at the next zoom out would be the one lie a
   * resampled map must not tell.
   */
  resample: ResampleSpec | null
  /**
   * The edit of the reference the map is drawn through (§27.7), or `null` for
   * the file as it is. Held for the reason {@link resample} is: a rung opened
   * later for a zoom is drawn through it too, or the next zoom out would show
   * the file's own sequences under the edited names.
   */
  lens: ReferenceEdit | null
  /**
   * The page's answer about the multi-genome containers (§29), as the open
   * that made this session carried it, so a sibling rung is opened under the
   * same one. A rung of a file that passed is a rung of the same file; this is
   * the second lock on a door the first already shut.
   */
  metacool?: boolean
  /**
   * What the method weighs of the stage's last picture (§27.5), kept here for
   * the `suggest` requests that count its suggestions off the stage's thread
   * (§27.12), under the id of the read that made it.
   */
  stageMethod?: { picture: number; contacts: PictureContacts; expected: Expected; corners: FileCorner[] }
  /**
   * The rung the stage last read a window of, drawn through its edit (§27.9),
   * kept while the edit and the rung stand: building the lens is the one part
   * of a window's read that is not the window's size.
   */
  stageWindowMap?: { key: string; map: MetaCooler }
  /**
   * Where the finer rungs placed the points the stage asked of them (§27.5),
   * by the neighbourhood each read covers — the pieces of the edited sequence
   * around it — so a point an edit elsewhere leaves as it was is not read
   * again; and the rungs drawn through the edit last asked with.
   */
  refinePlaced?: Map<string, { delta: number; binsize: number; support: number } | null>
  refineMaps?: { fingerprint: string; maps: Map<string, MetaCooler> }
}

/**
 * Sibling rungs held open at once, besides the one that was opened.
 *
 * Two is what a zoom actually uses: the rung the picture is on, and the one it
 * is heading for. A third covers a reader stepping through levels without
 * settling. Each costs an HDF5 handle and that rung's chrom table, which on a
 * cooler is kilobytes — the number is small because there is no reason for it to
 * be large, not because a larger one would break.
 */
const MAX_RUNGS = 3

let session: Session | null = null
let calls = 0
let lastOp: SourceStats = { requests: 0, bytes: 0 }
const cancelled = new Set<number>()
/** The views' reads, which the census and the circularity check stand aside for (§12). */
const foreground = new Foreground()

function requireSession(): Session {
  if (session === null) throw new Error('no file is open in the reader worker')
  return session
}

/**
 * The map a request names: the open one, or a sibling rung of it.
 *
 * Opened lazily and over the retained source, so this is one `h5.File` and that
 * rung's own metadata rather than a fresh mount. A rung this file does not have
 * — a stale link, a hand-edited request — falls back to the open map rather than
 * refusing: the block that comes back is then the one the open map holds, which
 * is a coarser or finer picture of the same place and never a wrong one.
 */
async function mapFor(rung: string | undefined): Promise<MetaCooler> {
  const active = requireSession()
  if (rung === undefined || rung === '') return active.mc
  if (!active.mc.entries.includes(rung)) return active.mc
  const held = active.rungs.get(rung)
  if (held !== undefined) {
    touchRung(active, rung)
    return held
  }
  // An imported `.pairs` has no bytes to reopen: the ladder is in memory and a
  // rung is one `MetaCooler` over a table that already exists. Built on demand
  // and retained like any other rung, so the eviction below still bounds how
  // many are held — though for this container what it evicts is a handle over
  // arrays rather than an open HDF5 file.
  if (active.pairs !== null) {
    const table = active.pairs.tables.get(Number(rung))
    if (table === undefined) return active.mc
    const built = MetaCooler.fromPairs({
      uri: active.mc.uri,
      header: active.pairs.header,
      pixels: table,
      rungs: active.pairs.rungs,
      indexed: active.pairs.indexed,
      declaredRecords: active.pairs.declaredRecords,
    })
    const seen = throughLens(active, built)
    drawnAsSession(active, seen)
    active.rungs.set(rung, seen)
    touchRung(active, rung)
    while (active.recent.length > MAX_RUNGS) {
      const oldest = active.recent.pop()
      if (oldest === undefined) break
      active.rungs.get(oldest)?.close()
      active.rungs.delete(oldest)
    }
    return seen
  }
  const group = active.mc.entryGroup === '' ? 'entries' : active.mc.entryGroup
  const { path } = parseUri(active.mc.uri)
  let opened: MetaCooler
  try {
    opened = await MetaCooler.open(
      `${path}::${group}/${rung}`,
      active.source,
      active.metacool === undefined ? {} : { metacool: active.metacool },
    )
  } catch {
    // A rung that will not open is not a reason to fail the read: the open map
    // answers the same question at a different resolution.
    return active.mc
  }
  opened = throughLens(active, opened)
  drawnAsSession(active, opened)
  active.rungs.set(rung, opened)
  touchRung(active, rung)
  while (active.recent.length > MAX_RUNGS) {
    const oldest = active.recent.pop()
    if (oldest === undefined) break
    active.rungs.get(oldest)?.close()
    active.rungs.delete(oldest)
  }
  return opened
}

/**
 * A sibling rung drawn through the session's edit, as the open map is (§27.7).
 * A rung the edit cannot be drawn on is answered by the open map, which is
 * what `mapFor` does for a rung that will not open: the same question at
 * another resolution, rather than the file's own sequences under the edit's names.
 */
function throughLens(active: Session, rung: MetaCooler): MetaCooler {
  if (active.lens === null) return rung
  const { map, refusal } = MetaCooler.withLens(rung, active.lens)
  if (refusal === null) return map
  rung.close()
  return active.mc
}

/**
 * A sibling rung drawn to the session's total, as the open map is (§6.5).
 *
 * Not awaited: the rung takes its own census when it is first read, and its
 * reads wait for it; a refusal is what those reads then answer with.
 */
function drawnAsSession(active: Session, rung: MetaCooler): void {
  if (active.resample === null) return
  rung.resample(active.resample).catch(() => undefined)
}

function touchRung(active: Session, rung: string): void {
  active.recent = [rung, ...active.recent.filter((name) => name !== rung)]
}

function releaseRungs(active: Session | null): void {
  if (active === null) return
  for (const held of active.rungs.values()) held.close()
  active.rungs.clear()
  active.recent = []
}

/**
 * A request's extent, on whichever rung is about to answer it.
 *
 * The arithmetic is `metacooler/coords.ts`'s, where it can be tested against a
 * real `.mcool` — this worker module runs `getH5()` at load and cannot be
 * imported into a test, which is the same reason `snapToGrid`'s rule is mirrored
 * in `test/unit/anchored-grid.test.ts` rather than exercised directly.
 */
function crossRung(from: MetaCooler, to: MetaCooler, extent: Extent): Extent {
  return from === to ? extent : crossResolution(from.coords, to.coords, extent)
}

function post(response: WorkerResponse, transfers: Transferable[] = []): void {
  ctx.postMessage(response, transfers)
}

/**
 * The bar and the way out, for the reads that walk a whole file.
 *
 * The same two hooks the overview scan has had all along, handed to the pooled
 * read and to the roll-up — the three are one operation seen three ways, and a
 * progress bar on one of them and not the others was a difference in the
 * plumbing rather than in the wait.
 */
function scanHooks(id: number): {
  cancelled: () => boolean
  onProgress: (done: number, total: number, note?: string) => void
} {
  return {
    cancelled: () => cancelled.has(id),
    // The `note` is passed through rather than dropped. A pixel scan has
    // nothing to say beyond its percentage, but an import does — "reading
    // records", "building the 5 kb rung", "writing pixels" — and the wire
    // type, the client and both progress surfaces have always carried it.
    onProgress: (done, total, note) =>
      post(note === undefined ? { type: 'progress', id, done, total } : { type: 'progress', id, done, total, note }),
  }
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

/**
 * Phase two of opening a `.pairs`: probe, then either refuse with the numbers
 * or run the import.
 *
 * The probe happens on both roads because it is cheap — a preamble and, where
 * there is one, a small index — and because the second road needs the index's
 * record count for its progress bar anyway.
 *
 * @returns `null` when the reader cancelled the import.
 * @throws ViewerError `pairs-binning-needed`, carrying the probe, when no
 *   binning was asked for.
 */
async function openPairs(
  request: Extract<WorkerRequest, { kind: 'open' }>,
  source: ByteSource,
): Promise<PairsImport | null> {
  const probe = await probePairs(source, () => openIndexSource(request.source))
  const binning = request.binning
  if (binning === undefined) {
    const detail: PairsProbeResult = {
      contigs: probe.header.contigs.map((contig) => ({ ...contig })),
      genomeLength: probe.genomeLength,
      records: probe.records,
      indexed: probe.index !== null,
      assembly: probe.header.assembly,
      sorted: probe.header.sorted,
      sourceBytes: probe.sourceBytes,
      suggestedBase: suggestBase(probe),
    }
    throw new ViewerError(
      'pairs-binning-needed',
      'This is a .pairs file: a list of contacts with no resolution of its own. Choose a ' +
        'bin size to build a map at.',
      detail as unknown as Record<string, unknown>,
    )
  }
  return importPairs(source, probe, {
    base: binning.base,
    rungs: binning.rungs,
    oneBased: binning.oneBased ?? true,
    ...scanHooks(request.id),
  })
}

/** What the import did, for the info panel and the status line. */
function summarise(pairs: PairsImport, download: boolean, binning: PairsBinning): PairsImportSummary {
  const base = pairs.tables.get(pairs.rungs[0])!
  const orientation = base.orientation ?? null
  return {
    binning,
    // The **base rung's**, which is the file's: a coarser rung is derived from
    // the base's pixels and never sees a record, so there is nothing there for
    // an orientation to be a property of.
    orientation:
      orientation === null
        ? null
        : { edges: orientation.edges, counts: orientation.counts, total: orientation.total },
    base: pairs.rungs[0],
    rungs: pairs.rungs,
    records: base.sum,
    nnz: base.nnz,
    indexed: pairs.indexed,
    skippedUnknownContig: base.skippedUnknownContig,
    skippedBadPosition: base.skippedBadPosition,
    clampedPosition: base.clampedPosition,
    requiredMerge: base.wasUnsorted,
    truncated: base.truncated,
    sequencesWithoutCisContacts: base.contigsWithoutCisContacts,
    download,
  }
}

/**
 * Build the `.mcool` for the import this session was opened from.
 *
 * A request of its own rather than part of `open`, for three reasons: it is a
 * second long job and wants its own bar and its own cancel; a reader who calls
 * it off still has the map; and the bytes are large enough that they want to be
 * *transferred* rather than copied across the thread boundary, which a result
 * shared with the open payload could not be.
 */
async function handleExportMcool(id: number): Promise<McoolExport> {
  const active = requireSession()
  if (active.pairs === null) {
    throw new ViewerError(
      'unsupported',
      'This map was not imported from a .pairs file, so there is nothing to write: it is ' +
        'already a file on disk or on a bucket.',
      { layout: active.mc.layout.kind },
    )
  }
  const bytes = await writeMcool(active.pairs, scanHooks(id))
  if (bytes === null) throw abortError()
  return { bytes, filename: mcoolNameFor(active.mc.uri), rungs: active.pairs.rungs }
}

/** The most pixels a lifted `.mcool` gathers across its rungs: a rung that would pass it is left out, finest first. */
const LIFT_BUDGET = 60_000_000

/**
 * The open map lifted through an edit of its reference, as an `.mcool` of
 * every rung the file has (§27.8): each rung opened as the file stores it —
 * never through the session's own lens, which may be another edit — drawn
 * through `edit`, and its pixels gathered in the edited assembly's bins.
 * Rungs finer than the budget allows are left out, and said so.
 */
async function handleExportLifted(id: number, edit: ReferenceEdit): Promise<LiftedExport> {
  const active = requireSession()
  const base = active.mc.unlensed ?? active.mc
  const hooks = scanHooks(id)
  const names = base.entries.length > 0 ? [...base.entries] : ['']
  // Finest first, as the file lists them.
  const sized = names.map((name) => ({ name, size: name === '' ? base.binsize : Number(name) })).sort((a, b) => a.size - b.size)
  const tables = new Map<number, BinnedPixels>()
  const skipped: Array<{ rung: number; why: string }> = []
  // Coarsest first, so a budget spent leaves out the finest.
  let spent = 0
  for (const { name, size } of [...sized].reverse()) {
    const rung = name === '' ? base : await openPlainRung(active, name)
    if (rung === null) {
      skipped.push({ rung: size, why: 'it would not open' })
      continue
    }
    try {
      const nnz = rung.nnz ?? 0
      if (spent + nnz > LIFT_BUDGET) {
        skipped.push({ rung: size, why: `${nnz.toLocaleString('en-US')} pixels would pass the budget of ${LIFT_BUDGET.toLocaleString('en-US')}` })
        continue
      }
      const { map, refusal } = MetaCooler.withLens(rung, edit)
      if (refusal !== null) throw new ViewerError('unsupported', refusal, {})
      const table = await liftedTable(map, {
        cancelled: hooks.cancelled,
        onProgress: (done, total) => hooks.onProgress(done, total, `lifting the ${size.toLocaleString('en-US')} bp rung`),
      })
      if (table === null) throw abortError()
      tables.set(size, table)
      spent += table.nnz
    } finally {
      if (rung !== base) rung.close()
    }
  }
  const rungs = [...tables.keys()].sort((a, b) => a - b)
  if (rungs.length === 0) throw new ViewerError('unsupported', 'No rung of this map could be lifted within the budget.', {})
  const finest = tables.get(rungs[0]) as BinnedPixels
  const header: PairsHeader = {
    version: '',
    assembly: null,
    sorted: null,
    shape: 'upper triangle',
    contigs: finest.contigs,
    columns: { chrom1: 1, pos1: 2, chrom2: 3, pos2: 4, strand1: -1, strand2: -1 } as PairsHeader['columns'],
    text: '',
  }
  const bytes = await writeMcool(
    { header, rungs, tables, indexed: false, declaredRecords: null },
    {
      ...hooks,
      about: {
        generatedBy: `metacooler-viewer ${VERSION} (lifted through an edit of the reference; unbalanced)`,
        metadata: (table) => ({
          'generated-by': `metacooler-viewer ${VERSION}`,
          'lifted-from': active.mc.uri,
          'lifted-through': edit.history.slice(0, edit.cursor).map((entry) => entry.step),
          'contacts-written': table.sum,
          balanced: false,
          note:
            'Raw counts through an edit of the reference: bins moved whole, a stretch set aside left out, a duplicated ' +
            'one written at each copy. Run `cooler balance` to add a bins/weight column.',
        }),
      },
    },
  )
  if (bytes === null) throw abortError()
  const stem = (parseUri(active.mc.uri).path.split('/').pop() ?? 'map').replace(/\.(m?m?(meta)?cool|hic|pairs(\.gz)?)$/i, '')
  // One genome's edit is that genome's map alone, and says whose.
  const genome = edit.original.genome === undefined ? '' : `.${edit.original.genome}`
  return { bytes, filename: `${stem}${genome}.edited.mcool`, rungs, contacts: finest.sum, skipped }
}

/** A rung of the open file as the file stores it: no lens, not held — the caller closes it. */
async function openPlainRung(active: Session, rung: string): Promise<MetaCooler | null> {
  if (active.pairs !== null) {
    const table = active.pairs.tables.get(Number(rung))
    if (table === undefined) return null
    return MetaCooler.fromPairs({
      uri: active.mc.uri,
      header: active.pairs.header,
      pixels: table,
      rungs: active.pairs.rungs,
      indexed: active.pairs.indexed,
      declaredRecords: active.pairs.declaredRecords,
    })
  }
  const base = active.mc.unlensed ?? active.mc
  const group = base.entryGroup === '' ? 'entries' : base.entryGroup
  const { path } = parseUri(base.uri)
  try {
    return await MetaCooler.open(`${path}::${group}/${rung}`, active.source, active.metacool === undefined ? {} : { metacool: active.metacool })
  } catch {
    return null
  }
}

/** The import and rung this URI reuses, when it reuses one — see `rungInImport`. */
function importedRungFor(
  active: Session | null,
  uri: string,
): { pairs: PairsImport; size: number } | null {
  if (active?.pairs == null) return null
  const size = rungInImport(active.pairs, active.mc.uri, uri)
  return size === null ? null : { pairs: active.pairs, size }
}

/**
 * Say what an open is doing, in the units of whatever it is doing.
 *
 * Bytes while a file is coming across, pixels while it is being parsed, and the
 * `note` says which — because the two have different denominators and a bar
 * that silently switched from one to the other would look like it had gone
 * backwards. Two sweeps with a label each is what a reader can actually follow.
 */
function reporter(id: number): (done: number, total: number, note: string) => void {
  let last = 0
  return (done, total, note) => {
    // Throttled to ~20 Hz. The download loop fires per network chunk and the
    // parse per hundredth of a file, and posting every one of them would put
    // more messages on the thread than the read it is describing.
    const now = Date.now()
    if (now - last < 50 && done < total) return
    last = now
    post({ type: 'progress', id, done, total, note })
  }
}

async function handleOpen(request: Extract<WorkerRequest, { kind: 'open' }>): Promise<OpenResult> {
  // Before the session is torn down, because it is the thing being reused.
  const reusable = importedRungFor(session, request.uri)
  releaseRungs(session)
  if (reusable === null) session?.mc.close()
  session = null
  // A cancel that arrives after its target finished leaves its id behind, since
  // the `finally` that would have removed it has already run. Harmless
  // individually and unbounded over a session, so it is cleared with the file
  // the ids belonged to.
  cancelled.clear()

  // `openMap` knows the two roads a container can arrive by: HDF5 through a
  // mount, or a HiC-Pro pair read whole as two text files (`worker/open.ts`).
  // What it cannot know is the third, because a `.pairs` is not opened at all —
  // it is *imported*, at a resolution the file does not carry — so that one is
  // reached through the refusal the mount raises, below.
  const say = reporter(request.id)
  const hooks = {
    report: say,
    cancelled: () => cancelled.has(request.id),
    // The page's dev features switch (§29), carried on each open because a
    // worker has no `localStorage` of its own to read it from.
    ...(request.metacool === undefined ? {} : { metacool: request.metacool }),
  }
  let mc: MetaCooler
  let source: ByteSource
  let pairs: PairsImport | null = reusable?.pairs ?? null
  if (reusable !== null) {
    // A rung switch inside a file already imported: no read, no dialog, no
    // second pass. The table is in hand.
    source = await createSource(request.source)
    mc = MetaCooler.fromPairs({
      uri: request.uri,
      header: reusable.pairs.header,
      pixels: reusable.pairs.tables.get(reusable.size)!,
      rungs: reusable.pairs.rungs,
      indexed: reusable.pairs.indexed,
      declaredRecords: reusable.pairs.declaredRecords,
    })
  } else {
    try {
      ;({ mc, source } = await openMap(request.uri, request.source, hooks))
    } catch (error) {
      // A `.pairs` is the one input that cannot be opened from its own bytes: it
      // declares no resolution, so there is nothing to open it *at*. The first
      // open is therefore always refused, and what comes back is what the dialog
      // needs to make the choice a decision rather than a guess.
      if (!(error instanceof ViewerError) || error.code !== 'pairs-binning-needed') throw error
      // The mount the refusal came from, handed back rather than made again:
      // `createSource` retains a source per file, so this is the same one.
      source = await createSource(request.source)
      pairs = await openPairs(request, source)
      if (pairs === null) throw abortError()
      mc = MetaCooler.fromPairs({
        uri: request.uri,
        header: pairs.header,
        pixels: pairs.tables.get(pairs.rungs[0])!,
        rungs: pairs.rungs,
        indexed: pairs.indexed,
        declaredRecords: pairs.declaredRecords,
      })
    }
  }
  // Through the edit, where the reader asked for one (§27.7): the file was
  // opened as it is, and from here on it is presented as the edited assembly.
  let lens: ReferenceEdit | null = null
  let lensRefusal: string | null = null
  if (request.edit !== undefined) {
    const seen = MetaCooler.withLens(mc, request.edit)
    mc = seen.map
    lensRefusal = seen.refusal
    if (seen.refusal === null) lens = request.edit
  }
  session = {
    mc,
    source,
    sourceKind: request.source.kind,
    rungs: new Map(),
    recent: [],
    pairs,
    resample: null,
    lens,
    ...(request.metacool === undefined ? {} : { metacool: request.metacool }),
  }

  return {
    ...(pairs === null || request.binning === undefined
      ? {}
      : { pairs: summarise(pairs, request.binning.download === true, request.binning) }),
    ...(request.edit === undefined ? {} : { edit: { refusal: lensRefusal } }),
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
    displayExtent: mc.displayBinExtent(),
    entries: mc.entries,
    entryGroup: mc.entryGroup,
    cells: mc.cells,
    activeCells: mc.activeCells,
    // Not on a remote read in small pieces: the count is one dataset header
    // per cell, scattered through the file, and on that source it is another
    // four thousand round trips after the thousand the listing already cost —
    // a wait with nothing on screen to show for it. Unknown is what it is.
    cellNnz:
      mc.cells.length > 0 && !(request.source.kind === 'remote' && request.source.reading === 'fine')
        ? mc.nnz
        : null,
    hasGenomes: mc.hasGenomes,
    hasWeights: mc.hasWeights,
    scoreColumns: mc.scoreColumns,
    sourceBytes: source.size,
    contacts: mc.declaredContacts,
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

/**
 * The cells table: one row per cell, columns discovered from their attributes.
 *
 * Free, on any file that opened at all. The names were the cost, and they were
 * paid at open; every cell's attribute block sits in HDF5 metadata the listing
 * already brought across, measured at **zero** additional source chunks on both
 * a 3,882-cell HiCMatrix file and a cooler-written one (§12). So the columns
 * that make the table worth having — the stored pixels and the contact total
 * per cell, which is what separates a deeply sequenced cell from an empty one —
 * cost nothing to offer and are read here rather than being made optional.
 */
function handleCells(): CellsResult {
  const { mc } = requireSession()
  const table = mc.cellTable()
  const active = new Set(mc.activeCells)
  const names = mc.cells
  const selected: number[] = []
  for (let i = 0; i < names.length; i++) if (active.has(names[i])) selected.push(i)
  return { table: tableToPayload(table), selected: Int32Array.from(selected) }
}

/** Swap the cells the open map sums, in place — see the request's note. */
function handleSelectCells(
  request: Extract<WorkerRequest, { kind: 'selectCells' }>,
): CellsSelectedResult {
  const { mc } = requireSession()
  mc.selectCells(request.names)
  return { names: mc.activeCells, nnz: mc.nnz ?? 0, scoreColumns: mc.scoreColumns }
}

/** What `/bins` holds, by name and kind — no values (§8.12). */
function handleBinColumns(): BinColumnsResult {
  return { columns: requireSession().mc.binColumns() }
}

/**
 * One `/bins` column over one bin range.
 *
 * The read is bounded by the caller's range and clamped to the file's own bin
 * count here, so a block whose last cell runs past the final bin — which is
 * every pooled block on a file whose bin count is not a multiple of the pooling
 * — asks for a shorter slice instead of failing.
 */
function handleBinColumn(
  request: Extract<WorkerRequest, { kind: 'binColumn' }>,
): BinColumnResult {
  const { mc } = requireSession()
  const from = Math.max(0, Math.min(Math.trunc(request.from), mc.nBins))
  const to = Math.max(from, Math.min(Math.trunc(request.to), mc.nBins))
  const values = mc.binColumn(request.column, from, to)
  return {
    column: request.column,
    from,
    to,
    ...(Array.isArray(values) ? { text: values } : { values }),
  }
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

/**
 * The stage's whole-genome picture (§27.9).
 *
 * Read from the finest rung of the ladder whose bins fit the picture — a yeast
 * `.mcool` gives its 1 kb rung, twelve thousand cells, whatever rung is open —
 * and pooled a few bins a cell only where none does. One pass over that rung,
 * watched like the whole-genome read: the bar, and Escape.
 */
async function handlePicture(request: Extract<WorkerRequest, { kind: 'picture' }>): Promise<PictureResult> {
  const open = requireSession().mc
  const cap = Math.max(256, Math.min(PICTURE_CELLS, Math.trunc(request.cells ?? PICTURE_CELLS)))
  // The file's own order, whatever the session is drawn through: the stage
  // draws the edit through the picture, not the picture through the edit —
  // and so the rung is the one whose bins of the file's own sequences fit.
  const base = open.unlensed ?? open
  // One genome's sequences, in the file's order, where the stage is on one.
  let drawn: number[] | undefined
  if (request.contigs !== undefined) {
    const index = new Map(base.chromnames.map((name, c) => [name, c]))
    drawn = [...new Set(request.contigs.map((name) => index.get(name)).filter((c): c is number => c !== undefined))].sort((a, b) => a - b)
    if (drawn.length === 0) throw new ViewerError('unsupported', 'None of the sequences the stage asked for are in this file.')
  }
  const rung = pictureRung(base, cap, drawn)
  const seen = await mapFor(rung)
  const mc = seen.unlensed ?? seen
  const fits = pictureStride(mc.coords, cap, drawn)
  let offsets: Float64Array | null = null
  try {
    offsets = mc.store.binOffsets()
  } catch {
    offsets = null
  }
  // The finest that fits, pooled further where the map is too shallow at it.
  const deep = depthStride(mc.coords, offsets, drawn)
  const stride = fits === null ? null : Math.max(fits, deep)
  if (stride === null) {
    throw new ViewerError(
      'unsupported',
      `The stage draws the whole assembly at ${cap.toLocaleString('en-US')} cells a side, each inside one ` +
        `sequence, and this one has ${(drawn?.length ?? mc.coords.nContigs).toLocaleString('en-US')} sequences.`,
    )
  }
  const layout = pictureLayout(mc.coords, stride, drawn)
  const balanced = request.balance === true && mc.hasWeights
  // What the pass will read, said as it starts (§27.12): the stored pixels of
  // the rows it covers — every one where they are the whole map — at the
  // rung's bins, and how many of those a cell pools.
  const pixels = picturePixels(mc, offsets, drawn)
  post({
    type: 'progress',
    id: request.id,
    done: 0,
    total: 1,
    note:
      `${pixels === null ? 'every stored pixel' : `${pixels.toLocaleString('en-US')} stored pixels`} at ${resolutionLabel(mc.binsize)}` +
      (stride > 1 ? `, ${stride} bins a cell` : ''),
  })
  const read = await mc.picture(layout, {
    balance: balanced,
    ...(request.value === undefined ? {} : { value: request.value }),
    ...(request.method === true ? { gather: METHOD_GATHER } : {}),
    ...scanHooks(request.id),
  })
  if (read === null || cancelled.has(request.id)) throw abortError()
  const { vmin, vmax } = displayRange(read.histogram, read.quantizer)
  // What the map is expected to hold, and its corners, once per file (§27.5):
  // the stage weighs every edit against these.
  const contacts = read.contacts
  const expected = contacts === undefined ? null : expectedOf(contacts, balanced)
  const method =
    contacts === undefined || expected === null ? undefined : { contacts, expected, corners: findCorners(contacts, expected) }
  // Kept rather than sent, where asked: the suggestions are counted here.
  const kept = request.keep === true && method !== undefined
  const active = requireSession()
  if (kept) active.stageMethod = { picture: request.id, ...method }
  return {
    rung: seen === open ? null : (rung ?? null),
    binsize: mc.binsize * stride,
    stride,
    n: layout.n,
    sequences: (drawn ?? mc.chromnames.map((_, c) => c)).map((c, i) => ({
      name: mc.chromnames[c],
      length: mc.coords.contigLengths[c],
      firstCell: layout.offsets[i],
      cells: layout.offsets[i + 1] - layout.offsets[i],
    })),
    levels: read.levels,
    low: read.quantizer.low,
    high: read.quantizer.high,
    vmin,
    vmax,
    balanced,
    pixels: read.pixels,
    least: depthFloor(mc.coords, offsets, mc.binsize, drawn),
    ...(method === undefined ? {} : kept ? { methodKept: request.id } : { method }),
  }
}

/** The cells a stage window may hold: four million, 16 MB of floats. */
const STAGE_WINDOW_CELLS = 4_000_000

/**
 * A window of the stage's map read finer than its picture (§27.9): the rung
 * whose bins are about a pixel — the coarsest no coarser than `binsize`, else
 * the finest there is — drawn through the stage's edit, the window's rows and
 * columns named as places in the edited assembly and handed back as runs of
 * bins, one per edited sequence each side crosses. `null` where no rung is
 * finer than the picture's own cell, or the window would be too large to hold.
 */
async function handleStageWindow(request: Extract<WorkerRequest, { kind: 'stageWindow' }>): Promise<WindowRead | null> {
  const active = requireSession()
  const base = active.mc.unlensed ?? active.mc
  const rungs = rungsOf(base)
  const fits = rungs.filter((rung) => rung.size <= request.binsize)
  const chosen = fits.length > 0 ? fits[fits.length - 1] : rungs[0]
  if (chosen === undefined || !(chosen.size < request.coarser)) return null
  const key = `${chosen.name}|${request.key}`
  if (active.stageWindowMap?.key !== key) {
    const seen = chosen.size === base.binsize ? base : await mapFor(chosen.name)
    const rung = seen.unlensed ?? seen
    // Not closed when replaced: a map drawn through an edit shares its rung's
    // file, which the rungs above hold and close.
    const { map, refusal } = MetaCooler.withLens(rung, request.edit)
    if (refusal !== null) throw new ViewerError('unsupported', refusal)
    active.stageWindowMap = { key, map }
  }
  const map = active.stageWindowMap.map
  const index = new Map(map.chromnames.map((name, c) => [name, c]))
  const offsets = map.coords.chromOffset
  const size = map.binsize
  const extentOf = (side: StageWindowSide): Extent | null => {
    const a = index.get(side.from.sequence)
    const b = index.get(side.to.sequence)
    if (a === undefined || b === undefined) return null
    const lo = Math.min(offsets[a + 1] - 1, offsets[a] + Math.floor(Math.max(0, side.from.bp) / size))
    const hi = Math.min(offsets[b + 1], offsets[b] + Math.ceil(Math.max(0, side.to.bp) / size))
    return hi > lo ? [lo, hi] : null
  }
  const rows = extentOf(request.rows)
  const cols = extentOf(request.cols)
  if (rows === null || cols === null || (rows[1] - rows[0]) * (cols[1] - cols[0]) > STAGE_WINDOW_CELLS) return null
  const dense = await map.matrix({ rows, cols, balance: request.balance && map.hasWeights })
  const runsOf = ([lo, hi]: Extent): WindowRun[] => {
    const out: WindowRun[] = []
    for (let c = 0; c < map.chromnames.length; c++) {
      const from = Math.max(lo, offsets[c])
      const to = Math.min(hi, offsets[c + 1])
      if (to > from) out.push({ sequence: map.chromnames[c], firstBin: from - offsets[c], count: to - from, at: from - lo })
    }
    return out
  }
  return { binsize: size, rows: runsOf(dense.rowExtent), cols: runsOf(dense.colExtent), values: dense.values, ncols: dense.ncols }
}

/** A file's rungs, finest first, by entry name and bin size: the one it has, where it has one. */
function rungsOf(base: MetaCooler): Array<{ name: string; size: number }> {
  return base.entryGroup === 'resolutions'
    ? base.entries
        .map((name) => ({ name, size: Number(name) }))
        .filter((rung) => Number.isInteger(rung.size) && rung.size > 0)
        .sort((a, b) => a.size - b.size)
    : [{ name: '', size: base.binsize }]
}

/** The most placements kept between edits before they are let go. */
const REFINE_KEPT = 4096

/**
 * A suggestion's points placed again at the finer rungs (§27.5): each read
 * around at every rung from the picture's cell to the finest the map is deep
 * enough to show, through the stage's edit — the rungs drawn through it once
 * for the edit — and kept by the neighbourhood the reads cover.
 */
async function handleRefine(request: Extract<WorkerRequest, { kind: 'refine' }>): Promise<Array<RefinedPoint | null>> {
  const active = requireSession()
  const base = active.mc.unlensed ?? active.mc
  const rungs = rungsOf(base)
  const chain = refineChain(
    rungs.map((rung) => rung.size),
    request.cell,
    request.least,
  )
  if (chain.length === 0) return request.points.map(() => null)
  const fingerprint = editFingerprint(request.edit)
  if (active.refineMaps?.fingerprint !== fingerprint) active.refineMaps = { fingerprint, maps: new Map() }
  const maps = active.refineMaps.maps
  const placed = (active.refinePlaced ??= new Map())
  if (placed.size > REFINE_KEPT) placed.clear()
  const assembly = EditedAssembly.of(request.edit)
  const lensedAt = async (size: number): Promise<MetaCooler | null> => {
    const rung = rungs.find((candidate) => candidate.size === size)
    if (rung === undefined) return null
    let map = maps.get(rung.name)
    if (map === undefined) {
      const seen = rung.size === base.binsize ? base : await mapFor(rung.name)
      // Not closed when let go: a map drawn through an edit shares its rung's
      // file, which the rungs above hold and close.
      const { map: lensed, refusal } = MetaCooler.withLens(seen.unlensed ?? seen, request.edit)
      if (refusal !== null) throw new ViewerError('unsupported', refusal)
      map = lensed
      maps.set(rung.name, map)
    }
    return map
  }
  const read: ReadSquare = async (sequence, lo, hi, size) => {
    if (cancelled.has(request.id)) throw abortError()
    const map = await lensedAt(size)
    const c = map === null ? -1 : map.chromnames.indexOf(sequence)
    if (map === null || c < 0) return null
    const offset = map.coords.chromOffset[c]
    const rows: Extent = [offset + lo, offset + hi]
    const dense = await map.matrix({ rows, cols: rows, balance: request.balance && map.hasWeights })
    return dense.nrows === hi - lo && dense.ncols === hi - lo ? { n: hi - lo, values: dense.values } : null
  }
  // The farthest a point's reads reach: the first rung's, a cell and a half
  // and three windows either side.
  const span = (Math.ceil((REFINE_REACH * request.cell) / chain[0]) + 3 * REFINE_WINDOW + 1) * chain[0]
  const out: Array<RefinedPoint | null> = []
  for (const point of request.points) {
    if (cancelled.has(request.id)) throw abortError()
    const length = assembly.lengthOf(point.sequence)
    if (length === null) {
      out.push(null)
      continue
    }
    const bp = point.bp
    const lo = Math.max(0, bp - span)
    const hi = Math.min(length, bp + span)
    const pieces = assembly
      .piecesIn(point.sequence, lo, hi)
      .map(({ offset, piece }) => `${offset - bp}:${piece.sequence}:${piece.start}:${piece.end}:${piece.strand}`)
      .join(';')
    const key = [request.balance, request.cell, chain.join(','), chain.map((size) => bp % size).join(','), lo - bp, hi - bp, pieces].join('|')
    let found = placed.get(key)
    if (found === undefined) {
      const refined = await refinePoint(point, length, request.cell, chain, read)
      found = refined === null ? null : { delta: refined.bp - bp, binsize: refined.binsize, support: refined.support }
      placed.set(key, found)
    }
    out.push(found === null ? null : { bp: bp + found.delta, binsize: found.binsize, support: found.support })
  }
  return out
}

/**
 * The suggestions for an edit (§27.5), counted against what the method weighs
 * of the stage's picture, kept here by its read — the whole of `suggest`, the
 * lens built from the edit and the picture's layout as the stage builds it,
 * off the stage's thread (§27.12).
 */
function handleSuggest(request: Extract<WorkerRequest, { kind: 'suggest' }>): Suggested {
  const held = requireSession().stageMethod
  if (held === undefined || held.picture !== request.picture) {
    throw new ViewerError('unsupported', 'The picture these suggestions were asked of has been read again; they are counted against the new one.')
  }
  const grid = LensGrid.of(EditedAssembly.of(request.edit), request.layout)
  return suggest({
    contacts: held.contacts,
    expected: held.expected,
    corners: held.corners,
    grid,
    ...(request.weights === undefined ? {} : { weights: request.weights }),
    ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
  })
}

/**
 * Where one genome's contigs and every other contig belong by their contacts
 * (§27.10): one pass over the file's stored pixels, raw counts, each contact
 * of two contigs counted for both — for a contig of the genome, by the genome
 * of the other; for a contig outside it, with the genome's contigs and in all.
 */
async function handleGenomeLinks(request: Extract<WorkerRequest, { kind: 'genomeLinks' }>): Promise<GenomeLinksResult> {
  const open = requireSession().mc
  const mc = open.unlensed ?? open
  if (!mc.hasGenomes) throw new ViewerError('unsupported', 'Only a metagenome has genomes a contig could belong to.')
  const n = mc.coords.nContigs
  const index = new Map(mc.chromnames.map((name, c) => [name, c]))
  const inside = new Uint8Array(n)
  for (const name of request.contigs) {
    const c = index.get(name)
    if (c !== undefined) inside[c] = 1
  }
  const binContig = new Int32Array(mc.nBins)
  for (let c = 0; c < n; c++) {
    const [lo, hi] = mc.coords.contigBinExtent(c)
    binContig.fill(c, lo, hi)
  }
  const genomeOf = mc.contigGenomeIds
  const genomes = mc.genomeNames
  const total = new Float64Array(n)
  const own = new Float64Array(n)
  const byGenome = new Map<number, Float64Array>()
  for (let c = 0; c < n; c++) if (inside[c] === 1) byGenome.set(c, new Float64Array(genomes.length))
  const hooks = scanHooks(request.id)
  let pixels = 0
  await mc.store.scanAll({
    onChunk: (chunk) => {
      if (hooks.cancelled()) return false
      for (let i = 0; i < chunk.length; i++) {
        const a = binContig[chunk.bin1[i]]
        const b = binContig[chunk.bin2[i]]
        if (a === b) continue
        const v = chunk.count[i]
        if (!(v > 0)) continue
        total[a] += v
        total[b] += v
        if (inside[b] === 1) own[a] += v
        if (inside[a] === 1) {
          own[b] += v
          const row = byGenome.get(a)
          if (row !== undefined && genomeOf[b] >= 0) row[genomeOf[b]] += v
        }
        if (inside[b] === 1) {
          const row = byGenome.get(b)
          if (row !== undefined && genomeOf[a] >= 0) row[genomeOf[a]] += v
        }
      }
      pixels += chunk.length
      return true
    },
    onProgress: (done, all) => hooks.onProgress(done, all, 'reading every contact for where the contigs belong'),
  })
  if (hooks.cancelled()) throw abortError()
  const insideRows: GenomeLinksResult['inside'] = []
  for (const [c, row] of byGenome) {
    const partners = [...row]
      .map((contacts, g) => ({ genome: genomes[g], contacts }))
      .filter((partner) => partner.contacts > 0)
      .sort((x, y) => y.contacts - x.contacts)
      .slice(0, 6)
    insideRows.push({ contig: mc.chromnames[c], total: total[c], own: own[c], partners })
  }
  const outside: GenomeLinksResult['outside'] = []
  for (let c = 0; c < n; c++) {
    if (inside[c] === 1 || own[c] < 3) continue
    const g = genomeOf[c]
    outside.push({ contig: mc.chromnames[c], genome: g >= 0 ? genomes[g] : '__unbinned__', length: mc.coords.contigLengths[c], contacts: own[c], total: total[c] })
  }
  outside.sort((x, y) => y.contacts / y.total - x.contacts / x.total || y.contacts - x.contacts)
  return { inside: insideRows, outside: outside.slice(0, 100), pixels }
}

/**
 * The stored pixels a picture's pass reads (§27.12): the map's count where it
 * reads every row, the rows of the sequences it draws where the per-bin index
 * says, and `null` where neither is known.
 */
function picturePixels(mc: MetaCooler, offsets: Float64Array | null, drawn: readonly number[] | undefined): number | null {
  if (drawn === undefined) return mc.nnz ?? (offsets === null ? null : offsets[offsets.length - 1])
  if (offsets === null) return null
  let total = 0
  for (const c of drawn) {
    const [first, end] = mc.coords.contigBinExtent(c)
    total += offsets[end] - offsets[first]
  }
  return total
}

/**
 * The rung a picture of `cap` cells a side is read from: the finest whose bins
 * fit, else the coarsest, which is then pooled. `undefined` for the open map —
 * a file with no ladder, or one whose open rung is the answer.
 *
 * Counted from the open map's sequence lengths, so no rung is opened to be
 * measured: an `.mcool`'s entries are its bin sizes.
 */
function pictureRung(open: MetaCooler, cap: number, contigs?: readonly number[]): string | undefined {
  if (open.entryGroup !== 'resolutions') return undefined
  const lengths = open.coords.contigLengths
  const drawn = contigs ?? Array.from({ length: lengths.length }, (_, c) => c)
  const binsAt = (size: number): number => {
    let total = 0
    for (const c of drawn) total += Math.ceil(lengths[c] / size)
    return total
  }
  const rungs = open.entries
    .map((name) => ({ name, size: Number(name) }))
    .filter((rung) => Number.isInteger(rung.size) && rung.size > 0)
    .sort((a, b) => a.size - b.size)
  if (rungs.length === 0) return undefined
  const best = rungs.find((rung) => binsAt(rung.size) <= cap) ?? rungs[rungs.length - 1]
  return best.size === open.binsize ? undefined : best.name
}

async function handleMatrix(
  request: Extract<WorkerRequest, { kind: 'matrix' }>,
): Promise<MatrixResult> {
  const open = requireSession().mc
  // The rung the caller named, and the request's own extents translated onto it.
  // Both are no-ops for the ordinary read, which names no rung: `mapFor` hands
  // back the open map and `crossRung` returns the extent it was given.
  const mc = await mapFor(request.rung)
  const cols = crossRung(open, mc, request.cols ?? request.rows)
  const rows = crossRung(open, mc, request.rows)
  const asked = planOf(request.binsPerCell, request.contigsPerCell)
  const asked_ = { rows: request.rows, cols: request.cols ?? request.rows }
  // A circular window, and one that actually crosses the junction — a request
  // carrying `wrap` whose extents happen to lie inside the sequence takes the
  // ordinary road below, which reads the same bins onto the same grid.
  if (request.wrap !== undefined) {
    const wrap = crossRung(open, mc, request.wrap)
    if (needsWrapping(rows, wrap) || needsWrapping(cols, wrap)) {
      return atRung(mc, open, asked_, await readWrapped(mc, request, rows, cols, wrap, wrapEnvFor(mc, request.id, request.budgetBytes)))
    }
  }
  if (asked.binsPerCell > 1 || asked.contigsPerCell > 1) {
    // **Snapped, exactly as a plan this worker chose for itself is.** The grid
    // is a property of the sequence — cells fall at `contigStart + m·k` — and an
    // extent that starts part way through one would otherwise anchor the grid to
    // the *question*, so the same base pair would land in a different cell,
    // holding a different sum, each time the reader panned. That is why
    // `ui/refine.ts` used to say it must never send `binsPerCell`, and snapping
    // here is what lets a reader ask for a resolution the file does not store
    // (§3.4) and pan around in it. A no-op for the callers that had an explicit
    // plan before this — a whole-genome read and a selection both start at
    // sequence boundaries — so nothing that worked changes.
    return atRung(
      mc,
      open,
      asked_,
      await pooledResult(
        mc,
        request,
        snapToGrid(mc, rows, asked),
        snapToGrid(mc, cols, asked),
        asked,
      ),
    )
  }
  const planned = fitPlan(mc, rows, cols, request.budgetBytes)
  if (planned !== null) {
    return atRung(
      mc,
      open,
      asked_,
      await pooledResult(
        mc,
        request,
        snapToGrid(mc, rows, planned),
        snapToGrid(mc, cols, planned),
        planned,
      ),
    )
  }
  const dense = await mc.matrix(
    {
      rows,
      cols,
      ...(request.balance === true ? { balance: true } : {}),
      ...(request.value === undefined ? {} : { value: request.value }),
      ...(request.budgetBytes === undefined ? {} : { budgetBytes: request.budgetBytes }),
    },
    hintFor(rows, cols),
  )
  return atRung(mc, open, asked_, binLevelResult(mc, dense, request.genomes === true))
}

/**
 * The three decisions a wrapped read borrows from this worker.
 *
 * Built per call rather than held, because two of them close over the request's
 * own id — a cancel is per read — and because the whole object is three small
 * closures. See `worker/wrappedMatrix.ts`, which is the half of the wrapped path
 * worth testing and therefore the half that is not in this file.
 */
function wrapEnvFor(mc: MetaCooler, id: number, budgetBytes?: number): WrapEnv {
  return {
    // A wrapped window has the same cell count as an unwrapped one of the same
    // width on the same sequence, so the plan is fitted against a real extent of
    // that width — `fitPlan` measures from the contig table and is not written
    // to survive an extent that runs off the end of it.
    planFor: (wrap, rowWidth, colWidth) => {
      const lane = (span: number): Extent => {
        const width = Math.max(1, Math.min(span, wrap[1] - wrap[0]))
        return [wrap[0], wrap[0] + width]
      }
      return fitPlan(mc, lane(rowWidth), lane(colWidth), budgetBytes)
    },
    snap: (extent, plan) => snapToGrid(mc, extent, plan),
    hint: (rows, cols) => hintFor(rows, cols),
    throwIfCancelled: () => {
      if (cancelled.has(id)) throw abortError()
    },
    hooks: scanHooks(id),
  }
}

/**
 * Stamp a block with the bin size it was actually read at.
 *
 * Only where that is not the open map's, so an ordinary read carries nothing
 * extra and the field means what it says: *this block came from somewhere else*.
 * Without it a 5 kb picture read off a coarse rung would be labelled with the
 * 1 kb the session was opened at, which is the number a figure caption and a
 * methods section both take.
 */
function atRung(
  mc: MetaCooler,
  open: MetaCooler,
  request: { rows: Extent; cols: Extent },
  result: MatrixResult,
): MatrixResult {
  return mc === open
    ? result
    : { ...result, binsize: mc.binsize, source: { rows: request.rows, cols: request.cols } }
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
    {
      rows,
      cols,
      ...(request.balance === true ? { balance: true } : {}),
      ...(request.value === undefined ? {} : { value: request.value }),
    },
    aim,
    scanHooks(id),
  )
  if (cancelled.has(id)) throw abortError()
  const runs = (ids: Int32Array): AxisGroup[] =>
    idRuns(
      ids,
      (id) => mc.chromnames[id] ?? String(id),
      // No `unitStart`: a coarse cell measures from the run's own start, and
      // `anchor` below supplies the one correction that needs. The *identity*
      // is carried all the same — it is a fact about the sequence rather than
      // about this block, and the two answer different questions.
      undefined,
      (id) => mc.coords.contigLengths[id],
      (id) => mc.coords.contigStartBin(id),
    )
  const withGenomes = request.genomes === true && mc.hasGenomes
  return {
    nrows: pooled.nrows,
    ncols: pooled.ncols,
    // Already `Float32` when it was folded; copying it again would put a second
    // copy of the largest array in the read beside the first.
    values: pooled.values instanceof Float32Array ? pooled.values : Float32Array.from(pooled.values),
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
 * **Any block, wherever it begins.** This used to say "only for a block that
 * begins on a contig boundary", and to claim a region starting mid-contig was
 * left dense and refused by size. Neither was ever true of the code: there is no
 * boundary test here, `snapToGrid` widens a mid-contig request down to the
 * *contig's* own cell edges, and `anchor` exists precisely to give the first run
 * of such a block the `unitStart` the comment said it lacked. The claim mattered
 * because it is the one a zoom leans on — a viewport lands mid-contig by
 * definition — so it is corrected rather than left to be discovered.
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
function fitPlan(
  mc: MetaCooler,
  rows: Extent,
  cols: Extent,
  budgetBytes?: number,
): PoolPlan | null {
  const spans = rows[0] === cols[0] && rows[1] === cols[1] ? [rows] : [rows, cols]
  // Unpooled up to what the dense guard will pass, which is wider than a pooled
  // read's grid: the dense read is guarded and the pooled one is not, so only
  // the first may grow with the machine (`denseCellCap`).
  const unpooled = denseCellCap(budgetBytes)
  if (spans.every(([lo, hi]) => hi - lo <= unpooled)) return null
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
    {
      rows: request.rows,
      cols,
      ...(request.balance === true ? { balance: true } : {}),
      ...(request.value === undefined ? {} : { value: request.value }),
    },
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
  const matched: NameMatch[] = []
  const units = selectedContigs(mc, request.unit, request.names, request.naming, matched)
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
  // The caller's plan is a floor and nothing more. It works from a bin count it
  // worked out itself and cannot know how the chosen sequences fall, so the read
  // finds the capacity that fits — the same search a range gets — and reports
  // what it used. It used to be a refusal ("Select fewer sequences"), which is a
  // strange answer to someone who has just ticked *select all*, and then briefly
  // a coarsening that could not coarsen: one cell per selected sequence is a
  // floor no capacity clears, so a selection past the cap went back to being
  // pooled a second time by the renderer, contig-blind, with nothing said.
  const plan: PoolPlan = {
    binsPerCell: Math.max(1, aim.binsPerCell),
    contigsPerCell: 1,
  }
  // A selection *of genomes* is a picture of those genomes, so its cells are
  // kept inside one — see `selectionPooling`. Ticking contigs asks for no such
  // thing, and a cooler has no genomes to keep cells inside of.
  const byGenome = request.unit === 'genome' && mc.hasGenomes
  const selected = await mc.selectionMatrix(units, plan, {
    ...scanHooks(id),
    ...(request.balance === true ? { balance: true } : {}),
    ...(request.value === undefined ? {} : { value: request.value }),
    ...(byGenome ? { byGenome: true } : {}),
    // A byte budget is a cells-per-axis cap on a square block: four bytes a
    // cell, so `cap = √(budget / 4)`. Floored at one cell so a budget too small
    // to hold anything still produces a picture rather than an empty axis —
    // the refusal a deck wants is "coarser", not "nothing".
    ...(request.budgetBytes === undefined
      ? {}
      : { cellCap: Math.max(1, Math.floor(Math.sqrt(request.budgetBytes / 4))) }),
  })
  if (cancelled.has(id)) throw abortError()

  const runs = idRuns(
    selected.ids,
    (contig) => mc.chromnames[contig] ?? String(contig),
    undefined,
    (contig) => mc.coords.contigLengths[contig],
  )
  // Named rather than shadowing the module's `genomeRuns`, which walks bins.
  const genomeAxis = mc.hasGenomes ? aggregatedGenomeRuns(mc, selected.ids) : undefined
  // Ticked genomes are drawn *as* genomes; ticked contigs keep the contig lines.
  // See `selectionDrawsGenomes` for the rule and why it asks the runs.
  const dividedByGenome = selectionDrawsGenomes(request.unit, genomeAxis)
  const named = withMembers(mc, runs, selected.pooling)
  return {
    nrows: selected.nrows,
    ncols: selected.ncols,
    values: Float32Array.from(selected.values),
    // The axis is not a bin range, so the extent is the axis itself: cell 0 is
    // where it starts. `unitStart` is absent for the same reason, and the
    // coordinate arithmetic falls back to the group's own start, which is right.
    rowExtent: [0, selected.nrows],
    colExtent: [0, selected.ncols],
    rowGroups: named,
    colGroups: named,
    ...(genomeAxis === undefined ? {} : { rowGenomes: genomeAxis, colGenomes: genomeAxis }),
    ...(dividedByGenome ? { genomeBoundaries: true } : {}),
    level: 'bin',
    binsPerCell: selected.binsPerCell,
    contigsPerCell: selected.contigsPerCell,
    rowContigs: units.length,
    colContigs: units.length,
    ...(matched.length === 0 ? {} : { matched }),
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
  naming?: NameContext,
  /** Filled with the names that had to be matched across conventions (§5.9). */
  matched?: NameMatch[],
): Array<{ id: number; extent: Extent }> {
  const ids = new Set<number>()
  for (const name of names) {
    if (unit === 'contig') {
      const id = mc.chromnames.indexOf(name)
      if (id >= 0) {
        ids.add(id)
        continue
      }
      // Not under that spelling. The same second chance `parseMetacoolerRange`
      // gives a region, for the same reason and in the same order: **after**
      // exact membership has failed, never before it. A selection is the other
      // half of a shared view — tick four chromosomes in the lead and every
      // companion draws those four — so a deck whose files disagree about
      // nomenclature would otherwise navigate by region and go blank the moment
      // anybody ticked a box.
      const match = mc.names.find(name, naming === undefined ? {} : { from: naming })
      if (match !== null) {
        const aliased = mc.chromnames.indexOf(match.name)
        if (aliased >= 0) {
          ids.add(aliased)
          // Reported, not merely resolved. A selection drawn from names matched
          // across conventions and saying nothing is exactly the silent rename
          // the region path carries `ParsedRange.matched` to prevent.
          matched?.push(match)
        }
      }
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
  const { mc, resample } = requireSession()
  // The edge list counts the file as stored. A resampled map's overview is the
  // resampled map's, so it is taken the way any other file's is (§6.5).
  if (resample !== null) return handleOverview({ id: request.id, kind: 'overview', level: 'genome' })
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

/**
 * Draw the open map to a total, or put back the file as stored (§6.5).
 *
 * The census is the one long part — a walk over every stored pixel, once per
 * map — and it reports as it goes, in pixels. It is handed back with the answer
 * so the analysis worker's mount of the same map need not walk them again: a
 * copy, since the answer's buffers move to the main thread and the census stays
 * with the map here.
 */
async function handleResample(
  request: Extract<WorkerRequest, { kind: 'resample' }>,
): Promise<ResampleResult> {
  const active = requireSession()
  const spec: ResampleSpec | null =
    request.contacts === null
      ? null
      : {
          contacts: request.contacts,
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          ...(request.alpha === undefined ? {} : { alpha: request.alpha }),
        }
  active.resample = spec
  for (const rung of active.rungs.values()) {
    rung.resample(spec).catch(() => undefined)
  }
  const say = reporter(request.id)
  const plan = await active.mc.resample(spec, {
    onProgress: (done, total) => say(done, total, 'counting contacts'),
    cancelled: () => cancelled.has(request.id),
  })
  const census = await active.mc.takenCensus()
  return {
    mode: plan?.mode ?? 'none',
    contacts: spec?.contacts ?? null,
    total: census?.total ?? null,
    census:
      census === null
        ? null
        : { ...census, a: census.a.slice(), b: census.b.slice(), sum: census.sum.slice() },
  }
}

/**
 * The contacts the open map holds, counted where the file does not say (§6.5).
 *
 * Every rung of a ladder holds the same contacts, so the coarsest is counted:
 * the same contacts in the fewest stored pixels. A map with no ladder is
 * counted itself, by the census a resample of it would take anyway and then
 * keeps.
 */
async function handleContacts(request: Extract<WorkerRequest, { kind: 'contacts' }>): Promise<{ total: number | null }> {
  const active = requireSession()
  const declared = active.mc.declaredContacts
  if (declared !== null) return { total: declared }
  const ladder = active.mc.entries
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a))
  const map = ladder.length > 0 ? await mapFor(ladder[0]) : active.mc
  const say = reporter(request.id)
  return {
    total: await map.countContacts({
      onProgress: (done, total) => say(done, total, 'counting contacts'),
      pause: (wanted) => foreground.quiet(wanted),
    }),
  }
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
    case 'exportMcool':
      return handleExportMcool(request.id)
    case 'exportLifted':
      return handleExportLifted(request.id, request.edit)
    case 'genomes':
      return handleGenomes()
    case 'contigs':
      return handleContigs()
    case 'cells':
      return handleCells()
    case 'selectCells':
      return handleSelectCells(request)
    case 'binColumns':
      return handleBinColumns()
    case 'binColumn':
      return handleBinColumn(request)
    case 'range':
      // Resolved against the rung the caller named, because a range is a bin
      // extent and bin extents are per level. Absent, it is the open map's, as
      // every call but a zoom-driven one leaves it.
      return parseMetacoolerRange(
        await mapFor(request.rung),
        request.range,
        request.naming,
        request.circular,
      )
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
    case 'resample':
      return handleResample(request)
    case 'contacts':
      return handleContacts(request)
    case 'stats':
      return handleStats()
    case 'picture':
      return handlePicture(request)
    case 'suggest':
      return handleSuggest(request)
    case 'stageWindow':
      return handleStageWindow(request)
    case 'refine':
      return handleRefine(request)
    case 'genomeLinks':
      return handleGenomeLinks(request)
    case 'cancel':
      cancelled.add(request.target)
      return null
    case 'close':
      releaseRungs(session)
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
  // The census and a read marked `background` go behind every other request:
  // one waits between its steps (`handleContacts`), the other before it starts.
  const background = request.kind === 'contacts' || (request.kind === 'matrix' && request.background === true)
  if (background && request.kind === 'matrix') await foreground.quiet(() => cancelled.has(request.id))
  const ended = background ? null : foreground.begin()
  const before = session?.source.stats()
  const summing = followCells(request.id)
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
    ended?.()
    summing()
    cancelled.delete(request.id)
  }
}

/**
 * Report the cell fan-out of whatever this request turns out to read.
 *
 * Attached here, around the whole dispatch, rather than inside the handlers
 * that read a block: a cell set is summed by `matrix`, by `aggregate`, by
 * `selection` and by the overview, and every one of them reaches the store
 * through several layers that have no reason to learn about cells. The store is
 * per selection and lives on the session, so this is the one place that knows
 * both it and the id the news belongs to.
 *
 * Returns the undo, which the caller runs in its `finally` — a sink left
 * attached would post against a request that has already been answered.
 */
function followCells(id: number): () => void {
  const store = session?.mc.store
  // One cell is not a sum, and a bar that says `1 of 1` says nothing.
  if (!(store instanceof ScoolStore) || store.names.length < 2) return () => {}
  const say = reporter(id)
  const sink = (done: number, total: number): void => say(done, total, 'summing cells')
  store.onCells = sink
  // Cleared only if it is still ours: two reads can be in flight at once — a
  // map and the overview behind it — and the one that finishes first must not
  // silence the one still running.
  return () => {
    if (store.onCells === sink) store.onCells = null
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
