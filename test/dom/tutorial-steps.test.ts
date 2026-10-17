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

import { beforeEach, describe, expect, it } from 'vitest'

import { partsOf, resumeIndex } from '@/ui/Tour'
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
}

beforeEach(() => {
  setUpDom()
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
    const at = resumeIndex(steps, 'phase-track')
    expect(steps[at].chapter).toBe('Compartments')
    expect(steps[at - 1].chapter).not.toBe('Compartments')
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
