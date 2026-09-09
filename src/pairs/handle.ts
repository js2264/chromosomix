/**
 * An imported `.pairs`, wearing a cooler's clothes.
 *
 * The counterpart to `hic/handle.ts`, and it makes the same argument: rather
 * than teaching `MetaCooler` about a third container, the container is taught
 * to answer `MetaCooler`'s questions. What it needs on open is a contig table,
 * a `chrom_offset`, and a handful of root attributes — and after
 * `pairs/bin.ts` has run, every one of those is a field on an object already in
 * memory.
 *
 * ## Where this differs from the `.hic` handle, and why
 *
 * `hic/handle.ts` refuses `pixels/*` and `indexes/bin1_offset` loudly, because
 * a `.hic` has no globally sorted pixel table and synthesising one would mean
 * reading the file to open it. Here the file *has* been read: the pixel table
 * exists, `nnz` is a number rather than `null`, and `datasetLength('pixels/…')`
 * answers with it so `validateLight`'s declared-versus-actual check runs for
 * real rather than being skipped.
 *
 * What is still refused is reading pixel *data* through this interface. It goes
 * through {@link PairsStore}, for the same reason a cooler's does: the seam is
 * drawn at the operation, and a caller that fetched columns by name would
 * bypass the chunking and the cancellation that every other path has.
 *
 * ## The three attributes that are not the file's own
 *
 * Same three as a `.hic`, and asserted for the same reasons:
 *
 * - **`bin-type: 'fixed'`** — the grid was chosen by the reader and is uniform
 *   by construction.
 * - **`contig-ordering: 'genome-then-length'`** — vacuous in its first half,
 *   since a pairs file has no genome layer, and true in its second:
 *   `#chromsize:` order is the contig order, and each contig is one contiguous
 *   block of bins.
 * - **`storage-mode: 'symmetric-upper'`** — a statement about the importer's
 *   output, which swaps every record onto the upper triangle, rather than about
 *   the file. Exactly the `.hic` handle's phrasing, and it is the reason
 *   `planRead` and `scatterDense` need no case for this format.
 *
 * ## Provenance is carried, not summarised
 *
 * The pairs header goes into the metadata verbatim, along with what the import
 * actually did — the record count, the skipped and clamped tallies, whether a
 * merge pass was needed. A reader looking at a map that came from a text file
 * should be able to see, without leaving the app, which file it was, how many
 * records went in, and whether any of them were dropped. It is also exactly
 * what the written `.mcool` carries, so a file handed to somebody else says the
 * same things this session does.
 */

import { makeTable } from '../h5/readTable'
import { ViewerError } from '../errors'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import type { Table } from '../types'
import type { BinnedPixels } from './bin'
import type { PairsHeader } from './format'

/** The datasets an imported map has no data for, and the sentence that says why. */
function refusePixels(path: string): never {
  throw new ViewerError(
    'unsupported',
    `A map binned from a .pairs file serves ${path} through PixelStore ` +
      '(metacooler/store.ts), not through the handle. Reaching for the column by name ' +
      'bypasses the chunking and the cancellation every other read has.',
    { path },
  )
}

export interface PairsHandleInit {
  uri: string
  header: PairsHeader
  pixels: BinnedPixels
  /** Every rung's bin size, as the entry names the resolution picker shows. */
  rungs: number[]
  /** Records the index promised, when there was one. */
  declaredRecords?: number | null
  /** `true` when a `.px2` was found and used. */
  indexed: boolean
}

export function pairsHandle(init: PairsHandleInit): Hdf5Handle {
  const { header, pixels } = init

  const chromTable = (): Table =>
    makeTable(pixels.contigs.length, ['name', 'length'], {
      name: pixels.contigs.map((contig) => contig.name),
      length: Float64Array.from(pixels.contigs, (contig) => contig.length),
    })

  const attributes: Record<string, AttrValue> = {
    format: 'PAIRS',
    'format-url': 'https://github.com/4dn-dcic/pairix/blob/master/pairs_format_specification.md',
    'format-version': versionNumber(header.version),
    'bin-size': pixels.binSize,
    'bin-type': 'fixed',
    // The *file-level* spellings, not the normalised ones. `normaliseInfo`
    // renames `contig-ordering` → `ordering`, `nchroms` → `ncontigs` and takes
    // `genome-assembly` in preference to `assembly`, so a handle that hands
    // over the already-renamed keys has them pass through untouched and shows
    // an em dash where the value is. This is what a cooler's attributes are
    // actually called, which is the thing this handle exists to imitate.
    'contig-ordering': 'genome-then-length',
    'storage-mode': 'symmetric-upper',
    'genome-assembly': header.assembly,
    nbins: pixels.nBins,
    nchroms: pixels.contigs.length,
    nnz: pixels.nnz,
    sum: pixels.sum,
    ngenomes: null,
    // Provenance. Every one of these is a fact about the import rather than
    // about the file, and a reader who cannot see them cannot tell a complete
    // import from one that quietly dropped a tenth of its records.
    'pairs-source': init.uri,
    'pairs-header': header.text,
    'pairs-sorted': header.sorted,
    'pairs-shape': header.shape,
    'pairs-indexed': init.indexed,
    'pairs-records': pixels.sum,
    ...(init.declaredRecords == null ? {} : { 'pairs-declared-records': init.declaredRecords }),
    ...(pixels.skippedUnknownContig === 0
      ? {}
      : { 'pairs-skipped-unknown-contig': pixels.skippedUnknownContig }),
    ...(pixels.skippedBadPosition === 0
      ? {}
      : { 'pairs-skipped-bad-position': pixels.skippedBadPosition }),
    ...(pixels.clampedPosition === 0 ? {} : { 'pairs-clamped-positions': pixels.clampedPosition }),
    ...(pixels.wasUnsorted ? { 'pairs-required-merge': true } : {}),
    ...(pixels.truncated ? { 'pairs-truncated': true } : {}),
    ...(pixels.contigsWithoutCisContacts.length === 0
      ? {}
      : {
          'pairs-sequences-without-cis-contacts': pixels.contigsWithoutCisContacts.join(', '),
        }),
  }

  return {
    uri: init.uri,
    group: '/',
    // The ladder, spelled the way an mcool's is, which is what wires an
    // imported map into the resolution picker, the refine ladder (§3.4) and a
    // deck descending to its lead's rung with no code in any of them learning
    // that this container exists.
    rootEntries: init.rungs.map((size) => String(size)),
    rootEntryGroup: 'resolutions',

    attrs: () => ({ ...attributes }),
    attrsAt: (path: string) => (path === '' || path === '/' ? { ...attributes } : {}),

    has(path: string): boolean {
      // No `bins/weight`: nothing is balanced, and offering the column would
      // put a Balance switch in the UI over weights that do not exist.
      return [
        'chroms',
        'chroms/name',
        'chroms/length',
        'contigs',
        'indexes',
        'indexes/chrom_offset',
        'pixels',
        'pixels/count',
        'bins',
      ].includes(path)
    },

    keys(path: string): string[] {
      if (path === '' || path === '/') return ['chroms', 'bins', 'pixels', 'indexes']
      if (path === 'chroms' || path === 'contigs') return ['name', 'length']
      if (path === 'pixels') return ['bin1_id', 'bin2_id', 'count']
      if (path === 'indexes') return ['chrom_offset']
      if (path === 'bins') return []
      return []
    },

    // There are no links, and the one caller asks in order to prove a *metacool*
    // is cooler-readable. `false` is the truthful answer and is never consulted
    // for a file with no genome layer.
    isSoftLink: () => false,

    datasetLength(path: string): number {
      if (path === 'chroms/name' || path === 'chroms/length') return pixels.contigs.length
      if (path === 'indexes/chrom_offset') return pixels.contigs.length + 1
      // Unlike a `.hic`, this is a real number and `validateLight` compares the
      // declared `nnz` against it rather than skipping the check.
      if (path.startsWith('pixels/')) return pixels.nnz
      return 0
    },

    dtype(path: string): string {
      // `'<i'` is honest: the values are counts of records, and nothing in the
      // path produces a fraction.
      if (path === 'pixels/count') return '<i'
      if (path === 'pixels/bin1_id' || path === 'pixels/bin2_id') return '<i'
      if (path === 'chroms/length') return '<i'
      if (path === 'chroms/name') return 'S'
      return '<d'
    },

    readNumeric(path: string, lo = 0, hi?: number): Float64Array {
      if (path === 'indexes/chrom_offset') return pixels.chromOffset.slice()
      if (path === 'chroms/length') {
        const end = hi ?? pixels.contigs.length
        return Float64Array.from(pixels.contigs.slice(lo, end), (contig) => contig.length)
      }
      if (path === 'bins/weight') {
        throw new ViewerError(
          'unsupported',
          'A map binned from a .pairs file carries raw counts and no balancing weights: ' +
            'nothing has been balanced. Export the .mcool and run `cooler balance` on it, ' +
            'or open a cooler that was written with weights.',
          {},
        )
      }
      if (path === 'indexes/bin1_offset' || path.startsWith('pixels/')) refusePixels(path)
      throw new ViewerError('unsupported', `An imported .pairs map has no ${path}.`, { path })
    },

    readInt32(path: string): Int32Array {
      if (path.startsWith('pixels/')) refusePixels(path)
      throw new ViewerError('unsupported', `An imported .pairs map has no ${path}.`, { path })
    },

    readStrings(path: string, lo = 0, hi?: number): string[] {
      if (path === 'chroms/name') {
        return pixels.contigs.slice(lo, hi ?? pixels.contigs.length).map((contig) => contig.name)
      }
      throw new ViewerError('unsupported', `An imported .pairs map has no ${path}.`, { path })
    },

    readTable(path: string): Table {
      if (path === 'chroms' || path === 'contigs') return chromTable()
      throw new ViewerError('unsupported', `An imported .pairs map has no /${path} table.`, {
        path,
      })
    },

    // Nothing to release: the bytes are this object's own arrays, and the
    // source they came from was closed when the import finished.
    // An imported `.pairs` is one pixel table per rung and has no group tree to
    // re-root into — the same answer a `.hic` gives, and for the same reason.
    // The sibling rungs are reached as they always were, by opening the import
    // again at another `::/resolutions/<n>`.
    at(path: string): never {
      throw new ViewerError('unsupported', `An imported .pairs has no /${path} group to open.`, {
        path,
      })
    },

    close: () => {},
  }
}

/** `## pairs format v1.0` → `1`, and `null` when there is no number in it. */
function versionNumber(version: string): number | null {
  const match = /v?(\d+)(?:\.(\d+))?/.exec(version)
  return match === null ? null : Number(match[1])
}
