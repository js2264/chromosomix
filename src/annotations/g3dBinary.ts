/**
 * WashU's binary g3d: the container `g3dtools load` writes and the WashU
 * Epigenome Browser reads (§25).
 *
 * The text g3d (`g3d.ts`) is what a solver writes; this is what a lab
 * *publishes*, because it is the file the browser can range-request. One
 * container holds the same model at several resolutions — the base one and
 * the `-s 2,4` multiples `g3dtools` averages from it — so a viewer can read
 * the coarse model first and the fine one on demand. Reading it here rather
 * than through the `g3djs` package is the arrangement `annotations/bam/`
 * records for `@gmod/bam`: every read in this app goes through a source that
 * counts, caches and signs its requests, and a reader that fetches for itself
 * sits outside all three. `g3djs` stays a devDependency and is the oracle the
 * tests hold this reader against, bead for bead.
 *
 * ## The layout, as learned from the writer
 *
 * Version 2 of the format, the only one `g3dtools` has written since 0.2:
 *
 * - The first **64,000 bytes** hold one MessagePack map and are zero-padded to
 *   that length: `{magic: 'G3D', version: 2, genome, name, offsets,
 *   resolutions, categories}`. `offsets` maps each resolution — as an
 *   **integer** key — to `{offset, size}` in bytes.
 * - Each resolution's block, at `[offset, offset + size)`, is one
 *   zlib-compressed MessagePack map: `{category: {chrom: {start: [ints],
 *   x: [floats], y: [floats], z: [floats]}}}`. A category is `shared` for an
 *   unphased model, `maternal` and `paternal` for a phased one, and whatever
 *   the sixth column said otherwise. Within a chromosome the arrays are sorted
 *   by start, because the writer sorts before it packs.
 *
 * Version 1 laid the beads out row by row under an index of its own, and
 * nothing has written it since 2020. It is refused by name rather than read
 * badly, and the refusal says how to get a version-2 file from the same text.
 *
 * ## What it becomes
 *
 * Exactly what {@link parseG3d} makes of the same beads: a `FeatureSet` whose
 * every row is one bead of `resolution` bases, with its coordinate carried
 * through the builder's sort and the haplotype written as a detail on a phased
 * file only. The one difference is where the width comes from — the text
 * reader infers it from the spacing of the starts, and here the file *declares*
 * it, so a model read at 40 kb is a model whose beads are 40 kb wide whatever
 * gaps it has. The chromosome names are the file's own — `g3dtools` prefixes
 * `chr` on the way in — and nothing here strips or adds anything, because
 * matching them to the map's is done downstream, once, for every format.
 */

import { declaredCount, declaredSpan, inflateCapped, inflationCap, type InflationPolicy } from '../sources/untrusted'
import { FeatureBuilder, type StructureSchema } from './featureset'
import { G3D_FIELD_HAPLOTYPE } from './g3d'
import { decodeMsgpack } from './msgpack'
import { DETAIL_SEP, type FeatureSet } from './types'

/** How many bytes the writer reserves for the header, whatever the header needs. */
export const G3D_HEADER_LENGTH = 64000

/** The format as a refusal names it. */
const G3D = 'binary g3d'

/**
 * How far one resolution's block may inflate: 64 times its compressed size,
 * never under 64 MiB nor over 1 GiB (`sources/untrusted.ts`).
 *
 * A block is MessagePack of bead starts and coordinates, some thirty bytes a
 * bead, and zlib shrinks it two or three times at most, because most of it is
 * float mantissa — so sixty-four is far past any real block's ratio. The floor
 * holds two million beads whatever they compress to; the ceiling thirty
 * million, where a bead a kilobase of a diploid human genome is six.
 */
const G3D_INFLATION: InflationPolicy = { ratio: 64, floor: 64 << 20, ceiling: 1 << 30 }

/** How this module asks for bytes; the same shape `twobit.ts` takes, for the same reason. */
export type ReadRange = (length: number, position: number) => Promise<Uint8Array>

/** What the header says about the file, with its byte map. */
export interface G3dHeader {
  version: number
  genome: string
  name: string
  /** In the file's order: the base resolution first, then each scale of it. */
  resolutions: number[]
  /** The category names, in the order the writer met them; `shared` alone for an unphased model. */
  categories: string[]
  /** Where each resolution's compressed block lies, keyed by the resolution. */
  offsets: Map<number, { offset: number; size: number }>
  /** The file's length, where the reader knew it — what a block's place is checked against. */
  fileSize?: number
}

/**
 * The bytes a binary g3d begins with: a map of at most fifteen entries, or a
 * `map16` for one that has grown past that, then the fixstr `magic` and the
 * fixstr `G3D`.
 */
const MAGIC_KEY = [0xa5, 0x6d, 0x61, 0x67, 0x69, 0x63] // fixstr "magic"
const MAGIC_VALUE = [0xa3, 0x47, 0x33, 0x44] // fixstr "G3D"

/**
 * Whether these bytes open a binary g3d.
 *
 * Tested on the bytes rather than by decoding, because this is asked of every
 * dropped file's first sixteen bytes before anything knows what it is, and a
 * decoder handed a random file's front would throw somewhere inside it. The
 * writer builds the header as a Python dict with `magic` first, so the pair
 * `magic: 'G3D'` follows the map byte directly; a `map16` is allowed in case
 * a later `g3dtools` adds a ninth key, and nothing else is, because a header
 * with more than 65,535 keys is not one this reader would understand anyway.
 */
export function isG3dBinary(head: Uint8Array): boolean {
  if (head.length === 0) return false
  const first = head[0]
  let at: number
  if (first >= 0x80 && first <= 0x8f) at = 1
  else if (first === 0xde) at = 3
  else return false
  const expected = [...MAGIC_KEY, ...MAGIC_VALUE]
  if (head.length < at + expected.length) return false
  for (let k = 0; k < expected.length; k++) {
    if (head[at + k] !== expected[k]) return false
  }
  return true
}

/**
 * Read and check the header.
 *
 * One read of the whole reserved block: the header is never longer than
 * 64,000 bytes because the writer asserts so, and a file shorter than that
 * (`size`) is read to its end. The decoder stops at the end of the map and
 * the padding is never looked at, which is what makes a header ending in a
 * zero byte safe (see `msgpack.ts`).
 *
 * Every field the reader will lean on is checked here rather than where it is
 * used, so a file that is not what it claims fails once, in one sentence,
 * before any block is fetched. That includes each block's offset and size, as
 * far as they can be judged from the header: a place in a file and no larger
 * than a block could inflate to (§10). Whether the block is inside *this*
 * file is asked when it is read, against `size` — a header read from a file's
 * front need not be the whole of it.
 */
export async function readG3dHeader(read: ReadRange, size?: number): Promise<G3dHeader> {
  const length = size === undefined ? G3D_HEADER_LENGTH : Math.min(G3D_HEADER_LENGTH, size)
  const bytes = await read(length, 0)
  if (!isG3dBinary(bytes)) {
    throw new Error('Not a binary g3d: the file does not begin with the G3D magic.')
  }
  const { value } = decodeMsgpack(bytes)
  if (!(value instanceof Map)) throw new Error('Not a binary g3d: the header is not a map.')
  if (value.get('magic') !== 'G3D') throw new Error('Not a binary g3d: the magic is not "G3D".')
  const version = value.get('version')
  if (version !== 2) {
    if (version === 1) {
      throw new Error(
        'This is a version-1 g3d, written by a g3dtools older than 0.2. Run `g3dtools load` over ' +
          'the original text to rewrite it as a version-2 file, which is the layout this reader ' +
          'and the WashU browser both understand.',
      )
    }
    throw new Error(`Unsupported g3d version ${String(version)}: this reader understands version 2.`)
  }
  const resolutions = numbers(value.get('resolutions'), 'resolutions')
  const categories = strings(value.get('categories'), 'categories')
  const rawOffsets = value.get('offsets')
  if (!(rawOffsets instanceof Map)) throw new Error('This g3d has no offsets map in its header.')
  const offsets = new Map<number, { offset: number; size: number }>()
  for (const [key, entry] of rawOffsets) {
    // The writer keys by integer; the number the key *reads as* is accepted
    // too, so a file re-packed by a tool that stringified its keys still opens.
    const resolution = typeof key === 'number' ? key : Number(key)
    if (!Number.isInteger(resolution) || !(entry instanceof Map)) continue
    const offset = entry.get('offset')
    const blockSize = entry.get('size')
    if (typeof offset !== 'number' || typeof blockSize !== 'number') continue
    const field = `${resolution} bp block`
    declaredCount(offset, { format: G3D, field: `offset of the ${field}`, ceiling: Number.MAX_SAFE_INTEGER })
    declaredCount(blockSize, { format: G3D, field: `size of the ${field}`, ceiling: G3D_INFLATION.ceiling })
    offsets.set(resolution, { offset, size: blockSize })
  }
  for (const resolution of resolutions) {
    if (!offsets.has(resolution)) {
      throw new Error(`This g3d lists a resolution of ${resolution} bp but has no block for it.`)
    }
  }
  return {
    version,
    genome: typeof value.get('genome') === 'string' ? (value.get('genome') as string) : '',
    name: typeof value.get('name') === 'string' ? (value.get('name') as string) : '',
    resolutions,
    categories,
    offsets,
    ...(size === undefined ? {} : { fileSize: size }),
  }
}

/**
 * Read one resolution of the model into beads with a place on each.
 *
 * One read for the block, one inflate, one decode, and then the walk the
 * writer's loop is the mirror of: each category in the order the block lists
 * them, each chromosome in the block's order, each bead in start order. The
 * haplotype index is the category's position in the header's list, and a
 * category the block has that the header does not — which no `g3dtools` has
 * written, since both come from one dict — is appended rather than dropped,
 * so every bead keeps a name.
 *
 * `detail` follows the text reader's rule to the letter: written only on a
 * phased model, where it tells two beads at one locus apart, because on a
 * haploid one it would offer the colour picker a category with one level.
 */
export async function readG3dModel(
  read: ReadRange,
  header: G3dHeader,
  resolution: number,
): Promise<FeatureSet> {
  const block = header.offsets.get(resolution)
  if (block === undefined) {
    throw new Error(
      `This g3d has no model at ${resolution} bp; it has ${header.resolutions.join(', ')}.`,
    )
  }
  // A block past the end of the file is a read of the rest of it to find that
  // out, so it is refused before the read is made (§10).
  if (header.fileSize !== undefined) {
    declaredSpan(block.offset, block.size, { format: G3D, field: `${resolution} bp block`, size: header.fileSize })
  }
  const compressed = await read(block.size, block.offset)
  if (compressed.length !== block.size) {
    throw new Error(
      `The ${resolution} bp block of this g3d is ${compressed.length} bytes where the header ` +
        `promised ${block.size}.`,
    )
  }
  const { value } = decodeMsgpack(await inflate(compressed, resolution))
  if (!(value instanceof Map)) throw new Error(`The ${resolution} bp block of this g3d is not a map.`)
  const haplotypes = [...header.categories]
  const phased = haplotypes.length > 1
  const builder = new FeatureBuilder()
  for (const [category, chromosomes] of value) {
    const name = String(category)
    let hap = haplotypes.indexOf(name)
    if (hap < 0) {
      hap = haplotypes.length
      haplotypes.push(name)
    }
    const detail = phased ? `${G3D_FIELD_HAPLOTYPE} ${name}` : ''
    if (!(chromosomes instanceof Map)) continue
    for (const [chrom, columns] of chromosomes) {
      if (!(columns instanceof Map)) continue
      const where = `${name}/${String(chrom)} at ${resolution} bp`
      const start = numbers(columns.get('start'), `start of ${where}`)
      const x = numbers(columns.get('x'), `x of ${where}`)
      const y = numbers(columns.get('y'), `y of ${where}`)
      const z = numbers(columns.get('z'), `z of ${where}`)
      if (x.length !== start.length || y.length !== start.length || z.length !== start.length) {
        throw new Error(`The columns of ${where} in this g3d are not the same length.`)
      }
      const contig = String(chrom)
      for (let at = 0; at < start.length; at++) {
        builder.add(contig, start[at], start[at] + resolution, {
          xyz: [x[at], y[at], z[at]],
          hap,
          detail,
        })
      }
    }
  }
  const schema: StructureSchema = { width: resolution, haplotypes }
  return builder.finish(null, schema)
}

/**
 * The line under a binary g3d's label before any model is read: the file's
 * own account of itself, from the header alone.
 */
export function g3dBinaryNote(header: G3dHeader): string {
  const resolutions = header.resolutions.length
  const categories = header.categories.length
  return [
    'binary g3d',
    `${resolutions} resolution${resolutions === 1 ? '' : 's'}`,
    `${categories} categor${categories === 1 ? 'y' : 'ies'}`,
  ].join(DETAIL_SEP)
}

/**
 * zlib-inflate one block, through the platform's own decompressor.
 *
 * The same call `hic/HicFile.ts` makes for the same reason: `DecompressionStream`
 * costs no bundle and every worker and every Node this runs on has it.
 * `'deflate'` and not `'deflate-raw'`, because `zlib.compress` in Python writes
 * the two-byte zlib header and the Adler-32 trailer, and asking for raw fails on
 * the first byte rather than producing a wrong bead later. Capped at
 * {@link G3D_INFLATION}'s proportion of what went in, so a block of a megabyte
 * cannot become the gigabyte deflate allows on its way to a refusal.
 */
async function inflate(bytes: Uint8Array, resolution: number): Promise<Uint8Array> {
  return inflateCapped(bytes, {
    format: G3D,
    field: `${resolution} bp block`,
    encoding: 'deflate',
    maxBytes: inflationCap(bytes.byteLength, G3D_INFLATION),
  })
}

/** An array of numbers from the decoded file, or an error naming what was not one. */
function numbers(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new Error(`This g3d's ${what} is not an array.`)
  for (const item of value) {
    if (typeof item !== 'number') throw new Error(`This g3d's ${what} holds a value that is not a number.`)
  }
  return value as number[]
}

/** An array of strings from the decoded file, or an error naming what was not one. */
function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`This g3d's ${what} is not an array.`)
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`This g3d's ${what} holds a value that is not a string.`)
  }
  return value as string[]
}
