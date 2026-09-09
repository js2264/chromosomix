/**
 * A `.hic`, wearing a cooler's clothes.
 *
 * This is the module that makes the difference not felt. `MetaCooler` reads a
 * handful of small things when it opens a file — a chromosome table, an offset
 * array, a few root attributes, a weight column — and every one of them is
 * something a `.hic` header already says. So rather than teaching `MetaCooler`
 * about a second container, the container is taught to answer `MetaCooler`'s
 * questions, and the reader, the coordinate model, the views, the tracks and
 * the fourteen analysis tasks go on being written against exactly one shape.
 *
 * The line this does **not** cross is the pixel table. `pixels/*` and
 * `indexes/bin1_offset` are refused here by name, loudly, because a plausible
 * answer would be worse than none: synthesising a globally sorted pixel table
 * means reading the whole file to open it, which is the one cost §2 exists to
 * avoid. Pixels go through `PixelStore` (`metacooler/store.ts`), which is drawn
 * at the operation rather than at the dataset for that reason.
 *
 * ## The three attributes that are not the file's own
 *
 * `bin-type`, `ordering` and `storage-mode` have no counterpart in a `.hic`
 * header, and all three are asserted rather than invented:
 *
 * - **`bin-type: 'fixed'`** is true. A BP-unit matrix is a fixed grid; the
 *   fragment-unit matrices, which are not, are excluded before this point.
 * - **`ordering: 'genome-then-length'`** is the §10 gate's vocabulary, and a
 *   `.hic` trivially satisfies what the gate is *for*: one contiguous block of
 *   bins per sequence, in one order. There are no genomes, so the first half of
 *   the name is vacuous and the second is the file's own layout.
 * - **`storage-mode: 'symmetric-upper'`** is what `HicFile.pairRecords`
 *   guarantees, by normalising every record it emits. It is a statement about
 *   this reader's output rather than about the bytes, and it is the reason
 *   `planRead` and `scatterDense` need no case for this format.
 */

import { makeTable } from '../h5/readTable'
import { ViewerError } from '../errors'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import type { Table } from '../types'
import type { HicFile } from './HicFile'

/**
 * The datasets a `.hic` cannot serve, and the sentence that says why.
 *
 * Reached only by a code path that bypassed {@link PixelStore}, which is a bug
 * in this repo rather than a problem with the file — so the message is written
 * for whoever is holding the stack trace.
 */
function refusePixels(path: string): never {
  throw new ViewerError(
    'unsupported',
    `A .hic has no ${path}: it is indexed per chromosome pair and per block, not as one ` +
      'sorted pixel table. Read pixels through PixelStore (metacooler/store.ts), which is ' +
      'the seam that exists for exactly this difference.',
    { path },
  )
}

export function hicHandle(uri: string, file: HicFile): Hdf5Handle {
  const chromTable = (): Table =>
    makeTable(file.chroms.length, ['name', 'length'], {
      name: file.chroms.map((chrom) => chrom.name),
      length: Float64Array.from(file.chroms, (chrom) => chrom.length),
    })

  const attributes: Record<string, AttrValue> = {
    format: 'HIC',
    'format-url': 'https://github.com/aidenlab/juicer/wiki/Data-structure',
    'format-version': file.header.version,
    'bin-size': file.binSize,
    'bin-type': 'fixed',
    ordering: 'genome-then-length',
    'storage-mode': 'symmetric-upper',
    assembly: file.header.genomeId,
    nbins: file.nBins,
    ncontigs: file.chroms.length,
    // Deliberately absent as numbers: a `.hic` states neither a record count nor
    // an integer contact total, and `validateLight` skips a declared value that
    // is null rather than comparing against a fabricated one.
    nnz: null,
    sum: null,
    ngenomes: null,
    // Passed through so the info panel shows what the writer recorded — the
    // Juicer version, the restriction enzyme, the statistics file. These are the
    // provenance a reader of somebody else's `.hic` most wants.
    ...file.header.attributes,
    ...(file.normType === null ? {} : { 'hic-normalisation': file.normType }),
  }

  return {
    uri,
    group: '/',
    // The resolution ladder, as the entry list every mcool already exposes —
    // which is what wires a `.hic` into the resolution picker, the refine ladder
    // (§3.4) and the deck's descend-to-the-lead's-rung behaviour, with no code
    // in any of the three learning that this container exists.
    rootEntries: file.resolutions.map((size) => String(size)),
    rootEntryGroup: 'resolutions',

    attrs: () => ({ ...attributes }),
    attrsAt: (path: string) => (path === '' || path === '/' ? { ...attributes } : {}),

    has(path: string): boolean {
      if (path === 'bins/weight') return file.normType !== null
      return ['chroms', 'chroms/name', 'chroms/length', 'indexes', 'pixels', 'bins'].includes(path)
    },

    keys(path: string): string[] {
      if (path === '' || path === '/') return ['chroms', 'bins', 'pixels', 'indexes']
      if (path === 'chroms') return ['name', 'length']
      if (path === 'pixels') return ['bin1_id', 'bin2_id', 'count']
      if (path === 'bins') return file.normType === null ? [] : ['weight']
      return []
    },

    // A `.hic` has no links at all, and the one caller asks in order to prove a
    // *metacool* is cooler-readable. `false` is the truthful answer and is never
    // consulted for a file with no genome layer.
    isSoftLink: () => false,

    datasetLength(path: string): number {
      if (path === 'chroms/name' || path === 'chroms/length') return file.chroms.length
      if (path === 'bins/weight') return file.nBins
      // Not `refusePixels`: `validateLight` asks for this unconditionally, and
      // the declared `nnz` beside it is null, so the comparison is skipped. A
      // throw here would refuse every file at open.
      if (path.startsWith('pixels/')) return 0
      return 0
    },

    dtype(path: string): string {
      // `'<f'` is the float kind, and it is the honest one: a `.hic` block holds
      // either int16 counts or float32 values, and a reader that reported an
      // integer kind would license the rounding `resolveCountKind` exists to
      // rule out for float coolers.
      if (path === 'pixels/count') return '<f'
      if (path === 'chroms/length') return '<i'
      if (path === 'chroms/name') return 'S'
      if (path === 'bins/weight') return '<d'
      return '<d'
    },

    readNumeric(path: string, lo = 0, hi?: number): Float64Array {
      if (path === 'indexes/chrom_offset') return file.chromOffset.slice()
      if (path === 'chroms/length') {
        const end = hi ?? file.chroms.length
        return Float64Array.from(file.chroms.slice(lo, end), (chrom) => chrom.length)
      }
      if (path === 'bins/weight') {
        if (file.normType === null) {
          throw new ViewerError(
            'unsupported',
            'This .hic carries no normalisation vectors, so there are no weights to balance ' +
              'with. Re-run Juicer Tools `addNorm`, or view the raw counts.',
            {},
          )
        }
        return file.weights(lo, hi ?? file.nBins)
      }
      if (path === 'indexes/bin1_offset' || path.startsWith('pixels/')) refusePixels(path)
      throw new ViewerError('unsupported', `A .hic has no ${path}.`, { path })
    },

    readInt32(path: string): Int32Array {
      if (path.startsWith('pixels/')) refusePixels(path)
      throw new ViewerError('unsupported', `A .hic has no ${path}.`, { path })
    },

    readStrings(path: string, lo = 0, hi?: number): string[] {
      if (path === 'chroms/name') {
        return file.chroms.slice(lo, hi ?? file.chroms.length).map((chrom) => chrom.name)
      }
      throw new ViewerError('unsupported', `A .hic has no ${path}.`, { path })
    },

    readTable(path: string): Table {
      if (path === 'chroms' || path === 'contigs') return chromTable()
      throw new ViewerError('unsupported', `A .hic has no /${path} table.`, { path })
    },

    // A `.hic` is one matrix per resolution and has no group tree to re-root
    // into. The sibling resolutions are reached the way they always were, by
    // opening the file again at another `::/resolutions/<n>`.
    at(path: string) {
      throw new ViewerError('unsupported', `A .hic has no /${path} group to open.`, { path })
    },

    close: () => file.close(),
  }
}
