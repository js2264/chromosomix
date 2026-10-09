/**
 * A `.2bit` written in memory, as kent's `faToTwoBit` writes one (§8.21).
 *
 * Little-endian, version 0, gaps recorded in the N blocks and written as `T`
 * in the packed bases, soft-mask blocks recorded and stepped over by the
 * reader. Shared by the reader's own tests and the command line's, which opens
 * a `--sequence` of this format by range.
 */

/** `T C A G` → `0 1 2 3`, four to a byte, most significant pair first. */
const CODE: Record<string, number> = { T: 0, C: 1, A: 2, G: 3 }

function packBases(sequence: string): Uint8Array {
  const out = new Uint8Array(Math.ceil(sequence.length / 4))
  for (let i = 0; i < sequence.length; i++) {
    const letter = sequence[i].toUpperCase()
    // An `N` is not in the two-bit alphabet: kent writes `T` in its place and
    // records the run in the N blocks, so this fixture does the same.
    const code = CODE[letter] ?? 0
    out[i >> 2] |= code << (6 - ((i & 3) << 1))
  }
  return out
}

export interface FixtureSequence {
  name: string
  bases: string
  /** Half-open spans that should read back as `N`. */
  gaps?: Array<[number, number]>
  /** Soft-mask spans, written so that stepping over them is exercised. */
  masks?: Array<[number, number]>
}

/** A whole `.2bit` file, little-endian, version 0. */
export function buildTwoBit(sequences: readonly FixtureSequence[]): Uint8Array {
  const encoder = new TextEncoder()
  const names = sequences.map((sequence) => encoder.encode(sequence.name))
  const indexBytes = names.reduce((sum, name) => sum + 1 + name.length + 4, 0)
  const bodies = sequences.map((sequence) => {
    const gaps = sequence.gaps ?? []
    const masks = sequence.masks ?? []
    const packed = packBases(sequence.bases)
    const size = 4 + 4 + gaps.length * 8 + 4 + masks.length * 8 + 4 + packed.length
    const body = new Uint8Array(size)
    const view = new DataView(body.buffer)
    let at = 0
    view.setUint32(at, sequence.bases.length, true)
    at += 4
    view.setUint32(at, gaps.length, true)
    at += 4
    for (const [from] of gaps) {
      view.setUint32(at, from, true)
      at += 4
    }
    for (const [from, to] of gaps) {
      view.setUint32(at, to - from, true)
      at += 4
    }
    view.setUint32(at, masks.length, true)
    at += 4
    for (const [from] of masks) {
      view.setUint32(at, from, true)
      at += 4
    }
    for (const [from, to] of masks) {
      view.setUint32(at, to - from, true)
      at += 4
    }
    view.setUint32(at, 0, true) // reserved
    at += 4
    body.set(packed, at)
    return body
  })

  const total = 16 + indexBytes + bodies.reduce((sum, body) => sum + body.length, 0)
  const file = new Uint8Array(total)
  const view = new DataView(file.buffer)
  view.setUint32(0, 0x1a412743, true)
  view.setUint32(4, 0, true) // version
  view.setUint32(8, sequences.length, true)
  view.setUint32(12, 0, true) // reserved

  let indexAt = 16
  let bodyAt = 16 + indexBytes
  sequences.forEach((_, at) => {
    file[indexAt] = names[at].length
    file.set(names[at], indexAt + 1)
    view.setUint32(indexAt + 1 + names[at].length, bodyAt, true)
    indexAt += 1 + names[at].length + 4
    file.set(bodies[at], bodyAt)
    bodyAt += bodies[at].length
  })
  return file
}
