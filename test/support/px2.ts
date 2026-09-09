/**
 * A synthetic `.px2`, laid out exactly as pairix writes one.
 *
 * The layout is the one recorded in `src/pairs/px2.ts` and read out of pairix's
 * `index.c`: an eight-byte `PX2.*` magic, `n_ref`, a 64-bit `linecount` (32-bit
 * for the two older magics), the `ti_conf_t` struct **including its padding**,
 * the name block, and then tabix's own per-reference bin and linear indexes.
 *
 * The padding is the whole reason this exists. `sizeof(ti_conf_t)` is written
 * to disk as whatever the compiler made it, so a reader cannot compute it by
 * summing the field widths — `parsePx2` probes instead, and validates each
 * candidate against the name block that follows. Writing indexes at *both*
 * plausible sizes is how that probe gets tested rather than trusted.
 */

import { bgzipBytes } from './pairs'

/** One chromosome-pair key and the compressed span its records occupy. */
export interface Px2Entry {
  /** As written in the index: two chromosomes joined by the split character. */
  key: string
  /** Block start of the first BGZF member holding a record for this key. */
  from: number
  /** Block start of the last one. */
  to: number
}

export interface Px2Options {
  entries: readonly Px2Entry[]
  linecount: number
  /** `sizeof(ti_conf_t)` as this build padded it. */
  confSize?: 36 | 40 | 44
  /** `PX2.004` by default; the older two carry a 32-bit line count. */
  magic?: 'PX2.004' | 'PX2.003' | 'PX2.002'
  splitChar?: string
  metaChar?: string
  lineSkip?: number
  /** Emit an index with no `linecount` field at all, to exercise the refusal. */
  corruptMagic?: boolean
}

const NUL = 0

/** Build the index, BGZF-compressed as pairix leaves it. */
export function px2(options: Px2Options): Uint8Array {
  const confSize = options.confSize ?? 36
  const magic = options.corruptMagic === true ? 'TBIXXX' : (options.magic ?? 'PX2.004')
  const wide = magic === 'PX2.004'
  const splitChar = options.splitChar ?? '|'

  const nameBytes: number[] = []
  for (const entry of options.entries) {
    for (const code of new TextEncoder().encode(entry.key)) nameBytes.push(code)
    nameBytes.push(NUL)
  }

  const headLength = 8 + 4 + (wide ? 8 : 4) + confSize + 4
  const head = new Uint8Array(headLength)
  const view = new DataView(head.buffer)

  for (let i = 0; i < 8; i++) head[i] = magic.charCodeAt(i) & 0xff
  // `PX2.004` is seven characters; the eighth byte is the version marker.
  if (options.corruptMagic !== true) head[7] = 1

  let at = 8
  view.setInt32(at, options.entries.length, true)
  at += 4
  if (wide) {
    view.setBigUint64(at, BigInt(options.linecount), true)
    at += 8
  } else {
    view.setUint32(at, options.linecount, true)
    at += 4
  }

  // `preset`, then the two column triples that make this 2D rather than tabix.
  const conf = at
  const columns = [0, 2, 3, 3, 4, 5, 5]
  for (let i = 0; i < columns.length; i++) view.setUint32(conf + i * 4, columns[i], true)
  head[conf + 28] = 0x09 // delimiter: tab
  head[conf + 29] = splitChar.charCodeAt(0)
  head[conf + 30] = (options.metaChar ?? '#').charCodeAt(0)
  // Padded to a 4-byte boundary before `line_skip`, which is what makes the
  // struct's on-disk size a property of the compiler rather than of the format.
  view.setUint32(conf + 32, options.lineSkip ?? 0, true)
  at = conf + confSize
  view.setInt32(at, nameBytes.length, true)

  const bodies: number[] = []
  const push32 = (value: number): void => {
    bodies.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
  }
  const pushVirtual = (block: number): void => {
    const virtual = BigInt(block) << 16n
    for (let i = 0; i < 8; i++) bodies.push(Number((virtual >> BigInt(i * 8)) & 0xffn))
  }
  for (const entry of options.entries) {
    push32(1) // n_bin
    push32(4681) // the bin number, which the reader never keeps
    push32(1) // n_chunk
    pushVirtual(entry.from)
    pushVirtual(entry.to)
    push32(1) // n_intv
    pushVirtual(entry.from)
  }

  const out = new Uint8Array(head.length + nameBytes.length + bodies.length)
  out.set(head, 0)
  out.set(nameBytes, head.length)
  out.set(bodies, head.length + nameBytes.length)
  return bgzipBytes(out)
}
