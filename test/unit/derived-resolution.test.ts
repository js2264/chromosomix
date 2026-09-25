// @vitest-environment jsdom
/**
 * A comparison of two tracks leaves at **the resolution of the tracks**.
 *
 * The lane was always exact. `annotations/derived.ts` cuts at every boundary of
 * either operand, so the step function on screen is right at any zoom and owes
 * nothing to the contact map underneath it. The export was not: it read both
 * operands onto the map's bin grid and wrote a bin vector, on the stated
 * argument that "a bigWig is values on a grid, so a file has to pick one".
 *
 * That premise was false. A bedGraph-typed section holds arbitrary intervals —
 * decision 1 of `write/bigwig.ts`, and the reason a gap is a gap and a short
 * final bin is short — so the grid was an assumption in the caller and nothing
 * else. What it cost: a reader who divided two 10 bp tracks while looking at a
 * 20 kb map got a 20 kb file back, every boundary in their data gone and every
 * number a mean of means, with nothing in the file or on the row to say so. The
 * worst shape this failure can take, because the picture they would check it
 * against is the exact one.
 *
 * So what is pinned here is that the file follows the *data*: 10 bp operands
 * make a 10 bp file, 50 kb operands make a 50 kb file, irregular operands make
 * an irregular file, and the map's bin size appears in none of those sentences.
 * Everything goes out through `writeBigWig` and comes back in through
 * `@gmod/bbi` — the parser this app draws a loaded track with — because
 * "not re-binned" is a claim about what a reader will find in the file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BigWig } from '@gmod/bbi'
import { BlobFile } from 'generic-filehandle2'

import type { AnalysisContext, AnalysisFraming } from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import type { Region, TrackSampleSet, TrackSamples } from '@/annotations/types'
import type { AnnotationClient } from '@/annotations/worker/client'
import { setUpDom, type DomTeardown } from '../support/dom'
import { tracksCardOver } from '../support/tracksCard'

/** One sequence, short enough that a 10 bp track over it is a readable table. */
const CONTIG: BedGraphContig = { name: 'chrI', startBin: 0, bins: 5, length: 100_000 }

/** The map is at 20 kb. Nothing below may borrow that number. */
const MAP_BINSIZE = 20_000

function framing(): AnalysisFraming {
  return {
    uri: 'f.mcool::resolutions/20000',
    label: 'chrI · 20.0 kb bins · counts',
    binsize: MAP_BINSIZE,
    binsPerCell: 1,
    rows: [0, CONTIG.bins],
    cols: [0, CONTIG.bins],
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

function context(): AnalysisContext {
  return {
    uri: 'f.mcool::resolutions/20000',
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: [],
    binsize: MAP_BINSIZE,
    nBins: CONTIG.bins,
    contigs: [{ ...CONTIG, genome: -1 }],
    genomes: null,
    entries: [],
    framing: framing(),
    blockLoaded: false,
    blockBytes: 0,
  }
}

/** `[start, end, value]` triples, which is what a track's own intervals are. */
type Span = [number, number, number]

/** Evenly spaced intervals of `width`, valued by `at`. */
function evenly(width: number, value: (start: number) => number): Span[] {
  const out: Span[] = []
  for (let start = 0; start < CONTIG.length; start += width) {
    out.push([start, Math.min(CONTIG.length, start + width), value(start)])
  }
  return out
}

interface Asked {
  entry: string
  basesPerPixel: number
  exact: boolean
}

/**
 * A worker stand-in that answers with each operand's **own** intervals.
 *
 * Which is what a bigWig does when asked at `basesPerSpan: 1`: it hands back the
 * items on disk rather than a zoom level. The requests are recorded, because
 * *how* the export asks is half of the fix — a request at the map's bin size
 * gets a reduced answer from the real worker however faithful this stub is.
 */
function client(
  spansOf: Record<string, Span[]>,
  asked: Asked[],
): AnnotationClient {
  return {
    request: (payload: {
      kind: string
      entry: string
      regions: Region[]
      basesPerPixel: number
      exact?: true
    }) => {
      if (payload.kind !== 'sample') return Promise.resolve({})
      asked.push({
        entry: payload.entry,
        basesPerPixel: payload.basesPerPixel,
        exact: payload.exact === true,
      })
      const own = spansOf[payload.entry] ?? []
      const regions: TrackSamples[] = payload.regions.map((region) => {
        const inside = own.filter(([start, end]) => end > region.start && start < region.end)
        return {
          contig: region.contig,
          start: region.start,
          end: region.end,
          starts: Int32Array.from(inside.map((span) => span[0])),
          ends: Int32Array.from(inside.map((span) => span[1])),
          values: Float32Array.from(inside.map((span) => span[2])),
          min: null,
          max: null,
          variant: null,
          summary: false,
        }
      })
      const set: TrackSampleSet = { basesPerPixel: payload.basesPerPixel, regions, extent: null }
      return Promise.resolve(set)
    },
    drop: () => {},
    destroy: () => {},
  } as unknown as AnnotationClient
}

interface Bench {
  workspace: AnalysisWorkspace
  asked: Asked[]
}

function bench(a: Span[], b: Span[]): Bench {
  const store = new AnnotationStore(`resolution|${Math.random()}`, { persist: false })
  const left = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'numerator',
    source: { kind: 'remote', url: 'a.bw', name: 'numerator' },
  })
  const right = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'denominator',
    source: { kind: 'remote', url: 'b.bw', name: 'denominator' },
  })
  store.update(left.id, { status: 'ready' })
  store.update(right.id, { status: 'ready' })
  const derived = store.begin({
    card: 'synthetic',
    kind: 'track',
    label: 'ratio',
    source: { kind: 'derived', name: 'ratio' },
  })
  store.update(derived.id, {
    derivedFrom: { a: left.id, b: right.id, op: 'ratio' },
    status: 'ready',
  })

  const asked: Asked[] = []
  const spans = { [left.id]: a, [right.id]: b }
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context(),
    framing: () => framing(),
    block: () => null,
    store: () => store,
    annotations: () => client(spans, asked),
    contigs: () => [CONTIG],
    carried: () => [],
    changed: () => {},
  }
  const workspace = new AnalysisWorkspace(host)
  stores.set(workspace, store)
  return { workspace, asked }
}

/** The store each bench's workspace reads its rows from, for the card over it. */
const stores = new WeakMap<AnalysisWorkspace, AnnotationStore>()

interface Saved {
  name: string
  blob: Blob
}

const saved: Saved[] = []
let teardown: DomTeardown
let restoreDownloads: () => void
let restoreCompression: () => void

function withoutCompression(): () => void {
  const scope = globalThis as { CompressionStream?: unknown }
  const real = scope.CompressionStream
  delete scope.CompressionStream
  return () => {
    if (real !== undefined) scope.CompressionStream = real
  }
}

function captureDownloads(): () => void {
  let pending: Blob | null = null
  const urls = URL as unknown as {
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
  }
  const realCreate = urls.createObjectURL
  const realRevoke = urls.revokeObjectURL
  const realClick = HTMLAnchorElement.prototype.click
  urls.createObjectURL = (blob: Blob) => {
    pending = blob
    return 'blob:test'
  }
  urls.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (pending !== null) saved.push({ name: this.download, blob: pending })
    pending = null
  }
  return () => {
    urls.createObjectURL = realCreate
    urls.revokeObjectURL = realRevoke
    HTMLAnchorElement.prototype.click = realClick
  }
}

async function press(workspace: AnalysisWorkspace, label: string): Promise<Saved> {
  // The row's own buttons, on the Tracks card where a synthetic row lives.
  const mounted = tracksCardOver(stores.get(workspace)!, workspace)
  const buttons = Array.from(mounted.el.querySelectorAll('button'))
  const target = buttons.find((node) => node.textContent?.trim() === label)
  expect(target, `no ${label} button on the row`).toBeTruthy()
  const before = saved.length
  target!.click()
  for (let tick = 0; tick < 400 && saved.length === before; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(saved, `nothing was written for ${label}`).toHaveLength(before + 1)
  mounted.destroy()
  return saved[saved.length - 1]
}

/** Every interval of a written bigWig, through the app's own reader. */
async function readBack(blob: Blob): Promise<Span[]> {
  const file = new BigWig({ filehandle: new BlobFile(blob) })
  await file.getHeader()
  const features = await file.getFeatures(CONTIG.name, 0, CONTIG.length, { scale: 1 })
  return features
    .map((feature): Span => [feature.start, feature.end, feature.score ?? NaN])
    .sort((one, two) => one[0] - two[0])
}

function dataRows(text: string): string[] {
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
}

beforeEach(() => {
  teardown = setUpDom()
  saved.length = 0
  restoreDownloads = captureDownloads()
  restoreCompression = withoutCompression()
})

afterEach(() => {
  restoreCompression()
  restoreDownloads()
  teardown()
})

describe('how the export asks for its operands', () => {
  it('asks for the data, not for a picture of it', () => {
    const { workspace, asked } = bench(evenly(10, () => 2), evenly(10, () => 1))
    void press(workspace, 'bigWig')
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      expect(asked).toHaveLength(2)
      for (const request of asked) {
        // `1`, not the map's 20,000: a bigWig picks its zoom level from this, so
        // asking at the map's bin size is asking to be re-binned before a single
        // line of writer code runs.
        expect(request.basesPerPixel).toBe(1)
        // And `exact`, which is what stops a *computed* operand folding its bins
        // into the few thousand buckets a frame can draw (`binVector.ts`).
        expect(request.exact).toBe(true)
      }
      workspace.destroy()
    })
  })
})

describe('a ratio of two tracks finer than the map', () => {
  // 10 bp operands under a 20 kb map: two thousand data boundaries per bin.
  const numerator = evenly(10, (start) => 2 + (start / 10) % 3)
  const denominator = evenly(10, () => 2)

  it('is written at 10 bp, not at the map’s 20 kb', async () => {
    const { workspace } = bench(numerator, denominator)
    const written = await readBack((await press(workspace, 'bigWig')).blob)

    expect(written).toHaveLength(numerator.length)
    expect(written[0][0]).toBe(0)
    expect(written[0][1]).toBe(10)
    // The claim, stated as the thing that was wrong: no interval is a map bin.
    expect(written.every(([start, end]) => end - start === 10)).toBe(true)
    expect(written.some(([, end], at) => end - written[at][0] === MAP_BINSIZE)).toBe(false)
    workspace.destroy()
  })

  it('carries the values the operands actually had', async () => {
    const { workspace } = bench(numerator, denominator)
    const written = await readBack((await press(workspace, 'bigWig')).blob)
    for (let at = 0; at < 8; at++) {
      expect(written[at][2]).toBeCloseTo(numerator[at][2] / denominator[at][2], 5)
    }
    workspace.destroy()
  })

  it('agrees with the bedGraph and the TSV, interval for interval', async () => {
    const { workspace } = bench(numerator, denominator)
    const written = await readBack((await press(workspace, 'bigWig')).blob)
    const bedGraph = dataRows(await (await press(workspace, 'bedGraph')).blob.text())
    const tsv = dataRows(await (await press(workspace, 'TSV')).blob.text())

    expect(bedGraph).toHaveLength(written.length)
    // The TSV carries a header row above the same rows.
    expect(tsv[0]).toBe('chrom\tstart\tend\tvalue')
    expect(tsv).toHaveLength(written.length + 1)
    for (let at = 0; at < 5; at++) {
      const [start, end] = written[at]
      expect(bedGraph[at].startsWith(`chrI\t${start}\t${end}\t`)).toBe(true)
      expect(tsv[at + 1].startsWith(`chrI\t${start}\t${end}\t`)).toBe(true)
    }
    workspace.destroy()
  })
})

describe('a ratio of two tracks coarser than the map', () => {
  /**
   * The other direction, and the one that says this is about the *data* rather
   * than about a smaller number being better: 50 kb operands stay 50 kb. A
   * writer that had merely swapped one grid for a finer one would upsample here
   * and claim readings at a resolution nothing measured.
   */
  it('is written at 50 kb, which is what the operands say', async () => {
    const { workspace } = bench(evenly(50_000, () => 6), evenly(50_000, () => 3))
    const written = await readBack((await press(workspace, 'bigWig')).blob)
    expect(written).toEqual([
      [0, 50_000, 2],
      [50_000, 100_000, 2],
    ])
    workspace.destroy()
  })
})

describe('operands on no grid at all', () => {
  /**
   * The case a bin vector cannot represent even in principle, and the one the
   * lane has always drawn correctly: two step functions whose boundaries
   * interleave. The file is the common refinement — a cut at every boundary of
   * either — which is `combineSamples`' own output and the same arithmetic the
   * picture is drawn from.
   */
  it('is cut at every boundary of either operand', async () => {
    const { workspace } = bench(
      [
        [0, 30, 10],
        [30, 100, 20],
      ],
      [
        [0, 50, 5],
        [50, 100, 10],
      ],
    )
    const written = await readBack((await press(workspace, 'bigWig')).blob)
    expect(written).toEqual([
      [0, 30, 2],
      [30, 50, 4],
      [50, 100, 2],
    ])
    workspace.destroy()
  })

  it('leaves out a stretch only one operand covers', async () => {
    // 30–100 has a numerator and no denominator. `x / undefined` is not a
    // reading, and a file says nothing about it rather than inventing one.
    const { workspace } = bench(
      [
        [0, 100, 8],
      ],
      [
        [0, 30, 4],
      ],
    )
    const written = await readBack((await press(workspace, 'bigWig')).blob)
    expect(written).toEqual([[0, 30, 2]])
    workspace.destroy()
  })

  it('leaves out a stretch whose denominator is zero', async () => {
    // `x / 0` is an infinity, which BBI cannot carry without taking the total
    // summary and every zoom record over it. A gap is a state every reader
    // already understands.
    const { workspace } = bench(
      [
        [0, 100, 8],
      ],
      [
        [0, 50, 0],
        [50, 100, 4],
      ],
    )
    const written = await readBack((await press(workspace, 'bigWig')).blob)
    expect(written).toEqual([[50, 100, 2]])
    workspace.destroy()
  })
})
