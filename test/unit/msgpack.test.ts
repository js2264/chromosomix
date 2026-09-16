/**
 * The MessagePack decoder, form by form (§25).
 *
 * Two kinds of evidence. The first is the spec's own table, written out as
 * bytes: every first-byte form the decoder claims to read is decoded from a
 * sequence typed here by hand, with the form named beside it, so a reader can
 * hold each case against the spec without a packer in the loop. The second is
 * a packer *not written here*: `scripts/make_g3d_fixtures.py` packs one value
 * with Python's `msgpack` — the library `g3dtools` writes with — and the same
 * value as JSON, and the decoder is held to reproduce it. A decoder and a
 * hand-typed test can share a misreading of the spec; a decoder and the
 * reference packer cannot.
 *
 * The fixture half skips by name when the fixture is absent, which is what a
 * fresh clone and a CI runner see (`test:nofixtures`).
 */

import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { decodeMsgpack } from '@/annotations/msgpack'

const BIN = new URL('../fixtures/structure/msgpack.bin', import.meta.url).pathname
const JSON_PATH = new URL('../fixtures/structure/msgpack.json', import.meta.url).pathname

/** The value of a byte sequence, with the bytes spelled as the spec spells them. */
function decode(...bytes: number[]): unknown {
  return decodeMsgpack(new Uint8Array(bytes)).value
}

describe('every MessagePack form, from the spec', () => {
  it('reads nil and the booleans', () => {
    expect(decode(0xc0)).toBeNull() // nil
    expect(decode(0xc2)).toBe(false) // false
    expect(decode(0xc3)).toBe(true) // true
  })

  it('reads the fixints, both signs', () => {
    expect(decode(0x00)).toBe(0) // positive fixint 0
    expect(decode(0x7f)).toBe(127) // positive fixint 127
    expect(decode(0xe0)).toBe(-32) // negative fixint -32
    expect(decode(0xff)).toBe(-1) // negative fixint -1
  })

  it('reads every unsigned width', () => {
    expect(decode(0xcc, 0xff)).toBe(255) // uint 8
    expect(decode(0xcd, 0x01, 0x00)).toBe(256) // uint 16
    expect(decode(0xce, 0x00, 0x01, 0x00, 0x00)).toBe(65536) // uint 32
    // uint 64: 2^32, the smallest value the packer reaches for this width
    expect(decode(0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00)).toBe(4294967296)
    // uint 64: 2^53 - 1, the largest a number holds exactly
    expect(decode(0xcf, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('reads every signed width', () => {
    expect(decode(0xd0, 0x80)).toBe(-128) // int 8
    expect(decode(0xd1, 0xff, 0x7f)).toBe(-129) // int 16
    expect(decode(0xd2, 0xff, 0xff, 0x7f, 0xff)).toBe(-32769) // int 32
    // int 64: -2^31 - 1
    expect(decode(0xd3, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff)).toBe(-2147483649)
    // int 64: -(2^53 - 1)
    expect(decode(0xd3, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01)).toBe(Number.MIN_SAFE_INTEGER)
  })

  it('refuses a 64-bit integer a number would round', () => {
    // uint 64: 2^53, one past exact
    expect(() => decode(0xcf, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)).toThrow(/does not fit/)
    // int 64: -2^53
    expect(() => decode(0xd3, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)).toThrow(/does not fit/)
  })

  it('reads both float widths', () => {
    expect(decode(0xca, 0x3f, 0xc0, 0x00, 0x00)).toBe(1.5) // float 32
    // float 64: pi
    expect(decode(0xcb, 0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18)).toBe(Math.PI)
  })

  it('reads every string width, as UTF-8', () => {
    expect(decode(0xa3, 0x47, 0x33, 0x44)).toBe('G3D') // fixstr, 3 bytes
    expect(decode(0xa0)).toBe('') // fixstr, empty
    expect(decode(0xd9, 0x03, 0x47, 0x33, 0x44)).toBe('G3D') // str 8
    expect(decode(0xda, 0x00, 0x03, 0x47, 0x33, 0x44)).toBe('G3D') // str 16
    expect(decode(0xdb, 0x00, 0x00, 0x00, 0x03, 0x47, 0x33, 0x44)).toBe('G3D') // str 32
    expect(decode(0xa2, 0xc3, 0xa9)).toBe('é') // fixstr, one two-byte character
  })

  it('reads every bin width, as bytes', () => {
    expect(decode(0xc4, 0x02, 0x00, 0xff)).toEqual(new Uint8Array([0, 255])) // bin 8
    expect(decode(0xc5, 0x00, 0x02, 0x00, 0xff)).toEqual(new Uint8Array([0, 255])) // bin 16
    expect(decode(0xc6, 0x00, 0x00, 0x00, 0x02, 0x00, 0xff)).toEqual(new Uint8Array([0, 255])) // bin 32
  })

  it('reads every array width', () => {
    expect(decode(0x92, 0x01, 0x02)).toEqual([1, 2]) // fixarray
    expect(decode(0x90)).toEqual([]) // fixarray, empty
    expect(decode(0xdc, 0x00, 0x02, 0x01, 0x02)).toEqual([1, 2]) // array 16
    expect(decode(0xdd, 0x00, 0x00, 0x00, 0x02, 0x01, 0x02)).toEqual([1, 2]) // array 32
  })

  it('reads every map width, to a Map', () => {
    const one = new Map<string | number, unknown>([['a', 1]])
    expect(decode(0x81, 0xa1, 0x61, 0x01)).toEqual(one) // fixmap
    expect(decode(0x80)).toEqual(new Map()) // fixmap, empty
    expect(decode(0xde, 0x00, 0x01, 0xa1, 0x61, 0x01)).toEqual(one) // map 16
    expect(decode(0xdf, 0x00, 0x00, 0x00, 0x01, 0xa1, 0x61, 0x01)).toEqual(one) // map 32
  })

  it('keeps an integer key as a number, in the file order', () => {
    // fixmap {20000: 'x', 'y': 2}: the uint 16 key stays a number and stays first
    const map = decode(0x82, 0xcd, 0x4e, 0x20, 0xa1, 0x78, 0xa1, 0x79, 0x02) as Map<string | number, unknown>
    expect([...map.keys()]).toEqual([20000, 'y'])
    expect(map.get(20000)).toBe('x')
    expect(map.get('20000')).toBeUndefined()
  })

  it('refuses a key that is neither a string nor an integer', () => {
    // fixmap {nil: 1}
    expect(() => decode(0x81, 0xc0, 0x01)).toThrow(/map key/)
  })

  it('nests', () => {
    // fixmap {'a': fixarray [1, fixmap {'b': nil}]}
    const value = decode(0x81, 0xa1, 0x61, 0x92, 0x01, 0x81, 0xa1, 0x62, 0xc0)
    expect(value).toEqual(new Map([['a', [1, new Map([['b', null]])]]]))
  })

  it('says where the object ended, so a padded buffer is read once', () => {
    // fixmap {'v': 0} followed by zero padding: the padding is a run of
    // positive fixint 0s, each a legal value, and none of them is read.
    const padded = new Uint8Array(16)
    padded.set([0x81, 0xa1, 0x76, 0x00])
    const { value, end } = decodeMsgpack(padded)
    expect(value).toEqual(new Map([['v', 0]]))
    expect(end).toBe(4)
    // And a second object can be read from where the first stopped.
    const two = new Uint8Array([0x01, 0xa1, 0x78])
    expect(decodeMsgpack(two, decodeMsgpack(two).end).value).toBe('x')
  })

  it('throws on a truncated buffer, naming the offset', () => {
    expect(() => decode()).toThrow(/truncated/)
    expect(() => decode(0xcd, 0x01)).toThrow(/offset 1/) // uint 16 short one byte
    expect(() => decode(0xa3, 0x47)).toThrow(/truncated/) // fixstr short two
    expect(() => decode(0x92, 0x01)).toThrow(/truncated/) // fixarray short one element
  })

  it('refuses the ext family and the never-used byte', () => {
    expect(() => decode(0xc1)).toThrow(/0xc1/) // never used
    expect(() => decode(0xd4, 0x01, 0x00)).toThrow(/unsupported/) // fixext 1
    expect(() => decode(0xc7, 0x00, 0x01)).toThrow(/unsupported/) // ext 8
  })

  it('decodes from a view into a larger buffer at the view’s own offset', () => {
    const backing = new Uint8Array([0xff, 0xff, 0xcd, 0x01, 0x00, 0xff])
    expect(decodeMsgpack(backing.subarray(2, 5)).value).toBe(256)
  })
})

/**
 * A decoded value in the shape JSON can hold: `Map` to object with string
 * keys, bytes to base64. What `make_g3d_fixtures.py` did on its side, undone.
 */
function jsonable(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of value) out[String(key)] = jsonable(item)
    return out
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map(jsonable)
  return value
}

const available = existsSync(BIN) && existsSync(JSON_PATH)
const suite = available ? describe : describe.skip

suite('against what Python’s msgpack packed', () => {
  it('reproduces the value, and stops where the packer did', () => {
    const bytes = new Uint8Array(readFileSync(BIN))
    const expected = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as {
      value: unknown
      second: number
      first_end: number
    }
    const first = decodeMsgpack(bytes)
    expect(first.end).toBe(expected.first_end)
    expect(jsonable(first.value)).toEqual(expected.value)
    // The integer keys came back as numbers, not as the strings JSON holds.
    const map = first.value as Map<string, Map<string | number, unknown>>
    expect([...map.get('intkeys')!.keys()]).toEqual([1, -2, 300, 70000])
    // The packer was asked for a float 32 on the second value alone.
    expect(bytes[first.end]).toBe(0xca)
    const second = decodeMsgpack(bytes, first.end)
    expect(second.value).toBe(expected.second)
    expect(second.end).toBe(bytes.length)
  })
})
