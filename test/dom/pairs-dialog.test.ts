// @vitest-environment jsdom
/**
 * The one dialog that has to be answered before anything can be drawn.
 *
 * There is no map behind it — a `.pairs` file states no resolution, so the grid
 * does not exist until the reader picks one — and that makes two things load
 * bearing in a way they are not elsewhere. The numbers it shows have to be
 * *this file's*, because they are the whole basis of the choice; and dismissing
 * it has to unwind the open rather than reveal something, because there is
 * nothing behind it to reveal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openPairsDialog } from '@/ui/PairsDialog'
import type { PairsBinning, PairsProbeResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
  teardown()
})

const PROBE: PairsProbeResult = {
  contigs: [
    { name: 'chrI', length: 230_218 },
    { name: 'chrII', length: 813_184 },
    { name: 'chrIII', length: 316_620 },
  ],
  genomeLength: 1_360_022,
  records: 500_000,
  indexed: true,
  assembly: 'sacCer3',
  sorted: 'chr1-chr2-pos1-pos2',
  sourceBytes: 12_345_678,
  suggestedBase: 1_000,
}

function open(
  probe: PairsProbeResult = PROBE,
): { chosen: PairsBinning | null; cancelled: () => boolean } {
  const state = { chosen: null as PairsBinning | null, wasCancelled: false }
  openPairsDialog({
    probe,
    fileLabel: 'yeast.pairs.gz',
    onConfirm: (binning) => {
      state.chosen = binning
    },
    onCancel: () => {
      state.wasCancelled = true
    },
  })
  return { get chosen() { return state.chosen }, cancelled: () => state.wasCancelled }
}

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.trim() ?? ''

const input = (selector: string): HTMLInputElement =>
  document.querySelector(selector) as HTMLInputElement

function type(selector: string, value: string): void {
  const box = input(selector)
  box.value = value
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the pairs binning dialog', () => {
  it('opens on the suggested resolution, not on an empty box', () => {
    open()
    expect(input('.pairs-base').value).toBe('1000')
    expect(Number(input('.pairs-rungs').value)).toBeGreaterThan(0)
  })

  it('says what is in the file, including that it is indexed', () => {
    open()
    const summary = text('.pairs-summary')
    expect(summary).toContain('3 sequences')
    expect(summary).toContain('sacCer3')
    expect(summary).toContain('indexed')
    expect(summary).toContain('500,000 records')
  })

  it('says the whole file is read when there is no index', () => {
    open({ ...PROBE, indexed: false, records: null })
    expect(text('.pairs-summary')).toContain('no .px2 index')
  })

  it('previews the ladder as bin sizes rather than as a count', () => {
    open()
    expect(text('.pairs-ladder')).toContain('1 kb, 2 kb, 5 kb')
    type('.pairs-rungs', '2')
    expect(text('.pairs-ladder')).toBe('Ladder: 1 kb, 2 kb.')
  })

  it('recomputes the cost as the resolution is typed', () => {
    open()
    const fine = text('.pairs-cost')
    type('.pairs-base', '10000')
    const coarse = text('.pairs-cost')
    expect(coarse).not.toBe(fine)
    // chrI 24 + chrII 82 + chrIII 32 bins at 10 kb, each rounded up.
    expect(coarse).toContain('138 bins at 10 kb')
    expect(coarse).toContain('over 500,000 records')
    // The triangle binds here, not the record count: 138 * 139 / 2.
    expect(coarse).toContain('at most 9,591 stored pixels')
  })

  it('warns before a grid so fine that most bins would hold one contact', () => {
    open()
    type('.pairs-base', '1')
    expect(text('.pairs-warning')).toContain('scatter')
    type('.pairs-base', '10000')
    expect(text('.pairs-warning')).toBe('')
  })

  it('snaps a typed resolution onto the 1-2-5 series when the box is left', () => {
    open()
    const box = input('.pairs-base')
    box.value = '1500'
    box.dispatchEvent(new Event('blur', { bubbles: true }))
    expect(box.value).toBe('2000')
  })

  it('hands back the choice, with the download on by default', () => {
    const session = open()
    type('.pairs-base', '5000')
    type('.pairs-rungs', '3')
    ;(document.querySelector('.pairs-actions .btn-primary') as HTMLButtonElement).click()
    expect(session.chosen).toEqual({ base: 5_000, rungs: 3, oneBased: true, download: true })
  })

  it('lets the download be turned off', () => {
    const session = open()
    const box = document.querySelector('.pairs-download input') as HTMLInputElement
    box.checked = false
    ;(document.querySelector('.pairs-actions .btn-primary') as HTMLButtonElement).click()
    expect(session.chosen?.download).toBe(false)
  })

  it('submits on Enter from either box', () => {
    const session = open()
    input('.pairs-base').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    expect(session.chosen).not.toBeNull()
  })

  it('unwinds the open when it is dismissed, because nothing is behind it', () => {
    const session = open()
    ;(document.querySelector('.modal-panel .btn-close') as HTMLButtonElement).click()
    expect(session.cancelled()).toBe(true)
    expect(session.chosen).toBeNull()
  })

  it('does not report a cancel when it was answered', () => {
    const session = open()
    ;(document.querySelector('.pairs-actions .btn-primary') as HTMLButtonElement).click()
    expect(session.cancelled()).toBe(false)
  })

  it('falls back to the suggestion rather than binning at zero', () => {
    const session = open()
    type('.pairs-base', '0')
    // A zero bin size would make every coordinate formula a division by zero,
    // so the empty or nonsensical box reads as "the number you were offered"
    // rather than as a value to honour.
    expect(text('.pairs-ladder')).toContain('1 kb')
    ;(document.querySelector('.pairs-actions .btn-primary') as HTMLButtonElement).click()
    expect(session.chosen?.base).toBe(1_000)
  })
})
