// @vitest-environment jsdom
/**
 * The guided tutorial as *About* offers it (§30), and the place it keeps.
 *
 * About is the way in a newcomer finds without being told, and the way back for
 * a reader who left half way: so what it offers follows what was kept — *play*
 * for nobody yet, *resume at step n of m* with a quiet *start over* beside it
 * for a reader who left, *play again* for one who finished — and a value nobody
 * wrote is a reader who never started rather than an error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TOUR_KEY, readTourProgress, writeTourProgress, type TourProgress } from '@/state/tour'
import { openAbout } from '@/ui/dialogs'
import { setUpDom } from '../support/dom'

beforeEach(() => {
  setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
  window.localStorage.clear()
})

function about(progress: TourProgress | null): { play: ReturnType<typeof vi.fn> } {
  const play = vi.fn()
  openAbout('https://example.org/repo', null, undefined, { progress, play })
  return { play }
}

const invited = (): HTMLButtonElement => document.querySelector('.about-tutorial-play') as HTMLButtonElement
const buttons = (): string[] =>
  Array.from(document.querySelectorAll('.about-tutorial-actions button')).map((node) => node.textContent ?? '')

describe('About', () => {
  it('offers to play the tutorial to a reader who has not begun it, and closes for it', () => {
    const { play } = about(null)
    expect(buttons()).toEqual(['play the tutorial'])
    invited().click()
    expect(play).toHaveBeenCalledWith('start')
    expect(document.querySelector('.about-tutorial')).toBeNull()
  })

  it('offers to resume where the reader left, with the way back to the start beside it', () => {
    const { play } = about({ step: 'insulation-sequence', index: 18, total: 35, finished: false })
    expect(buttons()).toEqual(['resume at step 19 of 35', 'start over'])
    invited().click()
    expect(play).toHaveBeenCalledWith('resume')
  })

  it('starts over from the quiet button', () => {
    const { play } = about({ step: 'insulation-sequence', index: 18, total: 35, finished: false })
    const over = Array.from(document.querySelectorAll<HTMLButtonElement>('.about-tutorial-actions button')).find(
      (node) => node.textContent === 'start over',
    )
    over?.click()
    expect(play).toHaveBeenCalledWith('start')
  })

  it('offers it again to a reader who finished it', () => {
    about({ step: 'finish', index: 34, total: 35, finished: true })
    expect(buttons()).toEqual(['play the tutorial again'])
  })

  it('says nothing of it where it cannot be played', () => {
    openAbout('https://example.org/repo')
    expect(document.querySelector('.about-body')).not.toBeNull()
    expect(document.querySelector('.about-tutorial')).toBeNull()
  })
})

describe('the place kept', () => {
  it('reads back what was written, under the app’s prefix', () => {
    writeTourProgress({ step: 'zoom', index: 15, total: 35, finished: false })
    expect(TOUR_KEY.startsWith('chromosomix:')).toBe(true)
    expect(readTourProgress()).toEqual({ step: 'zoom', index: 15, total: 35, finished: false })
  })

  it('takes a value nobody wrote for a reader who never started', () => {
    expect(readTourProgress()).toBeNull()
    window.localStorage.setItem(TOUR_KEY, 'not json')
    expect(readTourProgress()).toBeNull()
    window.localStorage.setItem(TOUR_KEY, JSON.stringify({ step: 'zoom', index: '15' }))
    expect(readTourProgress()).toBeNull()
  })
})
