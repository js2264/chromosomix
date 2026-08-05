/**
 * The FASTA reader: what it recognises, what it keeps, and what it says about GC.
 *
 * The parse is worth pinning at this level because it is the only place in the
 * viewer that reads a file *as bytes* rather than as text, and because
 * everything downstream of it — the assembly's lengths, the coordinates of every
 * base drawn, the GC line — is arithmetic over the arrays it builds. An
 * off-by-one in the record boundary is a genome shifted by one base, which no
 * screenshot would show.
 */

import { describe, expect, it } from 'vitest'

import { BASE_CODE, GC_WINDOW_MIN, gcBins, looksLikeFasta, parseFasta } from '@/annotations/fasta'

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function residues(store: ReturnType<typeof parseFasta>, name: string): string {
  return new TextDecoder().decode(store.bases.get(name) ?? new Uint8Array())
}

describe('looksLikeFasta', () => {
  it('is the first byte and nothing else', () => {
    expect(looksLikeFasta(bytes('>chrI\nACGT\n'))).toBe(true)
    expect(looksLikeFasta(bytes('chrI\t230218\n'))).toBe(false)
    expect(looksLikeFasta(bytes('I\t0\t100\n'))).toBe(false)
    expect(looksLikeFasta(new Uint8Array())).toBe(false)
  })
})

describe('parseFasta', () => {
  it('keeps every record, in file order, at its own length', () => {
    const store = parseFasta(bytes('>chrI desc here\nACGT\nAC\n>chrII\nGGGG\n'))
    expect(store.contigs).toEqual([
      { name: 'chrI', length: 6 },
      { name: 'chrII', length: 4 },
    ])
    expect(residues(store, 'chrI')).toBe('ACGTAC')
    expect(residues(store, 'chrII')).toBe('GGGG')
    expect(store.total).toBe(10)
  })

  it('takes the name up to the first space, and drops the rest of the header', () => {
    const store = parseFasta(bytes('>chrI [organism=yeast] len=6\nACGTAC\n'))
    expect(store.contigs[0].name).toBe('chrI')
  })

  it('drops line endings of either flavour, and needs no final newline', () => {
    const store = parseFasta(bytes('>a\r\nAC\r\nGT\r\n>b\r\nTT'))
    expect(residues(store, 'a')).toBe('ACGT')
    expect(residues(store, 'b')).toBe('TT')
  })

  it('keeps case, because a soft-masked genome means something by it', () => {
    const store = parseFasta(bytes('>a\nACGTacgt\n'))
    expect(residues(store, 'a')).toBe('ACGTacgt')
    // …and identity is case-blind, so a masked G is still a G.
    expect(BASE_CODE['g'.charCodeAt(0)]).toBe(BASE_CODE['G'.charCodeAt(0)])
  })

  it('does not mistake a > inside a header or a sequence for a new record', () => {
    // The only `>` that starts a record is one at the start of a line.
    const store = parseFasta(bytes('>a b>c\nACGT\nAC>GT\n'))
    expect(store.contigs).toHaveLength(1)
    expect(residues(store, 'a')).toBe('ACGTAC>GT')
  })

  it('skips a duplicate name rather than merging two sequences under it', () => {
    const store = parseFasta(bytes('>a\nAAAA\n>a\nCCCC\n>b\nGG\n'))
    expect(store.contigs.map((contig) => contig.name)).toEqual(['a', 'b'])
    expect(residues(store, 'a')).toBe('AAAA')
  })

  it('skips an empty record rather than declaring a zero-length sequence', () => {
    const store = parseFasta(bytes('>a\n>b\nACGT\n'))
    expect(store.contigs).toEqual([{ name: 'b', length: 4 }])
  })
})

describe('gcBins', () => {
  it('is the GC fraction of each window', () => {
    const store = parseFasta(bytes(`>a\n${'GC'.repeat(20)}${'AT'.repeat(20)}\n`))
    const seq = store.bases.get('a') as Uint8Array
    const bins = gcBins(seq, 0, 80, 40)
    expect(Array.from(bins.starts)).toEqual([0, 40])
    expect(Array.from(bins.ends)).toEqual([40, 80])
    expect(bins.values[0]).toBeCloseTo(1)
    expect(bins.values[1]).toBeCloseTo(0)
  })

  it('never bins narrower than the window floor', () => {
    const store = parseFasta(bytes(`>a\n${'ACGT'.repeat(100)}\n`))
    const seq = store.bases.get('a') as Uint8Array
    // Asked for one base per bin, which would be a step function between 0 and 1.
    const bins = gcBins(seq, 0, 400, 1)
    expect(bins.ends[0] - bins.starts[0]).toBe(GC_WINDOW_MIN)
    // Six whole `ACGT` and an `A`: twelve of twenty-five, not the 0 or 1 a
    // one-base window would have given.
    expect(bins.values[0]).toBeCloseTo(12 / 25)
  })

  it('reports a run of N as no data rather than as GC of zero', () => {
    const store = parseFasta(bytes(`>a\n${'N'.repeat(50)}${'G'.repeat(50)}\n`))
    const seq = store.bases.get('a') as Uint8Array
    const bins = gcBins(seq, 0, 100, 50)
    expect(Number.isNaN(bins.values[0])).toBe(true)
    expect(bins.values[1]).toBeCloseTo(1)
  })

  it('clips to the sequence, so the last bin is the partial one', () => {
    const store = parseFasta(bytes(`>a\n${'G'.repeat(70)}\n`))
    const seq = store.bases.get('a') as Uint8Array
    const bins = gcBins(seq, 0, 1000, 50)
    expect(Array.from(bins.ends)).toEqual([50, 70])
  })

  it('counts U as T, so an RNA is not a sequence of unknowns', () => {
    const store = parseFasta(bytes('>a\nUUUUUUUUUUUUUUUUUUUUUUUUUUGGGGGGGGGGGGGGGGGGGGGGGGGG\n'))
    const seq = store.bases.get('a') as Uint8Array
    const bins = gcBins(seq, 0, 26, 26)
    expect(bins.values[0]).toBe(0)
  })
})
