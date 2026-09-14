/**
 * The FASTA index, and the arithmetic that reads a window by it.
 *
 * Pinned against `parseFasta` rather than against hand-computed offsets: a
 * file is written, indexed the way `samtools faidx` would index it, and every
 * window read by the index has to equal the same window sliced from the file
 * read whole. An off-by-one here is a genome shifted by one base, which no
 * screenshot would show — the same reason `fasta.test.ts` exists.
 */

import { describe, expect, it } from 'vitest'

import { byteOf, byteRange, contigsOf, looksLikeFai, parseFai, residuesIn } from '@/annotations/fai'
import { parseFasta } from '@/annotations/fasta'

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Index a FASTA the way `samtools faidx` does, from its text. */
function faidx(text: string): string {
  const lines: string[] = []
  const encoded = bytes(text)
  let at = 0
  const records = text.split(/(?<=\n)/)
  let name = ''
  let offset = 0
  let length = 0
  let lineBases = 0
  let lineWidth = 0
  const flush = (): void => {
    if (name !== '') lines.push(`${name}\t${length}\t${offset}\t${lineBases}\t${lineWidth}`)
  }
  for (const line of records) {
    const size = bytes(line).length
    if (line.startsWith('>')) {
      flush()
      name = line.slice(1).trim().split(/\s+/)[0]
      offset = at + size
      length = 0
      lineBases = 0
      lineWidth = 0
    } else if (name !== '') {
      const residues = line.replace(/\r?\n$/, '').length
      if (lineBases === 0) {
        lineBases = residues
        lineWidth = size
      }
      length += residues
    }
    at += size
  }
  flush()
  expect(at).toBe(encoded.length)
  return lines.join('\n') + '\n'
}

const FASTA = '>chrI a yeast chromosome\nACGTACGTAC\nGGTTCCAAGG\nTTAA\n>chrII\nCCCC\nGG\n>chrIII\nA\n'

describe('parseFai', () => {
  it('reads the five columns and keeps file order', () => {
    const records = parseFai(faidx(FASTA))
    expect(records).toEqual([
      { name: 'chrI', length: 24, offset: 25, lineBases: 10, lineWidth: 11 },
      { name: 'chrII', length: 6, offset: 59, lineBases: 4, lineWidth: 5 },
      { name: 'chrIII', length: 1, offset: 75, lineBases: 1, lineWidth: 2 },
    ])
    expect(contigsOf(records)).toEqual([
      { name: 'chrI', length: 24 },
      { name: 'chrII', length: 6 },
      { name: 'chrIII', length: 1 },
    ])
  })

  it('takes a sixth column in its stride, and a duplicate name once', () => {
    expect(parseFai('a\t4\t3\t4\t5\t0\nb\t4\t12\t4\t5\n')).toHaveLength(2)
    expect(parseFai('a\t4\t3\t4\t5\na\t4\t12\t4\t5\n').map((r) => r.name)).toEqual(['a'])
  })

  it('answers with nothing rather than half an index for a file that is not one', () => {
    expect(parseFai('chrI\t230218\n')).toEqual([])
    expect(parseFai('a\t4\t3\t0\t5\n')).toEqual([])
    expect(parseFai('a\t4\t3\t6\t5\n')).toEqual([])
    expect(parseFai('a\t4\t3\t4\tx\n')).toEqual([])
    expect(parseFai('')).toEqual([])
  })

  it('recognises its own shape', () => {
    expect(looksLikeFai(faidx(FASTA))).toBe(true)
    expect(looksLikeFai('chrI\t230218\nchrII\t813184\n')).toBe(false)
    expect(looksLikeFai('chrI\t0\t100\tpeak\t5\n')).toBe(false)
  })
})

describe('byteRange', () => {
  const whole = parseFasta(bytes(FASTA))
  const file = bytes(FASTA)
  const records = parseFai(faidx(FASTA))

  function viaIndex(name: string, start: number, end: number): string {
    const record = records.find((r) => r.name === name) as (typeof records)[number]
    const { from, to } = byteRange(record, start, end)
    return new TextDecoder().decode(residuesIn(file.subarray(from, to)))
  }

  function viaWhole(name: string, start: number, end: number): string {
    const seq = whole.bases.get(name) as Uint8Array
    return new TextDecoder().decode(seq.subarray(Math.max(0, start), Math.min(seq.length, end)))
  }

  it('reads every window of every sequence exactly as the file read whole does', () => {
    for (const record of records) {
      for (let start = 0; start <= record.length; start++) {
        for (let end = start; end <= record.length + 2; end++) {
          expect(viaIndex(record.name, start, end), `${record.name}:${start}-${end}`).toBe(
            viaWhole(record.name, start, end),
          )
        }
      }
    }
  })

  it('stops before the line ending when a window ends a line', () => {
    const chrI = records[0]
    // Residues 0–10 are the whole first line; the read must not carry its newline.
    expect(byteRange(chrI, 0, 10)).toEqual({ from: 25, to: 35 })
    expect(byteOf(chrI, 10)).toBe(36)
    // …and a window starting on the second line begins past it.
    expect(byteRange(chrI, 10, 12)).toEqual({ from: 36, to: 38 })
  })

  it('is empty for a window past the end, and clips one that runs over', () => {
    const chrII = records[1]
    expect(byteRange(chrII, 6, 9)).toEqual({ from: byteOf(chrII, 6), to: byteOf(chrII, 6) })
    expect(viaIndex('chrII', 4, 100)).toBe('GG')
    expect(viaIndex('chrII', -3, 2)).toBe('CC')
  })

  it('holds for CRLF files, whose line width is two more than their residues', () => {
    const crlf = FASTA.replace(/\n/g, '\r\n')
    const dos = parseFai(faidx(crlf))
    expect(dos[0].lineWidth).toBe(12)
    const raw = bytes(crlf)
    const parsed = parseFasta(raw)
    const { from, to } = byteRange(dos[0], 8, 14)
    expect(new TextDecoder().decode(residuesIn(raw.subarray(from, to)))).toBe(
      new TextDecoder().decode((parsed.bases.get('chrI') as Uint8Array).subarray(8, 14)),
    )
  })
})

describe('residuesIn', () => {
  it('drops line endings and nothing else, and hands the same array back when there are none', () => {
    const clean = bytes('ACGT')
    expect(residuesIn(clean)).toBe(clean)
    expect(new TextDecoder().decode(residuesIn(bytes('AC\r\nGT\nn')))).toBe('ACGTn')
  })
})
