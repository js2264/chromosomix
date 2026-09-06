/**
 * A VCF through the annotations worker: what it opens as, and what it says.
 *
 * The unit tests prove the parser reads records correctly. This proves the
 * *routing* — which is where every previous format-shaped bug in this app has
 * actually lived. `sniffFormat` has no "none of mine" answer; its last line is
 * `return 'bed'`. So a format the worker does not ask about first is silently
 * parsed as a BED, which is what a four-column bedGraph did before
 * `sniffSignal` existed and what a VCF did until now: refused with *"all 7
 * lines failed the contig, start, end test that every BED-like format begins
 * with"* — a message naming a format the reader never handed over.
 *
 * Driven through `self.onmessage`, the worker's real front door, so the sniff
 * order, the dispatch and the transfer list are all in the path.
 */

// Deliberately **not** jsdom, for the reason `bam-lane.test.ts` gives: the
// worker wants `self`, `File`, `Blob` and the compression streams, and jsdom's
// `Blob` has no `.stream()`.

import { beforeAll, describe, expect, it } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { AnnotationPayload, FeatureSet } from '@/annotations/types'
import { bgzfBlock } from './bam-fixtures'
import { lengthsAreExact, type Assembly } from '@/genome/assembly'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (m: AnnotationResponse) => {
    posted.push(m)
  }
  await import('@/annotations/worker/annotations.worker')
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

const HEADER = `##fileformat=VCFv4.3
##contig=<ID=chrV,length=20000>
##INFO=<ID=AF,Number=A,Type=Float,Description="Allele Frequency">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA001\tNA002
`

const ROWS = [
  'chrV 1000 rs100 A G 60 PASS AF=0.5;DP=30 GT 0/1 1/1',
  'chrV 2000 . CTTT C 40 PASS AF=0.25 GT 0/0 0/1',
  'chrV 2500 . G GAA 35 PASS AF=0.5 GT 0/1 0/1',
  'chrV 4000 sv1 N <DEL> 99 PASS SVTYPE=DEL;END=4800 GT 0/1 0/1',
].map((row) => row.replace(/ +/g, '\t'))

const TEXT = HEADER + ROWS.join('\n') + '\n'

const MAP = [{ name: 'chrV', length: 20_000 }]

function fileOf(text: string, name = 'calls.vcf'): File {
  return new File([text], name)
}

function payloadOf(response: AnnotationResponse): { format: string; summary: string; data: FeatureSet } {
  const held = response as { payload: { format: string; summary: string; payload: AnnotationPayload } }
  expect(held.payload.payload.kind).toBe('features')
  return {
    format: held.payload.format,
    summary: held.payload.summary,
    data: (held.payload.payload as { kind: 'features'; data: FeatureSet }).data,
  }
}

describe('opening a VCF', () => {
  it('opens as a variant file rather than being refused as a broken BED', async () => {
    const response = await ask({
      kind: 'load',
      entry: 'v-open',
      source: { kind: 'local', file: fileOf(TEXT), name: 'calls.vcf' },
      mapContigs: MAP,
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const { format, data } = payloadOf(response)
    expect(format).toBe('vcf')
    expect(data.length).toBe(4)
    expect(data.contigs).toEqual(['chrV'])
  })

  it('counts the samples it is not going to draw, in the summary', async () => {
    // A VCF's genotype columns are a matrix of variants × samples and this app
    // does not draw one (§13). A reader who brought a thousand-genome file is
    // told what the lane is showing them rather than left to infer it from a
    // lane that looks complete.
    const response = await ask({
      kind: 'load',
      entry: 'v-samples',
      source: { kind: 'local', file: fileOf(TEXT), name: 'calls.vcf' },
      mapContigs: MAP,
    })
    const { summary } = payloadOf(response)
    expect(summary).toContain('4 variants')
    expect(summary).toContain('2 samples not drawn')
  })

  it('says variants, not features', async () => {
    // The word under the lane's name is the word the reader's file uses.
    const response = await ask({
      kind: 'load',
      entry: 'v-word',
      source: { kind: 'local', file: fileOf(TEXT), name: 'calls.vcf' },
      mapContigs: MAP,
    })
    expect(payloadOf(response).summary).not.toContain('feature')
  })

  it('carries the symbolic deletion at its real size, over the wire', async () => {
    // End to end, because this is the one thing that can silently lie: `<DEL>`
    // writes one `N` in REF, so without INFO/END an 800 bp deletion crosses the
    // worker boundary as a single base and draws as a tick.
    const response = await ask({
      kind: 'load',
      entry: 'v-sv',
      source: { kind: 'local', file: fileOf(TEXT), name: 'calls.vcf' },
      mapContigs: MAP,
    })
    const { data } = payloadOf(response)
    const at = data.name.indexOf('sv1')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(data.end[at] - data.start[at]).toBe(801)
  })

  it('is not confused by a name that says otherwise', async () => {
    // §8.3: the bytes decide. A VCF called `.txt` opens, and a BED called
    // `.vcf` is still a BED.
    const asTxt = await ask({
      kind: 'load',
      entry: 'v-txt',
      source: { kind: 'local', file: fileOf(TEXT, 'calls.txt'), name: 'calls.txt' },
      mapContigs: MAP,
    })
    expect(payloadOf(asTxt).format).toBe('vcf')

    const bed = 'chrV\t1000\t2000\tpeak1\t500\t+\n'.repeat(4)
    const asVcf = await ask({
      kind: 'load',
      entry: 'v-bed',
      source: { kind: 'local', file: fileOf(bed, 'peaks.vcf'), name: 'peaks.vcf' },
      mapContigs: MAP,
    })
    expect(payloadOf(asVcf).format).toBe('bed')
  })
})

describe('a VCF that has lost its header', () => {
  it('opens from the records alone, which is what the indexed road serves', async () => {
    // `spansFor` starts at the first *record*'s block, so a `.vcf.gz` with a
    // `.tbi` reaches the sniffer with every `#` line in the part of the file
    // that was deliberately not fetched. A sniffer needing the header would
    // work on the slow road and fail on the fast one.
    const response = await ask({
      kind: 'load',
      entry: 'v-bare',
      source: { kind: 'local', file: fileOf(ROWS.join('\n') + '\n'), name: 'slice.vcf' },
      mapContigs: MAP,
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    expect(payloadOf(response).format).toBe('vcf')
  })
})

describe('what genome a VCF is on', () => {
  it('answers exactly, from the lengths its header declares', async () => {
    // `##contig=<ID=,length=>` is a chrom.sizes written inside the file:
    // declared rather than inferred, the tier a BAM's `@SQ` table sits at. So a
    // dropped VCF opens a browser over its real chromosomes (§5.8), which no
    // other text feature format can do.
    const response = await ask({
      kind: 'assembly',
      source: { kind: 'local', file: fileOf(TEXT), name: 'calls.vcf' },
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const held = (response as {
      payload: { format: string; contigs: unknown[]; exact: boolean; origin: string }
    }).payload
    expect(held.format).toBe('vcf')
    expect(held.contigs).toEqual([{ name: 'chrV', length: 20_000 }])
    expect(held.exact).toBe(true)
    // …and the field the *browser* actually reads. `lengthsAreExact` is written
    // over `origin` and looks at nothing else, so a VCF reporting `features`
    // here would print "lengths inferred from the features in this file" under a
    // genome whose lengths the file states outright — while `exact: true` sat
    // beside it being correct and being ignored. That is the mistake the `bam`
    // origin exists to undo, and asserting only `exact` would let it back in.
    expect(held.origin).toBe('vcf')
    expect(lengthsAreExact({ origin: held.origin } as Assembly)).toBe(true)
  })

  it('falls back to a lower bound where the header declares none', async () => {
    // Legal and common. The lane still opens; it just reports its edges as the
    // last variant rather than claiming a precision it has not got.
    const response = await ask({
      kind: 'assembly',
      source: { kind: 'local', file: fileOf(ROWS.join('\n') + '\n'), name: 'slice.vcf' },
    })
    const held = (response as { payload: { format: string; exact: boolean; origin: string } })
      .payload
    expect(held.format).toBe('vcf')
    expect(held.exact).toBe(false)
    expect(held.origin).toBe('features')
    expect(lengthsAreExact({ origin: held.origin } as Assembly)).toBe(false)
  })
})

describe('a bgzipped VCF', () => {
  it('opens through the same road a bgzipped GTF takes', async () => {
    // No new code: `decodeAnnotationBytes` inflates by magic bytes and the text
    // reaches the same sniffers. Worth a test because the gzip path is the one
    // a reader actually has on disk — `bcftools` writes `.vcf.gz` by default.
    const block = await bgzfBlock(new TextEncoder().encode(TEXT))
    const eof = await bgzfBlock(new Uint8Array(0))
    const bytes = new Uint8Array(block.length + eof.length)
    bytes.set(block, 0)
    bytes.set(eof, block.length)
    const response = await ask({
      kind: 'load',
      entry: 'v-gz',
      source: {
        kind: 'local',
        file: new File([bytes as BlobPart], 'calls.vcf.gz'),
        name: 'calls.vcf.gz',
      },
      mapContigs: MAP,
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const { format, data } = payloadOf(response)
    expect(format).toBe('vcf')
    expect(data.length).toBe(4)
  })

  it('reads every block of one, not just the first', async () => {
    // The case the single-block test cannot see. BGZF is *concatenated* gzip
    // members — `bgzip` starts a new one roughly every 64 KiB — so any real
    // `.vcf.gz` is many of them, and a reader that stops at the first member's
    // end returns the opening blockful and calls it the file. That is a wrong
    // answer wearing the shape of a right one: the lane draws, the count looks
    // plausible, and the variants past the first block are simply absent.
    //
    // Two data blocks here rather than a 64 KiB one, because the boundary is
    // what is under test and `bgzfBlock` lets it be put anywhere.
    const half = 40
    const many = Array.from({ length: half * 2 }, (_, i) =>
      `chrV\t${1000 + i * 10}\trs${i}\tA\tG\t60\tPASS\tAF=0.5\tGT\t0/1\t1/1`,
    )
    const first = await bgzfBlock(
      new TextEncoder().encode(HEADER + many.slice(0, half).join('\n') + '\n'),
    )
    const second = await bgzfBlock(new TextEncoder().encode(many.slice(half).join('\n') + '\n'))
    const eof = await bgzfBlock(new Uint8Array(0))
    const bytes = new Uint8Array(first.length + second.length + eof.length)
    bytes.set(first, 0)
    bytes.set(second, first.length)
    bytes.set(eof, first.length + second.length)

    const response = await ask({
      kind: 'load',
      entry: 'v-gz-blocks',
      source: {
        kind: 'local',
        file: new File([bytes as BlobPart], 'many.vcf.gz'),
        name: 'many.vcf.gz',
      },
      mapContigs: MAP,
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const { data } = payloadOf(response)
    expect(data.length).toBe(half * 2)
    // The last record of the last block, so a short read cannot pass by luck.
    expect(data.start[data.length - 1]).toBe(1000 + (half * 2 - 1) * 10 - 1)
  })
})
