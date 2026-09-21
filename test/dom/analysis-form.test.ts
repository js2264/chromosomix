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
import { FOURC_TASK } from '@/analysis/tasks/fourc'
import { TRACK_CORRELATION_TASK } from '@/analysis/tasks/trackcorr'
import { COVERAGE_TASK } from '@/analysis/tasks/coverage'
import { APA_TASK } from '@/analysis/tasks/apa'
import { MAG_QC_TASK } from '@/analysis/tasks/mags'
import { defaultParams, type AnalysisContext, type AnalysisTask, type Params } from '@/analysis/types'
import { RECONSTRUCT_TASK, STRUCTURE_MAP_TASK } from '@/analysis/tasks/structure'
import { ParamForm } from '@/ui/ParamForm'
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

describe('a whole-sequence picker', () => {
  it('starts on every sequence, not on whatever the map is framed at', () => {
    for (const task of [EXPECTED_TASK, INSULATION_TASK]) {
      const view = form(task)
      expect(view.value.region, task.id).toBe('')
      view.destroy()
    }
  })

  it('offers “every sequence” as the choice it starts on', () => {
    const view = form(INSULATION_TASK)
    const options = all<HTMLOptionElement>(view.el, 'option').map((node) => node.textContent)
    expect(options[0]).toBe('every sequence')
    expect(options).toContain('I')
    expect(options).toContain('IV')
    view.destroy()
  })

  // The opposite case, and the reason the rule is about `sequences` rather than
  // about regions: an anchor is a place, and where the reader is looking is the
  // best guess there is.
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
    expect(view.value.region).toBe('')
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

describe('the units a form asks in', () => {
  /**
   * A caption reading "10 bins at 1.0 kb" under a box is a promise about what
   * the task will do, and it is only a promise the *matrix* tasks can keep.
   * Track correlation reads bigWigs and can run with no map open at all, so its
   * bin size has nothing to be measured against — it printed the file's
   * resolution beside a number that has nothing to do with it.
   */
  it('prints no bin count beside track correlation’s bin size', () => {
    const view = form(TRACK_CORRELATION_TASK)
    expect(asks(view, 'bin at')).toBe(false)
    expect(asks(view, 'bins at')).toBe(false)
    expect(view.value.binsize).toBe(100)
    view.destroy()
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
    expect(cost.note).toContain('2,574 bin correlation matrix')
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
    expect(cis.note).toContain('2 sequences, one correlation each')
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
    // **Grouped**, as §26.1 has every box that shows a coordinate write one: the
    // line above this box reads `II:10,001-70,000 · 1 kb bins`, and the seed used
    // to come out `II:10001-70000` — two spellings of one window, an inch apart,
    // in the box a reader is about to edit. `parseHumanized` strips separators
    // before it does anything else, so the value still parses as it did.
    expect(view.value.region).toBe('II:10,001-70,000')
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
  // `mapPick.locusText` writes the paste form — 1-based inclusive, which §8.9
  // pins for the clipboard because that is what samtools and bedtools take — and
  // the runners read this parameter with cooler's grammar, 0-based half-open. So
  // a drag that framed bins 230–1042 arrived at the runner naming bin 231
  // onwards, one bin past the stretch the reader had just pointed at, and
  // nothing on the screen said so. A 4C profile is read off its anchor, so the
  // shift moved the peak.
  afterEach(() => {
    resetPick()
  })

  it('names the bins that were dragged, in the grammar the runner reads', () => {
    const { view, latest } = watchedForm(FOURC_TASK)
    document.body.appendChild(view.el)
    // Bins 230 to 1042 of a 1 kb file — chromosome II, whole.
    pickLocus({ contig: 'II', start: 230_000, end: 1_043_000 })
    // Not `II:230001-1043000`, which is the same stretch written for a terminal
    // and one base along when read as cooler reads it.
    expect(latest().anchor).toBe('II:230000-1043000')
  })

  it('leaves a whole sequence as its bare name, which has no coordinate to shift', () => {
    const { view, latest } = watchedForm(FOURC_TASK)
    document.body.appendChild(view.el)
    pickLocus({ contig: 'IV', start: 1_043_000, end: 2_574_000, whole: true })
    expect(latest().anchor).toBe('IV')
  })
})
