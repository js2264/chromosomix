/**
 * Opening a container from a {@link SourceSpec} — whichever container it is.
 *
 * There are two threads in this application that mount a contact map: the
 * reader worker, which every view reads through, and the analysis worker, which
 * mounts the same file a second time so a long task cannot block a pan
 * (§18.3). They must agree about what a file *is*, and for a while they did not:
 * the reader grew a HiC-Pro road — two text files, read whole, no HDF5 anywhere
 * (§3.9) — and the analysis worker kept calling `MetaCooler.open` directly, so
 * every task on a HiC-Pro pair reached h5wasm with a `.matrix` and failed inside
 * it with `error - name not defined!`. The map was on screen; the task said the
 * file was broken.
 *
 * That is the argument for this module. The knowledge of *how many roads there
 * are into a map* belongs in one place, and a third caller — the CLI — gets it
 * for free by importing the same function rather than by remembering to grow a
 * branch.
 *
 * What stays with each caller is what differs honestly between them: their own
 * progress channel, their own cancellation set, and what they do with the map
 * once it is open.
 */

import { ViewerError } from '../errors'
import { hicProBinsNames, isHicProMatrix } from '../annotations/sidecar'
import { parseBins, parseMatrix } from '../hicpro/parse'
import { MetaCooler } from '../metacooler/MetaCooler'
import { signS3Request, type S3Credential } from '../s3/sigv4'
import type { ByteSource } from '../types'
import type { SourceSpec } from './protocol'
import { createSource, readWhole } from './sources'

/** A bin file, which is a source spec of the same shape as the matrix's. */
type BinsSpec = NonNullable<SourceSpec['bins']>

/**
 * What a caller wants to hear about while a container opens, and how to stop.
 *
 * Both optional, and both absent is a perfectly ordinary open: most containers
 * are HDF5, mount in a handful of bounded reads and are finished before anyone
 * could want either. The two indexless ones are why this exists (§3.8, §3.9).
 */
export interface OpenHooks {
  /** Bytes or pixels as they land, with the phase that is counting them. */
  report?(done: number, total: number, note: string): void
  /** Asked between chunks; `true` aborts the open with an `AbortError`. */
  cancelled?(): boolean
}

/**
 * Mount `uri` from `spec`, by whichever road the container needs.
 *
 * Two roads, and the branch is the bin file rather than the extension: a
 * matrix names one or is refused, so `binsFor` answering non-`null` *is* the
 * statement that this is a HiC-Pro pair.
 */
export async function openMap(
  uri: string,
  spec: SourceSpec,
  hooks: OpenHooks = {},
): Promise<{ mc: MetaCooler; source: ByteSource }> {
  // A HiC-Pro pair never reaches `createSource`: it has no index, so both
  // halves are read whole and parsed into typed arrays, and there is no mount
  // left behind for a `ByteSource` to represent (§3.9).
  const bins = await binsFor(spec)
  return bins === null
    ? await openThroughSource(uri, spec, hooks)
    : await openHicPro(uri, spec, bins, hooks)
}

/** The ordinary road: mount the bytes, and let the reader classify them. */
async function openThroughSource(
  uri: string,
  spec: SourceSpec,
  hooks: OpenHooks,
): Promise<{ mc: MetaCooler; source: ByteSource }> {
  const source = await createSource(spec, {
    ...(hooks.report === undefined
      ? {}
      : { onProgress: (received, total) => hooks.report?.(received, total, 'downloading') }),
    ...(hooks.cancelled === undefined ? {} : { cancelled: hooks.cancelled }),
  })
  // A `reading` on the spec *is* the reader's answer to the §12 gate — the
  // shell only ever sets one by re-issuing this open with what they chose.
  const agreed = spec.kind === 'remote' && spec.reading !== undefined
  // Listing a single-cell container's cells is the one wait in this application
  // that cannot be measured while it happens: it is a single call into h5wasm
  // that issues a thousand small synchronous reads and returns when it is done,
  // so this thread is not free to say anything until it already has the answer.
  // What can be said is *which* wait it is, before it starts — an indeterminate
  // bar under the name of the phase, which is the difference between a reader
  // who knows a thousand reads are in flight and one watching a spinner.
  if (looksSingleCell(uri)) hooks.report?.(0, 0, 'listing cells')
  const mc = await MetaCooler.open(uri, source, agreed ? { listingAgreed: true } : {})
  return { mc, source }
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
  uri: string,
  spec: SourceSpec,
  bins: BinsSpec,
  hooks: OpenHooks,
): Promise<{ mc: MetaCooler; source: ByteSource }> {
  const binsName = nameOf(bins)
  const matrixName = nameOf(spec)
  const watch = (note: string): { onProgress?: (a: number, b: number) => void; cancelled?: () => boolean } => ({
    ...(hooks.report === undefined
      ? {}
      : { onProgress: (got: number, total: number) => hooks.report?.(got, total, note) }),
    ...(hooks.cancelled === undefined ? {} : { cancelled: hooks.cancelled }),
  })
  const binBytes = await readWhole(bins, watch('reading the bins'))
  const parsedBins = parseBins(binBytes, binsName)
  // Before the matrix is touched, and after the bins are — the bins are small
  // and their bin count is what makes the estimate below mean anything.
  await assertLoadAffordable(spec, matrixName, parsedBins.nBins)
  const matrixBytes = await readWhole(spec, watch('downloading the matrix'))
  return hicProMap(uri, { bytes: matrixBytes, name: matrixName }, parsedBins, binsName, binBytes.length, hooks)
}

/**
 * A HiC-Pro map from bytes already in hand — the half of the road above that is
 * not I/O.
 *
 * Split out for the CLI, which has a filesystem rather than a `SourceSpec` and
 * reads both halves itself. The parse, the bin-id arithmetic and the storage
 * mode are the whole of what makes this container a contact map, and there is
 * one copy of them.
 */
export async function hicProMap(
  uri: string,
  matrix: { bytes: Uint8Array; name: string },
  parsedBins: ReturnType<typeof parseBins>,
  binsName: string,
  binsBytes: number,
  hooks: OpenHooks = {},
): Promise<{ mc: MetaCooler; source: ByteSource }> {
  const parsedPixels = await parseMatrix(matrix.bytes, parsedBins.nBins, matrix.name, {
    ...(hooks.cancelled === undefined ? {} : { cancelled: hooks.cancelled }),
    ...(hooks.report === undefined
      ? {}
      : { onProgress: (done: number, total: number) => hooks.report?.(done, total, 'reading pixels') }),
  })
  const mc = MetaCooler.fromHicPro(uri, {
    bins: parsedBins,
    pixels: parsedPixels,
    matrixName: matrix.name,
    binsName,
  })
  return { mc, source: parsedSource(matrix.name, binsBytes + matrix.bytes.length) }
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
export async function binsFor(spec: SourceSpec): Promise<BinsSpec | null> {
  const name = nameOf(spec)
  if (!isHicProMatrix(name)) return null
  if (spec.bins !== undefined) return spec.bins
  if (spec.kind === 'remote') {
    const found = await probeBins(spec.url, spec.credential)
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
 * Whether this name is a container whose open has a listing phase worth naming.
 *
 * By name, because the answer is wanted *before* the file is classified — the
 * point of it is to label the wait that classification is about to spend. It is
 * only a label: a flat-layout `.scool` written as `.cool` gets the ordinary
 * spinner and opens exactly the same, and nothing downstream reads this.
 */
function looksSingleCell(uri: string): boolean {
  return /\.scool(\.gz)?(\?|#|$)/i.test(uri)
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
 * difference from §3.8's gate. There the cost was round trips, which a local
 * file does not pay; here it is parsing and memory, which it pays in full — a
 * gigabyte of text off a local disk is the same ten seconds and the same
 * gigabyte of typed arrays as one off a bucket.
 */
const HICPRO_GATE_BYTES = 200 << 20

/**
 * Refuse to read a large matrix until the reader has agreed to what it costs.
 *
 * §3.9's gate, and the shape is §3.8's: a refusal carrying the numbers, thrown
 * where the cost is about to be paid and caught by the shell, which asks and
 * re-issues the open with the agreement on the source. The agreement rides on
 * the same `reading` field, because it is the same sentence — *yes, read it
 * whole* — and this container has no second way to be read.
 *
 * @throws ViewerError `hicpro-load-cost` when the matrix is large and unagreed.
 */
async function assertLoadAffordable(
  spec: SourceSpec,
  matrixName: string,
  nBins: number,
): Promise<void> {
  if (spec.reading !== undefined) return
  const bytes = await sizeOfSource(spec)
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
    // A host that will not answer a `HEAD` is not a reason to refuse the file;
    // it is a reason not to quote a number, so the gate does not fire.
    return null
  }
}

/** A source's file name, without the directory, the query or the fragment. */
export function nameOf(spec: SourceSpec | BinsSpec): string {
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
