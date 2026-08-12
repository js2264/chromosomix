// @vitest-environment jsdom
/**
 * What a task remembers, and the one scope it is allowed to remember it in.
 *
 * §18.2: a parameter set is a decision, and a reader who has found the
 * insulation window that shows what they are looking at should not have to find
 * it again after clicking a chromosome. `analysis/memory.ts` is where that lives
 * and its docstring is emphatic about *why it is one scope*: `SessionConfig`
 * gathers a session by reading a **fixed list** of scopes out of storage, which
 * is what makes an exported config provably the same thing a reload would
 * restore, and a scope named after a task id cannot be on a fixed list.
 *
 * The drawer had grown its own anyway. It read and wrote `analysis:<task id>`,
 * one scope per task, while the workspace wrote every task's parameters into
 * `analysis:params` on Run — two schemes for one thing, splitting exactly where
 * that docstring said they would. The visible half was that an exported session
 * carried the parameters of every task and put none of them back: `buildConfig`
 * read `analysis:params`, `applyConfig` wrote it, and the form that was supposed
 * to open from it was looking somewhere else entirely.
 *
 * So this asserts the join rather than either side of it: what the form writes
 * is what `SessionConfig` collects, and what `SessionConfig` restores is what the
 * form opens with.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ANALYSIS_SCOPE, readAnalysisMemory, recallParams, rememberParams } from '@/analysis/memory'
import type { AnalysisRunner } from '@/analysis/runner'
import type { AnalysisContext, AnalysisFraming, AnalysisTask } from '@/analysis/types'
import { READY } from '@/analysis/types'
import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import { recall } from '@/state/UiMemory'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
})

afterEach(() => {
  teardown()
  window.sessionStorage.clear()
})

const URI = 'yeast.mcool::/resolutions/1000'

const TASK: AnalysisTask = {
  id: 'insulation',
  title: 'Diamond insulation',
  blurb: 'A boundary score per bin.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: () => READY,
  params: [
    {
      kind: 'number',
      key: 'window',
      label: 'Diamond window',
      default: 100_000,
      min: 1000,
      integer: true,
    },
    { kind: 'toggle', key: 'balance', label: 'Use balancing weights', default: false },
  ],
  outputs: ['profile'],
  estimate: () => ({ class: 'free', requests: 0, bytes: 0, note: 'free' }),
}

/** A second task, so "one scope, keyed by task" is a claim with two keys in it. */
const OTHER: AnalysisTask = {
  ...TASK,
  id: 'ps',
  title: 'Contact probability',
  params: [{ kind: 'number', key: 'factor', label: 'Bin factor', default: 1.1, min: 1 }],
}

const FRAMING: AnalysisFraming = {
  uri: URI,
  label: 'chrIV at 1 kb',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 500],
  cols: [0, 500],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

const CONTEXT: AnalysisContext = {
  uri: URI,
  layout: 'cool',
  hasMap: true,
  hasGenomes: false,
  hasWeights: false,
  scoreColumns: [],
  binsize: 1000,
  nBins: 500,
  contigs: [],
  genomes: null,
  entries: [],
  framing: FRAMING,
  blockLoaded: true,
  blockBytes: 0,
}

const RUNNER = {
  subscribe: () => () => {},
  resultOf: () => null,
  resultsFor: () => [],
  stateOf: () => ({ status: 'idle' }),
  run: () => {},
  runAll: () => {},
  /** One map, so the drawer offers no batch — see `AnalysisRunner.targets`. */
  targets: () => [],
  cancel: () => {},
} as unknown as AnalysisRunner

function open(task: AnalysisTask): { el: HTMLElement; destroy(): void } {
  const drawer = new AnalysisDrawer({
    runner: RUNNER,
    context: () => CONTEXT,
    framing: () => FRAMING,
    onClose: () => {},
    hasLanes: () => true,
    writeProfile: () => Promise.resolve(),
  })
  document.body.appendChild(drawer.el)
  drawer.show(task)
  return { el: drawer.el, destroy: () => drawer.destroy() }
}

/** The number box a parameter is typed into, by its label's `for`. */
function numberBox(root: ParentNode, key: string): HTMLInputElement {
  const found = all<HTMLInputElement>(root, 'input[type="number"]').find((box) =>
    (box.id ?? '').endsWith(`-${key}`),
  )
  if (found === undefined) throw new Error(`no box for ${key}`)
  return found
}

/**
 * The on/off button for a toggle parameter, found by the label it is named by.
 *
 * A `<button aria-pressed>` rather than a checkbox: the word beside it is what
 * names it, so the button carries `aria-labelledby` pointing at that word.
 */
function toggle(root: ParentNode, key: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>(root, 'button.btn-toggle').find((node) =>
    (node.getAttribute('aria-labelledby') ?? '').endsWith(`-${key}-label`),
  )
  if (found === undefined) throw new Error(`no toggle for ${key}`)
  return found
}

/** Whether that button is pressed, which is what the parameter holds. */
function pressed(root: ParentNode, key: string): boolean {
  return toggle(root, key).getAttribute('aria-pressed') === 'true'
}

function typeInto(box: HTMLInputElement, value: string): void {
  box.value = value
  box.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('the form opens where it was left', () => {
  it('starts at the descriptor’s defaults with nothing stored', () => {
    const view = open(TASK)
    expect(numberBox(view.el, 'window').value).toBe('100000')
    expect(pressed(view.el, 'balance')).toBe(false)
    view.destroy()
  })

  it('opens at what was stored for this file and this task', () => {
    rememberParams(URI, 'insulation', { window: 25_000, balance: true })
    const view = open(TASK)
    expect(numberBox(view.el, 'window').value).toBe('25000')
    expect(pressed(view.el, 'balance')).toBe(true)
    view.destroy()
  })

  it('keeps a parameter the descriptor has gained since', () => {
    rememberParams(URI, 'insulation', { window: 25_000 })
    const view = open(TASK)
    expect(numberBox(view.el, 'window').value).toBe('25000')
    // `balance` was not in what was written, so it is at its default rather
    // than `undefined`.
    expect(pressed(view.el, 'balance')).toBe(false)
    view.destroy()
  })

  it('drops a key the descriptor has lost, and one of the wrong shape', () => {
    rememberParams(URI, 'insulation', {
      window: 25_000,
      // A parameter this task no longer has, and one whose type has changed.
      scales: 'three',
      balance: 'yes' as unknown as boolean,
    })
    const view = open(TASK)
    expect(numberBox(view.el, 'window').value).toBe('25000')
    expect(pressed(view.el, 'balance')).toBe(false)
    view.destroy()
  })

  it('keeps one file’s decisions off another file', () => {
    rememberParams('other.cool', 'insulation', { window: 5000 })
    const view = open(TASK)
    expect(numberBox(view.el, 'window').value).toBe('100000')
    view.destroy()
  })
})

describe('the scope it writes to', () => {
  it('is the one `SessionConfig` collects, and no other', () => {
    const view = open(TASK)
    typeInto(numberBox(view.el, 'window'), '40000')

    // The join. `buildConfig` reads exactly this scope; the drawer used to read
    // and write `analysis:insulation`, which nothing on the fixed list names.
    const stored = recall<Record<string, unknown>>(URI, ANALYSIS_SCOPE)
    expect(stored).not.toBeNull()
    expect((stored as Record<string, Record<string, unknown>>)['insulation'].window).toBe(40_000)
    expect(recall(URI, 'analysis:insulation')).toBeNull()
    view.destroy()
  })

  it('holds every task at once rather than one per scope', () => {
    const first = open(TASK)
    typeInto(numberBox(first.el, 'window'), '40000')
    first.destroy()

    const second = open(OTHER)
    typeInto(numberBox(second.el, 'factor'), '1.4')
    second.destroy()

    // A read-modify-write, so the second task's entry did not take the first
    // task's with it.
    expect(Object.keys(readAnalysisMemory(URI)).sort()).toEqual(['insulation', 'ps'])
    expect(recallParams(URI, 'insulation')?.window).toBe(40_000)
    expect(recallParams(URI, 'ps')?.factor).toBe(1.4)
  })

  it('remembers on every edit rather than on Run', () => {
    const view = open(TASK)
    typeInto(numberBox(view.el, 'window'), '40000')
    // Nothing has been run, and reproducing a figure is opening the session and
    // pressing Run — including the run the reader configured and came back to.
    expect(recallParams(URI, 'insulation')?.window).toBe(40_000)
    view.destroy()
  })

  it('comes back through what an exported session carries', () => {
    const view = open(TASK)
    typeInto(numberBox(view.el, 'window'), '40000')
    toggle(view.el, 'balance').click()
    view.destroy()

    // What `buildConfig` would have gathered, replayed the way `applyConfig`
    // replays it — and the form opens on it.
    const exported = recall<Record<string, unknown>>(URI, ANALYSIS_SCOPE)
    window.sessionStorage.clear()
    expect(recallParams(URI, 'insulation')).toBeNull()
    for (const [task, params] of Object.entries(exported ?? {})) {
      rememberParams(URI, task, params as Record<string, never>)
    }

    const reopened = open(TASK)
    expect(numberBox(reopened.el, 'window').value).toBe('40000')
    expect(pressed(reopened.el, 'balance')).toBe(true)
    reopened.destroy()
  })
})

describe('what comes out of storage is untrusted', () => {
  it('reads nothing at all out of a value that is not a record of records', () => {
    window.sessionStorage.setItem(
      `metacooler-viewer:ui:${URI}:${ANALYSIS_SCOPE}`,
      JSON.stringify([1, 2, 3]),
    )
    expect(readAnalysisMemory(URI)).toEqual({})
    const view = open(TASK)
    expect(numberBox(view.el, 'window').value).toBe('100000')
    view.destroy()
  })

  it('keeps the entries that are records and drops the ones that are not', () => {
    window.sessionStorage.setItem(
      `metacooler-viewer:ui:${URI}:${ANALYSIS_SCOPE}`,
      JSON.stringify({ insulation: { window: 7000 }, ps: 'nonsense' }),
    )
    expect(Object.keys(readAnalysisMemory(URI))).toEqual(['insulation'])
    expect(recallParams(URI, 'ps')).toBeNull()
  })
})
