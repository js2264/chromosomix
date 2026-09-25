// @vitest-environment jsdom
/**
 * Which assembly an exported profile is laid out over.
 *
 * A profile is a set of values on the bins it was computed on, and after a
 * change of resolution those are no longer the bins under the map. The
 * workspace already knows that where the *lane* is concerned — it keeps the
 * vector on its own grid ({@link HeldProfile.grid}) so a 1 kb track goes on
 * being drawn in the right place over a 5 kb file — and the export has to be
 * written over that same grid. It was not: `writeProfile` derived the assembly
 * from `host.contigs()`, which is rebuilt at the *current* bin size. A 1 kb
 * coverage track exported after a switch to 5 kb therefore came out with every
 * contig after the first taking its rows from the previous contig's values, and
 * with each contig cut short after its 5 kb bin count — 274 rows of a
 * 1,362-bin vector, on the wrong chromosomes, in a file that opens cleanly
 * everywhere.
 *
 * The bigWig beside it was already right, which is worth pinning rather than
 * assuming: `writeBigWig` is handed names and lengths only and rebuilds the bin
 * offsets from the profile's own `binsize`, and neither a name nor a length
 * changes with the resolution. So the two files offered for one row disagreed,
 * which is the first thing `write/bedgraph.ts` rules out.
 *
 * The last test is the guard in the other direction, and it is the one that
 * matters for every session that never changes resolution: a row whose held
 * grid *is* the assembly under it must still be written byte for byte as it was
 * before the grid was threaded through.
 *
 * jsdom, because the export is pressed on the card's own button — the seam the
 * reader uses — and the workspace builds a document to hold that card.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisContext, AnalysisFraming, ProfileOutput, Provenance } from '@/analysis/types'
import { profileToBedGraph, type BedGraphContig } from '@/analysis/write/bedgraph'
import { writeBigWig } from '@/analysis/write/bigwig'
import {
  AnalysisWorkspace,
  type AnalysisWorkspaceHost,
  type CarriedResult,
} from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import type { ComputedSource } from '@/annotations/types'
import { syntheticEntry } from '@/ui/synthetic'
import { setUpDom, type DomTeardown } from '../support/dom'
import { tracksCardOver } from '../support/tracksCard'

/**
 * Three sequences, so a wrong offset lands on a named neighbour.
 *
 * A single contig would hide the whole failure: its `startBin` is zero at every
 * bin size, so only the *second* contig onwards can be written from the wrong
 * place. These are chrI, chrII and chrIII of the yeast assembly, and their
 * lengths are what make the two grids disagree by an interesting amount — 231
 * bins against 47 for the first.
 */
const LENGTHS: Array<[string, number]> = [
  ['chrI', 230_218],
  ['chrII', 813_184],
  ['chrIII', 316_620],
]

/** The same assembly, as it is laid out at one bin size. */
function grid(binsize: number): BedGraphContig[] {
  let startBin = 0
  return LENGTHS.map(([name, length]) => {
    const bins = Math.ceil(length / binsize)
    const contig = { name, startBin, bins, length }
    startBin += bins
    return contig
  })
}

function nBins(binsize: number): number {
  const contigs = grid(binsize)
  const last = contigs[contigs.length - 1]
  return last.startBin + last.bins
}

function framing(uri: string, binsize: number): AnalysisFraming {
  return {
    uri,
    label: `whole genome at ${binsize / 1000} kb, balanced, count`,
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

function context(uri: string, binsize: number): AnalysisContext {
  return {
    uri,
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: true,
    scoreColumns: [],
    binsize,
    nBins: nBins(binsize),
    contigs: grid(binsize).map((contig) => ({ ...contig, genome: -1 })),
    genomes: null,
    entries: [],
    framing: framing(uri, binsize),
    blockLoaded: false,
    blockBytes: 0,
  }
}

/**
 * Coverage at 1 kb, where every value *is* its own absolute bin index.
 *
 * So a row of the file says where the number it carries came from, and an
 * offset error is legible in the assertion rather than inferred from it.
 */
function profileAtOneKb(): ProfileOutput {
  const values = new Float32Array(nBins(1000))
  for (let bin = 0; bin < values.length; bin++) values[bin] = bin
  return {
    kind: 'profile',
    id: 'coverage',
    label: 'coverage',
    values,
    extent: [0, values.length],
    binsize: 1000,
    unit: '',
  }
}

function provenance(binsize: number): Provenance {
  return {
    task: 'coverage',
    taskVersion: 1,
    params: {},
    framing: framing('f.mcool', binsize),
    createdAt: '2026-08-10T00:00:00Z',
    app: 'test',
  }
}

function computedSource(binsize: number): ComputedSource {
  return {
    kind: 'computed',
    name: 'coverage',
    task: 'coverage',
    recipe: { params: {}, taskVersion: 1, framing: framing('f.mcool', binsize) },
    framing: framing('f.mcool', binsize).label,
  }
}

/** A client that answers nothing: no lane is drawn here, only a file written. */
function client(): AnnotationClient {
  return {
    request: () => Promise.resolve({}),
    drop: () => {},
    destroy: () => {},
  } as unknown as AnnotationClient
}

/** The 1 kb profile, as the workspace that computed it hands it to the next one. */
function carriedProfile(): CarriedResult {
  const output = profileAtOneKb()
  return {
    entry: syntheticEntry(output, computedSource(1000), '#0072b2'),
    profile: {
      output,
      provenance: provenance(1000),
      task: 'coverage',
      grid: grid(1000).map((contig) => ({ ...contig })),
    },
  }
}

/** A workspace over the file at one resolution, handed what the previous one held. */
function bench(binsize: number, carried: readonly CarriedResult[]): AnalysisWorkspace {
  const uri = `f.mcool::resolutions/${binsize}`
  const store = new AnnotationStore(`export|${uri}|${Math.random()}`)
  store.clear()
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context(uri, binsize),
    framing: () => framing(uri, binsize),
    block: () => null,
    store: () => store,
    annotations: () => client(),
    contigs: () => grid(binsize),
    carried: () => carried,
    changed: () => {},
  }
  const workspace = new AnalysisWorkspace(host)
  stores.set(workspace, store)
  return workspace
}

/** The store each bench's workspace files its rows into, for the card over it. */
const stores = new WeakMap<AnalysisWorkspace, AnnotationStore>()

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
 * Not a fussy detail: `deflateBytes` pipes a `Blob` through it, and jsdom's
 * `Blob` has no `stream()`, so the compressed road cannot be walked here at
 * all. `write/bigwig.ts` documents the other one — with no `CompressionStream`
 * the sections go out uncompressed with `uncompressBufSize = 0`, which is a
 * legal bigWig — and it is the same road on both sides of every comparison
 * below, which is all these assertions ask of it.
 */
function withoutCompression(): () => void {
  const scope = globalThis as { CompressionStream?: unknown }
  const real = scope.CompressionStream
  delete scope.CompressionStream
  return () => {
    if (real !== undefined) scope.CompressionStream = real
  }
}

/**
 * What `downloadBlob` would have handed the browser.
 *
 * There is no seam in `ui/export.ts` to reach for, and there should not be: it
 * makes an object URL and clicks an anchor, which is the whole of what saving a
 * file from a page is. Both halves are replaced here — the URL because jsdom
 * has none, the click so that nothing navigates — and the blob is paired with
 * the download name the anchor carried, which is the other half of the export
 * worth asserting.
 */
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

/**
 * Press one of the row's export buttons and wait for the file.
 *
 * The card's handler discards the promise — the export is fire-and-forget from
 * a click, and a bigWig deflates before it exists — so the file is waited for
 * rather than awaited.
 */
async function press(workspace: AnalysisWorkspace, label: string): Promise<Saved> {
  // The row's own buttons, on the Tracks card where a synthetic row lives.
  const mounted = tracksCardOver(stores.get(workspace)!, workspace)
  const buttons = Array.from(mounted.el.querySelectorAll('button'))
  const target = buttons.find((button) => button.textContent?.trim() === label)
  expect(target, `no ${label} button on the row`).toBeTruthy()
  const before = saved.length
  target!.click()
  for (let tick = 0; tick < 400 && saved.length === before; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(saved).toHaveLength(before + 1)
  mounted.destroy()
  return saved[saved.length - 1]
}

/** The file without its provenance comments, which `write/tsv.ts` already pins. */
function dataRows(text: string): string[] {
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
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

describe('exporting a profile carried across a change of resolution', () => {
  it('lays the bedGraph out over the grid the values were computed on', async () => {
    const carried = carriedProfile()
    const workspace = bench(5000, [carried])
    const rows = dataRows(await (await press(workspace, 'bedGraph')).blob.text())

    // chrI's offset is zero at either bin size, so the first contig cannot tell
    // the two grids apart; chrII is where they part company — 1 kb bin 231
    // against 5 kb bin 47 — and the value is its own bin index, so the row says
    // which grid was used.
    expect(grid(1000)[1].startBin).toBe(231)
    expect(grid(5000)[1].startBin).toBe(47)
    expect(rows[0]).toBe('chrI\t0\t1000\t0')
    expect(rows.find((row) => row.startsWith('chrII\t'))).toBe('chrII\t0\t1000\t231')
    expect(rows.find((row) => row.startsWith('chrIII\t'))).toBe(
      `chrIII\t0\t1000\t${grid(1000)[2].startBin}`,
    )

    workspace.destroy()
  })

  it('writes every bin of the vector, not the new grid’s share of them', async () => {
    const carried = carriedProfile()
    const workspace = bench(5000, [carried])
    const rows = dataRows(await (await press(workspace, 'bedGraph')).blob.text())

    // 1,362 rows and not 274: walking the 5 kb contigs stopped each chromosome
    // after a fifth of its bins and dropped the rest of the vector on the floor.
    expect(rows).toHaveLength(nBins(1000))
    for (const contig of grid(1000)) {
      expect(rows.filter((row) => row.startsWith(`${contig.name}\t`))).toHaveLength(contig.bins)
    }
    // And the last bin of the last contig still ends at the sequence rather than
    // at the bin boundary — the clamp `write/bedgraph.ts` owns, unaffected here.
    expect(rows[rows.length - 1]).toBe(`chrIII\t316000\t316620\t${nBins(1000) - 1}`)

    workspace.destroy()
  })

  it('leaves the bigWig it is supposed to agree with untouched', async () => {
    const carried = carriedProfile()
    const workspace = bench(5000, [carried])
    const written = await bytes((await press(workspace, 'bigWig')).blob)

    // This export never had the defect: it is given names and lengths only, and
    // rebuilds the bin offsets from the profile's own `binsize`. Both lists say
    // the same thing about a name and a length, so passing the held grid instead
    // of the current contigs must produce the same file to the byte.
    const fromTheCurrentContigs = await writeBigWig({
      contigs: grid(5000).map((contig) => ({ name: contig.name, length: contig.length })),
      values: carried.profile!.output.values,
      firstBin: 0,
      binsize: 1000,
    })
    expect(written).toEqual(await bytes(fromTheCurrentContigs))

    workspace.destroy()
  })
})

describe('exporting a profile that was not carried', () => {
  /**
   * The common case, and the regression risk in this fix: a row computed by the
   * workspace it is exported from is stored with `this.grid()`, which is
   * `host.contigs()` field for field, so nothing about its files may change.
   */
  it('is written byte for byte as deriving the assembly from the map produced', async () => {
    const carried = carriedProfile()
    const workspace = bench(1000, [carried])
    const output = carried.profile!.output
    const held = carried.profile!.provenance

    const bedGraph = await press(workspace, 'bedGraph')
    expect(await bedGraph.blob.text()).toBe(profileToBedGraph(output, grid(1000), held))
    expect(bedGraph.name).toMatch(/^coverage-\d{8}-\d{6}\.bedGraph$/)

    const bigWig = await press(workspace, 'bigWig')
    const asItWas = await writeBigWig({
      contigs: grid(1000).map((contig) => ({ name: contig.name, length: contig.length })),
      values: output.values,
      firstBin: 0,
      binsize: 1000,
    })
    expect(await bytes(bigWig.blob)).toEqual(await bytes(asItWas))
    expect(bigWig.name).toMatch(/^coverage-\d{8}-\d{6}\.bw$/)

    workspace.destroy()
  })
})
