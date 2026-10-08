// @vitest-environment jsdom
/**
 * What the motif task offers, refuses, and asks the reader for.
 *
 * The three halves of a descriptor that are not the run itself, and each is here
 * because it would be wrong invisibly.
 *
 * **Availability is `waiting`, never `absent`.** §18.1 has two kinds of
 * "cannot", and a motif search with no reference open is the kind that is one
 * drag away — so the row is listed and greyed with a sentence saying what to
 * load. Absence would teach a reader who has not met this app before that it
 * cannot search a sequence at all, which is the wrong lesson and the harder one
 * to unlearn. **And it is ready with no contact map**, because a 1D browser
 * session (§5.8) is exactly where a reader has a genome and no matrix.
 *
 * **The estimate refuses before the run rather than after it.** `compileMotif`
 * is the same function the runner calls, so the sentence under a greyed-out
 * **Run** is the sentence the run would have produced — a reader who typed
 * `ACGX` reads why without pressing anything.
 *
 * **The pattern is a box.** It is the one free-text parameter in the catalogue
 * (`TextParam`), and the reason it is not the locus box — which would offer this
 * file's chromosome names as suggestions — is exactly that a form should not
 * suggest `chrIV` to somebody typing `GATC`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MOTIF_SITE_LIMIT, MOTIF_TASK } from '@/analysis/tasks/motif'
import { defaultParams, type AnalysisContext } from '@/analysis/types'
import { defaultStyle, type AnnotationEntry } from '@/annotations/types'
import { ParamForm } from '@/ui/ParamForm'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

function sequenceEntry(): AnnotationEntry {
  return {
    id: 'seq1',
    card: 'linear',
    kind: 'sequence',
    label: 'sacCer3.fa',
    source: { kind: 'remote', url: 'https://example.invalid/sacCer3.fa', name: 'sacCer3.fa' },
    status: 'ready',
    visible: true,
    placement: { top: false, right: false, bottom: true, left: false },
    style: defaultStyle('sequence', '#0072b2'),
  }
}

/** A session with a map by default, and one without when `hasMap` is false. */
function context(options: { entries?: AnnotationEntry[]; hasMap?: boolean } = {}): AnalysisContext {
  const hasMap = options.hasMap !== false
  return {
    uri: hasMap ? 'yeast.cool' : 'sacCer3.fa',
    layout: 'cool',
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
    binsize: hasMap ? 1000 : 0,
    nBins: hasMap ? 2574 : 0,
    hasMap,
    contigs: [
      { name: 'I', startBin: 0, bins: 230, length: 230_218, genome: -1 },
      { name: 'II', startBin: 230, bins: 813, length: 813_184, genome: -1 },
      { name: 'IV', startBin: 1043, bins: 1531, length: 1_531_933, genome: -1 },
    ],
    genomes: null,
    entries: options.entries ?? [],
    framing: null,
    blockLoaded: false,
    blockBytes: 0,
  }
}


/**
 * **Most sites**, which is the number box whose ceiling is the site limit —
 * found by that ceiling rather than by position, since the mismatch budget
 * above it is a number box too.
 */
function limitBox(root: HTMLElement): HTMLInputElement | null {
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="number"]')]
  return boxes.find((box) => box.max === String(MOTIF_SITE_LIMIT)) ?? null
}

describe('whether the task is offered', () => {
  it('waits for a reference rather than hiding itself', () => {
    const state = MOTIF_TASK.availability(context())
    expect(state.state).toBe('waiting')
    expect(state.state === 'waiting' && state.needs).toMatch(/FASTA/i)
  })

  it('is ready the moment one is loaded', () => {
    expect(MOTIF_TASK.availability(context({ entries: [sequenceEntry()] })).state).toBe('ready')
  })

  it('is ready in a session with no contact map at all', () => {
    // The 1D browser: a genome and some tracks, no matrix. Nothing this task
    // reads is on the map, so nothing about it should wait for one.
    const state = MOTIF_TASK.availability(context({ entries: [sequenceEntry()], hasMap: false }))
    expect(state.state).toBe('ready')
  })
})

describe('what it costs, and what it refuses', () => {
  const price = (pattern: string, sequence = 'seq1'): ReturnType<typeof MOTIF_TASK.estimate> =>
    MOTIF_TASK.estimate(context({ entries: [sequenceEntry()] }), {
      ...defaultParams(MOTIF_TASK.params),
      sequence,
      pattern,
    })

  it('reads nothing, because the residues are already in memory', () => {
    const estimate = price('GATC')
    expect(estimate.class).toBe('free')
    expect(estimate.requests).toBe(0)
    expect(estimate.refusal).toBeUndefined()
    // And says what it will cost in *time*, which is the honesty a class of
    // `free` does not carry on its own.
    expect(estimate.note).toMatch(/pass over/i)
  })

  it('refuses a pattern that is not IUPAC, in the matcher’s own words', () => {
    const estimate = price('ACGX')
    expect(estimate.refusal).toContain('X')
    expect(estimate.refusal).toMatch(/IUPAC/)
  })

  it('refuses an empty box, which is a form to finish', () => {
    expect(price('')?.refusal).toMatch(/type a sequence/i)
  })

  it('refuses when no reference has been chosen', () => {
    expect(price('GATC', '')?.refusal).toMatch(/Choose a reference/i)
  })

  it('accepts a pattern with the spaces a paper prints it with', () => {
    expect(price('GGTCA NNN TGACC').refusal).toBeUndefined()
  })
})

/**
 * A reference read by range is priced by what it reads (§8.8, §18.8).
 *
 * Held whole, a search reads nothing and is `free`. Opened by its `.fai`, every
 * base searched is a base read, so the class is `scan` and the bytes are the
 * ticked sequences' bases times what the file spends on one — the figure a
 * reader about to search a mouse genome over a network has to meet before
 * **Run**, not in the progress bar.
 */
describe('what it costs over a reference read by range', () => {
  function indexed(kind: 'remote' | 'local'): AnnotationEntry {
    return {
      ...sequenceEntry(),
      label: 'mm10.fa',
      source:
        kind === 'remote'
          ? { kind: 'remote', url: 'https://example.invalid/mm10.fa', name: 'mm10.fa' }
          : { kind: 'local', name: 'mm10.fa' },
      byRange: { bases: 2_600_000, bytesPerBase: 61 / 60 },
    } as AnnotationEntry
  }
  const price = (entry: AnnotationEntry, sequences?: string[]): ReturnType<typeof MOTIF_TASK.estimate> =>
    MOTIF_TASK.estimate(context({ entries: [entry] }), {
      ...defaultParams(MOTIF_TASK.params),
      sequence: 'seq1',
      pattern: 'GATC',
      ...(sequences === undefined ? {} : { sequences }),
    })

  it('is a scan of every base of the reference, in bytes and in requests', () => {
    const estimate = price(indexed('remote'))
    expect(estimate.class).toBe('scan')
    expect(estimate.refusal).toBeUndefined()
    expect(estimate.bytes).toBe(Math.round(2_600_000 * 61 / 60))
    // One piece per sequence here, every one shorter than a piece.
    expect(estimate.requests).toBe(3)
    expect(estimate.note).toMatch(/Every base of mm10\.fa, 2\.6 Mb, read by range/)
  })

  it('counts no requests on a local file, whose reads are a disk’s', () => {
    const estimate = price(indexed('local'))
    expect(estimate.class).toBe('scan')
    expect(estimate.requests).toBeNull()
    expect(estimate.bytes).toBeGreaterThan(0)
  })

  it('is the ticked sequences’ bases alone when not all of them are ticked', () => {
    const estimate = price(indexed('remote'), ['IV'])
    expect(estimate.bytes).toBe(Math.round(1_531_933 * 61 / 60))
    expect(estimate.requests).toBe(1)
    expect(estimate.note).toMatch(/Every base of IV, 1\.5 Mb/)
  })

  it('refuses a run over no sequence at all', () => {
    expect(price(indexed('remote'), []).refusal).toMatch(/Tick at least one sequence/)
    expect(price(sequenceEntry() as AnnotationEntry, []).refusal).toMatch(/Tick at least one sequence/)
  })

  it('stays free for a reference held whole, however many are ticked', () => {
    const estimate = price(sequenceEntry(), ['I', 'II'])
    expect(estimate.class).toBe('free')
    expect(estimate.note).toMatch(/one pass over 2 sequences of sacCer3\.fa, 1\.0 Mb/)
  })
})

describe('the form it renders', () => {
  const form = (): ParamForm =>
    new ParamForm({
      specs: MOTIF_TASK.params,
      context: context({ entries: [sequenceEntry()] }),
      value: defaultParams(MOTIF_TASK.params),
      onChange: () => {},
    })

  it('asks for the pattern in a plain box, not in a locus box', () => {
    const view = form()
    const boxes = [...view.el.querySelectorAll<HTMLInputElement>('input[type="text"]')]
    expect(boxes).toHaveLength(1)
    const box = boxes[0]
    expect(box.placeholder).toBe('GGTCANNNTGACC')
    // A locus box carries a `<datalist>` of the file's sequence names. Offering
    // `chrIV` to somebody typing `GATC` is the whole reason this is its own kind.
    expect(box.getAttribute('list')).toBeNull()
    expect(view.el.querySelector('datalist')).toBeNull()
  })

  it('starts empty rather than seeded from wherever the map is framed', () => {
    const box = form().el.querySelector<HTMLInputElement>('input[type="text"]')
    expect(box?.value).toBe('')
  })

  it('commits what was typed, trimmed, when the box changes', () => {
    const view = form()
    const box = view.el.querySelector<HTMLInputElement>('input[type="text"]')
    expect(box).not.toBeNull()
    if (box === null) return
    box.value = '  GGTCANNNTGACC '
    box.dispatchEvent(new Event('change'))
    expect(view.value.pattern).toBe('GGTCANNNTGACC')
  })

  it('commits on Enter too, which is the gesture for a one-box question', () => {
    const view = form()
    const box = view.el.querySelector<HTMLInputElement>('input[type="text"]')
    if (box === null) return
    box.value = 'TTAGGG'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(view.value.pattern).toBe('TTAGGG')
  })

  it('offers the loaded reference and the strand question beside it', () => {
    const text = form().el.textContent ?? ''
    // Lowercase field labels (§26.4). The pattern box beside these is now
    // labelled *motif* rather than *Sequence*, which is what a sequence is
    // called everywhere else in this app.
    expect(text).toContain('reference')
    expect(text).toContain('both strands')
  })

  it('offers every sequence to tick, all of them ticked to begin with', () => {
    // Genome-wide by default, as the search always was; a reader narrowing a
    // mammalian search to one chromosome unticks the rest (§18.8).
    const view = form()
    const ticks = [...view.el.querySelectorAll<HTMLInputElement>('.param-sequences input[type="checkbox"]')]
    expect(ticks).toHaveLength(3)
    expect(ticks.every((box) => box.checked)).toBe(true)
    expect(view.value.sequences).toEqual(['I', 'II', 'IV'])
    ticks[0].checked = false
    ticks[0].dispatchEvent(new Event('change'))
    expect(view.value.sequences).toEqual(['II', 'IV'])
  })

  /**
   * **Most sites** carries the ceiling as well as the floor.
   *
   * `MOTIF_SITE_LIMIT` is what `analysis/run/motif.ts` caps every scan at, and
   * the spec used to declare `min` and no `max` — so `ParamForm.numberControl`,
   * which applies each bound only where it is defined, committed 2,000,000
   * unchanged. The run then capped at 500,000 and told the reader to raise a
   * control that had already stopped meaning anything. A form that cannot
   * produce the impossible number is the half of the fix a reader sees.
   */
  it('will not commit a site limit above the ceiling the run enforces', () => {
    const view = form()
    const box = limitBox(view.el)
    expect(box).not.toBeNull()
    if (box === null) return
    // In the DOM as well as in the clamp, so the box itself says what it takes.
    expect(box.max).toBe(String(MOTIF_SITE_LIMIT))
    box.value = '2000000'
    box.dispatchEvent(new Event('change'))
    expect(view.value.limit).toBe(MOTIF_SITE_LIMIT)
    expect(box.value).toBe(String(MOTIF_SITE_LIMIT))
  })

  it('still takes a smaller limit, which is the reader’s to choose', () => {
    const view = form()
    const box = limitBox(view.el)
    if (box === null) return
    box.value = '1000'
    box.dispatchEvent(new Event('change'))
    expect(view.value.limit).toBe(1000)
  })
})
