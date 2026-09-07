/**
 * A HiC-Pro pair, wearing a cooler's clothes.
 *
 * The sibling of `hic/handle.ts`, and it goes one step further than that one
 * does — far enough that it is worth saying why, because the difference deletes
 * a whole module.
 *
 * A `.hic` cannot answer `pixels/*` or `indexes/bin1_offset`: it is indexed per
 * chromosome pair and per block, and synthesising a globally sorted pixel table
 * would mean reading the whole file to open it. So it refuses those datasets by
 * name and its pixels go through a `PixelStore` of its own.
 *
 * A HiC-Pro matrix has **already** been read whole — there is no index, so
 * there was never a choice — and `hicpro/parse.ts` hands back exactly what a
 * cooler stores: `bin1_id`, `bin2_id` and `count` sorted in row-major order,
 * with a cumulative `bin1_offset` beside them. Those datasets are therefore
 * served here honestly rather than refused, and **`CoolerStore` reads them
 * unchanged**. There is no `HicProStore`, and there should not be one: the
 * pixel path for this container is the cooler path, byte for byte, and a second
 * implementation of it could only drift.
 *
 * ## The attributes that are not the file's own
 *
 * A HiC-Pro pair has no header at all — no version, no assembly, no provenance,
 * not even a bin size except as the width of its intervals. So more is asserted
 * here than for a `.hic`, and each of them is either measured or true by
 * construction:
 *
 * - **`bin-size`** is measured from the widest interval in the BED, and a grid
 *   that has no single width is refused before this point (§3.3).
 * - **`bin-type: 'fixed'`** follows from that refusal.
 * - **`ordering: 'genome-then-length'`** is the §10 gate's vocabulary. There are
 *   no genomes, so the first half is vacuous; the second is the BED's own
 *   layout, which is one contiguous run of bins per sequence and is checked
 *   when the BED is parsed.
 * - **`storage-mode: 'symmetric-upper'`** is a statement about this reader's
 *   output, not about the bytes: `MATRIX_FORMAT` may be any of four things and
 *   the parser normalises all of them, so what reaches `planRead` and
 *   `scatterDense` is upper-triangular whichever way the file was written.
 *
 * `nnz` and `sum` are the parser's own counts, which are exact — it read every
 * pixel — so unlike a `.hic` this container can state both.
 */

import { makeTable } from '../h5/readTable'
import { ViewerError } from '../errors'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import type { Table } from '../types'
import type { HicProBins, HicProPixels } from './parse'

/** The two halves, parsed — everything the handle below serves. */
export interface HicProFile {
  bins: HicProBins
  pixels: HicProPixels
  /** Where the pair came from, for the info panel's provenance rows. */
  matrixName: string
  binsName: string
}

/** Slice a typed array the way a bounded HDF5 read would. */
function span(length: number, lo: number, hi?: number): [number, number] {
  const from = Math.max(0, Math.min(Math.trunc(lo), length))
  const to = Math.max(from, Math.min(Math.trunc(hi ?? length), length))
  return [from, to]
}

export function hicProHandle(uri: string, file: HicProFile): Hdf5Handle {
  const { bins, pixels } = file

  const chromTable = (): Table =>
    makeTable(bins.names.length, ['name', 'length'], {
      name: [...bins.names],
      length: bins.lengths.slice(),
    })

  const attributes: Record<string, AttrValue> = {
    format: 'HiC-Pro',
    'format-url': 'https://github.com/nservant/HiC-Pro',
    'bin-size': bins.binsize,
    'bin-type': 'fixed',
    ordering: 'genome-then-length',
    'storage-mode': 'symmetric-upper',
    nbins: bins.nBins,
    ncontigs: bins.names.length,
    nnz: pixels.nnz,
    sum: pixels.sum,
    ngenomes: null,
    // The two names, because a HiC-Pro map *is* the pair and a reader looking
    // at the info panel should see which BED the matrix was read against —
    // pairing the wrong resolution is the one mistake this format invites.
    'hicpro-matrix': file.matrixName,
    'hicpro-bins': file.binsName,
    // What `MATRIX_FORMAT` turned out to be, as observed rather than as
    // declared — the file declares nothing. It is here so that a `lower` or
    // `complete` file visibly *was* understood as one.
    'hicpro-stored': pixels.observed,
  }

  return {
    uri,
    group: '/',
    // No ladder. Each resolution is its own pair of files in its own directory,
    // so the siblings are a fact about the folder rather than about this file,
    // and the Files panel is where a folder is browsed.
    rootEntries: [],
    rootEntryGroup: '',

    attrs: () => ({ ...attributes }),
    attrsAt: (path: string) => (path === '' || path === '/' ? { ...attributes } : {}),

    has(path: string): boolean {
      // No `bins/weight`, and that is a decision rather than a gap — see §3.8.
      // HiC-Pro's biases normalise the *raw* matrix, and its `iced/` matrix is
      // the already-normalised one; a reader that applied the first to the
      // second would silently normalise twice.
      return [
        'chroms',
        'chroms/name',
        'chroms/length',
        'bins',
        'pixels',
        'pixels/bin1_id',
        'pixels/bin2_id',
        'pixels/count',
        'indexes',
        'indexes/bin1_offset',
        'indexes/chrom_offset',
      ].includes(path)
    },

    keys(path: string): string[] {
      if (path === '' || path === '/') return ['chroms', 'bins', 'pixels', 'indexes']
      if (path === 'chroms') return ['name', 'length']
      if (path === 'pixels') return ['bin1_id', 'bin2_id', 'count']
      if (path === 'indexes') return ['bin1_offset', 'chrom_offset']
      // `/bins` exists as a group — the BED is one — but carries no column this
      // reader can serve per bin beyond the coordinates it already derived.
      if (path === 'bins') return []
      return []
    },

    // No links of any kind. The one caller asks in order to prove a *metacool*
    // is cooler-readable, and this container has no genome layer.
    isSoftLink: () => false,

    datasetLength(path: string): number {
      if (path === 'chroms/name' || path === 'chroms/length') return bins.names.length
      if (path.startsWith('pixels/')) return pixels.nnz
      if (path === 'indexes/bin1_offset') return bins.nBins + 1
      if (path === 'indexes/chrom_offset') return bins.names.length + 1
      return 0
    },

    dtype(path: string): string {
      // The float kind for the value column, and it is the honest one: an
      // `iced/` matrix holds fractional counts, and reporting an integer kind
      // would license the rounding `resolveCountKind` exists to rule out.
      if (path === 'pixels/count') return '<f'
      if (path === 'pixels/bin1_id' || path === 'pixels/bin2_id') return '<i'
      if (path === 'chroms/length') return '<i'
      if (path === 'chroms/name') return 'S'
      return '<d'
    },

    readNumeric(path: string, lo = 0, hi?: number): Float64Array {
      if (path === 'indexes/chrom_offset') return bins.chromOffset.slice()
      if (path === 'indexes/bin1_offset') {
        const [from, to] = span(bins.nBins + 1, lo, hi)
        return pixels.binOffset.slice(from, to)
      }
      if (path === 'chroms/length') {
        const [from, to] = span(bins.names.length, lo, hi)
        return bins.lengths.slice(from, to)
      }
      if (path === 'pixels/count') {
        const [from, to] = span(pixels.nnz, lo, hi)
        return Float64Array.from(pixels.count.subarray(from, to))
      }
      if (path === 'bins/weight') {
        throw new ViewerError(
          'unsupported',
          'A HiC-Pro matrix carries no balancing weights. Its `iced/` matrix is already ' +
            'normalised — open that one instead of balancing this one — and its `.biases` ' +
            'file belongs to the raw matrix, so applying it here would normalise twice.',
          { path },
        )
      }
      throw new ViewerError('unsupported', `A HiC-Pro matrix has no ${path}.`, { path })
    },

    readInt32(path: string, lo = 0, hi?: number): Int32Array {
      const [from, to] = span(pixels.nnz, lo, hi)
      if (path === 'pixels/bin1_id') return pixels.bin1.subarray(from, to)
      if (path === 'pixels/bin2_id') return pixels.bin2.subarray(from, to)
      throw new ViewerError('unsupported', `A HiC-Pro matrix has no ${path}.`, { path })
    },

    readStrings(path: string, lo = 0, hi?: number): string[] {
      if (path === 'chroms/name') {
        const [from, to] = span(bins.names.length, lo, hi)
        return bins.names.slice(from, to)
      }
      throw new ViewerError('unsupported', `A HiC-Pro matrix has no ${path}.`, { path })
    },

    readTable(path: string): Table {
      if (path === 'chroms' || path === 'contigs') return chromTable()
      throw new ViewerError('unsupported', `A HiC-Pro matrix has no /${path} table.`, { path })
    },

    // One pair of files is one map. There is no group tree to re-root into.
    at(path: string) {
      throw new ViewerError('unsupported', `A HiC-Pro matrix has no /${path} group.`, { path })
    },

    // The bytes were read and parsed at open and are held as typed arrays;
    // there is no mount to release and no source still open behind this.
    close: () => undefined,
  }
}
