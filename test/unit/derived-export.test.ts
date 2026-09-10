// @vitest-environment jsdom
/**
 * A track made out of two, as a **file**.
 *
 * The lane was never the problem. A comparison of two loaded tracks holds no
 * numbers of its own — it is recomputed from its operands' own samples every
 * time it is drawn, which is what keeps it exact at every zoom — so it drew
 * correctly everywhere, and the row's three export buttons were the only place
 * the app had to ask *which grid* those numbers go on. It asked
 * `AnalysisContext.nBins`, and that is a matrix bin count: a session with no
 * contact map reports zero for it on purpose, because zero is what keeps
 * `hasMap` false and the map tasks waiting, while the *grid* underneath is real
 * (`analysis/context.ts`). So in a 1D browser session — where two bigWigs and no
 * matrix is the whole point, and dividing one by the other is the likeliest
 * reason to be there at all — every whole-assembly vector came out with no bins
 * in it, and the export was a **file rather than an error**: a bigWig with a
 * legal header and no data blocks, a bedGraph with its provenance comments and
 * not one row under them, and nothing anywhere to say so.
 *
 * Hence the shape of this file. The browser-session cases are the regression;
 * the map-session case beside each is the guard that the fix is a fix and not a
 * second grid. Both halves go out through `writeBigWig` and come back in through
 * `@gmod/bbi` — the same parser that draws a loaded track — because a writer
 * nobody reads back is a writer that is wrong (§18.7), and because "not empty"
 * is precisely the claim under test.
 *
 * **The mechanism underneath has since moved, and these assertions have not.**
 * A comparison is no longer read onto any grid to be written: it goes out at its
 * operands' own resolution, which is `derived-resolution.test.ts`'s subject and
 * a second reason the files here are not empty. So what this file now pins is
 * the *outcome* — a derived row in a session with no contact map writes a real
 * file, in all three formats, with the values and the framing line it should
 * have — which was the reader-visible failure and is worth holding whichever way
 * the export is plumbed. The sizing rule that caused it is documented at
 * `AnalysisWorkspace.gridBins`, which now guards the one caller left.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BigWig } from '@gmod/bbi'
import { BlobFile } from 'generic-filehandle2'

import type { AnalysisContext, AnalysisFraming } from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import { browsingBinsize } from '@/genome/assembly'
import type { Region, TrackSampleSet, TrackSamples } from '@/annotations/types'
import type { AnnotationClient } from '@/annotations/worker/client'
import { setUpDom, type DomTeardown } from '../support/dom'

/**
 * Three sequences, so a value written onto the wrong one lands on a named
 * neighbour rather than off the end of the only contig there is.
 */
const LENGTHS: Array<[string, number]> = [
  ['chrI', 230_218],
  ['chrII', 813_184],
  ['chrIII', 316_620],
]

const TOTAL = LENGTHS.reduce((sum, [, length]) => sum + length, 0)

/** The bin size a session with no map is given, from the assembly's own length. */
const BROWSING = browsingBinsize(TOTAL)

function grid(binsize: number): BedGraphContig[] {
  let startBin = 0
  return LENGTHS.map(([name, length]) => {
    const bins = Math.ceil(length / binsize)
    const contig = { name, startBin, bins, length }
    startBin += bins
    return contig
  })
}

/** Bins the assembly has at this bin size — what a vector over it is long. */
function gridBins(binsize: number): number {
  const contigs = grid(binsize)
  const last = contigs[contigs.length - 1]
  return last.startBin + last.bins
}

function framing(uri: string, binsize: number): AnalysisFraming {
  return {
    uri,
    label: `whole genome at ${binsize} bp`,
    binsize,
    binsPerCell: 1,
    rows: [0, 100],
    cols: [0, 100],
    balance: true,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

/**
 * The two contexts a derived row can be exported from.
 *
 * `mapped: false` is `Session.analysisContext`'s browser-session branch field
 * for field: a real bin size chosen from the assembly, a real grid under it, and
 * `nBins` of zero — which is the entire input to the bug.
 */
function context(uri: string, binsize: number, mapped: boolean): AnalysisContext {
  return {
    uri,
    layout: 'cool',
    hasMap: mapped,
    hasGenomes: false,
    hasWeights: mapped,
    scoreColumns: [],
    binsize,
    nBins: mapped ? gridBins(binsize) : 0,
    contigs: grid(binsize).map((contig) => ({ ...contig, genome: -1 })),
    genomes: null,
    entries: [],
    framing: mapped ? framing(uri, binsize) : null,
    blockLoaded: false,
    blockBytes: 0,
  }
}

/**
 * A worker stand-in that answers `sample` the way a bigWig does.
 *
 * One interval per bin of the region, so the area-weighting in `binVector` has
 * exactly one contributor per bin and the arithmetic under test is the
 * comparison rather than the reduction. `value(entry, absoluteBin)` is what each
 * operand carries, so a test can make the ratio say where it came from.
 */
function client(
  binsize: number,
  value: (entry: string, bin: number) => number,
): AnnotationClient {
  const startOf = new Map(grid(binsize).map((contig) => [contig.name, contig.startBin]))
  return {
    request: (payload: { kind: string; entry: string; regions: Region[]; basesPerPixel: number }) => {
      if (payload.kind !== 'sample') return Promise.resolve({})
      const regions: TrackSamples[] = payload.regions.map((region) => {
        const base = startOf.get(region.contig) ?? 0
        const starts: number[] = []
        const ends: number[] = []
        const values: number[] = []
        for (let at = region.start; at < region.end; at += binsize) {
          starts.push(at)
          ends.push(Math.min(at + binsize, region.end))
          values.push(value(payload.entry, base + Math.floor(at / binsize)))
        }
        return {
          contig: region.contig,
          start: region.start,
          end: region.end,
          starts: Int32Array.from(starts),
          ends: Int32Array.from(ends),
          values: Float32Array.from(values),
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
  binsize: number
}

/**
 * A workspace holding one derived row over two loaded tracks.
 *
 * Built through `AnnotationCard`'s own two store calls rather than by
 * hand-writing an entry, so the row under test is the row the `combine…`
 * dropdown makes.
 */
function bench(options: {
  mapped: boolean
  value: (which: 'a' | 'b', bin: number) => number
}): Bench {
  const binsize = options.mapped ? 5000 : BROWSING
  const uri = options.mapped ? 'f.mcool' : 'sacCer3'
  const store = new AnnotationStore(`derived-export|${uri}|${Math.random()}`)
  store.clear()

  const a = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'numerator',
    source: { kind: 'remote', url: 'a.bw', name: 'numerator' },
  })
  const b = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'denominator',
    source: { kind: 'remote', url: 'b.bw', name: 'denominator' },
  })
  store.update(a.id, { status: 'ready' })
  store.update(b.id, { status: 'ready' })

  const derived = store.begin({
    card: 'synthetic',
    kind: 'track',
    label: 'numerator ÷ denominator',
    source: { kind: 'derived', name: 'numerator ÷ denominator' },
  })
  store.update(derived.id, {
    derivedFrom: { a: a.id, b: b.id, op: 'ratio' },
    status: 'ready',
    summary: 'ratio of two tracks',
  })

  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context(uri, binsize, options.mapped),
    framing: () => (options.mapped ? framing(uri, binsize) : null),
    block: () => null,
    store: () => store,
    annotations: () =>
      client(binsize, (entry, bin) => options.value(entry === a.id ? 'a' : 'b', bin)),
    contigs: () => grid(binsize),
    carried: () => [],
    changed: () => {},
  }
  return { workspace: new AnalysisWorkspace(host), binsize }
}

interface Saved {
  name: string
  blob: Blob
}

const saved: Saved[] = []
let teardown: DomTeardown
let restoreDownloads: () => void
let restoreCompression: () => void

/**
 * Take `CompressionStream` away for the length of this file.
 *
 * `deflateBytes` pipes a `Blob` through it and jsdom's `Blob` has no `stream()`,
 * so the compressed road cannot be walked here at all. `write/bigwig.ts`
 * documents the other one: with no `CompressionStream` the sections go out
 * uncompressed with `uncompressBufSize = 0`, which is a legal bigWig and one
 * `@gmod/bbi` reads back exactly as it reads a deflated one.
 */
function withoutCompression(): () => void {
  const scope = globalThis as { CompressionStream?: unknown }
  const real = scope.CompressionStream
  delete scope.CompressionStream
  return () => {
    if (real !== undefined) scope.CompressionStream = real
  }
}

/** What `downloadBlob` would have handed the browser; jsdom has no object URLs. */
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

/** Press one of the row's export buttons and wait for the file. */
async function press(workspace: AnalysisWorkspace, label: string): Promise<Saved> {
  const buttons = Array.from(workspace.syntheticEl.querySelectorAll('button'))
  const target = buttons.find((button) => button.textContent?.trim() === label)
  expect(target, `no ${label} button on the row`).toBeTruthy()
  const before = saved.length
  target!.click()
  for (let tick = 0; tick < 400 && saved.length === before; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(saved, `nothing was written for ${label}`).toHaveLength(before + 1)
  return saved[saved.length - 1]
}

/** The file without its provenance comments, which `write/tsv.ts` already pins. */
function dataRows(text: string): string[] {
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
}

/** Every interval of the written bigWig, read back by the app's own parser. */
async function readBack(
  blob: Blob,
): Promise<Map<string, Array<{ start: number; end: number; score: number }>>> {
  const file = new BigWig({ filehandle: new BlobFile(blob) })
  await file.getHeader()
  const out = new Map<string, Array<{ start: number; end: number; score: number }>>()
  for (const [name, length] of LENGTHS) {
    const features = await file.getFeatures(name, 0, length, { scale: 1 })
    out.set(
      name,
      features
        .map((feature) => ({ start: feature.start, end: feature.end, score: feature.score ?? NaN }))
        .sort((one, two) => one.start - two.start),
    )
  }
  return out
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

/** A ratio whose value *is* the absolute bin it came from, so a row says so. */
const selfDescribing = (which: 'a' | 'b', bin: number): number => (which === 'a' ? 2 * bin : 2)

describe('exporting a derived track from a session with no contact map', () => {
  it('writes a bigWig with the values in it, not an empty one', async () => {
    const { workspace, binsize } = bench({ mapped: false, value: selfDescribing })
    const written = await readBack((await press(workspace, 'bigWig')).blob)

    // The regression, stated the way the reader met it: a file came out and it
    // had nothing in it. Every contig's bins are here, on the browsing grid.
    const total = [...written.values()].reduce((sum, list) => sum + list.length, 0)
    expect(total).toBe(gridBins(binsize))
    expect(total).toBeGreaterThan(0)

    // And each value is the absolute bin it came from, so a contig written from
    // the wrong offset is legible rather than merely absent.
    for (const contig of grid(binsize)) {
      const intervals = written.get(contig.name)!
      expect(intervals).toHaveLength(contig.bins)
      expect(intervals[0]).toEqual({ start: 0, end: binsize, score: contig.startBin })
      const last = intervals[intervals.length - 1]
      expect(last.end).toBe(contig.length)
      expect(last.score).toBe(contig.startBin + contig.bins - 1)
    }

    workspace.destroy()
  })

  it('writes a bedGraph row per bin, and the two files agree', async () => {
    const { workspace, binsize } = bench({ mapped: false, value: selfDescribing })
    const rows = dataRows(await (await press(workspace, 'bedGraph')).blob.text())
    const written = await readBack((await press(workspace, 'bigWig')).blob)

    expect(rows).toHaveLength(gridBins(binsize))
    // Agreeing cell for cell is the first thing `write/bedgraph.ts` claims, and
    // the empty export broke it in the only way that leaves both files legal.
    const fromTheBigWig: string[] = []
    for (const [name] of LENGTHS) {
      for (const interval of written.get(name)!) {
        fromTheBigWig.push(`${name}\t${interval.start}\t${interval.end}\t${interval.score}`)
      }
    }
    expect(rows).toEqual(fromTheBigWig)

    workspace.destroy()
  })

  it('names the grid it is on rather than a file whose bins these are not', async () => {
    const { workspace, binsize } = bench({ mapped: false, value: selfDescribing })
    const text = await (await press(workspace, 'bedGraph')).blob.text()

    // There is no open file in a browser session, so "this file's bins" would
    // name a resolution nothing was measured at.
    expect(text).toContain(`# framing: two loaded tracks, read onto the assembly’s`)
    expect(text).toContain(`${binsize.toLocaleString()} bp bins`)

    workspace.destroy()
  })

  it('writes the TSV over the same bins', async () => {
    const { workspace, binsize } = bench({ mapped: false, value: selfDescribing })
    const rows = dataRows(await (await press(workspace, 'TSV')).blob.text())

    // One header row and then the vector; the empty export wrote the header and
    // stopped, which reads as a task that produced nothing.
    expect(rows.length).toBe(gridBins(binsize) + 1)

    workspace.destroy()
  })

  it('leaves a bin whose denominator is zero out of the file entirely', async () => {
    // `x / 0` is `Infinity`, and BBI has nowhere to put one: written, it takes
    // the total summary and every zoom record over it with it. A gap is a state
    // every reader already understands, so that is what a bin like this is.
    const { workspace, binsize } = bench({
      mapped: false,
      value: (which, bin) => (which === 'a' ? 2 * bin : bin === 1 ? 0 : 2),
    })
    const written = await readBack((await press(workspace, 'bigWig')).blob)

    const chrI = written.get('chrI')!
    expect(chrI).toHaveLength(grid(binsize)[0].bins - 1)
    expect(chrI.some((interval) => interval.start === binsize)).toBe(false)
    expect(chrI.every((interval) => Number.isFinite(interval.score))).toBe(true)

    workspace.destroy()
  })
})

describe('exporting a derived track from a session with a contact map', () => {
  /**
   * The regression risk in the fix, and the reason it is a fix rather than a
   * second grid: where a map is open, its bin count and its contig grid are the
   * same number by construction (§3.3), so nothing about this file may change.
   */
  it('is written over the map’s own bins, exactly as before', async () => {
    const { workspace, binsize } = bench({ mapped: true, value: selfDescribing })
    const rows = dataRows(await (await press(workspace, 'bedGraph')).blob.text())
    const written = await readBack((await press(workspace, 'bigWig')).blob)

    expect(binsize).toBe(5000)
    expect(rows).toHaveLength(gridBins(5000))
    for (const contig of grid(5000)) {
      const intervals = written.get(contig.name)!
      expect(intervals).toHaveLength(contig.bins)
      expect(intervals[0].score).toBe(contig.startBin)
    }

    workspace.destroy()
  })

  it('still says the bins are the open file’s', async () => {
    const { workspace } = bench({ mapped: true, value: selfDescribing })
    const text = await (await press(workspace, 'bedGraph')).blob.text()
    expect(text).toContain('# framing: two loaded tracks, read onto this file’s 5,000 bp bins')
    workspace.destroy()
  })
})
