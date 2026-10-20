/**
 * The two halves of the task catalogue, checked against each other.
 *
 * `analysis/registry.ts` is what the panel offers and `analysis/run/index.ts` is
 * what the worker can run, and they are separate modules on purpose — the split
 * `analysis/job.ts` describes is what keeps `MetaCooler` out of the main-thread
 * bundle. The cost of that is a pair of lists nothing forces to agree, and both
 * ways of disagreeing are invisible in either file: an id in `RUNNERS` with no
 * descriptor is a task that can be run and is never offered, and a descriptor
 * with no runner is a row that fails the instant somebody clicks it. The stub
 * that `run/index.ts` grew up as promised this test, and here it is.
 *
 * The rest is the doctrine `tasksFor` implements. §8.5, restated by §18.1: **a
 * task that means nothing on this file is absent, not disabled.** A filter that
 * quietly reordered its output, or that let a task through whose `appliesTo`
 * said no, would be a panel row that lies about the open file — so both are
 * asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest'

import { buildAnalysisContext } from '@/analysis/context'
import { TASK_GROUP_LABELS, TASKS, runnableTasks, taskById, tasksFor } from '@/analysis/registry'
import { RUNNERS } from '@/analysis/run/index'
import { TRACK_RUNNERS } from '@/analysis/run/tracks'
import { defaultParams } from '@/analysis/types'
import type { AnalysisContext, AnalysisTask } from '@/analysis/types'
import { defaultStyle } from '@/annotations/types'
import type { AnnotationEntry } from '@/annotations/types'

/** A context for a file with nothing in it but bins — the weakest real case. */
/** A loaded file, at the point a task could use it as an input. */
function entry(id: string, kind: 'track' | 'segments' | 'pairs'): AnnotationEntry {
  return {
    id,
    card: kind === 'pairs' ? 'overlay' : 'linear',
    kind,
    label: id,
    source: { kind: 'remote', url: `https://example.invalid/${id}`, name: id },
    status: 'ready',
    visible: true,
    placement: { top: false, right: false, bottom: true, left: false },
    style: defaultStyle(kind, '#0072b2'),
  }
}

function context(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    ...buildAnalysisContext({
      uri: 'test.cool',
      layout: 'cool',
      binsize: 1000,
      nBins: 100,
      hasGenomes: false,
      hasWeights: false,
      scoreColumns: ['count'],
      contigs: {
        length: 1,
        columns: ['name', 'length'],
        data: { name: ['chrI'], length: Float64Array.from([100_000]) },
      },
      genomes: null,
      displayGenomes: null,
      entries: [],
      framing: null,
      blockLoaded: false,
      blockBytes: 0,
    }),
    ...overrides,
  }
}

describe('the analysis registry', () => {
  it('has a runner for every task it offers, in that task’s own venue', () => {
    // Two maps, because there are two venues (`analysis/job.ts`): a task runs
    // where its inputs already are. Checking only one of them is how a task
    // ends up offered by the panel and unrunnable when clicked — which is the
    // exact mistake this test caught the day the annotations venue arrived.
    const missing = TASKS.filter((task) =>
      task.venue === 'annotations' ? TRACK_RUNNERS[task.id] === undefined : RUNNERS[task.id] === undefined,
    ).map((task) => task.id)
    expect(missing).toEqual([])
  })

  it('has a task for every runner it registers', () => {
    const orphans = [...Object.keys(RUNNERS), ...Object.keys(TRACK_RUNNERS)].filter(
      (id) => taskById(id) === undefined,
    )
    expect(orphans).toEqual([])
  })

  it('registers each runner in exactly one venue', () => {
    // A task in both maps would run in whichever worker the router happened to
    // reach first, which is a difference nobody would see until one of the two
    // could not answer.
    const both = Object.keys(RUNNERS).filter((id) => TRACK_RUNNERS[id] !== undefined)
    expect(both).toEqual([])
  })

  it('gives every task a distinct id', () => {
    const ids = TASKS.map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a heading for every group a task claims', () => {
    for (const task of TASKS) {
      expect(TASK_GROUP_LABELS[task.group]).toBeTruthy()
    }
  })

  it('finds a task by id and answers undefined for one it has never heard of', () => {
    expect(taskById('expected')?.title).toBe('Contact probability P(s)')
    expect(taskById('a-task-from-a-later-build')).toBeUndefined()
  })
})

describe('tasksFor', () => {
  it('keeps registry order rather than any order of its own', () => {
    const offered = tasksFor(context()).map((task) => task.id)
    const expected = TASKS.filter(
      (task) => task.availability(context()).state !== 'absent',
    ).map((task) => task.id)
    expect(offered).toEqual(expected)
  })

  /**
   * The doctrine, applied where it belongs and only there.
   *
   * A metagenome task on a plain cooler is `absent`, because the file has no
   * `/genomes` table and nothing the reader does next produces one — listing it
   * would be offering something not on the menu. A task waiting for a file the
   * reader *can* drop is a different claim and gets a different answer.
   */
  it('leaves out what this file can never do', () => {
    const offered = tasksFor(context()).map((task) => task.id)
    expect(offered).not.toContain('magqc')
    expect(offered).not.toContain('magpurity')
  })

  it('lists what is one drag away, rather than hiding the feature', () => {
    // APA used to vanish on a file with no loop set, which taught a reader who
    // had not met the app before that it does not do aggregate peak analysis.
    const offered = tasksFor(context())
    const apa = offered.find((task) => task.id === 'apa')
    expect(apa, 'APA is listed').toBeDefined()
    const state = apa?.availability(context())
    expect(state?.state).toBe('waiting')
    expect(state?.state === 'waiting' && state.needs).toMatch(/loop set|feature set/i)
  })

  it('offers P(s) on a plain cooler with nothing else loaded', () => {
    // The claim `analysis/tasks/ps.ts` opens with: every contact map has a
    // diagonal, so the panel is never empty on a file this app can open at all.
    const ready = runnableTasks(context()).map((task) => task.id)
    expect(ready).toContain('expected')
  })
})

/**
 * A 1D browser session (§5.8) has an assembly, tracks, and no matrix — and the
 * Analysis panel belongs there too. Three tasks run entirely on loaded tracks,
 * and hiding the column would mean a reader who came in through a bigWig never
 * learns that comparing two of them is one click away.
 */
describe('a session with no contact map', () => {
  const noMap = (entries: AnalysisContext['entries'] = []): AnalysisContext =>
    context({ hasMap: false, binsize: 0, nBins: 0, entries })

  it('still offers a panel, rather than none at all', () => {
    expect(tasksFor(noMap()).length).toBeGreaterThan(0)
  })

  it('greys every task that reads the matrix, and says why', () => {
    for (const id of ['expected', 'insulation', 'fourc', 'coverage']) {
      const task = tasksFor(noMap()).find((candidate) => candidate.id === id)
      expect(task, id).toBeDefined()
      const state = task?.availability(noMap())
      expect(state?.state, id).toBe('waiting')
      expect(state?.state === 'waiting' && state.needs).toMatch(/contact map/i)
    }
  })

  it('runs the track tasks, which never needed a map', () => {
    const tracks: AnalysisContext['entries'] = [
      entry('a', 'track'),
      entry('b', 'track'),
      entry('c', 'segments'),
      entry('d', 'segments'),
    ]
    const ready = runnableTasks(noMap(tracks)).map((task) => task.id)
    expect(ready).toContain('trackcorr')
    expect(ready).toContain('overlap')
    expect(ready).toContain('metaplot')
  })

  it('does not offer a metagenome task it cannot know about yet', () => {
    // With nothing open there is no file to say no on behalf of, so a MAG task
    // is listed and waiting rather than absent — the reader can open one.
    const state = tasksFor(noMap()).find((task) => task.id === 'magqc')?.availability(noMap())
    expect(state?.state).toBe('waiting')
    expect(state?.state === 'waiting' && state.needs).toMatch(/metagenome/i)
  })
})

describe('every descriptor', () => {
  const each = (check: (task: AnalysisTask) => void): void => {
    for (const task of TASKS) check(task)
  }

  it('names itself with something other than its title', () => {
    each((task) => {
      expect(task.id).not.toBe('')
      expect(task.id).not.toBe(task.title)
      expect(task.blurb).not.toBe('')
    })
  })

  it('gives every parameter a distinct key', () => {
    each((task) => {
      const keys = task.params.map((spec) => spec.key)
      expect(new Set(keys).size).toBe(keys.length)
    })
  })

  it('declares at least one output kind', () => {
    each((task) => {
      expect(task.outputs.length).toBeGreaterThan(0)
    })
  })

  /**
   * A `column` parameter points at another parameter *by key*, and a rename
   * would break the link with no type error and no failing task — the control
   * would simply stop following the thing it was supposed to follow.
   */
  it('resolves every parameter that names another one', () => {
    each((task) => {
      const keys = new Set(task.params.map((spec) => spec.key))
      for (const spec of task.params) {
        if (spec.kind === 'column') {
          expect(keys, `${task.id}.${spec.key} → ${spec.from}`).toContain(spec.from)
        }
      }
    })
  })

  /**
   * A reader looking at a map who wants a profile through a spot on it has
   * already got the spot in front of them, and reading coordinates off the
   * picture to type them back in is the thing the button exists to save. The
   * button is only offered where a map exists, which `ParamForm` decides — this
   * checks the half the descriptor owns.
   */
  it('lets 4C pick its anchor on the map', () => {
    const task = TASKS.find((candidate) => candidate.id === 'fourc')
    expect(task).toBeDefined()
    const anchor = task?.params.find((spec) => spec.key === 'anchor')
    expect(anchor?.kind).toBe('region')
    expect(anchor?.kind === 'region' && anchor.pickable).toBe(true)
  })

  /**
   * **Nothing ticked is nothing to read, and the estimate says so.**
   *
   * The five tasks that moved from a sequence dropdown to the tick boxes gained
   * a state the dropdown had no way to be in: a reader can press **none**. The
   * one thing it must not become is a genome-wide run — an empty answer that
   * quietly widens is the failure `SequencesParam` was written against — so it
   * is priced as nothing and refused with the sentence chromosight's own tick
   * boxes have always used. Unanswered stays the whole file, which is what the
   * empty region string it replaces meant.
   */
  it('refuses a run with no sequence ticked, and prices an unanswered one', () => {
    // Every task that takes the list, cis/trans and reproducibility included.
    // Those two were left out once, on the ground that the list there narrows
    // what is *reported* out of a pass that reads the whole file either way —
    // and so an empty one ran, and came back as every sequence: a whole-file
    // answer to a reader who had pressed **none**, which is the one thing
    // §18.2 says nothing ticked must not become.
    const perSequence = [
      'expected',
      'scalogram',
      'insulation',
      'di',
      'hicscore',
      'compartments',
      'cistrans',
      'hicrep',
    ]
    // A second map on the same grid, without which reproducibility refuses for
    // a reason of its own before the list is asked about.
    const deck = context({ peers: [{ label: 'rep2', uri: 'rep2.cool', binsize: 1000 }] })
    for (const id of perSequence) {
      const task = taskById(id)
      expect(task, id).toBeDefined()
      if (task === undefined) continue
      expect(task.params.some((spec) => spec.kind === 'sequences'), id).toBe(true)
      const none = task.estimate(deck, { ...defaultParams(task.params), sequences: [] })
      expect(none.refusal, id).toBe(
        id === 'compartments'
          ? 'Tick at least one sequence. All of them is the genome-wide compartment call.'
          : 'Tick at least one sequence.',
      )
      expect(none.requests, id).toBe(0)
      const all = task.estimate(deck, { ...defaultParams(task.params), sequences: null })
      expect(all.refusal, id).toBeUndefined()
    }
  })

  /**
   * **A hint is one sentence, and it is prose (§26.4).**
   *
   * The rule was written down and nothing held it, so a third of the catalogue's
   * hints had grown a second sentence and a few had grown three — which is a
   * paragraph beside a control, in a column whose Run button it pushes off the
   * screen. Two kinds of line are exempt by the rule itself and only two: a
   * **toggle** may add what its *off* state does, because the control cannot
   * show it, and an **option**'s own hint is a tooltip rather than a row and is
   * where anything longer belongs.
   *
   * The rest of the rule is about what a hint is *made of*: no section numbers,
   * because a reader who needs §18.6 is reading the wrong document; no
   * backticks, no Markdown, because nothing renders them — they reach the DOM as
   * punctuation.
   */
  it('keeps every hint to one sentence, in prose', () => {
    const sentences = (text: string): number => text.split(/[.!?] +(?=[A-Z0-9])/).length
    each((task) => {
      for (const spec of task.params) {
        if (spec.hint === undefined) continue
        const where = `${task.id}.${spec.key}`
        expect(sentences(spec.hint), where).toBeLessThanOrEqual(spec.kind === 'toggle' ? 2 : 1)
        expect(spec.hint, where).not.toMatch(/[`*_]|§/)
        // A trailing full stop, because it is a sentence.
        expect(spec.hint, where).toMatch(/[.!?]$/)
      }
    })
  })

  /**
   * And a hint that says only what the control says is deleted rather than
   * reworded. The two the audit named were a tick-box list's *every one, unless
   * you say otherwise* — which is what an all-ticked column of boxes looks like
   * — and a locus box's *the locus the profile reads from: a span, a sequence,
   * or on a metagenome a whole genome*, which was the box's own tooltip repeated
   * underneath it. Pinned by their keys, since the words are gone.
   */
  it('asks the tick boxes and the anchor box without a line under them', () => {
    const hintOf = (id: string, key: string): string | undefined =>
      TASKS.find((task) => task.id === id)?.params.find((spec) => spec.key === key)?.hint
    expect(hintOf('chromosight', 'sequences')).toBeUndefined()
    expect(hintOf('cistrans', 'sequences')).toBeUndefined()
    expect(hintOf('fourc', 'anchor')).toBeUndefined()
    // Compartments keeps one, and it is the reason the rule is about *facts*
    // rather than about length: ticking several sequences there gives **one**
    // eigenvector over all of them under two of the three *contacts* settings,
    // and one per sequence under the default — which no arrangement of tick
    // boxes says. It used to name the first answer alone, under the setting
    // that never gives it.
    const hint = hintOf('compartments', 'sequences')
    expect(hint).toMatch(/One correlation per sequence under “cis only”/)
    expect(hint).toMatch(/one over all of them under “cis and trans” or “trans only”/)
    // By the labels the *contacts* control actually carries, so a renamed
    // option cannot leave the hint naming one the form does not show.
    const contacts = TASKS.find((task) => task.id === 'compartments')?.params.find(
      (spec) => spec.key === 'contacts',
    )
    const labels = contacts?.kind === 'choice' ? contacts.options.map((option) => option.label) : []
    expect(labels).toHaveLength(3)
    for (const label of labels) expect(hint).toContain(`“${label}”`)
  })
})

/**
 * Each card's reading order.
 *
 * Registry order is a reading order rather than an alphabetical one, and each
 * card's is an argument. **2D:** what every bin *has* (coverage and the
 * marginals), then how contact falls away from it (P(s)), then the same decay
 * kept per bin instead of averaged (the scalogram), then one locus's slice of
 * it (4C), then the domains it resolves into — insulation, the directionality
 * index that reads the same edge from its asymmetry, and the HiC score that
 * says how much contact is there at all — then the compartments those domains
 * sit in; then detection, the only one that makes a claim rather than a
 * summary, which needs the decay the tasks above it describe and produces the
 * loop set the pileup below it takes. **3D:** the task that *makes* a model
 * first, because the other two read one. **1D:** the task that *makes* an
 * interval set first, for the same reason. Pinned because the argument is
 * invisible in an array literal and reordering it is one line.
 */
describe('the cards', () => {
  const idsIn = (group: string): string[] =>
    TASKS.filter((task) => task.group === group).map((task) => task.id)

  it('come out in the order the panel draws them', () => {
    const order: string[] = []
    for (const task of TASKS) if (!order.includes(task.group)) order.push(task.group)
    expect(order).toEqual(['2d', '3d', '1d', 'metagenome'])
  })

  it('reads the 2D card outward from the axis', () => {
    expect(idsIn('2d')).toEqual([
      'coverage',
      'cistrans',
      'cellqc',
      'expected',
      'scalogram',
      'fourc',
      'insulation',
      'di',
      'hicscore',
      'compartments',
      'interarm',
      // Detection, the caller built for loops before the one that matches any
      // of five templates, a loop among them.
      'loops',
      'chromosight',
      'hicrep',
      // The pileup is about the matrix — it piles the matrix up at a set of
      // places — so it is 2D, beside the detection that finds the places.
      'apa',
    ])
  })

  it('opens the 3D card with the task that makes a model', () => {
    // A reader with no structure loaded has exactly one thing to do in this
    // card, and it should be the first row rather than the third.
    expect(idsIn('3d')).toEqual(['reconstruct3d', 'structuremap', 'spatialtracks'])
  })

  it('opens the 1D card with the tasks that make an interval set', () => {
    // A motif search and a peak call produce exactly the input the tasks below
    // them take — one from the sequence, the other from a track. Two sequence
    // sets against each other come last, a dev feature (§28, §29).
    expect(idsIn('1d')).toEqual([
      'motif',
      'peaks',
      'composition',
      'oriter',
      'metaplot',
      'trackcorr',
      'frip',
      'groupsignal',
      'overlap',
      'dotplot',
    ])
  })

  it('keeps the metagenome tasks together rather than cutting them by dimension', () => {
    // A MAG is a bin of an assembly, not a dimension: *split-MAG detection*
    // belongs beside *MAG purity* rather than beside *compartments*.
    expect(idsIn('metagenome')).toEqual(['magqc', 'magnetwork', 'magpurity', 'magsplit'])
  })
})
