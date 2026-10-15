/**
 * A binary g3d written in memory, as `g3dtools load` lays one out (§25.2).
 *
 * The oracle fixtures are written by `g3dtools` itself (`scripts/make_g3d_fixtures.py`)
 * and need Python to exist, so a suite that must run on a clean clone — the
 * malformed-file fuzz is one — has nothing to corrupt without this. It writes
 * the version-2 container `annotations/g3dBinary.ts` documents: one MessagePack
 * map zero-padded to 64,000 bytes, `magic` first, then one zlib-compressed map
 * per resolution at the offset the header names.
 *
 * **Not an oracle.** A writer and a reader from one repository can agree on a
 * wrong reading of the format; that is `g3d-binary-oracle.test.ts`'s job, with
 * `g3djs` and `g3dtools` on the other side. This exists to make well-formed
 * bytes to break.
 */

/** The bytes a value takes in MessagePack, by the spec's table of first bytes. */
export function packMsgpack(value: unknown): Uint8Array {
  const out: number[] = []
  const push16 = (n: number): void => {
    out.push((n >>> 8) & 0xff, n & 0xff)
  }
  const push32 = (n: number): void => {
    out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  }
  const write = (item: unknown): void => {
    if (item === null) {
      out.push(0xc0)
    } else if (typeof item === 'boolean') {
      out.push(item ? 0xc3 : 0xc2)
    } else if (typeof item === 'number') {
      if (Number.isInteger(item) && item >= 0 && item <= 0x7f) out.push(item)
      else if (Number.isInteger(item) && item < 0 && item >= -32) out.push(0x100 + item)
      else if (Number.isInteger(item) && item >= 0 && item <= 0xffffffff) {
        out.push(0xce)
        push32(item)
      } else if (Number.isInteger(item) && item >= -0x80000000 && item < 0) {
        out.push(0xd2)
        push32(item >>> 0)
      } else {
        const bytes = new Uint8Array(8)
        new DataView(bytes.buffer).setFloat64(0, item)
        out.push(0xcb, ...bytes)
      }
    } else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item)
      if (bytes.length < 32) out.push(0xa0 | bytes.length)
      else if (bytes.length < 0x100) out.push(0xd9, bytes.length)
      else {
        out.push(0xdb)
        push32(bytes.length)
      }
      out.push(...bytes)
    } else if (Array.isArray(item)) {
      if (item.length < 16) out.push(0x90 | item.length)
      else if (item.length < 0x10000) {
        out.push(0xdc)
        push16(item.length)
      } else {
        out.push(0xdd)
        push32(item.length)
      }
      for (const element of item) write(element)
    } else if (item instanceof Map) {
      if (item.size < 16) out.push(0x80 | item.size)
      else {
        out.push(0xde)
        push16(item.size)
      }
      for (const [key, element] of item) {
        write(key)
        write(element)
      }
    } else {
      throw new Error(`packMsgpack: cannot pack ${typeof item}`)
    }
  }
  write(value)
  return Uint8Array.from(out)
}

/** One chromosome of one category: bead starts and their coordinates, sorted by start. */
export interface G3dBeads {
  start: number[]
  x: number[]
  y: number[]
  z: number[]
}

export interface G3dWriteOptions {
  genome?: string
  name?: string
  /** Per resolution, per category, per chromosome — the writer's own nesting. */
  models: Map<number, Map<string, Map<string, G3dBeads>>>
}

const HEADER_LENGTH = 64000

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A whole version-2 binary g3d. */
export async function writeG3d(options: G3dWriteOptions): Promise<Uint8Array> {
  const resolutions = [...options.models.keys()]
  const categories = [...new Set([...options.models.values()].flatMap((model) => [...model.keys()]))]
  const blocks: Uint8Array[] = []
  for (const resolution of resolutions) {
    const model = options.models.get(resolution) as Map<string, Map<string, G3dBeads>>
    const packed = new Map<string, unknown>()
    for (const [category, chroms] of model) {
      const byChrom = new Map<string, unknown>()
      for (const [chrom, beads] of chroms) {
        byChrom.set(chrom, new Map<string, unknown>([
          ['start', beads.start],
          ['x', beads.x],
          ['y', beads.y],
          ['z', beads.z],
        ]))
      }
      packed.set(category, byChrom)
    }
    blocks.push(await zlib(packMsgpack(packed)))
  }
  const offsets = new Map<number, unknown>()
  let at = HEADER_LENGTH
  resolutions.forEach((resolution, index) => {
    offsets.set(resolution, new Map<string, unknown>([['offset', at], ['size', blocks[index].length]]))
    at += blocks[index].length
  })
  const header = packMsgpack(new Map<string, unknown>([
    ['magic', 'G3D'],
    ['version', 2],
    ['genome', options.genome ?? 'hg38'],
    ['name', options.name ?? 'toy'],
    ['offsets', offsets],
    ['resolutions', resolutions],
    ['categories', categories],
  ]))
  if (header.length > HEADER_LENGTH) throw new Error('writeG3d: the header does not fit its 64,000 bytes')
  const out = new Uint8Array(at)
  out.set(header, 0)
  let offset = HEADER_LENGTH
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}
