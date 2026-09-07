/**
 * Writing the imported ladder back out as an `.mcool`.
 *
 * ## What this is, against what §13 refuses
 *
 * §13's rule is *"the app never modifies a file it opened"*, and it says in the
 * same breath that the distinction is **between authoring an output and editing
 * an input, and only the second is refused**. The viewer has always produced
 * files: a PNG, a PDF, a BED of hand-drawn marks, a bigWig of a synthetic
 * track. This is another output, and it touches nothing.
 *
 * §18.9 is the clause that has to move, and it named its reason: *"a derived
 * contact matrix is a format contract, and owning one means owning every
 * question about what its provenance, its balancing and its bin table mean."*
 * That is an argument about a matrix **derived** from an opened map — smoothed,
 * balanced, transformed — where the answers are choices this app would be
 * making on the reader's behalf. It does not reach a matrix that is the
 * *primary reduction of a primary file*, because here every one of those
 * questions is answered by the input rather than by us:
 *
 * - **the bin table** comes from `#chromsize:` and a size the reader chose. Not
 *   inferred, not negotiated;
 * - **provenance** is the source file's name, its preamble carried verbatim,
 *   the record count, and what the import dropped or clamped — all of it in
 *   `metadata` and in named attributes, so a file handed to somebody else says
 *   exactly what this session says;
 * - **balancing** does not exist. No weights are written and none are implied.
 *   `cooler balance` is the answer and the `generated-by` string says so.
 *
 * And what is written is *what is on screen*. `sum` and `nnz` are the numbers
 * the info panel is showing, from the arrays the map is being drawn from. There
 * is no second computation to disagree with the first.
 *
 * ## The one place this is not byte-identical to `cooler cload`
 *
 * `bins/chrom` is written as plain `int32` codes rather than as an HDF5 *enum*,
 * because h5wasm exposes no way to construct an enum type. cooler reads it —
 * its `convert_enum` path falls through to the raw codes when the dtype is not
 * an enum — but `Cooler.bins()` hands back integer codes where a file from
 * `cooler cload` hands back a categorical of chromosome names. Everything
 * numeric is identical; this is the difference and it is stated rather than
 * discovered.
 *
 * ## Memory
 *
 * The pixel columns are int64 on disk, as cooler writes them, and the bin ids
 * in hand are `Int32Array`. Converting a 13.7 M-pixel table whole would be a
 * 110 MB spike per column on top of a table that is already resident, so the
 * datasets are created at chunk size, resized, and filled through `write_slice`
 * — which caps the conversion buffer at {@link WRITE_CHUNK} entries and is
 * where the progress for a large export comes from.
 */

import { getH5, type H5wasmGroup } from '../h5/bootstrap'
import type { BinnedPixels } from './bin'
import type { PairsHeader } from './format'
import { formatBp, type PairsImport } from './import'
import { VERSION } from '../version'

/** Pixels converted and written at a time. */
export const WRITE_CHUNK = 1 << 20

/**
 * h5wasm's dtype strings are **C-struct format characters, not numpy's**, and
 * the difference is silent.
 *
 * `dtype_to_metadata` matches `/^([<>|]?)([bhiqefdsBHIQSaA])([0-9]*)$/` and
 * takes the width from the *letter*: the trailing digits are parsed and then
 * discarded for integer types. So `'<i8'` — which reads as "little-endian
 * int64" to anyone who has written numpy — is accepted, means **int32**, and
 * the only symptom is a `BigInt64Array` failing to convert somewhere inside the
 * library with "Cannot mix BigInt and other types".
 *
 * Named here so the two that matter are written once and are impossible to
 * mistype. The same fact is recorded from the reading side in `h5/api.ts`.
 */
const INT64 = '<q'
const INT32 = '<i'

/** cooler's own format strings, so the file is one rather than resembles one. */
const COOLER_FORMAT = 'HDF5::Cooler'
const MCOOL_FORMAT = 'HDF5::MCOOL'
const COOLER_FORMAT_VERSION = 3
const MCOOL_FORMAT_VERSION = 2
const COOLER_FORMAT_URL = 'https://github.com/open2c/cooler'

export interface WriteOptions {
  onProgress?: (done: number, total: number, note?: string) => void
  cancelled?: () => boolean
}

/**
 * Write every rung of `imported` as an `.mcool`, returning the bytes.
 *
 * Built in h5wasm's virtual filesystem and read straight back out, which is
 * what makes this a download rather than a write: nothing touches a real path
 * in either target, and the bytes go to the browser exactly as a PNG's do.
 *
 * @returns `null` when the caller cancelled.
 */
export async function writeMcool(
  imported: PairsImport,
  options: WriteOptions = {},
): Promise<Uint8Array | null> {
  const h5 = await getH5()
  const path = `/pairs-export-${Date.now()}.mcool`

  // A stale mount from a cancelled export would be silently reused.
  if (h5.FS.analyzePath(path).exists) h5.FS.unlink(path)

  const file = new h5.File(path, 'w')
  try {
    file.create_attribute('format', MCOOL_FORMAT)
    file.create_attribute('format-version', MCOOL_FORMAT_VERSION)
    const resolutions = file.create_group('resolutions')

    const totalPixels = imported.rungs.reduce(
      (acc, size) => acc + (imported.tables.get(size)?.nnz ?? 0),
      0,
    )
    let written = 0

    for (const size of imported.rungs) {
      const table = imported.tables.get(size)
      if (table === undefined) continue
      const group = resolutions.create_group(String(size))
      writeCoolerGroup(group, table, imported, size)
      written = await writePixels(group, table, written, totalPixels, options)
      if (options.cancelled?.() === true) return null
      options.onProgress?.(written, totalPixels, `writing the ${formatBp(size)} rung`)
    }
  } finally {
    file.close()
  }

  try {
    const bytes = h5.FS.readFile(path)
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  } finally {
    h5.FS.unlink(path)
  }
}

/** Everything but the pixel table: attributes, chroms, bins, indexes. */
function writeCoolerGroup(
  group: H5wasmGroup,
  table: BinnedPixels,
  imported: PairsImport,
  binSize: number,
): void {
  const nChroms = table.contigs.length

  group.create_attribute('format', COOLER_FORMAT)
  group.create_attribute('format-version', COOLER_FORMAT_VERSION)
  group.create_attribute('format-url', COOLER_FORMAT_URL)
  group.create_attribute('bin-type', 'fixed')
  group.create_attribute('bin-size', binSize)
  group.create_attribute('storage-mode', 'symmetric-upper')
  group.create_attribute('nchroms', nChroms)
  group.create_attribute('nbins', table.nBins)
  group.create_attribute('nnz', table.nnz)
  group.create_attribute('sum', table.sum)
  group.create_attribute('generated-by', `metacooler-viewer ${VERSION} (pairs import; unbalanced)`)
  group.create_attribute('creation-date', new Date().toISOString())
  if (imported.header.assembly !== null) {
    group.create_attribute('assembly', imported.header.assembly)
  }
  group.create_attribute('metadata', JSON.stringify(provenance(imported, table)))

  const chroms = group.create_group('chroms')
  chroms.create_dataset({ name: 'name', data: table.contigs.map((contig) => contig.name) })
  chroms.create_dataset({
    name: 'length',
    data: Int32Array.from(table.contigs, (contig) => contig.length),
    dtype: INT32,
  })

  // The bin table cooler stores and this reader never needs (§3.3): written
  // because a cooler is not one without it, and computed rather than read.
  const bins = group.create_group('bins')
  const chromOf = new Int32Array(table.nBins)
  const start = new Int32Array(table.nBins)
  const end = new Int32Array(table.nBins)
  for (let contig = 0; contig < nChroms; contig++) {
    const from = table.chromOffset[contig]
    const to = table.chromOffset[contig + 1]
    const length = table.contigs[contig].length
    for (let bin = from; bin < to; bin++) {
      const offset = (bin - from) * binSize
      chromOf[bin] = contig
      start[bin] = offset
      // The last bin of a contig is short, which is cooler's own rule and the
      // one place the arithmetic is not a plain multiplication.
      end[bin] = Math.min(offset + binSize, length)
    }
  }
  bins.create_dataset({ name: 'chrom', data: chromOf, dtype: INT32 })
  bins.create_dataset({ name: 'start', data: start, dtype: INT32 })
  bins.create_dataset({ name: 'end', data: end, dtype: INT32 })

  const indexes = group.create_group('indexes')
  indexes.create_dataset({
    name: 'chrom_offset',
    data: BigInt64Array.from(table.chromOffset, (value) => BigInt(value)),
    dtype: INT64,
  })
  indexes.create_dataset({ name: 'bin1_offset', data: bin1Offsets(table), dtype: INT64 })
}

/** The CSR row pointer, one entry per bin plus a terminator. */
function bin1Offsets(table: BinnedPixels): BigInt64Array {
  const offsets = new BigInt64Array(table.nBins + 1)
  let at = 0
  for (let bin = 0; bin < table.nBins; bin++) {
    while (at < table.nnz && table.bin1[at] === bin) at++
    offsets[bin + 1] = BigInt(at)
  }
  return offsets
}

/**
 * The pixel table, in chunks.
 *
 * Created at chunk size and resized rather than built whole, so the int64
 * conversion buffer never exceeds {@link WRITE_CHUNK} entries however large the
 * table is.
 */
async function writePixels(
  group: H5wasmGroup,
  table: BinnedPixels,
  writtenSoFar: number,
  totalPixels: number,
  options: WriteOptions,
): Promise<number> {
  const pixels = group.create_group('pixels')
  const nnz = table.nnz
  const first = Math.min(WRITE_CHUNK, Math.max(1, nnz))

  const bin1 = pixels.create_dataset({
    name: 'bin1_id',
    data: toBig(table.bin1, 0, Math.min(first, nnz)),
    shape: [Math.min(first, nnz)],
    maxshape: [null],
    chunks: [first],
    dtype: INT64,
    compression: 'gzip',
  })
  const bin2 = pixels.create_dataset({
    name: 'bin2_id',
    data: toBig(table.bin2, 0, Math.min(first, nnz)),
    shape: [Math.min(first, nnz)],
    maxshape: [null],
    chunks: [first],
    dtype: INT64,
    compression: 'gzip',
  })
  const count = pixels.create_dataset({
    name: 'count',
    data: table.count.slice(0, Math.min(first, nnz)),
    shape: [Math.min(first, nnz)],
    maxshape: [null],
    chunks: [first],
    dtype: INT32,
    compression: 'gzip',
  })

  if (nnz > first) {
    bin1.resize([nnz])
    bin2.resize([nnz])
    count.resize([nnz])
    for (let at = first; at < nnz; at += WRITE_CHUNK) {
      if (options.cancelled?.() === true) return writtenSoFar + at
      const stop = Math.min(at + WRITE_CHUNK, nnz)
      bin1.write_slice([[at, stop]], toBig(table.bin1, at, stop))
      bin2.write_slice([[at, stop]], toBig(table.bin2, at, stop))
      count.write_slice([[at, stop]], table.count.slice(at, stop))
      options.onProgress?.(writtenSoFar + stop, totalPixels, 'writing pixels')
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return writtenSoFar + nnz
}

/** An int32 slice as int64, which is the dtype cooler's pixel ids carry. */
function toBig(source: Int32Array, from: number, to: number): BigInt64Array {
  const out = new BigInt64Array(Math.max(0, to - from))
  for (let i = 0; i < out.length; i++) out[i] = BigInt(source[from + i])
  return out
}

/**
 * What the file says about where it came from.
 *
 * Written into `metadata` as JSON, which is where cooler puts free-form
 * provenance and where this app's own info panel reads it back from. The pairs
 * preamble is carried verbatim rather than summarised: it is the only record of
 * the pipeline that produced the contacts, and a file that drops it has lost
 * the one thing a reader would want to check.
 */
function provenance(imported: PairsImport, table: BinnedPixels): Record<string, unknown> {
  const header: PairsHeader = imported.header
  return {
    'generated-by': `metacooler-viewer ${VERSION}`,
    'imported-from': 'pairs',
    'pairs-format': header.version,
    'pairs-sorted': header.sorted,
    'pairs-shape': header.shape,
    'pairs-indexed': imported.indexed,
    'pairs-header': header.text,
    'records-binned': table.sum,
    ...(imported.declaredRecords == null
      ? {}
      : { 'records-declared-by-index': imported.declaredRecords }),
    ...(table.skippedUnknownContig === 0
      ? {}
      : { 'records-skipped-unknown-contig': table.skippedUnknownContig }),
    ...(table.clampedPosition === 0 ? {} : { 'positions-clamped': table.clampedPosition }),
    ...(table.wasUnsorted ? { 'required-merge-pass': true } : {}),
    balanced: false,
    note: 'Raw counts, unbalanced. Run `cooler balance` to add a bins/weight column.',
  }
}

