/**
 * A per-bin result becoming a track (§18.5), at the two joints where it can go
 * wrong quietly.
 *
 * The first is the **id**. `mintAnnotationId` hands out `a` followed by a
 * number, the counter behind it restarts at one on every page load, and
 * `reserveAnnotationId` reads a restored id back by taking `Number` of
 * everything after the first character. A synthetic id of that shape would
 * therefore be handed to the next file dropped after a reload — and two rows
 * under one id is not two tracks, because `update` patches every match and
 * `remove` deletes every match, so the pair would move and die together with
 * neither able to be taken away. This is the failure `VIEWPOINT_ID` already
 * dodges by being `'4c'`, and it is silent until somebody deletes a track and
 * watches an unrelated one vanish with it.
 *
 * The second is the **recipe**. The values are megabytes and are deliberately
 * not persisted; what a reload gets back is the task and everything needed to
 * run it again, and a row that returns without one is a **Recompute** button
 * that cannot — which `AnnotationStore.stored` drops on the way out rather than
 * restore. So the round trip is the test: what the card puts in must be what
 * comes back.
 */

import { describe, expect, it } from 'vitest'

import type { ProfileOutput } from '../../src/analysis/types'
import { FeatureBuilder } from '../../src/annotations/featureset'
import { AnnotationLoader } from '../../src/annotations/loader'
import { AnnotationStore, mintAnnotationId } from '../../src/annotations/store'
import { defaultStyle, emptyPlacement } from '../../src/annotations/types'
import type { AnnotationPayload, ComputedSource } from '../../src/annotations/types'
import {
  SYNTHETIC_PREFIX,
  groupNameOn,
  syntheticEntry,
  syntheticId,
} from '../../src/ui/SyntheticCard'

/** The shape `mintAnnotationId` produces, and the one nothing else may take. */
const MINTED = /^a\d+$/

function profile(id: string, values: number[] = [1, Number.NaN, 3]): ProfileOutput {
  return {
    kind: 'profile',
    id,
    label: 'insulation, 10 kb',
    values: Float32Array.from(values),
    extent: [0, values.length],
    binsize: 1000,
    unit: '',
  }
}

function source(): ComputedSource {
  return {
    kind: 'computed',
    name: 'insulation, 10 kb',
    task: 'insulation',
    recipe: { params: { window: 10_000, seed: 1 }, taskVersion: 2, framing: { binsize: 1000 } },
    framing: 'chrIV:1–1,531,933 at 1 kb, balanced, count',
  }
}

/** The entry, in a store, ready — which is what `begin` plus one `update` is. */
function stored(uri: string, output: ProfileOutput): AnnotationStore {
  const store = new AnnotationStore(uri)
  store.clear()
  const computed = source()
  const entry = syntheticEntry(output, computed, '#0072b2')
  store.begin({
    id: entry.id,
    card: entry.card,
    kind: entry.kind,
    label: entry.label,
    // The entry's own `source` widens to the union `AnnotationEntry` allows,
    // which includes the two cases `begin` has no way to accept; the computed
    // one is what went in and is what goes back.
    source: computed,
    placement: entry.placement,
    style: entry.style,
  })
  store.update(entry.id, { status: entry.status })
  return store
}

describe('the id a synthetic track gets', () => {
  it('is never of the shape a loaded track is minted with', () => {
    expect(mintAnnotationId()).toMatch(MINTED)
    // Every one of these is an output id a task could plausibly hand over,
    // including the three chosen to look as much like a minted id as possible.
    for (const id of ['insulation:w10', 'ps', '1', '7', 'a1', 'a12345', '']) {
      expect(syntheticId(id)).not.toMatch(MINTED)
      expect(syntheticId(id).startsWith(SYNTHETIC_PREFIX)).toBe(true)
    }
    expect(syntheticEntry(profile('a9'), source(), '#0072b2').id).not.toMatch(MINTED)
  })

  /**
   * "Run on all maps" is what made the second half of this matter.
   *
   * The id was the output's alone, so a batch over five replicates produced five
   * coverage tracks under one id: each `begin` replaced the row before it, and
   * each placement moved the single surviving lane onto the next panel and off
   * the last. What came back from a five-map batch was one track, on the fifth
   * map, and four maps with nothing drawn on them — which reads as the batch
   * having silently failed rather than as five results landing on top of one
   * another.
   */
  describe('once a deck can measure more than one map', () => {
    it('is different for every map, so a batch leaves a row per panel', () => {
      const ids = ['lead', 'p1', 'p2', 'p3'].map((map) => syntheticId('coverage', map))
      expect(new Set(ids).size).toBe(4)
      for (const id of ids) expect(id.startsWith(SYNTHETIC_PREFIX)).toBe(true)
    })

    /**
     * Not cosmetic: a session restored from a reload, and every `Recompute` on a
     * row written before decks existed, resolves through this function. Prefixing
     * the ordinary case would orphan all of them.
     */
    it('leaves the lead’s id exactly as it has always been', () => {
      expect(syntheticId('coverage', 'lead')).toBe(syntheticId('coverage'))
      expect(syntheticId('coverage')).toBe(`${SYNTHETIC_PREFIX}coverage`)
    })

    it('still lands a second run of one map on the row already there', () => {
      // The whole reason the id is derived rather than minted: Recompute must
      // replace its own numbers, not stack a second lane of them beside it.
      expect(syntheticId('coverage', 'p1')).toBe(syntheticId('coverage', 'p1'))
    })

    it('never mints an id a loaded track could be given', () => {
      for (const id of ['insulation:w10', 'ps', '1', 'a12345', '']) {
        expect(syntheticId(id, 'p7')).not.toMatch(MINTED)
      }
    })

    it('names the map in the label, so five rows are not five `coverage`s', () => {
      const on = { map: 'p1', label: 'rep2.mcool::1000' }
      const plain = syntheticEntry(profile('coverage'), source(), '#0072b2')
      expect(syntheticEntry(profile('coverage'), source(), '#0072b2', on).label).toBe(
        `${plain.label} · rep2.mcool::1000`,
      )
      // …and says nothing extra about the lead, which is every session that has
      // never opened a deck.
      expect(
        syntheticEntry(profile('coverage'), source(), '#0072b2', {
          map: 'lead',
          label: 'first.cool',
        }).label,
      ).toBe(syntheticEntry(profile('coverage'), source(), '#0072b2').label)
    })
  })

  /**
   * And it does not move the counter either, which is the other half of the
   * same guarantee: `begin` reserves any id handed to it, so an id whose tail
   * parsed as a large number would push every subsequent minted id past it and
   * leave a gap that a *restored* row is already sitting in.
   */
  it('leaves the mint alone when a row carrying it enters a store', () => {
    const store = stored(`synth-mint-${Math.random()}.cool`, profile('99999'))
    const next = mintAnnotationId()
    expect(next).toMatch(MINTED)
    expect(store.byId(next)).toBeUndefined()
    expect(store.entries.map((entry) => entry.id)).not.toContain(next)
  })

  // Two runs of one task are one row, not two lanes of the same numbers: the id
  // is derived from the output rather than minted, and `begin` replaces an id it
  // already holds in place.
  it('is stable across a recompute of the same output', () => {
    const first = syntheticEntry(profile('insulation:w10'), source(), '#0072b2')
    const again = syntheticEntry(profile('insulation:w10', [4, 5, 6]), source(), '#d55e00')
    expect(again.id).toBe(first.id)
  })
})

describe('what a synthetic row is', () => {
  it('is an ordinary ready track on the synthetic card', () => {
    const entry = syntheticEntry(profile('insulation:w10'), source(), '#0072b2')
    expect(entry.kind).toBe('track')
    expect(entry.card).toBe('synthetic')
    expect(entry.status).toBe('ready')
    expect(entry.visible).toBe(true)
    expect(entry.style.colour).toBe('#0072b2')
    // The **left** edge, which is the one a dropped file never takes — so a
    // computed track arrives beside the reader's own stack rather than in the
    // middle of it. See `SYNTHETIC_EDGE`.
    expect(entry.placement).toEqual({ top: false, right: false, bottom: false, left: true })
  })

  // `NaN` is *no value here* and is skipped rather than propagated: one filtered
  // bin taking the whole extent with it would leave the limits boxes blank.
  it('seeds the limits from the values it has, skipping the gaps', () => {
    expect(syntheticEntry(profile('x', [1, Number.NaN, 3]), source(), '#000').fileExtent).toEqual({
      min: 1,
      max: 3,
    })
    expect(
      syntheticEntry(profile('y', [Number.NaN, Number.NaN]), source(), '#000').fileExtent,
    ).toBeUndefined()
  })
})

describe('what survives a reload (§8.6, §18.5)', () => {
  it('brings the recipe back intact', () => {
    const uri = `synth-keep-${Math.random()}.cool`
    const store = stored(uri, profile('insulation:w10'))
    store.restyle(syntheticId('insulation:w10'), { colour: '#abcdef', group: 'insulation' })

    const rows = AnnotationStore.stored(uri)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(syntheticId('insulation:w10'))
    expect(rows[0].card).toBe('synthetic')
    expect(rows[0].kind).toBe('track')
    // The whole point of persisting a computed row: the analysis, not a number
    // a colleague has to take on trust.
    expect(rows[0].source).toEqual({
      kind: 'computed',
      name: 'insulation, 10 kb',
      task: 'insulation',
      recipe: source().recipe,
      framing: 'chrIV:1–1,531,933 at 1 kb, balanced, count',
    })
    // …and everything the reader chose about the lane, exactly as a loaded
    // track's row keeps it.
    expect(rows[0].style.colour).toBe('#abcdef')
    expect(rows[0].style.group).toBe('insulation')
    expect(rows[0].placement.left).toBe(true)
  })

  // The values are not among what comes back, and nothing in the stored shape
  // has anywhere to put them — which is the claim §18.5 makes and the reason the
  // row returns `detached` with a Recompute button rather than as a lane.
  it('carries no values with it', () => {
    const uri = `synth-light-${Math.random()}.cool`
    stored(uri, profile('insulation:w10'))
    expect(JSON.stringify(AnnotationStore.stored(uri))).not.toContain('values')
  })

  /**
   * And the recipe survives the *restore*, not merely the save.
   *
   * `AnnotationLoader.restore` used to replace every non-remote source with a
   * `detached` placeholder carrying only a name — which threw the recipe away at
   * the last step, leaving a Recompute button on a row with nothing to recompute
   * from and a summary offering to re-open a file that never existed. Persisting
   * a recipe and then dropping it on the way back in is worse than not
   * persisting one, because the row looks as though it works.
   */
  it('comes back as a computed row, not as a dropped file', () => {
    const uri = `synth-restore-${Math.random()}.cool`
    stored(uri, profile('insulation:w10'))
    const rows = AnnotationStore.stored(uri)

    const back = new AnnotationStore(`${uri}-restored`)
    back.clear()
    new AnnotationLoader(back, null as never, []).restore(rows)

    const entry = back.byId(syntheticId('insulation:w10'))
    expect(entry?.status).toBe('detached')
    expect(entry?.source.kind).toBe('computed')
    expect((entry?.source as ComputedSource).task).toBe('insulation')
    expect((entry?.source as ComputedSource).recipe).toEqual(source().recipe)
    expect(entry?.summary).not.toContain('re-open')
  })
})

/**
 * Opening a second file does not take the first file's answers with it.
 *
 * `Session.carry` collects every `ready` row when a different file is about to
 * open, so that a reader who drops the same tracks beside two maps does not have
 * to drop them twice. A computed row is not one of those: it is an answer *about
 * the file being closed*, and there are no bytes behind it for `toWire` to
 * describe — so carrying one is both wrong and, before this, a thrown
 * `Error: … is a computed track and has no file to load.` on the way out.
 */
describe('carrying rows to the next file', () => {
  it('leaves a computed row behind rather than throwing on it', () => {
    const uri = `synth-carry-${Math.random()}.cool`
    const store = stored(uri, profile('insulation:w10'))
    const entry = store.byId(syntheticId('insulation:w10'))
    expect(entry).toBeDefined()

    const next = new AnnotationStore(`${uri}-next`)
    next.clear()
    const loader = new AnnotationLoader(next, null as never, [])
    expect(() => loader.carry(entry!)).not.toThrow()
    expect(next.entries).toHaveLength(0)
  })
})

/**
 * A called interval set is an overlay, and that is what makes the map draw it.
 *
 * `MatrixPanel.paintOverlays` walks `store.overlays()` and hands any entry with
 * a `features` payload to `render/overlays.ts`'s `drawDiagonalFeatures`. Until
 * §18 there was nothing that could put one there — `loader.cardFor` gives the
 * overlay card to a BEDPE and to nothing else, so a BED was always a lane and
 * that branch never ran, which `HANDOFF.md` §7 reports as known-open. An
 * insulation boundary set is the first thing that reaches it.
 *
 * So this is the link rather than the drawing: the drawing has its own tests
 * (`overlays-turned.test.ts`), and what they cannot check is that anything ever
 * calls them.
 */
describe('a computed interval set, as an overlay', () => {
  function intervals(): AnnotationPayload {
    const builder = new FeatureBuilder()
    builder.add('I', 120_000, 121_000, { score: 0.83 })
    return { kind: 'features', data: builder.finish() }
  }

  /** What `AnalysisWorkspace.adoptIntervals` puts in the store. */
  function overlayRow(uri: string): AnnotationStore {
    const store = new AnnotationStore(uri)
    store.clear()
    const computed: ComputedSource = { ...source(), name: 'Insulation boundaries' }
    store.begin({
      card: 'overlay',
      kind: 'segments',
      id: 'analysis:insulation:insulation-boundaries',
      label: 'Insulation boundaries',
      source: computed,
      placement: emptyPlacement(),
      style: defaultStyle('segments', '#0072b2'),
    })
    store.update('analysis:insulation:insulation-boundaries', {
      status: 'ready',
      payload: intervals(),
    })
    return store
  }

  it('is returned by the query the map paints from, carrying its features', () => {
    const store = overlayRow(`overlay-${Math.random()}.cool`)
    const drawn = store.overlays()
    expect(drawn).toHaveLength(1)
    expect(drawn[0].payload?.kind).toBe('features')
    expect(drawn[0].payload?.kind === 'features' && drawn[0].payload.data.length).toBe(1)
  })

  it('leaves the map alone while it is hidden, like any other overlay', () => {
    const uri = `overlay-hide-${Math.random()}.cool`
    const store = overlayRow(uri)
    store.update('analysis:insulation:insulation-boundaries', { visible: false })
    expect(store.overlays()).toHaveLength(0)
  })

  it('is one row across repeated runs, because the id is the task and the output', () => {
    // A second run of insulation with a wider window is the boundaries the
    // reader now wants, not a second set beside the first. `adoptIntervals`
    // removes and re-begins under the same id; what is asserted here is that
    // the id it derives cannot collide with a minted one.
    const store = overlayRow(`overlay-twice-${Math.random()}.cool`)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].id).not.toMatch(MINTED)
  })
})

/**
 * The display hints a task may send with a profile (§18.11).
 *
 * A task that emits a *set* — insulation at four windows — knows something about
 * how the set reads that no default can work out from one row: they belong
 * together, and they are a matrix rather than four curves. So it may name a
 * group and a drawing style, and they are written into the row's style **once**,
 * on the way in.
 *
 * Once, and into the style, is the whole design. From that moment they are the
 * reader's: renaming the group, breaking it up, or switching a row back to a
 * line are ordinary edits to an ordinary track, and nothing re-asserts the
 * suggestion behind them on the next repaint.
 */
describe('the hints a task sends with a profile', () => {
  function hinted(over: Partial<ProfileOutput>): ProfileOutput {
    return { ...profile('insulation-w20'), ...over }
  }

  it('become the row’s own group and style', () => {
    const entry = syntheticEntry(
      hinted({ group: 'Insulation', mode: 'heatmap' }),
      source(),
      '#0072b2',
    )
    expect(entry.style.group).toBe('Insulation')
    expect(entry.style.mode).toBe('heatmap')
  })

  it('leave a row that carries none exactly as it was', () => {
    const entry = syntheticEntry(profile('coverage'), source(), '#0072b2')
    expect(entry.style.group).toBe('')
    expect(entry.style.mode).toBe(defaultStyle('track', '#0072b2').mode)
  })

  /**
   * A batch runs the task once per map, and one group name across all of them
   * would stack five replicates' rows into one lane — five heatmaps of the same
   * window from five different files, reading as one scale ladder. The label is
   * made specific to the map for the same reason, so the two agree.
   */
  it('name a group per map, as the label is named per map', () => {
    const output = hinted({ group: 'Insulation', mode: 'heatmap' })
    const lead = syntheticEntry(output, source(), '#0072b2', { map: 'lead', label: 'first' })
    const other = syntheticEntry(output, source(), '#0072b2', { map: 'p2', label: 'replicate 2' })
    expect(lead.style.group).toBe('Insulation')
    expect(other.style.group).toBe('Insulation · replicate 2')
    expect(groupNameOn('Insulation')).toBe('Insulation')
  })
})
