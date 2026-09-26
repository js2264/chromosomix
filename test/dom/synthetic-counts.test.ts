// @vitest-environment jsdom
/**
 * How many things a task found, said on the row that found them.
 *
 * A called set is a number of things, and the number is the first thing anybody
 * wants from it: a detector that returned 3 loops and one that returned 3,000
 * are different results, and a reader deciding whether to trust a run is reading
 * that number before anything else. The row of a computed set said the task and
 * the framing and never the count — so *Detected loops* reported everything
 * about the run except its result, and the only way to find out how many was to
 * export the file and count the lines.
 *
 * The same fact was already on screen a few centimetres away, for the other kind
 * of row: a dropped BEDPE has carried `1,204 pairs` under its name since there
 * were rows at all, written by the annotations worker into `summary` and drawn
 * by the Tracks card. So this is one field and one line reused rather than a
 * second mechanism — `adoptIntervals` writes the same `summary`, and the Tracks
 * card draws it on a computed row's line with the task that made it.
 *
 * The **noun is the task's**, which is the part worth pinning: both halves of a
 * loop set are `pairs` to the parser and `boundaries`, `domains`, `segments`,
 * `sites` or `MAGs` to the person who ran the thing, and a row that says
 * `412 features` under *Insulation boundaries* is answering a question about the
 * file format instead of about the finding.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  IntervalsOutput,
  TaskResult,
} from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { FeatureBuilder, PairBuilder } from '@/annotations/featureset'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import { setUpDom, type DomTeardown } from '../support/dom'
import { tracksCardOver } from '../support/tracksCard'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const CONTIGS: BedGraphContig[] = [{ name: 'chrIV', startBin: 0, bins: 1600, length: 1_600_000 }]

function framing(): AnalysisFraming {
  return {
    uri: 'f.mcool',
    label: 'chrIV · 1.0 kb bins · counts',
    binsize: 1000,
    binsPerCell: 1,
    rows: [0, 1600],
    cols: [0, 1600],
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

function context(): AnalysisContext {
  return {
    uri: 'f.mcool',
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: [],
    binsize: 1000,
    nBins: 1600,
    contigs: CONTIGS.map((contig) => ({ ...contig, genome: -1 })),
    genomes: null,
    entries: [],
    framing: framing(),
    blockLoaded: false,
    blockBytes: 0,
  }
}

const TASK = { id: 'chromosight', title: 'Pattern detection' } as unknown as AnalysisTask

/** The seam the runner calls when a task finishes — reached as the lanes test does. */
function finish(workspace: AnalysisWorkspace, output: IntervalsOutput): void {
  const result = {
    outputs: [output],
    provenance: {
      task: TASK.id,
      taskVersion: 1,
      params: {},
      framing: framing(),
      createdAt: '2026-09-10T00:00:00Z',
      app: 'test',
    },
  } as unknown as TaskResult
  ;(
    workspace as unknown as {
      adopt(task: AnalysisTask, result: TaskResult, on: { map: string }): void
    }
  ).adopt(TASK, result, { map: 'lead' })
}

/** `n` loops, as the detector emits them: anchor pairs, called `pairs`. */
function loops(n: number): IntervalsOutput {
  const builder = new PairBuilder()
  for (let at = 0; at < n; at++) {
    const start = at * 10_000
    builder.add('chrIV', start, start + 1000, 'chrIV', start + 50_000, start + 51_000, {
      score: 0.7,
      name: '',
      detail: '',
    })
  }
  return {
    kind: 'intervals',
    id: 'chromosight-patterns',
    label: 'Detected loops',
    payload: { kind: 'pairs', data: builder.finish() },
    noun: { one: 'pair', many: 'pairs' },
  }
}

/** `n` boundaries, which is the case whose plural a naive `+ s` gets wrong. */
function boundaries(n: number): IntervalsOutput {
  const builder = new FeatureBuilder()
  for (let at = 0; at < n; at++) builder.add('chrIV', at * 10_000, at * 10_000 + 1000, { score: 1 })
  return {
    kind: 'intervals',
    id: 'insulation-boundaries',
    label: 'Insulation boundaries',
    payload: { kind: 'features', data: builder.finish() },
    noun: { one: 'boundary', many: 'boundaries' },
  }
}

/** A set from a task that never said what its elements are called. */
function unnamed(n: number): IntervalsOutput {
  const { noun: _ignored, ...rest } = boundaries(n)
  return rest
}

function bench(): { workspace: AnalysisWorkspace; store: AnnotationStore } {
  const store = new AnnotationStore(`counts|${Math.random()}`, { persist: false })
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context(),
    framing: () => framing(),
    block: () => null,
    store: () => store,
    annotations: () =>
      ({ request: () => Promise.resolve({}), drop: () => {} }) as unknown as AnnotationClient,
    contigs: () => CONTIGS,
    carried: () => [],
    changed: () => {},
  }
  return { workspace: new AnalysisWorkspace(host), store }
}

/** Every line of prose on the one row, with its settings open, on the Tracks card. */
function notesOn(workspace: AnalysisWorkspace, store: AnnotationStore): string[] {
  const mounted = tracksCardOver(store, workspace)
  const notes = Array.from(mounted.el.querySelectorAll('.ann-note, .ann-origin')).map(
    (node) => node.textContent ?? '',
  )
  mounted.destroy()
  return notes
}

describe('the count on a called set', () => {
  it('is written onto the row, in the task’s own word', () => {
    const { workspace, store } = bench()
    finish(workspace, loops(1204))
    const row = store.byId('analysis:chromosight:chromosight-patterns')
    expect(row?.summary).toBe('1,204 pairs')
    workspace.destroy()
  })

  it('is shown on the card, beside the task that made it', () => {
    const { workspace, store } = bench()
    finish(workspace, loops(1204))
    const notes = notesOn(workspace, store)
    expect(notes).toContain('Pattern detection · 1,204 pairs')
    // Above the framing, because the count is about the answer and the framing
    // is about the question.
    expect(notes.indexOf('Pattern detection · 1,204 pairs')).toBeLessThan(
      notes.indexOf(framing().label),
    )
    workspace.destroy()
  })

  it('uses the task’s plural rather than a word plus an s', () => {
    const { workspace, store } = bench()
    finish(workspace, boundaries(412))
    expect(store.byId('analysis:chromosight:insulation-boundaries')?.summary).toBe(
      '412 boundaries',
    )
    workspace.destroy()
  })

  it('counts one thing as one thing', () => {
    const { workspace, store } = bench()
    finish(workspace, boundaries(1))
    expect(store.byId('analysis:chromosight:insulation-boundaries')?.summary).toBe('1 boundary')
    workspace.destroy()
  })

  /**
   * Zero is a result, and the one a reader most needs told. A detector that
   * found nothing produces a row, an empty overlay and an export of no lines;
   * without the count that is indistinguishable on screen from a lane whose
   * marks are off the edge of the view.
   */
  it('says so when a task found nothing', () => {
    const { workspace, store } = bench()
    finish(workspace, boundaries(0))
    expect(store.byId('analysis:chromosight:insulation-boundaries')?.summary).toBe('0 boundaries')
    workspace.destroy()
  })

  it('falls back to the payload’s word for a task that named none', () => {
    const { workspace, store } = bench()
    finish(workspace, unnamed(7))
    expect(store.byId('analysis:chromosight:insulation-boundaries')?.summary).toBe('7 intervals')
    workspace.destroy()
  })
})

/**
 * Which controls a computed row is given, which is a question about what the
 * row *is* rather than about which card is listing it.
 *
 * A lane is placed — drawn along one or more of the map's four edges, which is
 * what the placement buttons decide. An **overlay** is not placed at all:
 * `MatrixPanel.paintOverlays` draws every ready, visible entry of
 * `store.overlays()` onto the matrix face and never reads a placement. So the
 * four edge buttons on a called loop set were inert, and pressing the last one
 * filed the row under a map it is not drawn on the strength of — while the two
 * controls that *would* have done something, the opacity and the radius, were
 * private to the one card a computed set never appears on.
 *
 * The Tracks card has always drawn this line correctly for a loaded interval
 * set. This is the same line, in the other place rows are listed.
 */
describe('the controls a called set is given', () => {
  const labelsOn = (workspace: AnalysisWorkspace, store: AnnotationStore): string[] => {
    const mounted = tracksCardOver(store, workspace)
    const labels = Array.from(mounted.el.querySelectorAll('.field-label')).map(
      (node) => node.textContent ?? '',
    )
    mounted.destroy()
    return labels
  }

  it('are the marks’ own, not four edges that cannot move it', () => {
    const { workspace, store } = bench()
    finish(workspace, loops(12))
    const labels = labelsOn(workspace, store)
    expect(labels).not.toContain('location')
    expect(labels).toContain('opacity')
    // A pair is a circle, so its size is the control; a segment is a box or a
    // mark across the diagonal, so its shape is.
    expect(labels).toContain('radius')
    expect(labels).not.toContain('shape')
    workspace.destroy()
  })

  it('are the shape and the opacity for a set of intervals', () => {
    const { workspace, store } = bench()
    finish(workspace, boundaries(88))
    const labels = labelsOn(workspace, store)
    expect(labels).not.toContain('location')
    expect(labels).toContain('shape')
    expect(labels).toContain('opacity')
    expect(labels).not.toContain('radius')
    workspace.destroy()
  })

  it('really do change the marks, through the same store the map paints from', () => {
    const { workspace, store } = bench()
    finish(workspace, loops(12))
    const id = 'analysis:chromosight:chromosight-patterns'
    const mounted = tracksCardOver(store, workspace)
    const slider = mounted.el.querySelector<HTMLInputElement>('.ann-range')
    expect(slider).not.toBeNull()
    slider!.value = '18'
    slider!.dispatchEvent(new Event('input', { bubbles: true }))
    expect(store.byId(id)?.style.radius).toBe(18)
    mounted.destroy()
    workspace.destroy()
  })
})
