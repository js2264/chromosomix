// @vitest-environment jsdom
/**
 * What a computed track survives, and what it must not.
 *
 * Changing the resolution of an `.mcool` is not opening a different file — it is
 * the same data at a different bin size — and the application already treats it
 * that way everywhere a reader can see: the view carries across
 * (`Session.carryAcrossEntries`), and so does every dropped track
 * (`Session.carry` → `AnnotationLoader.carry`). The one thing that did not was
 * the output of an analysis. A reader who ran compartments genome-wide, waited
 * four minutes for it, and then looked at the same region at a finer bin found
 * the Synthetic tracks card empty — the numbers having been dropped by the tab
 * that was still holding them, for no reason other than that they were held by a
 * workspace rather than by a store.
 *
 * Two claims are pinned here, and the second is the one that could go wrong
 * quietly. The values come across **on the grid they were computed on**: a
 * profile is one number per bin, its bins were 1 kb, and re-registering it
 * against the 5 kb assembly now under it would lay every value at five times its
 * true coordinate — a track that is still drawn, still exportable, and wrong
 * everywhere. `BinVector` carries its own `binsize` and contig offsets precisely
 * so a vector and the map beneath it need not share a grid, and
 * {@link HeldProfile.grid} is what keeps the right one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisContext, AnalysisFraming, ProfileOutput, Provenance } from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import {
  AnalysisWorkspace,
  type AnalysisWorkspaceHost,
  type CarriedResult,
} from '@/analysis/workspace'
import { FeatureBuilder } from '@/annotations/featureset'
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle, emptyPlacement, type ComputedSource } from '@/annotations/types'
import type { AnnotationClient } from '@/annotations/worker/client'
import type { BinVector } from '@/annotations/worker/binVector'
import { syntheticEntry, syntheticId } from '@/ui/SyntheticCard'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** The same chromosome, laid out at the two resolutions in play. */
function grid(binsize: number): BedGraphContig[] {
  return [{ name: 'chrIV', startBin: 0, bins: Math.ceil(1_531_933 / binsize), length: 1_531_933 }]
}

function framing(uri: string, binsize: number): AnalysisFraming {
  return {
    uri,
    label: `chrIV:1–1,531,933 at ${binsize / 1000} kb, balanced, count`,
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
    nBins: grid(binsize)[0].bins,
    contigs: grid(binsize).map((contig) => ({ ...contig, genome: -1 })),
    genomes: null,
    entries: [],
    framing: framing(uri, binsize),
    blockLoaded: false,
    blockBytes: 0,
  }
}

function profileOf(binsize: number): ProfileOutput {
  const values = new Float32Array(8)
  for (let i = 0; i < values.length; i++) values[i] = i / 2 - 2
  return {
    kind: 'profile',
    id: 'insulation:w10',
    label: 'insulation, 10 kb',
    values,
    extent: [0, values.length],
    binsize,
    unit: '',
  }
}

function computedSource(binsize: number): ComputedSource {
  return {
    kind: 'computed',
    name: 'insulation, 10 kb',
    task: 'insulation',
    recipe: { params: { window: 10_000 }, taskVersion: 2, framing: framing('f.mcool', binsize) },
    framing: framing('f.mcool', binsize).label,
  }
}

function provenance(binsize: number): Provenance {
  return {
    task: 'insulation',
    taskVersion: 2,
    params: { window: 10_000 },
    framing: framing('f.mcool', binsize),
    createdAt: '2026-08-10T00:00:00Z',
    app: 'test',
  }
}

/** A worker client that answers nothing and remembers what it was told. */
function client(): { client: AnnotationClient; registered: Array<[string, BinVector]> } {
  const registered: Array<[string, BinVector]> = []
  return {
    registered,
    client: {
      request: (message: { kind: string; entry: string; vector: BinVector }) => {
        if (message.kind === 'register') registered.push([message.entry, message.vector])
        return Promise.resolve({})
      },
      drop: () => {},
      destroy: () => {},
    } as unknown as AnnotationClient,
  }
}

interface Bench {
  workspace: AnalysisWorkspace
  store: AnnotationStore
  registered: Array<[string, BinVector]>
}

/**
 * A workspace over a file at one resolution, optionally handed what the previous
 * one was holding — which is exactly the seam `Session` uses.
 */
function bench(uri: string, binsize: number, carried: readonly CarriedResult[] = []): Bench {
  const store = new AnnotationStore(`carry|${uri}|${Math.random()}`)
  store.clear()
  const worker = client()
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context(uri, binsize),
    framing: () => framing(uri, binsize),
    block: () => null,
    store: () => store,
    annotations: () => worker.client,
    contigs: () => grid(binsize),
    carried: () => carried,
    changed: () => {},
  }
  return { workspace: new AnalysisWorkspace(host), store, registered: worker.registered }
}

/** One computed profile row, as the workspace that computed it would hand it on. */
function carriedProfile(binsize: number, over: Partial<{ visible: boolean }> = {}): CarriedResult {
  const output = profileOf(binsize)
  const entry = syntheticEntry(output, computedSource(binsize), '#0072b2')
  return {
    entry: { ...entry, ...over },
    profile: {
      output,
      provenance: provenance(binsize),
      task: 'insulation',
      grid: grid(binsize).map((contig) => ({ ...contig })),
    },
  }
}

describe('a computed track across a change of resolution', () => {
  it('arrives in the new workspace as the ready row it was', () => {
    const at5k = bench('f.mcool::resolutions/5000', 5000, [carriedProfile(1000)])
    const row = at5k.store.byId(syntheticId('insulation:w10'))
    expect(row?.status).toBe('ready')
    expect(row?.card).toBe('synthetic')
    expect(row?.kind).toBe('track')
    expect(row?.source.kind).toBe('computed')
    at5k.workspace.destroy()
  })

  /**
   * The claim that makes the numbers mean anything. The map is now on 5 kb bins
   * and the vector is not; what was registered has to say 1 kb, over the contig
   * offsets 1 kb produces, or every value lands five times too far along.
   */
  it('is registered on the grid it was computed on, not the one now under it', () => {
    const at5k = bench('f.mcool::resolutions/5000', 5000, [carriedProfile(1000)])
    expect(at5k.registered).toHaveLength(1)
    const [entry, vector] = at5k.registered[0]
    expect(entry).toBe(syntheticId('insulation:w10'))
    expect(vector.binsize).toBe(1000)
    expect(vector.contigs[0].bins).toBe(grid(1000)[0].bins)
    // …and emphatically not the assembly the new file reports.
    expect(vector.contigs[0].bins).not.toBe(grid(5000)[0].bins)
    at5k.workspace.destroy()
  })

  /** A copy, because the worker takes ownership of what it is sent. */
  it('keeps its own values after handing a copy to the worker', () => {
    const carried = carriedProfile(1000)
    const at5k = bench('f.mcool::resolutions/5000', 5000, [carried])
    const [, vector] = at5k.registered[0]
    expect(Array.from(vector.values)).toEqual(Array.from(carried.profile!.output.values))
    expect(vector.values).not.toBe(carried.profile!.output.values)
    at5k.workspace.destroy()
  })

  /**
   * Everything the reader decided about the lane comes with it. A track that
   * survives the switch and comes back drawn, blue and at the bottom is, from
   * the chair, a track that did not survive.
   */
  it('brings the colour, the edge and the hidden flag with it', () => {
    const carried = carriedProfile(1000, { visible: false })
    carried.entry = {
      ...carried.entry,
      label: 'insulation (renamed)',
      style: { ...carried.entry.style, colour: '#abcdef', group: 'insulation' },
    }
    const at5k = bench('f.mcool::resolutions/5000', 5000, [carried])
    const row = at5k.store.byId(syntheticId('insulation:w10'))
    expect(row?.label).toBe('insulation (renamed)')
    expect(row?.style.colour).toBe('#abcdef')
    expect(row?.style.group).toBe('insulation')
    expect(row?.visible).toBe(false)
    expect(row?.placement.left).toBe(true)
    at5k.workspace.destroy()
  })

  /** Called intervals are an overlay, and their coordinates are base pairs. */
  it('brings a called interval set back with its features', () => {
    const builder = new FeatureBuilder()
    builder.add('chrIV', 120_000, 121_000, { score: 0.83 })
    const entry = {
      id: 'analysis:insulation:insulation-boundaries',
      card: 'overlay' as const,
      kind: 'segments' as const,
      label: 'Insulation boundaries',
      source: computedSource(1000),
      status: 'ready' as const,
      visible: true,
      placement: emptyPlacement(),
      style: defaultStyle('segments', '#d55e00'),
      payload: { kind: 'features' as const, data: builder.finish() },
    }
    const at5k = bench('f.mcool::resolutions/5000', 5000, [{ entry }])
    const drawn = at5k.store.overlays()
    expect(drawn).toHaveLength(1)
    expect(drawn[0].payload?.kind === 'features' && drawn[0].payload.data.length).toBe(1)
    at5k.workspace.destroy()
  })

  /**
   * And a row that had nothing behind it in the first place stays that way. A
   * detached row is a recipe waiting for a Recompute; replaying it as `ready`
   * would give the reader a lane with no numbers in it.
   */
  it('leaves a detached row detached rather than promoting it', () => {
    const carried = carriedProfile(1000)
    const at5k = bench('f.mcool::resolutions/5000', 5000, [
      { entry: { ...carried.entry, status: 'detached', summary: 'recompute to draw it again' } },
    ])
    const row = at5k.store.byId(syntheticId('insulation:w10'))
    expect(row?.status).toBe('detached')
    expect(row?.summary).toBe('recompute to draw it again')
    expect(at5k.registered).toHaveLength(0)
    at5k.workspace.destroy()
  })
})

describe('what a workspace hands on', () => {
  it('is a round trip: what came in is what goes out', () => {
    const at1k = bench('f.mcool::resolutions/1000', 1000, [carriedProfile(1000)])
    const out = at1k.workspace.carry()
    expect(out).toHaveLength(1)
    expect(out[0].entry.id).toBe(syntheticId('insulation:w10'))
    expect(out[0].profile?.grid[0].bins).toBe(grid(1000)[0].bins)
    expect(out[0].profile?.output.binsize).toBe(1000)
    at1k.workspace.destroy()
  })

  /**
   * Only what it computed. Dropped tracks travel by the other road — the loader
   * still holds their handles — and a row collected twice would be begun twice.
   */
  it('is the computed rows and nothing else', () => {
    const at1k = bench('f.mcool::resolutions/1000', 1000, [carriedProfile(1000)])
    at1k.store.begin({
      card: 'linear',
      kind: 'track',
      id: 'a1',
      label: 'a dropped bigWig',
      source: { kind: 'remote', url: 'https://example.org/x.bw', name: 'x.bw' },
    })
    at1k.store.update('a1', { status: 'ready' })
    expect(at1k.store.entries).toHaveLength(2)
    expect(at1k.workspace.carry().map((row) => row.entry.id)).toEqual([
      syntheticId('insulation:w10'),
    ])
    at1k.workspace.destroy()
  })

  it('is empty on a file that carries no annotations at all (§8.5)', () => {
    const store = new AnnotationStore(`carry-none-${Math.random()}`)
    store.clear()
    const host: AnalysisWorkspaceHost = {
      source: () => null,
      context: () => context('community.metacool', 10_000),
      framing: () => framing('community.metacool', 10_000),
      block: () => null,
      store: () => null,
      annotations: () => null,
      contigs: () => grid(10_000),
      changed: () => {},
    }
    const workspace = new AnalysisWorkspace(host)
    expect(workspace.carry()).toEqual([])
    workspace.destroy()
  })
})
