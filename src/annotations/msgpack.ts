/**
 * A MessagePack decoder, and nothing else (§25).
 *
 * Written here rather than taken from a package for the reason every other
 * binary reader under `annotations/` is: this module is bundled into the
 * annotations worker, and the one thing WashU's binary g3d needs from
 * MessagePack is to be *read*. The whole of the format's spec is a table of
 * first bytes, and a decoder that follows it is a few hundred lines — shorter
 * than the licence text of the library it would replace, and with no encoder,
 * no extension registry and no timestamp type to carry for nobody.
 *
 * ## What it decodes to
 *
 * Plain values, with two decisions worth stating:
 *
 * - **A map is a `Map`, not an object.** `g3dtools` keys its `offsets` by the
 *   resolution as an *integer* — `{20000: {offset, size}}` — and an object
 *   would coerce that to the string `'20000'`, which is a key a caller then has
 *   to know to spell. A `Map<string | number, unknown>` keeps the file's own
 *   key type, so an integer key is looked up as a number and a string key as a
 *   string. A key of any other type is refused rather than stringified.
 * - **A 64-bit integer is a number when it can be, and an error when it
 *   cannot.** Every count in a g3d is a base-pair start or a byte offset, both
 *   far inside 2^53; a value outside it would be a corrupt file, and reading
 *   it as a rounded number would be a bead at a locus that does not exist.
 *
 * `bin` decodes to a `Uint8Array` viewing the input, and `str` through
 * `TextDecoder`, which every worker and every Node this runs on has.
 *
 * ## One object out of a padded buffer
 *
 * {@link decodeMsgpack} returns where the object *ended* as well as what it
 * was, because a g3d's header is one map at the front of a 64,000-byte block
 * padded with zeros — and `0x00` is a valid MessagePack value (the positive
 * fixint `0`), so "decode until the buffer is empty" would read a header
 * followed by fifty thousand zeros. Decoding one object and stopping is what
 * `g3dtools`' own reader does with `msgpack.Unpacker`; the JavaScript reader
 * trims trailing zeros first, which is wrong the day a header ends in a `0`.
 */

/** What one decode returns: the value, and the offset just past its bytes. */
export interface Decoded {
  value: unknown
  /** The index of the first byte after the object, so a caller can decode the next. */
  end: number
}

/** The largest and smallest 64-bit integers a `number` holds exactly. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/**
 * Decode one MessagePack object from the front of `bytes`, starting at `at`.
 *
 * Bytes after the object are ignored, and where they begin is returned; a
 * buffer that ends before the object does throws, naming the offset. Nothing
 * is cached and nothing is shared between calls, so the function is safe to
 * hand a view into a larger buffer.
 */
export function decodeMsgpack(bytes: Uint8Array, at = 0): Decoded {
  const reader = new Reader(bytes, at)
  const value = reader.next()
  return { value, end: reader.at }
}

/**
 * The cursor over one buffer.
 *
 * A class rather than a closure so that the recursive walk has a place to keep
 * its offset that every helper sees, and so the `DataView` and the
 * `TextDecoder` are built once per decode rather than once per value.
 */
class Reader {
  at: number
  private readonly view: DataView
  private readonly decoder = new TextDecoder()

  constructor(
    private readonly bytes: Uint8Array,
    at: number,
  ) {
    this.at = at
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  /**
   * The next object, by its first byte.
   *
   * The order is the spec's own table: the fixint, fixmap, fixarray and fixstr
   * ranges first, because they are ranges rather than single bytes, and then
   * the named codes in ascending order.
   */
  next(): unknown {
    const head = this.u8()
    if (head <= 0x7f) return head // positive fixint
    if (head >= 0xe0) return head - 0x100 // negative fixint
    if (head >= 0x80 && head <= 0x8f) return this.map(head & 0x0f) // fixmap
    if (head >= 0x90 && head <= 0x9f) return this.array(head & 0x0f) // fixarray
    if (head >= 0xa0 && head <= 0xbf) return this.str(head & 0x1f) // fixstr
    switch (head) {
      case 0xc0:
        return null
      case 0xc2:
        return false
      case 0xc3:
        return true
      case 0xc4:
        return this.bin(this.u8())
      case 0xc5:
        return this.bin(this.u16())
      case 0xc6:
        return this.bin(this.u32())
      case 0xca:
        return this.f32()
      case 0xcb:
        return this.f64()
      case 0xcc:
        return this.u8()
      case 0xcd:
        return this.u16()
      case 0xce:
        return this.u32()
      case 0xcf:
        return this.big(this.view.getBigUint64(this.take(8)))
      case 0xd0:
        return this.i8()
      case 0xd1:
        return this.i16()
      case 0xd2:
        return this.i32()
      case 0xd3:
        return this.big(this.view.getBigInt64(this.take(8)))
      case 0xd9:
        return this.str(this.u8())
      case 0xda:
        return this.str(this.u16())
      case 0xdb:
        return this.str(this.u32())
      case 0xdc:
        return this.array(this.u16())
      case 0xdd:
        return this.array(this.u32())
      case 0xde:
        return this.map(this.u16())
      case 0xdf:
        return this.map(this.u32())
      default:
        // 0xc1 is the one byte the spec never assigns; 0xc7–0xc9 and
        // 0xd4–0xd8 are the ext family, which no g3d writer emits and which
        // this reader therefore has no meaning to give.
        throw new Error(
          `msgpack: unsupported type byte 0x${head.toString(16).padStart(2, '0')} at offset ${this.at - 1}.`,
        )
    }
  }

  /** Reserve `length` bytes and return where they begin, or throw if they are not there. */
  private take(length: number): number {
    const start = this.at
    if (start + length > this.bytes.length) {
      throw new Error(
        `msgpack: truncated: needed ${length} byte${length === 1 ? '' : 's'} at offset ${start} ` +
          `of ${this.bytes.length}.`,
      )
    }
    this.at = start + length
    return start
  }

  private u8(): number {
    return this.view.getUint8(this.take(1))
  }

  private u16(): number {
    return this.view.getUint16(this.take(2))
  }

  private u32(): number {
    return this.view.getUint32(this.take(4))
  }

  private i8(): number {
    return this.view.getInt8(this.take(1))
  }

  private i16(): number {
    return this.view.getInt16(this.take(2))
  }

  private i32(): number {
    return this.view.getInt32(this.take(4))
  }

  private f32(): number {
    return this.view.getFloat32(this.take(4))
  }

  private f64(): number {
    return this.view.getFloat64(this.take(8))
  }

  /** A 64-bit integer as a number, refused where the number would round. */
  private big(value: bigint): number {
    if (value > MAX_SAFE || value < MIN_SAFE) {
      throw new Error(
        `msgpack: the 64-bit integer ${value} at offset ${this.at - 9} does not fit a JavaScript number.`,
      )
    }
    return Number(value)
  }

  private str(length: number): string {
    const start = this.take(length)
    return this.decoder.decode(this.bytes.subarray(start, start + length))
  }

  private bin(length: number): Uint8Array {
    const start = this.take(length)
    return this.bytes.subarray(start, start + length)
  }

  private array(length: number): unknown[] {
    const out = new Array<unknown>(length)
    for (let k = 0; k < length; k++) out[k] = this.next()
    return out
  }

  /**
   * A map of `length` pairs.
   *
   * Insertion order is the file's, which is what a `Map` keeps and an object
   * with integer-like keys would not: JavaScript reorders those ahead of every
   * string key, and a g3d's resolutions would come out sorted whether or not
   * the file listed them so.
   */
  private map(length: number): Map<string | number, unknown> {
    const out = new Map<string | number, unknown>()
    for (let k = 0; k < length; k++) {
      const keyAt = this.at
      const key = this.next()
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new Error(`msgpack: a map key at offset ${keyAt} is neither a string nor an integer.`)
      }
      out.set(key, this.next())
    }
    return out
  }
}
