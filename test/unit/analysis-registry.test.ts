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
    for (const id of ['expected', 'insulation', 'fourc', 'coverage', 'cid']) {
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
   * Three parameters point at another parameter *by key*, and a rename would
   * break the link with no type error and no failing task — the control would
   * simply stop following the thing it was supposed to follow, which on
   * `fromMap` means a locus box that quietly goes back to being a text box.
   */
  it('resolves every parameter that names another one', () => {
    each((task) => {
      const keys = new Set(task.params.map((spec) => spec.key))
      for (const spec of task.params) {
        if (spec.kind === 'column') {
          expect(keys, `${task.id}.${spec.key} → ${spec.from}`).toContain(spec.from)
        }
        if (spec.kind === 'region' && spec.fromMap !== undefined) {
          expect(keys, `${task.id}.${spec.key} → ${spec.fromMap}`).toContain(spec.fromMap)
          const toggle = task.params.find((other) => other.key === spec.fromMap)
          expect(toggle?.kind, `${task.id}.${spec.fromMap} is a toggle`).toBe('toggle')
        }
      }
    })
  })

  /**
   * The map's anchor gesture has existed since §8.9 and the 4C *lane* has always
   * drawn from it; the task asked for the same locus again in a text box. On by
   * default, because a reader who is looking at a map and wants a profile
   * through a spot on it has already told the app where — twice would be once
   * too many.
   */
  it('has 4C picking its anchor on the map, by default', () => {
    const task = TASKS.find((candidate) => candidate.id === 'fourc')
    expect(task).toBeDefined()
    const toggle = task?.params.find((spec) => spec.key === 'fromMap')
    expect(toggle?.kind).toBe('toggle')
    expect(toggle?.kind === 'toggle' && toggle.default).toBe(true)
    const anchor = task?.params.find((spec) => spec.key === 'anchor')
    expect(anchor?.kind === 'region' && anchor.fromMap).toBe('fromMap')
  })
})
