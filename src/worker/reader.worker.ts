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
import { crossResolution } from '../metacooler/coords'
import { parseMetacoolerRange } from '../metacooler/range'
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
} from './groups'
import { overviewUnitCap, poolUnits, TriangleAccumulator, type UnitPooling } from './overview'
import { deviceDenseBudgetBytes } from '../metacooler/matrix'
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
  type SourceSpec,
  type DeepValidation,
  type GenomesResult,
  type MatrixResult,
  type McoolExport,
  type OpenResult,
  type OverviewResult,
  type PairsImportSummary,
  type PairsProbeResult,
  type SourceKind,
  type StatsResult,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol'
import { createSource, openIndexSource, readWhole, releaseSources } from './sources'
import { importPairs, probePairs, rungInImport, suggestBase, type PairsImport } from '../pairs/import'
import { writeMcool } from '../pairs/write'
import { parseBins, parseMatrix } from '../hicpro/parse'
import { hicProBinsNames, isHicProMatrix } from '../annotations/sidecar'
import { signS3Request, type S3Credential } from '../s3/sigv4'
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
    active.rungs.set(rung, built)
    touchRung(active, rung)
    while (active.recent.length > MAX_RUNGS) {
      const oldest = active.recent.pop()
      if (oldest === undefined) break
      active.rungs.get(oldest)?.close()
      active.rungs.delete(oldest)
    }
    return built
  }
  const group = active.mc.entryGroup === '' ? 'entries' : active.mc.entryGroup
  const { path } = parseUri(active.mc.uri)
  let opened: MetaCooler
  try {
    opened = await MetaCooler.open(`${path}::${group}/${rung}`, active.source)
  } catch {
    // A rung that will not open is not a reason to fail the read: the open map
    // answers the same question at a different resolution.
    return active.mc
  }
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
function summarise(pairs: PairsImport, download: boolean): PairsImportSummary {
  const base = pairs.tables.get(pairs.rungs[0])!
  return {
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

/** `Hum53.pairs.gz` → `Hum53.mcool`, which is what the download is called. */
function mcoolNameFor(uri: string): string {
  const leaf = uri.split(/[\\/]/).pop() ?? 'pairs'
  const stem = leaf.replace(/\.px2$/i, '').replace(/\.gz$/i, '').replace(/\.pairs$/i, '')
  return `${stem || 'pairs'}.mcool`
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
 * Where this matrix's bin file is, or `null` when this is not a HiC-Pro matrix.
 *
 * Three roads in, in the order a reader is likely to have taken them:
 *
 * 1. **handed over** — dropped together, or picked out of a connected folder,
 *    where the sibling was found by name (`annotations/sidecar.ts`);
 * 2. **by convention**, for a URL: `<prefix>_<res>_abs.bed` next to the matrix,
 *    which is where HiC-Pro writes it. Probed rather than assumed, and the
 *    `_iced` matrices are probed against the raw directory's bed too, because
 *    that is the one HiC-Pro writes them against;
 * 3. **refused by name**, which is the honest end of the road for a local
 *    matrix with nothing beside it. There is no fallback to invent: without the
 *    bed there are no coordinates, so this is §8.13's situation rather than
 *    §8.11's, and the message says what to drop.
 */
async function binsFor(
  request: Extract<WorkerRequest, { kind: 'open' }>,
): Promise<NonNullable<SourceSpec['bins']> | null> {
  const name = nameOf(request.source)
  if (!isHicProMatrix(name)) return null
  if (request.source.bins !== undefined) return request.source.bins
  if (request.source.kind === 'remote') {
    const found = await probeBins(request.source.url, request.source.credential)
    if (found !== null) return found
  }
  throw new ViewerError(
    'hicpro-no-bins',
    `${name} is a HiC-Pro matrix, which is half of a contact map: the bin file beside it — ` +
      `${hicProBinsNames(name).join(' or ')} — is what says which genomic interval each bin ` +
      `id means, and there are no coordinates without it. Drop the two together, pick the ` +
      `matrix out of a connected folder so its bin file comes with it, or name the bin file ` +
      `on the URL as \`<matrix>#bins=<url>\`.`,
    { matrix: name, wanted: hicProBinsNames(name) },
  )
}

/** Try the conventional bin-file URLs beside a matrix; `null` if none answers. */
async function probeBins(
  url: string,
  credential: S3Credential | undefined,
): Promise<{ kind: 'remote'; url: string; credential?: S3Credential } | null> {
  const slash = url.lastIndexOf('/')
  const directory = slash < 0 ? '' : url.slice(0, slash + 1)
  const name = url.slice(slash + 1)
  const candidates = hicProBinsNames(name).map((n) => `${directory}${n}`)
  // An `iced/<res>/x_iced.matrix` is written against `raw/<res>/x_abs.bed`, one
  // directory across. Offered after the same-directory spellings, since a
  // pipeline that copied them together should not pay for a miss.
  if (directory.includes('/iced/')) {
    for (const n of hicProBinsNames(name)) {
      candidates.push(`${directory.replace('/iced/', '/raw/')}${n}`)
    }
  }
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'HEAD',
        headers:
          credential === undefined
            ? {}
            : signS3Request({ method: 'HEAD', url: candidate, credential }),
      })
      if (response.ok) {
        return credential === undefined
          ? { kind: 'remote', url: candidate }
          : { kind: 'remote', url: candidate, credential }
      }
    } catch {
      // Not there, or not allowed. The next spelling, then the refusal.
    }
  }
  return null
}

/**
 * The HiC-Pro road: read both text files whole, parse, and hand up a map.
 *
 * There is no `ByteSource` here because there is nothing left for one to
 * answer. A cooler keeps its file mounted and reads bands out of it as views
 * ask; this container has no index, so the whole of it was read at open and the
 * map is typed arrays from then on. What is handed back in a source's place is
 * a record of what that cost — the bytes really fetched — because the §12
 * accounting and the reader's own status bar both ask a source that question
 * and both should get the true answer rather than a zero.
 *
 * The bins are parsed **first**, and that ordering is not incidental: the
 * matrix names bins by id, so `nBins` is what turns an out-of-range id into
 * "these two halves are for different resolutions" instead of a corrupt read.
 */
async function openHicPro(
  request: Extract<WorkerRequest, { kind: 'open' }>,
  bins: NonNullable<SourceSpec['bins']>,
): Promise<{ mc: MetaCooler; source: ByteSource }> {
  const binsName = nameOf(bins)
  const matrixName = nameOf(request.source)
  const binBytes = await readWhole(bins)
  const parsedBins = parseBins(binBytes, binsName)
  // Before the matrix is touched, and after the bins are — the bins are small
  // and their bin count is what makes the estimate below mean anything.
  await assertLoadAffordable(request, matrixName, parsedBins.nBins)
  const matrixBytes = await readWhole(request.source)
  const parsedPixels = parseMatrix(matrixBytes, parsedBins.nBins, matrixName, {
    cancelled: () => cancelled.has(request.id),
    onProgress: (done, total) => post({ type: 'progress', id: request.id, done, total }),
  })
  const mc = MetaCooler.fromHicPro(request.uri, {
    bins: parsedBins,
    pixels: parsedPixels,
    matrixName,
    binsName,
  })
  return { mc, source: parsedSource(matrixName, binBytes.length + matrixBytes.length) }
}

/**
 * Above this many bytes of matrix, say what reading it will cost before doing it.
 *
 * 200 MB, which at this format's ~15 bytes per pixel is about 13 M pixels and,
 * at the measured 100 MB/s, about two seconds — the point where a picture stops
 * appearing and starts being waited for. Below it the read is quick enough that
 * a question about it would cost more than the read.
 *
 * The threshold is on **bytes, not on being remote**, and that is the
 * difference from §3.7's gate. There the cost was round trips, which a local
 * file does not pay; here it is parsing and memory, which it pays in full — a
 * gigabyte of text off a local disk is the same ten seconds and the same
 * gigabyte of typed arrays as one off a bucket.
 */
const HICPRO_GATE_BYTES = 200 << 20

/**
 * Refuse to read a large matrix until the reader has agreed to what it costs.
 *
 * §3.8's gate, and the shape is §3.7's: a refusal carrying the numbers, thrown
 * where the cost is about to be paid and caught by the shell, which asks and
 * re-issues the open with the agreement on the source. The agreement rides on
 * the same `reading` field, because it is the same sentence — *yes, read it
 * whole* — and this container has no second way to be read.
 *
 * @throws ViewerError `hicpro-load-cost` when the matrix is large and unagreed.
 */
async function assertLoadAffordable(
  request: Extract<WorkerRequest, { kind: 'open' }>,
  matrixName: string,
  nBins: number,
): Promise<void> {
  if (request.source.reading !== undefined) return
  const bytes = await sizeOfSource(request.source)
  if (bytes === null || bytes <= HICPRO_GATE_BYTES) return
  // ~15 bytes a row across the resolutions this format is written at, which is
  // an estimate and is presented as one; the exact count is known only after
  // the read this is asking about.
  const pixels = Math.round(bytes / 15)
  throw new ViewerError(
    'hicpro-load-cost',
    `${matrixName} is ${Math.round(bytes / (1 << 20))} MB of text, and a HiC-Pro matrix has ` +
      `no index — so the whole of it is read and turned into about ${pixels.toLocaleString()} ` +
      `pixels over ${nBins.toLocaleString()} bins before anything can be drawn. That is the ` +
      `only cost: afterwards every region is instant and panning is free.`,
    { matrix: matrixName, bytes, pixels, nBins },
  )
}

/** The byte length of a source, without reading it. */
async function sizeOfSource(spec: SourceSpec): Promise<number | null> {
  if (spec.kind === 'local') return spec.file.size
  try {
    const response = await fetch(spec.url, {
      method: 'HEAD',
      headers:
        spec.credential === undefined
          ? {}
          : signS3Request({ method: 'HEAD', url: spec.url, credential: spec.credential }),
    })
    const length = Number(response.headers.get('Content-Length') ?? Number.NaN)
    return Number.isFinite(length) ? length : null
  } catch {
    // A host that will not answer a HEAD is one the read below will fail on
    // anyway, with a better message than a gate could give.
    return null
  }
}

/** The last file name in a location, for the messages the parsers write. */
function nameOf(spec: SourceSpec | NonNullable<SourceSpec['bins']>): string {
  const raw = spec.kind === 'local' ? spec.file.name : spec.url
  // Neither a query string nor a fragment is part of the name, and both reach
  // here: a bucket URL carries the first, and `#bins=` the second.
  return raw.split(/[\\/]/).pop()?.split(/[?#]/)[0] ?? raw
}

/**
 * A source for bytes that have already been read and parsed away.
 *
 * Every field is the truth about a container that holds nothing open: the size
 * is what was fetched, the stats say the same, and every further read is a bug
 * rather than a cost — so `readBytes` refuses rather than returning empty.
 */
function parsedSource(id: string, bytes: number): ByteSource {
  return {
    id,
    size: bytes,
    // The bytes are here, parsed; nothing seeks over a network any more.
    isRemote: false,
    mount: () => Promise.resolve(id),
    readBytes() {
      throw new ViewerError(
        'unsupported',
        `${id} was read whole and parsed at open; there are no bytes left to read from it. ` +
          'A read reaching here is a code path that bypassed the parsed arrays.',
        { id },
      )
    },
    stats: () => ({ requests: 1, bytes }),
    close: () => undefined,
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

  // A HiC-Pro pair never reaches `createSource`: it has no index, so both
  // halves are read whole and parsed into typed arrays, and there is no mount
  // left behind for a `ByteSource` to represent (§3.8). It is decided first
  // because it is the one road that does not begin with a mount at all.
  const bins = await binsFor(request)
  let mc: MetaCooler
  let source: ByteSource
  let pairs: PairsImport | null = reusable?.pairs ?? null
  if (bins !== null) {
    ;({ mc, source } = await openHicPro(request, bins))
  } else {
    source = await createSource(request.source)
    try {
      if (reusable !== null) {
        // A rung switch inside a file already imported: no read, no dialog, no
        // second pass. The table is in hand.
        mc = MetaCooler.fromPairs({
          uri: request.uri,
          header: reusable.pairs.header,
          pixels: reusable.pairs.tables.get(reusable.size)!,
          rungs: reusable.pairs.rungs,
          indexed: reusable.pairs.indexed,
          declaredRecords: reusable.pairs.declaredRecords,
        })
      } else {
        // A `reading` on the spec *is* the reader's answer to the §12 gate —
        // the shell only ever sets one by re-issuing this open with what they
        // chose.
        const agreed = request.source.kind === 'remote' && request.source.reading !== undefined
        mc = await MetaCooler.open(request.uri, source, agreed ? { listingAgreed: true } : {})
      }
    } catch (error) {
      // A `.pairs` is the one input that cannot be opened from its own bytes: it
      // declares no resolution, so there is nothing to open it *at*. The first
      // open is therefore always refused, and what comes back is what the dialog
      // needs to make the choice a decision rather than a guess.
      if (!(error instanceof ViewerError) || error.code !== 'pairs-binning-needed') throw error
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
  session = {
    mc,
    source,
    sourceKind: request.source.kind,
    rungs: new Map(),
    recent: [],
    pairs,
  }

  return {
    ...(pairs === null ? {} : { pairs: summarise(pairs, request.binning?.download === true) }),
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
    cellNnz: mc.cells.length > 0 ? mc.nnz : null,
    hasGenomes: mc.hasGenomes,
    hasWeights: mc.hasWeights,
    scoreColumns: mc.scoreColumns,
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
  if (asked.binsPerCell > 1 || asked.contigsPerCell > 1) {
    return atRung(mc, open, asked_, await pooledResult(mc, request, rows, cols, asked))
  }
  const planned = fitPlan(mc, rows, cols)
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
  const selected = await mc.selectionMatrix(units, plan, {
    ...scanHooks(id),
    ...(request.balance === true ? { balance: true } : {}),
    ...(request.value === undefined ? {} : { value: request.value }),
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
  const withGenomes = mc.hasGenomes
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
    ...(withGenomes
      ? {
          rowGenomes: aggregatedGenomeRuns(mc, selected.ids),
          colGenomes: aggregatedGenomeRuns(mc, selected.ids),
        }
      : {}),
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
    case 'exportMcool':
      return handleExportMcool(request.id)
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
      return parseMetacoolerRange(await mapFor(request.rung), request.range, request.naming)
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
