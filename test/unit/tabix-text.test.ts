/**
 * A tabix-served text file, cut where `bgzip` really cuts it.
 *
 * `tabix.test.ts` builds its fixture one contig per block, so every span it
 * serves happens to begin and end on a line boundary and the seam this file is
 * about cannot appear there. Real `bgzip` fills a 64 KiB buffer and flushes it
 * when it is full, without looking at what it is cutting — which is the whole
 * reason a tabix virtual offset carries a 16-bit *within-block* part at all. So
 * a span starts with the tail of whatever record the previous block ran out on,
 * and stops in the middle of another.
 *
 * These fixtures cut records in half at the block boundary deliberately, and go
 * through the worker's own front door, because the damage a fragment does is
 * done by the **sniffers**: `sniffFormat` reads a piece of a GTF attribute
 * column as its first data row and answers `bed`, and the GTF is then refused
 * by `parseBed` with a message naming a format the reader never handed over. A
 * test that only inspected the served text would not see that.
 *
 * Deliberately **not** jsdom, for the reason `bam-lane.test.ts` gives: the
 * worker wants `self`, `File`, `Blob` and the compression streams, and jsdom's
 * `Blob` has no `.stream()`.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { AnnotationPayload, FeatureSet } from '@/annotations/types'
import { bgzfBlock, concat } from './bam-fixtures'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void
let wholeLines: (text: string, atFileStart: boolean, atFileEnd: boolean) => string

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (m: AnnotationResponse) => {
    posted.push(m)
  }
  const worker = await import('@/annotations/worker/annotations.worker')
  wholeLines = worker.wholeLines
  const handler = (globalThis as unknown as { onmessage: (e: { data: AnnotationRequest }) => void })
    .onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1

type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  for (let turn = 0; turn < 4000; turn++) {
    const found = posted.find((m) => 'id' in m && m.id === id)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`no answer for request ${id}`)
}

function payloadOf(response: AnnotationResponse): { format: string; data: FeatureSet } {
  const held = response as { payload: { format: string; payload: AnnotationPayload } }
  expect(held.payload.payload.kind).toBe('features')
  return {
    format: held.payload.format,
    data: (held.payload.payload as { kind: 'features'; data: FeatureSet }).data,
  }
}

// ---------------------------------------------------------------------------
// Fixtures: a bgzipped file whose blocks break where the caller says
// ---------------------------------------------------------------------------

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A bgzipped file, and where each block begins in both coordinate systems. */
interface Bgzipped {
  bytes: Uint8Array
  /** Compressed offset of each block — the high 48 bits of a virtual offset. */
  blockAt: number[]
  /** Uncompressed offset each block starts at. */
  textAt: number[]
}

/**
 * Bgzip `text`, breaking blocks at the given **uncompressed** offsets.
 *
 * Cutting at a byte the caller chose rather than at a line is the point of this
 * whole file: it is what `bgzf_write` does to a record that straddles the
 * moment its buffer filled up. The empty member on the end is the one a
 * bgzipped file really finishes with, and the trimming rule reads it.
 */
async function bgzip(text: string, cuts: number[]): Promise<Bgzipped> {
  const data = encode(text)
  const bounds = [0, ...cuts, data.length]
  const blocks: Uint8Array[] = []
  const blockAt: number[] = []
  const textAt: number[] = []
  let at = 0
  for (let i = 0; i + 1 < bounds.length; i++) {
    const block = await bgzfBlock(data.subarray(bounds[i], bounds[i + 1]))
    blockAt.push(at)
    textAt.push(bounds[i])
    at += block.length
    blocks.push(block)
  }
  blocks.push(await bgzfBlock(new Uint8Array(0)))
  return { bytes: concat(blocks), blockAt, textAt }
}

/** The virtual offset of an uncompressed position: block start, then the rest. */
function virtualAt(file: Bgzipped, position: number): bigint {
  let block = 0
  while (block + 1 < file.textAt.length && file.textAt[block + 1] <= position) block++
  return (BigInt(file.blockAt[block]) << 16n) | BigInt(position - file.textAt[block])
}

/** Where each contig's records begin and end in the uncompressed text. */
function runsIn(text: string): Array<{ name: string; from: number; to: number }> {
  const runs: Array<{ name: string; from: number; to: number }> = []
  let at = 0
  while (at < text.length) {
    let end = text.indexOf('\n', at)
    if (end < 0) end = text.length
    const line = text.slice(at, end)
    const tab = line.indexOf('\t')
    if (line !== '' && !line.startsWith('#') && tab > 0) {
      const name = line.slice(0, tab)
      const last = runs[runs.length - 1]
      // `to` is the last byte of the last record, which is what decides the
      // block the span stops in.
      if (last !== undefined && last.name === name) last.to = end
      else runs.push({ name, from: at, to: end })
    }
    at = end + 1
  }
  return runs
}

/**
 * A `.tbi` body — the inflated one — with one bin and one chunk per sequence.
 *
 * Only the fields the reader consults carry meaning; the rest are written at
 * their documented defaults so the layout is the real one. The same shape
 * `tabix.test.ts` builds, taking whole virtual offsets rather than block starts
 * because the within-block half is exactly what this file is about.
 */
function tabixBody(refs: Array<{ name: string; from: bigint; to: bigint }>): Uint8Array {
  const names = refs.map((ref) => ref.name).join('\0') + '\0'
  const nameBytes = encode(names)
  const out = new Uint8Array(36 + nameBytes.length + refs.length * (4 + 4 + 4 + 16 + 4))
  const view = new DataView(out.buffer)
  out.set([0x54, 0x42, 0x49, 1], 0) // 'TBI\1'
  view.setInt32(4, refs.length, true)
  view.setInt32(8, 0, true) // format: generic
  view.setInt32(12, 1, true) // col_seq
  view.setInt32(16, 2, true) // col_beg
  view.setInt32(20, 3, true) // col_end
  view.setInt32(24, '#'.charCodeAt(0), true)
  view.setInt32(28, 0, true) // skip
  view.setInt32(32, nameBytes.length, true)
  out.set(nameBytes, 36)
  let at = 36 + nameBytes.length
  for (const ref of refs) {
    view.setInt32(at, 1, true) // one bin
    at += 4
    view.setUint32(at, 4681, true) // bin number; never read
    at += 4
    view.setInt32(at, 1, true) // one chunk in it
    at += 4
    view.setBigUint64(at, ref.from, true)
    view.setBigUint64(at + 8, ref.to, true)
    at += 16
    view.setInt32(at, 0, true) // no linear index
    at += 4
  }
  return out
}

/** The pair of files a reader drops: the bgzipped text and its `.tbi`. */
async function pairOf(
  text: string,
  cuts: number[],
  name: string,
): Promise<{ file: File; index: File }> {
  const file = await bgzip(text, cuts)
  const refs = runsIn(text).map((run) => ({
    name: run.name,
    from: virtualAt(file, run.from),
    to: virtualAt(file, run.to),
  }))
  const index = concat([await bgzfBlock(tabixBody(refs)), await bgzfBlock(new Uint8Array(0))])
  return {
    file: new File([file.bytes as BlobPart], name),
    index: new File([index as BlobPart], `${name}.tbi`),
  }
}

/** Load one through the worker, over a map of just the contigs named. */
async function open(
  text: string,
  cuts: number[],
  name: string,
  mapContigs: string[],
): Promise<AnnotationResponse> {
  const { file, index } = await pairOf(text, cuts, name)
  return ask({
    kind: 'load',
    entry: name,
    source: { kind: 'local', file, name, index },
    mapContigs: mapContigs.map((contig) => ({ name: contig, length: 200_000 })),
  })
}

const gtfRow = (contig: string, i: number): string =>
  [
    contig,
    'sgd',
    'gene',
    `${i * 1000 + 1}`,
    `${i * 1000 + 600}`,
    '.',
    '+',
    '.',
    `gene_id "${contig}g${i}"; gene_name "${contig.toUpperCase()}-${i}";`,
  ].join('\t')

const vcfRow = (contig: string, i: number): string =>
  [contig, `${i * 1000 + 100}`, `rs${i}`, 'A', 'G', '60', 'PASS', `DP=11;AF=0.${i % 9}5`].join('\t')

const bedRow = (contig: string, i: number): string =>
  [contig, `${i * 1000}`, `${i * 1000 + 500}`, `${contig}-${i}`, `${10 + i}`, '+'].join('\t')

const rows = (write: (contig: string, i: number) => string, contig: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => write(contig, i))

/** Contig names, in the order the set holds them. */
const contigsOf = (data: FeatureSet): string[] => data.contigs

/** One feature's contig, start and end, for the whole set. */
function spansOf(data: FeatureSet): Array<[string, number, number]> {
  return Array.from({ length: data.length }, (_, i) => [
    data.contigs[data.contig[i]],
    data.start[i],
    data.end[i],
  ])
}

describe('a span that begins and ends inside a record', () => {
  it('opens an indexed GTF as a GTF rather than refusing it as a broken BED', async () => {
    // The finding, in one file. The block holding chrB's first record opens
    // fourteen bytes into the tail of chrA's last attribute column, and that
    // fragment has no tab in it: `sniffFormat` sees a two-column first row,
    // finds no integers where a GTF keeps them, and falls through to its last
    // line, `return 'bed'`. `parseGtf` is then never asked.
    const text =
      [...rows(gtfRow, 'chrA', 30), ...rows(gtfRow, 'chrB', 15), ...rows(gtfRow, 'chrC', 15)].join(
        '\n',
      ) + '\n'
    const cuts = [text.indexOf('chrB\t') - 14, text.indexOf(gtfRow('chrC', 5)) + 20]
    const response = await open(text, cuts, 'genes.gtf.gz', ['chrB'])

    expect(response.type, JSON.stringify(response)).toBe('result')
    const { format, data } = payloadOf(response)
    expect(format).toBe('gtf')
    // Every record of the contig asked for, at its own coordinates — GTF is
    // 1-based and inclusive, so row 0 is 1..600 and lands at 0..600 here.
    expect(contigsOf(data)).toEqual(['chrB', 'chrC'])
    expect(spansOf(data).filter(([contig]) => contig === 'chrB').length).toBe(15)
    expect(spansOf(data)).toContainEqual(['chrB', 0, 600])
    expect(spansOf(data)).toContainEqual(['chrB', 14_000, 14_600])
    // The five whole chrC rows inside the same block are slack the decode was
    // always going to hand back; the sixth, which the block cut in half, is not
    // a record and must not appear.
    expect(spansOf(data).filter(([contig]) => contig === 'chrC').length).toBe(5)
  })

  it('opens an indexed VCF from its records, with the header never fetched', async () => {
    // §8.14's shape road, which is the *only* road on this path: every `#` line
    // is in the part of the file the index deliberately did not ask for. One
    // fragment in front of the first whole record is enough for `sniffVcf` to
    // answer `false` — `looksLikeUnheadedRecord` fails on it — and the file is
    // refused with the same BED message the GTF got.
    const header = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n'
    const text =
      header +
      [...rows(vcfRow, 'chrA', 30), ...rows(vcfRow, 'chrB', 15), ...rows(vcfRow, 'chrC', 15)].join(
        '\n',
      ) +
      '\n'
    const cuts = [text.indexOf('chrB\t') - 7, text.indexOf(vcfRow('chrC', 5)) + 12]
    const response = await open(text, cuts, 'calls.vcf.gz', ['chrB'])

    expect(response.type, JSON.stringify(response)).toBe('result')
    const { format, data } = payloadOf(response)
    expect(format).toBe('vcf')
    expect(contigsOf(data)).toEqual(['chrB', 'chrC'])
    expect(spansOf(data).filter(([contig]) => contig === 'chrB').length).toBe(15)
  })

  it('draws no feature the file does not contain, at either seam', async () => {
    // A BED survives the sniffer — its truncated first row still has integers
    // in the right columns — so this is the *silent* half of the finding. The
    // leading fragment `A\t29000\t…` is a feature on a contig called "A" that
    // exists nowhere, and the trailing `chrC\t5000\t55` is a real record cut
    // mid-coordinate, which `FeatureBuilder.add` orders into a 4.9 kb box drawn
    // where nothing exists.
    const text =
      [...rows(bedRow, 'chrA', 30), ...rows(bedRow, 'chrB', 15), ...rows(bedRow, 'chrC', 15)].join(
        '\n',
      ) + '\n'
    const cuts = [text.indexOf('chrA\t29000') + 3, text.indexOf('chrC\t5000\t55') + 12]
    const response = await open(text, cuts, 'peaks.bed.gz', ['chrB'])

    expect(response.type, JSON.stringify(response)).toBe('result')
    const { data } = payloadOf(response)
    expect(contigsOf(data)).toEqual(['chrB', 'chrC'])
    for (const [contig, start, end] of spansOf(data)) {
      expect(end - start, `${contig} ${start}-${end}`).toBe(500)
    }
    expect(spansOf(data)).not.toContainEqual(['chrC', 55, 5000])
  })
})

describe('the two edges the trimming must not cut', () => {
  it('keeps the last line of a file that ends without a newline', async () => {
    // The index is only allowed to make the same file cheaper (§3.4), never to
    // change what it says, so the final record of a file whose last line is
    // unterminated has to survive the road that trims fragments. Its span is
    // the one that really does end where the file's data ends.
    const text = [...rows(bedRow, 'chrA', 30), ...rows(bedRow, 'chrB', 15)].join('\n')
    const cuts = [text.indexOf('chrA\t29000') + 3]
    const response = await open(text, cuts, 'tail.bed.gz', ['chrB'])

    expect(response.type, JSON.stringify(response)).toBe('result')
    const { data } = payloadOf(response)
    // No phantom contig from the leading fragment…
    expect(contigsOf(data)).toEqual(['chrB'])
    // …and the unterminated last record still there.
    expect(data.length).toBe(15)
    expect(spansOf(data)).toContainEqual(['chrB', 14_000, 14_500])
  })

  it('keeps the first line of a span that starts at byte 0', () => {
    // A file's first span begins at a real line start, and for a VCF or a
    // headed TSV that first line is the one the sniffers most need. Asserted on
    // the rule itself because the byte-0 case cannot be reached through a
    // fixture-sized file: `spansFor` adds a block's slack to every span, so on
    // anything under 64 KiB a span from byte 0 reads the whole file and the 80%
    // guard sends it down the whole-file road instead.
    const text = '##fileformat=VCFv4.3\nchr1\t100\t.\tA\tG\n'
    expect(wholeLines(text, true, true)).toBe(text)
    expect(wholeLines(text, false, true)).toBe('chr1\t100\t.\tA\tG\n')
  })

  it('drops a part with no line boundary in it at all', () => {
    // A span shorter than one record holds no whole record: what it has is the
    // middle of one that began before it, and the answer is nothing rather than
    // a fragment.
    expect(wholeLines('0\tPASS\tDP=11', false, false)).toBe('')
    expect(wholeLines('0\tPASS\tDP=11', false, true)).toBe('')
    // …but at byte 0 of a file that has no newline anywhere, that one line is
    // the file.
    expect(wholeLines('chr1\t1\t2', true, true)).toBe('chr1\t1\t2')
  })

  it('trims a fragment at the end of a span that only the fetch reached the end on', () => {
    // The subtle one, and why the rule cannot be `span.to < size`. The fetch
    // over-asks by a block, so on any file whose last wanted record sits within
    // 64 KiB of the end the fetch reaches EOF while the *decode* stops several
    // blocks short — and the text still ends mid-record.
    expect(wholeLines('chrB\t1\t2\nchrC\t3000\t30', false, false)).toBe('')
    expect(wholeLines('a\nchrB\t1\t2\nchrC\t3000\t30', false, false)).toBe('chrB\t1\t2\n')
  })
})
