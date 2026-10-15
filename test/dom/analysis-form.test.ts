// @vitest-environment jsdom
/**
 * What the analysis panel asks the reader, and what it answers for itself.
 *
 * Two rules are being pinned, and both are about *settings that were controls
 * and should not have been*.
 *
 * **Balancing is the file's answer.** "Use balancing weights" was a tickbox on
 * six tasks, off by default on five of them, and it is the one setting in the
 * panel where the wrong answer produces a figure that looks entirely reasonable:
 * an unbalanced P(s), insulation track or 4C profile is a plausible shape, and
 * nothing in the picture says which one was asked for. A reader who opened a
 * balanced file has answered the question by opening it.
 *
 * **A whole-sequence picker starts empty**, because empty is an answer there —
 * *every sequence* — and it is the one the list itself offers first. Seeding it
 * from the map's framing silently narrowed P(s), insulation and compartments to
 * whichever chromosome happened to be on screen, and reported the result as
 * though the reader had chosen it. A *locus* box is the opposite case and keeps
 * the framing: 4C's anchor is a place, and where you are looking is the best
 * guess there is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { COMPARTMENTS_TASK } from '@/analysis/tasks/compartments'
import { EXPECTED_TASK } from '@/analysis/tasks/ps'
import { INSULATION_TASK } from '@/analysis/tasks/insulation'
import { DI_TASK } from '@/analysis/tasks/di'
import { HIC_SCORE_TASK } from '@/analysis/tasks/hicscore'
import { SCALOGRAM_TASK } from '@/analysis/tasks/scalogram'
import { FOURC_TASK } from '@/analysis/tasks/fourc'
import { TRACK_CORRELATION_TASK } from '@/analysis/tasks/trackcorr'
import { COVERAGE_TASK } from '@/analysis/tasks/coverage'
import { APA_TASK } from '@/analysis/tasks/apa'
import { MAG_QC_TASK } from '@/analysis/tasks/mags'
import { METAPLOT_TASK } from '@/analysis/tasks/metaplot'
import { FRIP_TASK } from '@/analysis/tasks/frip'
import { COMPOSITION_TASK } from '@/analysis/tasks/composition'
import { TASKS } from '@/analysis/registry'
import {
  defaultParams,
  resolveSeeds,
  type AnalysisContext,
  type AnalysisTask,
  type NumberParam,
  type Params,
} from '@/analysis/types'
import { RECONSTRUCT_TASK, STRUCTURE_MAP_TASK } from '@/analysis/tasks/structure'
import { ORITER_TASK } from '@/analysis/tasks/oriter'
import { defaultStyle, type AnnotationEntry } from '@/annotations/types'
import { ParamForm, resolveEntryDefaults } from '@/ui/ParamForm'
import type { HeldFile } from '@/analysis/runner'
import { runnerParams } from '@/analysis/job'
import { pickLocus, resetPick } from '@/ui/mapPick'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const CONTIGS = [
  { name: 'I', startBin: 0, bins: 230, length: 230_218, genome: -1 },
  { name: 'II', startBin: 230, bins: 813, length: 813_184, genome: -1 },
  { name: 'IV', startBin: 1043, bins: 1531, length: 1_531_933, genome: -1 },
]

function context(options: { hasWeights?: boolean } = {}): AnalysisContext {
  return {
    uri: 'yeast.cool',
    layout: 'cool',
    hasGenomes: false,
    hasWeights: options.hasWeights === true,
    scoreColumns: ['count'],
    binsize: 1000,
    nBins: 2574,
    hasMap: true,
    contigs: CONTIGS,
    genomes: null,
    entries: [],
    // The map is framed on chromosome II, which is what used to leak into every
    // sequence picker on the panel.
    framing: {
      uri: 'yeast.cool',
      rows: [230, 1043],
      cols: [230, 1043],
      binsize: 1000,
      binsPerCell: 1,
      balance: false,
      value: '',
      normalise: null,
      level: 'bin',
      label: 'II at 1 kb',
    },
    blockLoaded: true,
    blockBytes: 0,
  }
}

function form(task: AnalysisTask, ctx = context()): ParamForm {
  return new ParamForm({
    specs: task.params,
    context: ctx,
    value: defaultParams(task.params),
    onChange: () => {},
  })
}

/** A form whose parameter writes are visible to the test. */
function watchedForm(task: AnalysisTask, ctx = context()): { view: ParamForm; latest: () => Params } {
  let params = defaultParams(task.params)
  const view = new ParamForm({
    specs: task.params,
    context: ctx,
    value: params,
    onChange: (next) => {
      params = next
    },
  })
  return { view, latest: () => params }
}

/** Every control label the form put on screen. */
function labels(view: ParamForm): string[] {
  return textsOf(view.el, '.controls-label, .param-label, label')
}

/** Whether any label mentions `text`, however the form marks its labels up. */
function asks(view: ParamForm, text: string): boolean {
  const all = `${view.el.textContent ?? ''}`.toLowerCase()
  return all.includes(text.toLowerCase())
}

describe('balancing', () => {
  it('is never a control on the tasks that read the matrix', () => {
    for (const task of [
      EXPECTED_TASK,
      INSULATION_TASK,
      FOURC_TASK,
      COMPARTMENTS_TASK,
      APA_TASK,
      MAG_QC_TASK,
    ]) {
      const view = form(task)
      expect(asks(view, 'balancing weights'), task.id).toBe(false)
      view.destroy()
    }
  })

  it('is on for a file that carries weights, and off for one that does not', () => {
    const weighted = form(EXPECTED_TASK, context({ hasWeights: true }))
    expect(weighted.value.balance).toBe(true)
    weighted.destroy()

    const raw = form(EXPECTED_TASK, context({ hasWeights: false }))
    expect(raw.value.balance).toBe(false)
    raw.destroy()
  })

  /**
   * A stored session from before the tickbox went away carries the reader's old
   * answer. It is overwritten rather than honoured: the value that runs has to
   * be the one this file's weights support, or the run is refused for a reason
   * the reader cannot see.
   */
  it('overrides a stored answer rather than trusting it', () => {
    const view = new ParamForm({
      specs: EXPECTED_TASK.params,
      context: context({ hasWeights: true }),
      value: { ...defaultParams(EXPECTED_TASK.params), balance: false },
      onChange: () => {},
    })
    expect(view.value.balance).toBe(true)
    view.destroy()
  })

  // Coverage keeps its tickbox on purpose: there it is a *diagnostic* — a
  // balanced file should have a flat total, so one that does not is a file whose
  // weights do not fit it — rather than a question with one right answer.
  it('is still asked on coverage, where it is the point of the run', () => {
    const view = form(COVERAGE_TASK, context({ hasWeights: true }))
    expect(asks(view, 'balancing weights')).toBe(true)
    expect(view.value.balance).toBe(false)
    view.destroy()
  })
})

/**
 * **One shape for *which sequences to run on*, and it is the tick boxes.**
 *
 * These five asked it with a dropdown whose first option read *every sequence*,
 * while four others asked it with a column of tick boxes, and a reader met both
 * in one column. The expectations here changed with the shape: there is no
 * `region` parameter on any of the five any more, the answer is a list of names
 * rather than a string, and *every sequence* is every box ticked rather than an
 * empty select. What has not changed is what the form must not do — seed the
 * answer from the map's framing, which silently narrowed each of them to
 * whichever chromosome was on screen.
 */
describe('a whole-sequence picker', () => {
  it('starts on every sequence, not on whatever the map is framed at', () => {
    for (const task of [EXPECTED_TASK, INSULATION_TASK, DI_TASK, HIC_SCORE_TASK, SCALOGRAM_TASK]) {
      const view = form(task)
      expect(view.value.sequences, task.id).toEqual(['I', 'II', 'IV'])
      view.destroy()
    }
  })

  it('asks with tick boxes and not with a dropdown', () => {
    for (const task of [EXPECTED_TASK, INSULATION_TASK, DI_TASK, HIC_SCORE_TASK, SCALOGRAM_TASK]) {
      const spec = task.params.find((param) => param.key === 'sequences')
      expect(spec?.kind, task.id).toBe('sequences')
      expect(task.params.some((param) => param.kind === 'region'), task.id).toBe(false)
      const view = form(task)
      const boxes = all<HTMLInputElement>(view.el, '.param-sequences input[type="checkbox"]')
      expect(boxes, task.id).toHaveLength(3)
      expect(boxes.every((box) => box.checked), task.id).toBe(true)
      expect(all<HTMLOptionElement>(view.el, 'option').map((node) => node.textContent)).not.toContain(
        'every sequence',
      )
      view.destroy()
    }
  })

  // The opposite case, and the reason the rule is about *which sequences* rather
  // than about regions: an anchor is a place, and where the reader is looking is
  // the best guess there is. A locus box is what `kind: 'region'` is now for and
  // all it is for.
  it('does not apply to a locus box, which still starts where the map is', () => {
    const view = form(FOURC_TASK)
    expect(view.value.anchor).not.toBe('')
    view.destroy()
  })
})

describe('P(s)', () => {
  it('starts per chromosome, over every sequence', () => {
    const view = form(EXPECTED_TASK)
    expect(view.value.scope).toBe('contig')
    // Every box ticked, which is what *over every sequence* is now spelled as.
    expect(view.value.sequences).toEqual(['I', 'II', 'IV'])
    view.destroy()
  })

  it('asks for the near-diagonal trim in bins, and no longer asks how many to draw', () => {
    const view = form(EXPECTED_TASK)
    expect(asks(view, 'Sequences to draw')).toBe(false)
    const spec = EXPECTED_TASK.params.find((param) => param.key === 'minSeparation')
    expect(spec?.kind === 'number' && spec.unit).toBe('bins')
    view.destroy()
  })
})

/**
 * **P(s)'s `.pairs`: a drop area that is also a button, and an address under
 * it (§18.8)** — and no question at all on a map whose own import counted the
 * four orientations.
 *
 * It was an address box alone, which sent a reader holding the file on their
 * disk off to find somewhere to host it, and on a map binned from a `.pairs`
 * asked for the very file the map was binned from.
 */
describe('the .pairs P(s) reads its four orientations from', () => {
  const stranded = (value: Params): Params => ({ ...value, stranded: true })

  /** A form with the four orientations on, and the shelf a drawer would lend it. */
  function pairsForm(
    ctx = context(),
    start: Params = stranded(defaultParams(EXPECTED_TASK.params)),
    shelf = new Map<string, HeldFile>(),
  ): { view: ParamForm; latest: () => Params; shelf: Map<string, HeldFile> } {
    let params = start
    const view = new ParamForm({
      specs: EXPECTED_TASK.params,
      context: ctx,
      value: start,
      onChange: (next) => {
        params = next
      },
      files: {
        get: (key) => shelf.get(key),
        set: (key, held) => {
          if (held === null) shelf.delete(key)
          else shelf.set(key, held)
        },
      },
    })
    params = view.value
    return { view, latest: () => params, shelf }
  }

  /** A drop of `files` on `target`, as an operating system hands one over. */
  function drop(target: Element, files: File[]): Event {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { files, items: [], types: ['Files'] },
    })
    target.dispatchEvent(event)
    return event
  }

  const zoneOf = (view: ParamForm): HTMLElement | null => view.el.querySelector('.param-drop')
  const addressOf = (view: ParamForm): HTMLInputElement | null =>
    view.el.querySelector('.param-address')
  const pairs = (name = 'library.pairs.gz'): File => new File(['## pairs format v1.0\n'], name)

  it('asks with a drop area that is a button, and an address box, once the toggle is on', () => {
    const off = form(EXPECTED_TASK)
    expect(zoneOf(off)).toBeNull()
    off.destroy()

    const { view } = pairsForm()
    const zone = zoneOf(view)
    expect(zone?.getAttribute('role')).toBe('button')
    expect(zone?.getAttribute('tabindex')).toBe('0')
    expect(zone?.textContent).toContain('Drop a .pairs here, or click to choose one')
    expect(addressOf(view)?.placeholder).toMatch(/address/)
    view.destroy()
  })

  it('takes a dropped .pairs for itself, keeps the file and records its name', () => {
    const { view, latest, shelf } = pairsForm()
    document.body.appendChild(view.el)
    let reachedTheApp = false
    const app = (): void => {
      reachedTheApp = true
    }
    document.body.addEventListener('drop', app)
    const file = pairs()
    const event = drop(zoneOf(view)!, [file])
    document.body.removeEventListener('drop', app)

    // Taken here and not let through: the app would *open* a dropped `.pairs`,
    // as a map, behind a dialog.
    expect(reachedTheApp).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(latest().pairsUri).toBe('library.pairs.gz')
    expect(shelf.get('pairsUri')?.source).toEqual({ kind: 'local', file })
    expect(zoneOf(view)?.classList.contains('is-held')).toBe(true)
    expect(zoneOf(view)?.textContent).toContain('library.pairs.gz')
    view.destroy()
  })

  it('opens the picker when pressed, and takes what is chosen', async () => {
    const file = pairs('chosen.pairs')
    const picker = async (): Promise<Array<{ getFile(): Promise<File> }>> => [
      { getFile: async () => file },
    ]
    Object.defineProperty(window, 'showOpenFilePicker', { value: picker, configurable: true })
    try {
      const { view, latest } = pairsForm()
      zoneOf(view)!.click()
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
      expect(latest().pairsUri).toBe('chosen.pairs')
      view.destroy()
    } finally {
      Reflect.deleteProperty(window, 'showOpenFilePicker')
    }
  })

  it('refuses a file that is not a .pairs, and says so under the area', () => {
    const { view, latest } = pairsForm()
    drop(zoneOf(view)!, [new File(['x'], 'reads.bam')])
    expect(latest().pairsUri).toBe('')
    expect(view.el.textContent).toContain('reads.bam is not a .pairs or .pairs.gz file.')
    view.destroy()
  })

  it('takes an address, which replaces a dropped file', () => {
    const { view, latest, shelf } = pairsForm()
    drop(zoneOf(view)!, [pairs()])
    const box = addressOf(view)!
    box.value = 'https://example.org/library.pairs.gz'
    box.dispatchEvent(new Event('change'))
    expect(latest().pairsUri).toBe('https://example.org/library.pairs.gz')
    expect(shelf.has('pairsUri')).toBe(false)
    expect(zoneOf(view)?.classList.contains('is-held')).toBe(false)
    view.destroy()
  })

  it('refuses a name typed where an address goes', () => {
    const { view, latest } = pairsForm()
    const box = addressOf(view)!
    box.value = 'library.pairs.gz'
    box.dispatchEvent(new Event('change'))
    expect(latest().pairsUri).toBe('')
    expect(view.el.textContent).toMatch(/An address starts with https:\/\/ or s3:\/\//)
    view.destroy()
  })

  it('empties a name whose file is no longer held, and keeps an address', () => {
    const named = { ...stranded(defaultParams(EXPECTED_TASK.params)), pairsUri: 'library.pairs.gz' }
    expect(pairsForm(context(), named).latest().pairsUri).toBe('')
    const held = new Map<string, HeldFile>([
      ['pairsUri', { value: 'library.pairs.gz', source: { kind: 'local', file: pairs() } }],
    ])
    expect(pairsForm(context(), named, held).latest().pairsUri).toBe('library.pairs.gz')
    const url = { ...named, pairsUri: 's3://bucket/library.pairs.gz' }
    expect(pairsForm(context(), url).latest().pairsUri).toBe('s3://bucket/library.pairs.gz')
  })

  it('asks nothing on a map whose import counted the four, and records the import', () => {
    const binned = { ...context(), binnedFrom: { name: 'CG002.pairs.gz', orientation: true } }
    const url = { ...stranded(defaultParams(EXPECTED_TASK.params)), pairsUri: 's3://b/x.pairs.gz' }
    const { view, latest } = pairsForm(binned, url)
    expect(zoneOf(view)).toBeNull()
    expect(addressOf(view)).toBeNull()
    // Settled, so the run is recorded as what it read: the import's own curves.
    expect(latest().pairsUri).toBe('')
    expect(EXPECTED_TASK.estimate(binned, latest()).note).toContain(
      'The four orientations were counted as CG002.pairs.gz was binned.',
    )
    view.destroy()
  })

  it('still asks on a map binned from a .pairs that had no strands', () => {
    const binned = { ...context(), binnedFrom: { name: 'CG002.pairs.gz', orientation: false } }
    const { view, latest } = pairsForm(binned)
    expect(zoneOf(view)).not.toBeNull()
    expect(EXPECTED_TASK.estimate(binned, latest()).note).toContain(
      'CG002.pairs.gz has no strand columns',
    )
    view.destroy()
  })

  it('says a matrix opened on its own needs one, and prices one given as its pass', () => {
    const asked = stranded(defaultParams(EXPECTED_TASK.params))
    const ctx = context()
    const resolved = resolveEntryDefaults(EXPECTED_TASK.params, ctx, asked)
    expect(EXPECTED_TASK.estimate(ctx, resolved).note).toContain(
      'The four orientations need a .pairs: choose one above.',
    )
    const given = { ...resolved, pairsUri: 'library.pairs.gz' }
    const priced = EXPECTED_TASK.estimate(ctx, given)
    expect(priced.class).toBe('scan')
    expect(priced.note).toContain('one pass over the whole of library.pairs.gz')
  })

  it('still refuses a run with nothing ticked when a .pairs is given', () => {
    const ctx = context()
    const given = {
      ...resolveEntryDefaults(EXPECTED_TASK.params, ctx, stranded(defaultParams(EXPECTED_TASK.params))),
      pairsUri: 'library.pairs.gz',
      sequences: [],
    }
    expect(EXPECTED_TASK.estimate(ctx, given).refusal).toBe('Tick at least one sequence.')
  })
})

/**
 * **Every matrix setting is a number of bins, or of diagonals, and never a
 * length of genome (§18.2).**
 *
 * The rule used to be the other way round: a length was asked for in base pairs
 * and the form printed *n bins at 1 kb* under the box, translating what the
 * reader typed into what the task would do. Two things were wrong with that. The
 * quantity a matrix parameter names — a scan band, a shift, a stratum, a
 * separation between two anchors — *is* a count of the grid's own cells, so the
 * translation was the reader doing arithmetic the run then undid; and the same
 * typed number meant a different thing on every rung of an `.mcool`. So the
 * boxes ask in bins, the caption is gone with the boxes it was for, and what a
 * run came to in base pairs is said once by the runner, on the file open.
 *
 * The exception is the one thing bins are not a unit of: a **1D track**. A
 * metaplot's flank, a FRiP's sampling step and a track correlation's window are
 * base pairs and stay base pairs, and none of the three carries a bin count.
 */
describe('the units a form asks in', () => {
  /** Every number parameter of every task, with the task that owns it. */
  const numbers = (): Array<{ task: string; key: string; unit: string | undefined }> =>
    TASKS.flatMap((task) =>
      task.params
        .filter((param): param is NumberParam => param.kind === 'number')
        .map((param) => ({ task: task.id, key: param.key, unit: param.unit })),
    )

  it('asks no box for a matrix distance in base pairs', () => {
    // `cellqc` is the one task whose base-pair numbers are not a grid at all:
    // its three band edges are Nagano et al.'s published separations, are what
    // the phasing plot's own axes print, and are never turned into bins by
    // anything — the histogram measures a separation in base pairs and compares
    // it there. The 1D tasks are the stated exception — the three that read
    // tracks, and the two that read the reference, whose windows are lengths of
    // sequence at every resolution — and the peak caller, whose smoothing window
    // and widths are shapes along a track read at base resolution.
    const onTracks = new Set([
      'metaplot',
      'frip',
      'trackcorr',
      'cellqc',
      'composition',
      'oriter',
      'groupsignal',
      'peaks',
    ])
    const inBp = numbers().filter((param) => param.unit === 'bp' && !onTracks.has(param.task))
    expect(inBp).toEqual([])
  })

  it('asks every distance it converted in bins, and says so beside the box', () => {
    const wanted: Record<string, string[]> = {
      scalogram: ['reach'],
      apa: ['window', 'minDist', 'minShift', 'maxShift', 'minSep', 'maxSep'],
      chromosight: ['minDist', 'maxDist', 'minSeparation'],
      hicrep: ['maxDistance', 'smooth'],
      insulation: ['window', 'spacing'],
      di: ['window', 'spacing'],
      expected: ['minSeparation'],
    }
    for (const [task, keys] of Object.entries(wanted)) {
      const found = numbers().filter((param) => param.task === task && param.unit === 'bins')
      expect(found.map((param) => param.key).sort(), task).toEqual([...keys].sort())
    }
  })

  /**
   * A 1D quantity keeps its unit and gains no mention of bins — in its label, in
   * its unit or in its hint. Track correlation is the case the rule was written
   * from: it correlates bigWigs and can run with no contact map open at all, so
   * its window had nothing to be a count of, and the control was called *bin
   * size* and printed `1 bin at 10.0 kb` beside a box reading 10,000.
   */
  it('says nothing about bins on a control that reads a track', () => {
    for (const task of [TRACK_CORRELATION_TASK, METAPLOT_TASK, FRIP_TASK]) {
      const view = form(task)
      expect(asks(view, 'bin'), task.id).toBe(false)
      view.destroy()
    }
    expect(form(TRACK_CORRELATION_TASK).value.binsize).toBe(100)
  })

  it('prints no bin count under any box, on any task', () => {
    for (const task of TASKS) {
      const view = form(task)
      expect(asks(view, 'bin at'), task.id).toBe(false)
      expect(asks(view, 'bins at'), task.id).toBe(false)
      view.destroy()
    }
  })

  it('asks insulation for a diamond in bins', () => {
    const view = form(INSULATION_TASK)
    expect(view.value.window).toBe(10)
    // Lowercase, since field labels are (§26.4): every label in this form was
    // Title-case while every label on the cards beside it was not.
    expect(labels(view).join(' ')).toContain('window')
    view.destroy()
  })
})

describe('coverage', () => {
  it('starts with the total marginal alone', () => {
    const view = form(COVERAGE_TASK)
    expect(view.value.total).toBe(true)
    expect(view.value.fraction).toBe(false)
    expect(view.value.cis).toBe(false)
    expect(view.value.trans).toBe(false)
    view.destroy()
  })
})

/**
 * Compartments takes **several** sequences and correlates them together, cis
 * and trans — which is a different quantity from the per-chromosome one and not
 * an average of it: two chromosomes in the same compartment touch each other in
 * trans, and that is where a genome-wide eigenvector's signal comes from.
 *
 * The convention worth pinning is the one about *empty*. Everywhere else in this
 * app an empty selection means "all of them"; here it means the reader pressed
 * **None**, and a run whose parameters read `[]` must not be indistinguishable
 * from one that ran over everything. So unanswered (`null`) resolves to every
 * sequence and `[]` stays `[]` and is refused.
 */
describe('ticking several sequences', () => {
  it('starts with every one ticked, which is the genome-wide call', () => {
    const view = form(COMPARTMENTS_TASK)
    expect(view.value.sequences).toEqual(['I', 'II', 'IV'])
    const boxes = all<HTMLInputElement>(view.el, '.param-sequences input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    expect(boxes.every((box) => box.checked)).toBe(true)
    view.destroy()
  })

  it('names each sequence and says how many are ticked', () => {
    const view = form(COMPARTMENTS_TASK)
    expect(
      textsOf(view.el, '.param-sequences .param-check span:not(.param-check-note)'),
    ).toEqual(['I', 'II', 'IV'])
    // …with its length beside it, so a reader picking chromosomes can see which
    // ones are worth correlating without leaving the form.
    expect(textsOf(view.el, '.param-check-note')).toEqual([
      '230.2 kb',
      '813.2 kb',
      '1.53 Mb',
    ])
    expect(asks(view, '3 of 3 ticked')).toBe(true)
    view.destroy()
  })

  it('unticks one without touching the rest', () => {
    let held: unknown = null
    const view = new ParamForm({
      specs: COMPARTMENTS_TASK.params,
      context: context(),
      value: defaultParams(COMPARTMENTS_TASK.params),
      onChange: (next) => {
        held = next.sequences
      },
    })
    const boxes = all<HTMLInputElement>(view.el, '.param-sequences input[type="checkbox"]')
    boxes[1].checked = false
    boxes[1].dispatchEvent(new Event('change'))
    expect(held).toEqual(['I', 'IV'])
    view.destroy()
  })

  it('has a None that empties it and an All that fills it', () => {
    const view = form(COMPARTMENTS_TASK)
    buttonNamed(view.el, 'none')?.click()
    expect(view.value.sequences).toEqual([])
    expect(asks(view, '0 of 3 ticked')).toBe(true)

    buttonNamed(view.el, 'all')?.click()
    expect(view.value.sequences).toEqual(['I', 'II', 'IV'])
    view.destroy()
  })

  /**
   * The half of the convention that a helpful `resolve` would quietly undo:
   * pressing **None** is an answer, and re-filling it on the next context change
   * would make the button do nothing a moment after it worked.
   */
  it('leaves an emptied list empty when the context changes under it', () => {
    const view = form(COMPARTMENTS_TASK)
    buttonNamed(view.el, 'none')?.click()
    view.setContext(context())
    expect(view.value.sequences).toEqual([])
    view.destroy()
  })

  it('drops a name the open file does not have', () => {
    const view = new ParamForm({
      specs: COMPARTMENTS_TASK.params,
      context: context(),
      value: { ...defaultParams(COMPARTMENTS_TASK.params), sequences: ['I', 'chr21'] },
      onChange: () => {},
    })
    expect(view.value.sequences).toEqual(['I'])
    view.destroy()
  })

  it('refuses a run with nothing ticked, and says what to do', () => {
    const view = form(COMPARTMENTS_TASK)
    buttonNamed(view.el, 'none')?.click()
    const refusal = COMPARTMENTS_TASK.estimate(context(), view.value).refusal ?? ''
    expect(refusal).toMatch(/tick at least one/i)
    view.destroy()
  })

  it('prices the whole ticked set as one correlation, not one per sequence', () => {
    const view = form(COMPARTMENTS_TASK)
    const cost = COMPARTMENTS_TASK.estimate(context(), { ...view.value, contacts: 'both' })
    // 230 + 813 + 1531 bins, correlated together.
    // cooltools' method by default (§18.8), so the matrix priced is observed/expected.
    expect(cost.note).toContain('2,574 bin observed/expected matrix')
    expect(cost.note).toContain('cis and trans')
    view.destroy()
  })

  it('refuses a ticked set past the bin-count gate, counting the whole of it', () => {
    const huge = context()
    huge.contigs = [
      { name: 'A', startBin: 0, bins: 5000, length: 5e6, genome: -1 },
      { name: 'B', startBin: 5000, bins: 5000, length: 5e6, genome: -1 },
    ]
    const view = form(COMPARTMENTS_TASK, huge)
    const both = { ...view.value, contacts: 'both' }
    const refusal = COMPARTMENTS_TASK.estimate(huge, both).refusal ?? ''
    expect(refusal).toContain('10,000×10,000')
    expect(refusal).toMatch(/untick some/i)
    view.destroy()
  })
})

/**
 * Cis, trans and both are three computations, and the control has to be read as
 * offering three rather than as a filter over one.
 *
 * **Trans** is the standard genome-wide call: the cis blocks carry a
 * near-diagonal that dominates every row, so a correlation with them left out is
 * a statement about which sequences share a compartment and nothing else. It
 * needs two sequences by definition.
 *
 * **Cis** changes the *shape* of the run — one correlation per sequence rather
 * than one across them — which is why it is priced against the largest sequence
 * rather than the whole set, and why it is the mode that still works at a
 * resolution the other two are refused at. The alternative, one square with its
 * trans blocks removed, correlates to a block-diagonal matrix whose leading
 * eigenvector lives on one chromosome; that is wrong in a way that looks like
 * data, and it is the reason the modes are not interchangeable.
 */
/**
 * What an optional input starts on when nobody has chosen one.
 *
 * The star or the first *loaded* entry, and never another task's output: the
 * two loci an Origin and terminus run leaves are the first interval set on the
 * list, and the compartments were phased by their "gene density" by default.
 * And an input that is a guess however it is filled — the track the
 * compartments follow, the coverage an origin call reads — starts on none.
 */
describe('an optional input nobody has chosen', () => {
  function entry(id: string, kind: AnnotationEntry['kind'], computed = false): AnnotationEntry {
    return {
      id,
      card: computed ? 'synthetic' : kind === 'segments' ? 'overlay' : 'linear',
      kind,
      label: id,
      source: computed
        ? { kind: 'computed', name: id, task: 'oriter', recipe: {}, framing: 'PAK at 4 kb' }
        : { kind: 'remote', url: `https://example.invalid/${id}`, name: id },
      status: 'ready',
      visible: true,
      placement: { top: false, right: false, bottom: true, left: false },
      style: defaultStyle(kind, '#0072b2'),
    }
  }
  const phasing = (entries: AnnotationEntry[]): Record<string, unknown> =>
    resolveEntryDefaults(COMPARTMENTS_TASK.params, { ...context(), entries }, defaultParams(COMPARTMENTS_TASK.params))

  it('is not phased by a set a task made', () => {
    const params = phasing([entry('loci', 'segments', true), entry('PAK.fa', 'sequence')])
    expect(params.phaseFeatures).toBe('')
    expect(params.phaseSequence).toBe('PAK.fa')
  })

  it('is still phased by a gene model the reader loaded, ahead of a computed set', () => {
    const params = phasing([entry('loci', 'segments', true), entry('genes.gtf', 'gtf')])
    expect(params.phaseFeatures).toBe('genes.gtf')
  })

  it('starts the phasing track and the origin call’s coverage on none', () => {
    expect(phasing([entry('chip.bw', 'track')]).phaseTrack).toBe('')
    const oriter = resolveEntryDefaults(
      ORITER_TASK.params,
      { ...context(), entries: [entry('PAK.fa', 'sequence'), entry('cov.bw', 'track')] },
      defaultParams(ORITER_TASK.params),
    )
    expect(oriter.coverage).toBe('')
    expect(oriter.sequence).toBe('PAK.fa')
  })
})

/**
 * A bin size the context answers until the reader does (§18.2, §18.8): base
 * composition reads the open map's resolution, and 10 kb in a 1D browser with a
 * FASTA and nothing else. Held unanswered, so it follows a change of resolution;
 * answered for the run, so the run's record says which bin size it read.
 */
describe('a number the open map answers', () => {
  const box = (view: ParamForm): HTMLInputElement | null =>
    view.el.querySelector<HTMLInputElement>('input[id$="-resolution"]')
  const fasta: AnnotationEntry = {
    id: 'PAK.fa',
    card: 'linear',
    kind: 'sequence',
    label: 'PAK.fa',
    source: { kind: 'remote', url: 'https://example.invalid/PAK.fa', name: 'PAK.fa' },
    status: 'ready',
    visible: true,
    placement: { top: false, right: false, bottom: true, left: false },
    style: defaultStyle('sequence', '#0072b2'),
  }
  /** A 1D browser: the same sequences, a browsing grid, and no matrix. */
  const browser = (): AnalysisContext => {
    const base = context()
    if (base.framing === null) throw new Error('the map context is framed')
    return {
      ...base,
      hasMap: false,
      nBins: 0,
      entries: [fasta],
      framing: { ...base.framing, rows: [0, 0], cols: [0, 0], label: 'yeast.fa' },
    }
  }

  it('shows the map’s resolution, and 10 kb with no map open', () => {
    const view = form(COMPOSITION_TASK)
    expect(box(view)?.value).toBe('1000')
    view.setContext(browser())
    expect(box(view)?.value).toBe('10000')
    view.destroy()
  })

  it('stays unanswered in the form and is answered for the run', () => {
    const unanswered = defaultParams(COMPOSITION_TASK.params)
    expect(unanswered.resolution).toBeNull()
    expect(resolveSeeds(COMPOSITION_TASK.params, context(), unanswered).resolution).toBe(1000)
    expect(resolveSeeds(COMPOSITION_TASK.params, browser(), unanswered).resolution).toBe(10_000)
    const typed = { ...unanswered, resolution: 2_500 }
    expect(resolveSeeds(COMPOSITION_TASK.params, browser(), typed).resolution).toBe(2_500)
  })

  it('is ready in a 1D browser with a FASTA loaded, and waits for one without', () => {
    expect(COMPOSITION_TASK.availability(browser()).state).toBe('ready')
    expect(COMPOSITION_TASK.availability({ ...browser(), entries: [] }).state).toBe('waiting')
  })
})

describe('which contacts a compartment run reads', () => {
  /**
   * Cis is the default because it is the answer most readers want at a price
   * most files can pay: it is the object people mean by "the compartment track",
   * and it is the only one of the three that runs at a fine resolution.
   */
  it('starts on cis only, and offers the other two', () => {
    const view = form(COMPARTMENTS_TASK)
    expect(view.value.contacts).toBe('cis')
    expect(asks(view, 'Cis only')).toBe(true)
    expect(asks(view, 'Cis and trans')).toBe(true)
    expect(asks(view, 'Trans only')).toBe(true)
    view.destroy()
  })

  it('says which halves it is reading in the price', () => {
    const view = form(COMPARTMENTS_TASK)
    expect(COMPARTMENTS_TASK.estimate(context(), { ...view.value, contacts: 'both' }).note).toContain(
      'cis and trans',
    )
    expect(
      COMPARTMENTS_TASK.estimate(context(), { ...view.value, contacts: 'trans' }).note,
    ).toContain('trans only')
    view.destroy()
  })

  /**
   * The practical difference between the modes, in one assertion: the same
   * ticked set is refused as one correlation and ordinary as sixteen.
   */
  it('prices cis against the largest sequence rather than the whole set', () => {
    const fine = context()
    fine.contigs = [
      { name: 'A', startBin: 0, bins: 5000, length: 5e6, genome: -1 },
      { name: 'B', startBin: 5000, bins: 5000, length: 5e6, genome: -1 },
    ]
    const view = form(COMPARTMENTS_TASK, fine)
    expect(
      COMPARTMENTS_TASK.estimate(fine, { ...view.value, contacts: 'both' }).refusal,
    ).toContain('10,000×10,000')

    const cis = COMPARTMENTS_TASK.estimate(fine, { ...view.value, contacts: 'cis' })
    expect(cis.refusal).toBeUndefined()
    expect(cis.note).toContain('2 sequences, one decomposition each')
    expect(cis.note).toContain('5,000 bins')
    view.destroy()
  })

  it('refuses trans with one sequence ticked, and says what to do instead', () => {
    const view = form(COMPARTMENTS_TASK)
    const one = { ...view.value, sequences: ['II'], contacts: 'trans' }
    const refusal = COMPARTMENTS_TASK.estimate(context(), one).refusal ?? ''
    expect(refusal).toMatch(/at least two/i)
    expect(refusal).toMatch(/cis/i)
    // …and the same one sequence is fine in either of the other two modes.
    expect(
      COMPARTMENTS_TASK.estimate(context(), { ...one, contacts: 'cis' }).refusal,
    ).toBeUndefined()
    expect(
      COMPARTMENTS_TASK.estimate(context(), { ...one, contacts: 'both' }).refusal,
    ).toBeUndefined()
    view.destroy()
  })

  // A refusal that names only the way out the reader has already rejected is
  // half a refusal: at a fine resolution, cis-only is the answer.
  it('offers cis as a way past the bin-count gate', () => {
    const huge = context()
    huge.contigs = [
      { name: 'A', startBin: 0, bins: 5000, length: 5e6, genome: -1 },
      { name: 'B', startBin: 5000, bins: 5000, length: 5e6, genome: -1 },
    ]
    const view = form(COMPARTMENTS_TASK, huge)
    expect(
      COMPARTMENTS_TASK.estimate(huge, { ...view.value, contacts: 'both' }).refusal,
    ).toMatch(/cis contacts alone/i)
    view.destroy()
  })
})

/**
 * cooltools' `ignore_diags`, in the two tasks that read a matrix against its own
 * diagonal.
 *
 * The near-diagonal is where self-ligation and unligated fragments land, and
 * those cells are both the largest in the matrix and the least structural. Left
 * in, they carry a disproportionate share of what a row correlates with and of
 * what a small diamond sums — so the answer becomes a picture of how deep the
 * diagonal is. Two by default, which is cooltools' default and what the numbers
 * a reader compares against were computed with.
 */
describe('ignoring the near-diagonal', () => {
  it('is asked for by both compartments and insulation, at cooltools’ default', () => {
    for (const task of [COMPARTMENTS_TASK, INSULATION_TASK]) {
      const view = form(task)
      expect(view.value.ignoreDiags, task.id).toBe(2)
      expect(asks(view, 'Diagonals to ignore'), task.id).toBe(true)
      view.destroy()
    }
  })

  // There is no diagonal in a trans block to ignore, so the control is not
  // shown — a form that offers a setting with no effect is a form that has to
  // be worked out.
  it('is hidden under trans only, where there is no diagonal to ignore', () => {
    const spec = COMPARTMENTS_TASK.params.find((param) => param.key === 'ignoreDiags')
    expect(spec?.when?.({ contacts: 'trans' })).toBe(false)
    expect(spec?.when?.({ contacts: 'cis' })).toBe(true)
    expect(spec?.when?.({ contacts: 'both' })).toBe(true)
  })
})

/**
 * The two 4C controls a metagenome does not get.
 *
 * *Cis only* and *Normalisation* are real questions on a cooler — a chromosome
 * is a self-contained thing, cis is the commonest reading and the cheap one, and
 * that chromosome's own P(s) is the curve to divide by. On a metacool an anchor
 * is one MAG among hundreds sharing a tube: the reading wanted is what it
 * touches *everywhere*, and a decay accumulated from one assembly's contigs is
 * not an expectation for contact between assemblies.
 *
 * So the file decides, and the last test is the one that matters: the specs are
 * fixed when the form is built and the drawer hands it another file's context
 * without rebuilding it, so a rule read once at construction would show a
 * metagenome two controls whose answers it is about to ignore.
 */
describe('4C on a metagenome', () => {
  const community = (): AnalysisContext => ({
    ...context(),
    uri: 'gut.metacool',
    layout: 'metacool',
    hasGenomes: true,
    genomes: [
      { name: 'MAG_1', extent: [0, 1043], contigs: 2 },
      { name: 'MAG_2', extent: [1043, 2574], contigs: 1 },
    ],
  })

  it('asks a cooler about both, as it always did', () => {
    const view = form(FOURC_TASK)
    expect(asks(view, 'Cis only')).toBe(true)
    expect(asks(view, 'Normalisation')).toBe(true)
    view.destroy()
  })

  it('asks a metagenome about neither, and still asks for the anchor', () => {
    const view = form(FOURC_TASK, community())
    expect(asks(view, 'Cis only')).toBe(false)
    expect(asks(view, 'Normalisation')).toBe(false)
    expect(asks(view, 'Anchor')).toBe(true)
    expect(asks(view, 'Exclude anchor region')).toBe(true)
    view.destroy()
  })

  it('offers to leave the anchor out, off until asked', () => {
    const view = form(FOURC_TASK)
    expect(asks(view, 'Exclude anchor region')).toBe(true)
    expect(view.value.excludeAnchor).toBe(false)
    view.destroy()
  })

  it('settles both keys to what the run will be, so the provenance is not a lie', () => {
    // A hidden control still has a value, and that value is written into the
    // run's provenance and the header of every TSV exported from it. Left at
    // its default it read `param cis: true` on a table computed by a walk over
    // the whole file — a number attributed to a computation nobody performed.
    const view = form(FOURC_TASK, community())
    expect(view.value.cis).toBe(false)
    expect(view.value.normalise).toBe('none')
    view.destroy()
  })

  it('leaves a cooler’s own answers alone', () => {
    const view = form(FOURC_TASK)
    expect(view.value.cis).toBe(true)
    view.destroy()
  })

  it('takes the rows away when the drawer is handed a metagenome, and puts them back', () => {
    const view = form(FOURC_TASK)
    view.setContext(community())
    expect(asks(view, 'Cis only')).toBe(false)
    view.setContext(context())
    expect(asks(view, 'Cis only')).toBe(true)
    view.destroy()
  })
})

describe('a box that takes several sequences (§25.6)', () => {
  function framed(rows: [number, number], cols: [number, number] = rows): AnalysisContext {
    const base = context()
    return { ...base, framing: { ...(base.framing as NonNullable<AnalysisContext['framing']>), rows, cols } }
  }

  it('is seeded with the locus when the map is inside one sequence', () => {
    const view = form(RECONSTRUCT_TASK, framed([240, 300]))
    // Grouped, as §26.1 has every coordinate on screen written — including in a
    // box whose own grammar is comma-separated, because `splitRegionList` knows a
    // thousands comma from a separator. Split plainly, this seed read as `II:10`,
    // `001` and `70,000`, and the run came back *Expected HYPHEN token missing*.
    expect(view.value.region).toBe('II:10,001-70,000')
    view.destroy()
  })

  it('groups the digits for a box that takes one locus too', () => {
    // The 4C anchor, a box away from the one above in the same column: the two
    // read alike, which is the whole of §26.1.
    const view = form(FOURC_TASK, framed([240, 300]))
    expect(view.value.anchor).toBe('II:10,001-70,000')
    view.destroy()
  })

  it('hands the runner the bins on screen and not a base past them (§26.1)', () => {
    // The round trip through the run's own boundary: rows 240–300 are II's bins
    // 10–70 at 1 kb, seeded 1-based, and given to the runner as exactly those.
    const view = form(FOURC_TASK, framed([240, 300]))
    expect(runnerParams(FOURC_TASK.params, view.value).anchor).toBe('II:10000-70000')
    view.destroy()
    const several = form(RECONSTRUCT_TASK, framed([240, 300]))
    expect(runnerParams(RECONSTRUCT_TASK.params, several.value).region).toBe('II:10000-70000')
    several.destroy()
  })

  it('says how it reads its coordinates, as every other locus box does', () => {
    const view = form(FOURC_TASK, framed([240, 300]))
    const box = view.el.querySelector<HTMLInputElement>('.param-region')
    expect(box?.title).toMatch(/Coordinates are 1-based and inclusive/)
    expect(box?.title).not.toMatch(/show --range/)
    view.destroy()
  })

  it('is seeded with every sequence on screen when the map spans several', () => {
    const view = form(RECONSTRUCT_TASK, framed([0, 1043]))
    expect(view.value.region).toBe('I, II')
    view.destroy()
    const versus = form(STRUCTURE_MAP_TASK, framed([230, 1200]))
    expect(versus.value.region).toBe('II, IV')
    versus.destroy()
  })

  it('is left empty — every sequence — for the whole file, or a view touching every sequence', () => {
    const view = form(RECONSTRUCT_TASK, framed([0, 2574]))
    expect(view.value.region).toBe('')
    view.destroy()
    const touching = form(RECONSTRUCT_TASK, framed([100, 1200]))
    expect(touching.value.region).toBe('')
    touching.destroy()
  })

  it('takes the union of the two axes', () => {
    const view = form(RECONSTRUCT_TASK, framed([0, 230], [1043, 2574]))
    expect(view.value.region).toBe('I, IV')
    view.destroy()
  })
})


describe('an anchor picked off the map', () => {
  // THE DIALECT, and it is a wrong *answer* rather than a wrong label.
  //
  // The box is read as every locus box is, 1-based and inclusive (§26.1), and
  // the run's boundary (`runnerParams`) hands the runner cooler's grammar. So a
  // pick is written in the display form — the form the seed beside it is in —
  // and lands on exactly the bins that were dragged. Written in any other, it
  // is a base off one way or the other, and a 4C profile is read off its anchor.
  afterEach(() => {
    resetPick()
  })

  it('names the bins that were dragged, in the form the box is read in', () => {
    const { view, latest } = watchedForm(FOURC_TASK)
    document.body.appendChild(view.el)
    // Bins 230 to 1042 of a 1 kb file.
    pickLocus({ contig: 'II', start: 230_000, end: 1_043_000 })
    expect(latest().anchor).toBe('II:230,001-1,043,000')
    // …which the runner is handed as those bins and no others.
    expect(runnerParams(FOURC_TASK.params, latest()).anchor).toBe('II:230000-1043000')
  })

  it('leaves a whole sequence as its bare name, which has no coordinate to shift', () => {
    const { view, latest } = watchedForm(FOURC_TASK)
    document.body.appendChild(view.el)
    pickLocus({ contig: 'IV', start: 1_043_000, end: 2_574_000, whole: true })
    expect(latest().anchor).toBe('IV')
  })
})

/**
 * APA's cards (§18.8). A card none of whose controls the settings leave is not
 * drawn — the distance-matched control's card under observed / expected, which
 * is the default; the Ranking card for anything but a feature set — and a track
 * list the reader emptied stays empty however often the form is handed its
 * context again, which is what the drawer does around a run.
 */
describe('APA’s cards', () => {
  function track(id: string): AnnotationEntry {
    return {
      id,
      card: 'linear',
      kind: 'track',
      label: id,
      source: { kind: 'remote', url: `https://example.invalid/${id}`, name: id },
      status: 'ready',
      visible: true,
      placement: { top: false, right: false, bottom: true, left: false },
      style: defaultStyle('track', '#0072b2'),
    }
  }

  /** The headings of the cards on screen, the untitled first one as `''`. */
  function cards(view: ParamForm): string[] {
    return all(view.el, '.param-group')
      .filter((card) => !card.classList.contains('hidden'))
      .map((card) => card.querySelector('.controls-title')?.textContent ?? '')
  }

  it('draws no Control card under observed / expected, and draws it for the distance-matched control', () => {
    const view = form(APA_TASK)
    expect(view.value.norm).toBe('oe')
    expect(cards(view)).not.toContain('Control')
    view.setValue({ ...view.value, norm: 'matched' })
    expect(cards(view)).toContain('Control')
    view.setValue({ ...view.value, norm: 'none' })
    expect(cards(view)).not.toContain('Control')
  })

  it('draws the Ranking card for a feature set alone, whatever was ranked before', () => {
    const view = form(APA_TASK)
    expect(view.value.anchors).toBe('pairs')
    expect(cards(view)).not.toContain('Ranking')
    view.setValue({ ...view.value, anchors: 'features' })
    expect(cards(view)).toContain('Ranking')
    // Top N, chosen on a ranked feature set, does not follow the reader back to the loops.
    view.setValue({ ...view.value, anchors: 'pairs', rankBy: 'score', subset: 'top' })
    expect(cards(view)).not.toContain('Ranking')
    expect(labels(view)).not.toContain('N')
  })

  /** The tracks ticked on screen, by label. */
  function ticked(view: ParamForm): string[] {
    return all(view.el, '.param-check')
      .filter((row) => row.querySelector<HTMLInputElement>('input')?.checked === true)
      .map((row) => row.textContent ?? '')
  }

  it('opens on the starred track, and keeps the list the reader emptied however often the context comes back', () => {
    const ctx = { ...context(), entries: [track('atac.bw'), { ...track('pol2.bw'), primary: true }] }
    const { view, latest } = watchedForm(APA_TASK, ctx)
    expect(view.value.tracks).toEqual(['pol2.bw'])
    expect(ticked(view)).toEqual(['pol2.bw'])
    // Every box unticked, as a reader does it, then the drawer's round trip around a run.
    const box = all(view.el, '.param-check').find((row) => row.textContent === 'pol2.bw')
    const input = box?.querySelector<HTMLInputElement>('input')
    if (input === null || input === undefined) throw new Error('no box for pol2.bw')
    input.checked = false
    input.dispatchEvent(new Event('change'))
    expect(latest().tracks).toEqual([])
    view.setContext(ctx)
    view.setContext({ ...ctx })
    expect(view.value.tracks).toEqual([])
    expect(ticked(view)).toEqual([])
    expect(latest().tracks).toEqual([])
  })

  it('ticks a track loaded after the form opened on none, and never one in place of a track that went', () => {
    const { view } = watchedForm(APA_TASK)
    expect(view.value.tracks).toBeNull()
    const ctx = { ...context(), entries: [track('atac.bw'), track('pol2.bw')] }
    view.setContext(ctx)
    expect(view.value.tracks).toEqual(['atac.bw'])
    view.setContext({ ...ctx, entries: [track('pol2.bw')] })
    expect(view.value.tracks).toEqual([])
  })
})
