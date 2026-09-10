/**
 * The bigWig this app writes, read back by the reader this app ships.
 *
 * A writer nobody reads back is a writer that is wrong (§18.7), so every
 * assertion here goes out through `writeBigWig` and comes back in through
 * `@gmod/bbi` — the same parser that draws a loaded track — rather than
 * inspecting bytes this file also wrote. What is checked is the small set of
 * things a careless BBI writer gets wrong in a way that nobody notices until the
 * file is already in somebody else's browser: a gap that comes back as a number,
 * a final interval that runs off the end of the sequence, a summary that
 * disagrees with the data under it, a chromosome tree that only works while the
 * assembly is small, and an export that is not the same twice.
 */

import { describe, expect, it } from 'vitest'

import { BigWig } from '@gmod/bbi'
import { BlobFile } from 'generic-filehandle2'

import { bigWigBytesEstimate, writeBigWig } from '@/analysis/write/bigwig'
import type { BigWigBins, BigWigContig } from '@/analysis/write/bigwig'
import { planTree } from '@/analysis/write/tree'

/**
 * Four contigs chosen to hit every case the contract names at once, and
 * deliberately **not** in name order — `chrZ` is listed first — so that a writer
 * that confused the caller's order with the file's contig ids would put every
 * value on the wrong sequence.
 */
const CONTIGS: BigWigContig[] = [
  { name: 'chrZ', length: 10_000 },
  { name: 'chrM', length: 7_500 },
  { name: 'chrA', length: 3_000 },
  { name: 'chrB', length: 2_000_000 },
]

const BINSIZE = 1000

/** Bins per contig, in the caller's order, which is what `firstBin` counts. */
const BIN_COUNTS = CONTIGS.map((contig) => Math.ceil(contig.length / BINSIZE))
const TOTAL_BINS = BIN_COUNTS.reduce((sum, count) => sum + count, 0)

/** Absolute bin index of each contig's first bin. */
const BIN_OFFSETS = BIN_COUNTS.map((_, i) =>
  BIN_COUNTS.slice(0, i).reduce((sum, count) => sum + count, 0),
)

/**
 * A vector with a hole in the middle of a contig, a contig that is entirely
 * hole, negative values, and enough bins on `chrB` to need more than one
 * section.
 */
function buildValues(): Float32Array {
  const values = new Float32Array(TOTAL_BINS)
  values.fill(NaN)
  const set = (contig: number, bin: number, value: number): void => {
    values[BIN_OFFSETS[contig] + bin] = value
  }
  // chrZ: ten bins, with bins 3, 4 and 5 left as NaN and several values below
  // zero — a log-ratio track looks like this.
  for (let bin = 0; bin < 10; bin += 1) {
    if (bin >= 3 && bin <= 5) continue
    set(0, bin, bin - 4.5)
  }
  // chrM: every bin, so the partial last one (7000-7500) is definitely written.
  for (let bin = 0; bin < 8; bin += 1) set(1, bin, 1 + bin / 8)
  // chrA: nothing at all.
  // chrB: two thousand bins, past the 1024 items a section holds, with a second
  // gap inside so the multi-section path meets one too.
  for (let bin = 0; bin < 2000; bin += 1) {
    if (bin >= 1000 && bin < 1005) continue
    set(3, bin, Math.sin(bin / 25) * 10)
  }
  return values
}

const INPUT: BigWigBins = {
  contigs: CONTIGS,
  values: buildValues(),
  firstBin: 0,
  binsize: BINSIZE,
}

/** What the file should contain, worked out independently of the writer. */
interface Expected {
  start: number
  end: number
  value: number
}

function expectedFor(input: BigWigBins, name: string): Expected[] {
  const index = input.contigs.findIndex((contig) => contig.name === name)
  const contig = input.contigs[index]
  const offset = input.contigs
    .slice(0, index)
    .reduce((sum, other) => sum + Math.ceil(other.length / input.binsize), 0)
  const out: Expected[] = []
  for (let bin = 0; bin < Math.ceil(contig.length / input.binsize); bin += 1) {
    const at = offset + bin - input.firstBin
    if (at < 0 || at >= input.values.length) continue
    const value = input.values[at]
    if (Number.isNaN(value)) continue
    const start = bin * input.binsize
    out.push({ start, end: Math.min(start + input.binsize, contig.length), value })
  }
  return out
}

/** Open a written blob with the app's own reader. */
function open(blob: Blob): BigWig {
  return new BigWig({ filehandle: new BlobFile(blob) })
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Walk the chromosome B+ tree in the bytes, returning every internal node's
 * declared key beside the first key actually in the subtree it points at.
 *
 * Read directly rather than through `@gmod/bbi`, and that is the whole point of
 * it existing. `_readChromosomeTree` advances past an internal key without
 * looking at it and then recurses into *every* child; libBigWig walks the whole
 * tree eagerly too. So both JS and C readers here find every contig whatever the
 * internal keys say — and a writer that got them wrong would sail through a
 * round-trip test while producing a file the UCSC tools, which binary-search on
 * those keys, cannot navigate. That failure is invisible from inside this repo,
 * which is exactly why it is asserted on the bytes.
 */
function bptInternalKeys(bytes: Uint8Array): Array<{ declared: string; actual: string }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const treeAt = Number(view.getBigUint64(8, true))
  const keySize = view.getUint32(treeAt + 8, true)
  const decoder = new TextDecoder()

  const keyAt = (at: number): string =>
    decoder.decode(bytes.subarray(at, at + keySize)).replace(/\0+$/, '')

  /** The first key in the subtree rooted at `nodeAt`, descending leftmost. */
  const firstKeyUnder = (nodeAt: number): string => {
    const isLeaf = view.getUint8(nodeAt) === 1
    if (isLeaf) return keyAt(nodeAt + 4)
    return firstKeyUnder(Number(view.getBigUint64(nodeAt + 4 + keySize, true)))
  }

  const out: Array<{ declared: string; actual: string }> = []
  const visit = (nodeAt: number): void => {
    const isLeaf = view.getUint8(nodeAt) === 1
    const count = view.getUint16(nodeAt + 2, true)
    if (isLeaf) return
    for (let i = 0; i < count; i += 1) {
      const at = nodeAt + 4 + i * (keySize + 8)
      const child = Number(view.getBigUint64(at + keySize, true))
      out.push({ declared: keyAt(at), actual: firstKeyUnder(child) })
      visit(child)
    }
  }
  visit(treeAt + 32)
  return out
}

describe('planTree', () => {
  it('is a single leaf for a small assembly and several levels for a metagenome', () => {
    const shape = { fanOut: 256, leafItemBytes: 24, internalItemBytes: 24, rootOffset: 100 }
    expect(planTree(16, shape).depth).toBe(1)
    expect(planTree(256, shape).depth).toBe(1)
    // The case the builder exists for: 20,000 contigs need 79 leaves under a
    // root, which a writer that emits one fat leaf would get wrong silently.
    const big = planTree(20_000, shape)
    expect(big.depth).toBe(2)
    expect(big.nodes.filter((node) => node.isLeaf).length).toBe(Math.ceil(20_000 / 256))
    expect(big.nodes[0].isLeaf).toBe(false)
    expect(big.nodes[0].children.length).toBe(Math.ceil(20_000 / 256))
  })

  it('places the root first and packs every node without overlap or gap', () => {
    const shape = { fanOut: 4, leafItemBytes: 10, internalItemBytes: 6, rootOffset: 64 }
    const plan = planTree(30, shape)
    expect(plan.nodes[0].offset).toBe(64)
    let cursor = 64
    for (const node of plan.nodes) {
      expect(node.offset).toBe(cursor)
      const items = node.isLeaf ? node.leafCount : node.children.length
      cursor += 4 + items * (node.isLeaf ? 10 : 6)
    }
    expect(cursor - 64).toBe(plan.bytes)
    // Every leaf is accounted for exactly once, in order.
    const leaves = plan.nodes.filter((node) => node.isLeaf)
    let next = 0
    for (const leaf of leaves) {
      expect(leaf.leafFirst).toBe(next)
      next += leaf.leafCount
    }
    expect(next).toBe(30)
  })

  it('still yields a root when there is nothing to index', () => {
    const plan = planTree(0, {
      fanOut: 256,
      leafItemBytes: 32,
      internalItemBytes: 24,
      rootOffset: 8,
    })
    expect(plan.nodes.length).toBe(1)
    expect(plan.nodes[0].isLeaf).toBe(true)
    expect(plan.nodes[0].leafCount).toBe(0)
  })
})

describe('writeBigWig', () => {
  it('names every contig with its true length, however the caller ordered them', async () => {
    const header = await open(await writeBigWig(INPUT)).getHeader()
    expect(header.fileType).toBe('bigwig')
    expect(header.version).toBe(4)
    for (const contig of CONTIGS) {
      const id = header.refsByName[contig.name]
      expect(id).toBeTypeOf('number')
      expect(header.refsByNumber[id].length).toBe(contig.length)
    }
    // Ids follow name order, not the caller's, which is what every UCSC-written
    // file does and what a binary-searching B+ tree needs.
    expect(header.refsByName.chrA).toBe(0)
    expect(header.refsByName.chrB).toBe(1)
    expect(header.refsByName.chrM).toBe(2)
    expect(header.refsByName.chrZ).toBe(3)
  })

  it('gives every value back exactly, at the bin bounds it was written with', async () => {
    const file = open(await writeBigWig(INPUT))
    for (const name of ['chrZ', 'chrM', 'chrB']) {
      const contig = CONTIGS.find((c) => c.name === name)!
      const features = await file.getFeatures(name, 0, contig.length)
      const wanted = expectedFor(INPUT, name)
      expect(features.length).toBe(wanted.length)
      features.forEach((feature, i) => {
        expect(feature.start).toBe(wanted[i].start)
        expect(feature.end).toBe(wanted[i].end)
        // Exact float32 equality: the value is stored as the float32 it already
        // was, so anything but equality means the writer changed it.
        expect(feature.score).toBe(wanted[i].value)
      })
    }
  })

  it('omits a gap rather than writing NaN into it', async () => {
    const file = open(await writeBigWig(INPUT))
    // chrZ bins 3, 4 and 5 had no value. A fixedStep section would have had to
    // put *something* there and every downstream tool would read it as data.
    expect(await file.getFeatures('chrZ', 3000, 6000)).toEqual([])
    expect(await file.getFeatures('chrB', 1_000_000, 1_005_000)).toEqual([])
    // The bins either side of the hole are still there, so the hole is a hole
    // and not a truncation.
    const before = await file.getFeatures('chrZ', 2000, 3000)
    const after = await file.getFeatures('chrZ', 6000, 7000)
    expect(before.length).toBe(1)
    expect(after.length).toBe(1)
  })

  it('omits an infinity, rather than writing a file whose summary is poisoned', async () => {
    // A regression, and the failure it guards is the nastiest kind: the file
    // opened cleanly in every reader and only its *header* was wrong. With
    // `intervalsFor` filtering `NaN` alone, a single infinite bin gave
    // min -Infinity, max +Infinity, sumData NaN — so every autoscale and every
    // mean over the file was destroyed while the intervals themselves read back
    // perfectly. With only +Infinity present it was not even visibly broken,
    // because `min` stayed finite.
    const blob = await writeBigWig({
      contigs: [{ name: 'inf', length: 5000 }],
      values: Float32Array.from([1, Number.POSITIVE_INFINITY, 3, Number.NEGATIVE_INFINITY, 5]),
      firstBin: 0,
      binsize: 1000,
    })
    const file = open(blob)
    const { totalSummary } = await file.getHeader()

    expect(totalSummary.scoreMin).toBe(1)
    expect(totalSummary.scoreMax).toBe(5)
    // Three finite bins of a thousand bases each, and the sums weighted by span.
    expect(totalSummary.basesCovered).toBe(3000)
    expect(totalSummary.scoreSum).toBe(9000)
    expect(Number.isFinite(totalSummary.scoreSumSquares)).toBe(true)

    // And the infinite bins are holes, exactly as NaN bins are — the two are
    // one rule, because a bedGraph written beside this must agree cell for cell.
    expect(await file.getFeatures('inf', 1000, 2000)).toEqual([])
    expect(await file.getFeatures('inf', 3000, 4000)).toEqual([])
    expect((await file.getFeatures('inf', 0, 5000)).map((f) => f.score)).toEqual([1, 3, 5])
  })

  it('ends the last interval of a contig at the contig, not past it', async () => {
    const file = open(await writeBigWig(INPUT))
    // chrM is 7,500 bases at a 1 kb bin size, so its last bin is half a bin.
    const features = await file.getFeatures('chrM', 0, 7500)
    const last = features[features.length - 1]
    expect(last.start).toBe(7000)
    expect(last.end).toBe(7500)
    for (const feature of features) expect(feature.end).toBeLessThanOrEqual(7500)
  })

  it('says nothing at all about a contig with no data', async () => {
    const file = open(await writeBigWig(INPUT))
    expect(await file.getFeatures('chrA', 0, 3000)).toEqual([])
    // It is still in the header, because the assembly has it whether this track
    // covers it or not.
    const header = await file.getHeader()
    expect(header.refsByName.chrA).toBeTypeOf('number')
  })

  it('needs more than one section, and joins them without a seam', async () => {
    const file = open(await writeBigWig(INPUT))
    const wanted = expectedFor(INPUT, 'chrB')
    // 1,995 items at 1,024 to a section is two sections; a query straddling the
    // boundary has to return both halves in order.
    expect(wanted.length).toBeGreaterThan(1024)
    const across = await file.getFeatures('chrB', 1_020_000, 1_030_000)
    expect(across.length).toBe(10)
    for (let i = 1; i < across.length; i += 1) {
      expect(across[i].start).toBe(across[i - 1].end)
    }
  })

  it('carries a total summary that matches the data underneath it', async () => {
    const { totalSummary } = await open(await writeBigWig(INPUT)).getHeader()
    let bases = 0
    let sum = 0
    let sumSquares = 0
    let min = Infinity
    let max = -Infinity
    // Name order, which is the order the writer accumulates in, so the sums are
    // comparable to the last bit rather than merely close.
    for (const name of ['chrA', 'chrB', 'chrM', 'chrZ']) {
      for (const item of expectedFor(INPUT, name)) {
        const span = item.end - item.start
        bases += span
        sum += item.value * span
        sumSquares += item.value * item.value * span
        min = Math.min(min, item.value)
        max = Math.max(max, item.value)
      }
    }
    // `validCount` counts bases covered, not items — verified against the real
    // bigWigs in demo/yeast/ before this writer was written.
    expect(totalSummary.basesCovered).toBe(bases)
    expect(totalSummary.scoreMin).toBe(min)
    expect(totalSummary.scoreMax).toBe(max)
    expect(totalSummary.scoreSum).toBeCloseTo(sum, 6)
    expect(totalSummary.scoreSumSquares).toBeCloseTo(sumSquares, 4)
    // The gap really is missing from the total, rather than counted as zero.
    expect(bases).toBeLessThan(TOTAL_BINS * BINSIZE)
  })

  it('carries a zoom ladder a reader can actually use', async () => {
    const blob = await writeBigWig(INPUT)
    const file = open(blob)
    const { zoomLevels } = await file.getHeader()
    expect(zoomLevels.length).toBeGreaterThan(0)
    // Ten times the bin size for the first reduction, then four times a level,
    // and ascending — which is the order the reader's level picker assumes.
    expect(zoomLevels[0].reductionLevel).toBe(BINSIZE * 10)
    for (let i = 1; i < zoomLevels.length; i += 1) {
      expect(zoomLevels[i].reductionLevel).toBe(zoomLevels[i - 1].reductionLevel * 4)
    }

    const summaries = await file.getFeatures('chrB', 0, 2_000_000, { basesPerSpan: 100_000 })
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries.every((feature) => feature.summary === true)).toBe(true)
    for (const feature of summaries) {
      expect(feature.start).toBeGreaterThanOrEqual(0)
      expect(feature.end).toBeLessThanOrEqual(2_000_000)
      expect(feature.end).toBeGreaterThan(feature.start)
      expect(feature.minScore!).toBeLessThanOrEqual(feature.score!)
      expect(feature.maxScore!).toBeGreaterThanOrEqual(feature.score!)
      expect(feature.minScore!).toBeGreaterThanOrEqual(-10.001)
      expect(feature.maxScore!).toBeLessThanOrEqual(10.001)
    }
    // A window over the hole in chrB is summarised from the bins that do exist,
    // so the zoom level inherits the omission rather than averaging in a zero.
    const overGap = await file.getFeatures('chrB', 1_000_000, 1_005_000, {
      basesPerSpan: 100_000,
    })
    expect(overGap.every((feature) => Number.isFinite(feature.score!))).toBe(true)
  })

  it('reads back the same whichever slice of the genome the vector covers', async () => {
    // The same chrM values, handed over as a window of the genome-wide grid
    // rather than the whole of it.
    const firstBin = BIN_OFFSETS[1]
    const window: BigWigBins = {
      contigs: CONTIGS,
      values: INPUT.values.slice(firstBin, firstBin + BIN_COUNTS[1]),
      firstBin,
      binsize: BINSIZE,
    }
    const file = open(await writeBigWig(window))
    const features = await file.getFeatures('chrM', 0, 7500)
    const wanted = expectedFor(INPUT, 'chrM')
    expect(features.length).toBe(wanted.length)
    features.forEach((feature, i) => {
      expect(feature.start).toBe(wanted[i].start)
      expect(feature.score).toBe(wanted[i].value)
    })
    // Nothing leaked onto the neighbouring contigs.
    expect(await file.getFeatures('chrZ', 0, 10_000)).toEqual([])
    expect(await file.getFeatures('chrB', 0, 2_000_000)).toEqual([])
  })

  it('refuses a vector that runs off the end of the assembly', async () => {
    await expect(
      writeBigWig({ ...INPUT, values: new Float32Array(TOTAL_BINS + 1) }),
    ).rejects.toThrow(/bins/)
  })

  it('writes a genuinely multi-level chromosome tree', async () => {
    // Past the 256-item fan-out, so the tree has to grow a root above its
    // leaves. This is the metagenome case in miniature.
    const many: BigWigContig[] = Array.from({ length: 600 }, (_, i) => ({
      name: `ctg${String(i).padStart(4, '0')}`,
      length: 500,
    }))
    const values = new Float32Array(600 * 5)
    for (let i = 0; i < values.length; i += 1) values[i] = i % 7 === 0 ? NaN : i / 100
    const file = open(await writeBigWig({ contigs: many, values, firstBin: 0, binsize: 100 }))
    const header = await file.getHeader()
    expect(Object.keys(header.refsByName).length).toBe(600)
    expect(header.refsByName.ctg0000).toBe(0)
    expect(header.refsByName.ctg0599).toBe(599)
    // A leaf that a single-node tree would have lost: contig 400 sits in the
    // second leaf of the tree, reachable only through the root.
    const features = await file.getFeatures('ctg0400', 0, 500)
    expect(features.length).toBeGreaterThan(0)
    expect(features[features.length - 1].end).toBe(500)
  })

  it('gives every internal tree node the first key of the subtree beneath it', async () => {
    // Everything above this line goes through a reader that never *looks* at an
    // internal key — `@gmod/bbi` steps over it and recurses into every child,
    // and libBigWig walks the tree eagerly too. So the multi-level test passes
    // on key correctness by accident, and a writer that filled those keys with
    // rubbish would produce a file that reads perfectly here and cannot be
    // navigated by the UCSC tools, which binary-search on exactly those bytes.
    //
    // Three levels, so the check has internal nodes pointing at internal nodes
    // rather than only at leaves — the case a two-level tree cannot exercise.
    const many: BigWigContig[] = Array.from({ length: 70_000 }, (_, i) => ({
      name: `c${String(i).padStart(6, '0')}`,
      length: 100,
    }))
    // Almost every bin left as NaN. The subject here is the *assembly* tree, and
    // giving 70,000 contigs a value each would mean 70,000 sections and an
    // R-tree to match — fifteen seconds of work to test something that does not
    // depend on any of it.
    const values = new Float32Array(70_000).fill(NaN)
    values[0] = 1
    values[35_000] = 2
    values[69_999] = 3
    const bytes = await bytesOf(
      await writeBigWig({ contigs: many, values, firstBin: 0, binsize: 100 }),
    )

    const keys = bptInternalKeys(bytes)
    expect(keys.length).toBeGreaterThan(256)
    for (const { declared, actual } of keys) expect(declared).toBe(actual)
    // And the very first key of the whole tree is the collating-first contig,
    // which is what a binary search starts from.
    expect(keys[0].declared).toBe('c000000')
  })

  it('stops the zoom ladder when a level stops reducing', async () => {
    // Four hundred contigs shorter than the first reduction: a zoom window never
    // spans a contig, so every level from here down holds exactly one record per
    // contig. A ladder that only watched the record count against the tree
    // fan-out would write ten identical levels and overflow the u32
    // `reductionLevel` on the way.
    const many: BigWigContig[] = Array.from({ length: 400 }, (_, i) => ({
      name: `ctg${String(i).padStart(3, '0')}`,
      length: 30_000,
    }))
    const values = new Float32Array(400 * 6)
    for (let i = 0; i < values.length; i += 1) values[i] = i % 100
    const file = open(await writeBigWig({ contigs: many, values, firstBin: 0, binsize: 5000 }))
    const { zoomLevels } = await file.getHeader()
    expect(zoomLevels.length).toBe(1)
    expect(zoomLevels[0].reductionLevel).toBe(50_000)
  })

  it('falls back to an uncompressed but legal file with no CompressionStream', async () => {
    // The same fallback the PDF writer takes. Worth a test rather than a
    // comment, because it is the path that only ever runs on somebody else's
    // browser and would otherwise be discovered by them.
    const scope = globalThis as { CompressionStream?: typeof CompressionStream }
    const held = scope.CompressionStream
    delete scope.CompressionStream
    let blob: Blob
    try {
      blob = await writeBigWig(INPUT)
    } finally {
      scope.CompressionStream = held
    }
    const file = open(blob)
    // Zero is what tells a reader the sections are stored as they are.
    expect((await file.getHeader()).uncompressBufSize).toBe(0)
    const features = await file.getFeatures('chrZ', 0, 10_000)
    const wanted = expectedFor(INPUT, 'chrZ')
    expect(features.length).toBe(wanted.length)
    features.forEach((feature, i) => {
      expect(feature.start).toBe(wanted[i].start)
      expect(feature.score).toBe(wanted[i].value)
    })
    expect(await file.getFeatures('chrZ', 3000, 6000)).toEqual([])
    // Larger than the deflated file, which is the whole cost of the fallback.
    expect(blob.size).toBeGreaterThan((await writeBigWig(INPUT)).size)
  })

  it('is byte-identical across two writes of the same input', async () => {
    const [first, second] = await Promise.all([writeBigWig(INPUT), writeBigWig(INPUT)])
    const a = await bytesOf(first)
    const b = await bytesOf(second)
    expect(a.length).toBe(b.length)
    expect(a).toEqual(b)
  })
})

/**
 * The second road in: intervals, on no grid.
 *
 * Every analysis output is a measurement per bin and takes the road above. A
 * *comparison of two loaded tracks* is not: it is exact at every base, cut at
 * each boundary of either operand, and forcing it onto the contact map's grid to
 * write it was throwing that away — a ratio of two 10 bp tracks looked at on a
 * 20 kb map came back as a 20 kb file. Nothing about BBI required it; decision 1
 * at the top of `write/bigwig.ts` is precisely that a section holds arbitrary
 * intervals, and the grid was an assumption in the caller.
 *
 * So what is checked here is that the two roads meet: the same sections, the
 * same trees, the same summary, the same clamping at the end of a sequence, the
 * same silence about a value that is not finite — and the intervals written
 * exactly as they were handed over.
 */
describe('writeBigWig over spans', () => {
  const SPAN_CONTIGS: BigWigContig[] = [
    { name: 'chrB', length: 1_000 },
    { name: 'chrA', length: 250 },
  ]

  /** Irregular on purpose: nothing here is a multiple of anything. */
  const SPANS = [
    {
      contig: 'chrA',
      starts: Int32Array.from([0, 37, 90]),
      ends: Int32Array.from([37, 90, 300]),
      values: Float32Array.from([1.5, -2.25, 4]),
    },
    {
      contig: 'chrB',
      starts: Int32Array.from([10, 11, 500]),
      ends: Int32Array.from([11, 12, 1_000]),
      values: Float32Array.from([9, Number.NaN, 0.5]),
    },
  ]

  async function readBack(name: string, length: number): Promise<Array<[number, number, number]>> {
    const file = open(await writeBigWig({ contigs: SPAN_CONTIGS, spans: SPANS }))
    await file.getHeader()
    const features = await file.getFeatures(name, 0, length, { scale: 1 })
    return features
      .map((feature): [number, number, number] => [
        feature.start,
        feature.end,
        feature.score ?? NaN,
      ])
      .sort((one, two) => one[0] - two[0])
  }

  it('writes the intervals it was given, at their own boundaries', async () => {
    expect(await readBack('chrA', 250)).toEqual([
      [0, 37, 1.5],
      [37, 90, -2.25],
      // …and the last one clamped to the sequence, exactly as a short final bin
      // is on the other road: 90–300 was asked for and chrA is 250 long.
      [90, 250, 4],
    ])
  })

  it('omits a value that is not finite, as the bin road does', async () => {
    expect(await readBack('chrB', 1_000)).toEqual([
      [10, 11, 9],
      [500, 1_000, 0.5],
    ])
  })

  it('numbers contigs by name, whatever order the caller listed them in', async () => {
    // `chrB` is given first and sorts second, which is the one thing that puts
    // every value on the wrong sequence in a file that still opens cleanly.
    const file = open(await writeBigWig({ contigs: SPAN_CONTIGS, spans: SPANS }))
    const header = await file.getHeader()
    expect(header.refsByName['chrA']).toBe(0)
    expect(header.refsByName['chrB']).toBe(1)
  })

  it('summarises over the spans, weighted by what each one covers', async () => {
    const file = open(await writeBigWig({ contigs: SPAN_CONTIGS, spans: SPANS }))
    const header = await file.getHeader()
    const summary = header.totalSummary
    // 37 + 53 + 160 bases on chrA, 1 + 500 on chrB. The `NaN` interval covers
    // nothing, because it was never written.
    expect(summary.basesCovered).toBe(37 + 53 + 160 + 1 + 500)
    expect(summary.scoreMin).toBe(-2.25)
    expect(summary.scoreMax).toBe(9)
  })

  it('refuses a span on a sequence the assembly does not list', async () => {
    await expect(
      writeBigWig({
        contigs: SPAN_CONTIGS,
        spans: [{ contig: 'chrZ', starts: [0], ends: [10], values: [1] }],
      }),
    ).rejects.toThrow(/chrZ/)
  })

  it('refuses columns of different lengths', async () => {
    await expect(
      writeBigWig({
        contigs: SPAN_CONTIGS,
        spans: [{ contig: 'chrA', starts: [0, 10], ends: [10], values: [1, 2] }],
      }),
    ).rejects.toThrow(/different lengths/)
  })

  it('writes a legal file for an assembly no span mentions', async () => {
    // Every contig empty is a legitimate input on the bin road (a `.metacool`
    // contig nothing mapped to) and is one here too: a header, no data blocks,
    // and zeros in the summary rather than infinities.
    const file = open(await writeBigWig({ contigs: SPAN_CONTIGS, spans: [] }))
    const header = await file.getHeader()
    expect(header.totalSummary.basesCovered).toBe(0)
    expect(header.totalSummary.scoreMin).toBe(0)
    expect(await file.getFeatures('chrA', 0, 250, { scale: 1 })).toEqual([])
  })

  it('is byte-identical across two writes of the same spans', async () => {
    const [first, second] = await Promise.all([
      writeBigWig({ contigs: SPAN_CONTIGS, spans: SPANS }),
      writeBigWig({ contigs: SPAN_CONTIGS, spans: SPANS }),
    ])
    expect(await bytesOf(first)).toEqual(await bytesOf(second))
  })
})

describe('bigWigBytesEstimate', () => {
  it('lands within an order of magnitude of the file it is a hint about', async () => {
    const actual = (await writeBigWig(INPUT)).size
    const estimate = bigWigBytesEstimate(INPUT)
    expect(estimate).toBeGreaterThan(actual / 10)
    expect(estimate).toBeLessThan(actual * 10)
  })
})
