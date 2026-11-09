// @vitest-environment jsdom
/**
 * The guided tutorial's own steps (§30), read on an empty window.
 *
 * Not what each step does — `scripts/ui-tutorial.mjs` plays all of them on
 * 4DN's data — but the rules the engine relies on and a new step can break
 * without anything on screen saying so: an id a resume would land on twice, a
 * step that goes back to one that is not there, a part split in two, which the
 * resume and the card's bar both read as two parts; and the tutorial opening
 * and closing on a card in the middle of the window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { partsOf, resumeIndex, type TourStep } from '@/ui/Tour'
import { TUTORIAL_SEQUENCE, TUTORIAL_SET, tutorialSteps, type TutorialHost } from '@/ui/tutorial'
import { setUpDom } from '../support/dom'

/** A window with nothing open in it. */
const empty: TutorialHost = {
  view: () => null,
  binsize: () => null,
  score: () => null,
  file: () => null,
  sequences: () => null,
  store: () => null,
  panelOpen: () => false,
  task: () => null,
  runs: () => [],
  running: () => false,
  tracks: () => null,
  square: () => null,
  consoleOpen: () => false,
  marks: () => null,
  saved: () => [],
}

beforeEach(() => {
  setUpDom()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the tutorial’s steps', () => {
  const steps = tutorialSteps(empty)

  it('has one id per step', () => {
    const ids = steps.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('goes back, when a step’s surroundings go, only to a step that comes before it', () => {
    steps.forEach((step, at) => {
      if (step.needs === undefined) return
      const back = steps.findIndex((other) => other.id === step.needs?.back)
      expect(back, `${step.id} goes back to ${step.needs.back}`).toBeGreaterThanOrEqual(0)
      expect(back, `${step.id} goes back to ${step.needs.back}`).toBeLessThan(at)
    })
  })

  it('keeps each part’s steps together, so a resume and the bar see one part', () => {
    const chapters = partsOf(steps).map((part) => part.chapter)
    expect(new Set(chapters).size).toBe(chapters.length)
  })

  it('opens on a welcome and closes on the end, both in the middle of the window', () => {
    expect(steps[0].id).toBe('welcome')
    expect(steps[0].hero).toBe(true)
    expect(steps[steps.length - 1].id).toBe('finish')
    expect(steps[steps.length - 1].hero).toBe(true)
    expect(steps.slice(1, -1).every((step) => step.hero !== true)).toBe(true)
  })

  it('names the set to type, and the sequence every task is run on', () => {
    const search = steps.find((step) => step.id === 'search')
    expect(JSON.stringify(search?.text)).toContain(TUTORIAL_SET)
    for (const id of ['compartments-sequence', 'insulation-sequence']) {
      expect(steps.find((step) => step.id === id)?.title).toBe(`Tick ${TUTORIAL_SEQUENCE}`)
    }
  })

  it('resumes a reader who left mid-part at that part’s first step', () => {
    const at = resumeIndex(steps, 'compartments-run')
    expect(steps[at].chapter).toBe('Compartments')
    expect(steps[at - 1].chapter).not.toBe('Compartments')
  })

  it('shows the three groups of tasks the first time the Analysis panel opens, and only then', () => {
    const ids = steps.map((step) => step.id)
    const after = (id: string): string[] => ids.slice(ids.indexOf(id) + 1, ids.indexOf(id) + 5)
    expect(after('analysis-compartments')).toEqual(['tasks-2d', 'tasks-3d', 'tasks-1d', 'compartments'])
    expect(after('analysis-insulation')[0]).toBe('insulation')
    expect(after('analysis-trackcorr')[0]).toBe('trackcorr')
  })

  it('asks nothing about phasing, and ticks every track in one step', () => {
    const ids = steps.map((step) => step.id)
    expect(ids.filter((id) => id.startsWith('phase'))).toEqual([])
    expect(ids.filter((id) => id.startsWith('tick'))).toEqual(['tick-tracks'])
  })

  it('shows General as the map opens, and Aesthetics once there is a map for it to draw', () => {
    const ids = steps.map((step) => step.id)
    expect(ids.indexOf('look-general')).toBe(ids.indexOf('open-set') + 1)
    expect(ids.indexOf('look-aesthetics')).toBe(ids.indexOf('look-map') + 1)
  })

  it('reads an empty window without throwing, and finds done there only what asks for a closed drawer', () => {
    for (const step of steps) {
      expect(() => step.done?.(), step.id).not.toThrow()
      expect(() => step.target?.(), step.id).not.toThrow()
    }
    const done = steps.filter((step) => step.done?.() === true).map((step) => step.id)
    expect(done).toEqual(['compartments-close', 'insulation-close'])
  })
})

describe('the stores', () => {
  it('has the drawer opened from its header button, then switched to 4DN’s, and goes back if it is put down', () => {
    // jsdom lays nothing out, and the steps find only what is laid out.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    document.body.innerHTML =
      '<div class="head-files"><button aria-label="stores"></button></div>' +
      '<div class="store-drawer"><button class="store-tile" data-store="rsg"></button>' +
      '<button class="store-tile" data-store="4dn"></button></div>'
    let open: string | null = null
    const steps = tutorialSteps({ ...empty, store: () => open })
    const step = (id: string): TourStep => {
      const found = steps.find((candidate) => candidate.id === id)
      if (found === undefined) throw new Error(`no step ${id}`)
      return found
    }
    expect(steps.slice(0, 4).map((candidate) => candidate.id)).toEqual(['welcome', 'stores', 'store', 'search'])

    expect(step('stores').target?.()).toBe(document.querySelector('.head-files button'))
    expect(step('stores').done?.()).toBe(false)
    open = 'rsg'
    expect(step('stores').done?.()).toBe(true)
    expect(step('store').target?.()).toBe(document.querySelector('[data-store="4dn"]'))
    expect(step('store').done?.()).toBe(false)
    open = '4dn'
    expect(step('store').done?.()).toBe(true)

    open = null
    expect(step('store').needs?.holds()).toBe(false)
    expect(step('store').needs?.back).toBe('stores')
  })
})

describe('the gene model', () => {
  it('is set to none by the tour before Compartments runs, through the form’s own change', () => {
    // jsdom lays nothing out, and the steps find only what is laid out.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    const drawer = document.createElement('div')
    drawer.className = 'analysis-drawer'
    drawer.innerHTML =
      '<label class="field param-field"><span class="field-label">phase by gene density</span>' +
      '<select><option value="">Do not use a gene model</option>' +
      '<option value="bed">Hi-C on IMR-90 — 4DNFIUI2RM2Q (bed.gz)</option></select></label>'
    document.body.appendChild(drawer)
    const select = drawer.querySelector('select') as HTMLSelectElement
    select.value = 'bed'
    const changes: string[] = []
    select.addEventListener('change', () => changes.push(select.value))

    const steps = tutorialSteps(empty)
    steps.find((step) => step.id === 'compartments-run')?.prepare?.()
    expect(select.value).toBe('')
    expect(changes).toEqual([''])

    // Already none: nothing is written, and no second change reaches the form.
    steps.find((step) => step.id === 'compartments-none')?.prepare?.()
    expect(changes).toEqual([''])
  })
})
