/**
 * A curation stage's context over the small community, for DOM tests: the
 * controller counting through the method itself, the file's data, and a drag
 * the test drives by hand.
 */

import { CuratedBinning, fileBinning } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { genomeColour, POOL_COLOUR } from '../../src/curate/colours'
import { CurateModel } from '../../src/curate/model'
import type { CurateContext, CurateDragged, CurateFrame } from '../../src/curate/ui/context'
import { CurationStore } from '../../src/state/curation'
import type { CurationFocusResult } from '../../src/worker/curateProtocol'
import { community } from './curateCommunity'

let keys = 0

export interface TestStage {
  ctx: CurateContext
  model: CurateModel
  store: CurationStore
  said: Array<string | null>
  framed: CurateFrame[]
}

/** A context whose counts answer at once (a macrotask later), as the worker's would. */
export function testContext(): TestStage {
  const { base, evidence } = community()
  const store = new CurationStore(`curate-dom-${++keys}`, base, fileBinning(base), () => 0)
  const model = new CurateModel(store, {
    state: (curation, weights) => ({
      promise: Promise.resolve(stateAnswer(evidence, CuratedBinning.of(base, curation), weights)),
      cancel: () => {},
    }),
  }, { schedule: (run) => (run(), () => {}) })
  const said: Array<string | null> = []
  const framed: CurateFrame[] = []
  const frameListeners = new Set<(target: CurateFrame) => void>()
  let dragging: CurateDragged | null = null
  const ctx: CurateContext = {
    model,
    laidOut: () => false,
    data: {
      title: 'community.metacool',
      file: base,
      gc: Float64Array.from(base.names, (_, c) => 30 + (c % 5) * 5),
      coverage: null,
      coverageLabel: 'Hi-C contacts per kb',
      markerSets: ['Bact4'],
      background: evidence.background.rho,
    },
    colourOf: (id) => genomeColour(Math.max(0, base.genomes.findIndex((genome) => genome.name === id)), 'mag'),
    shortName: (id) => model.answer?.genomes.find((genome) => genome.id === id)?.name ?? id,
    prefixOf: () => '',
    poolColour: { css: POOL_COLOUR, rgba: 0xff7a7a7a },
    ink: () => ({ text: '#111', dim: '#555', faint: '#777', accent: '#1f5fa9', accentSoft: '#dce8f7', background: '#fff', font: '10px sans-serif' }),
    focus: () => ({ promise: new Promise<CurationFocusResult>(() => {}), cancel: () => {} }),
    say: (text) => said.push(text),
    frame: (target) => {
      framed.push(target)
      for (const listener of frameListeners) listener(target)
    },
    onFrame: (listener) => {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    startDrag: (dragged) => {
      dragging = dragged
    },
    get dragging() {
      return dragging
    },
    dropWords: (target) => {
      if (dragging === null) return null
      const plan = model.dropPlan(dragging, target)
      if (plan === null) return null
      return plan.refused !== undefined ? { words: plan.refused, refused: true } : { words: plan.words, refused: false }
    },
    drop: (target) => {
      if (dragging === null) return false
      const made = model.drop(dragging, target)
      dragging = null
      return made
    },
  }
  return { ctx, model, store, said, framed }
}
