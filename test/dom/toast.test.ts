// @vitest-environment jsdom
/**
 * The corner note, and the one thing about it that is not cosmetic.
 *
 * It carries a progress bar and a ×, and a × next to a moving bar is a promise
 * that pressing it stops the work. The first version only removed the element:
 * the `.mcool` went on being written in the worker and the download still fired
 * after the note was gone. That is the case pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { messageToast, progressToast } from '@/ui/toast'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  document.querySelectorAll('.toast').forEach((node) => node.remove())
  teardown()
})

const close = (): HTMLButtonElement => document.querySelector('.toast-close') as HTMLButtonElement
const note = (): string => document.querySelector('.toast-note')?.textContent ?? ''
/** The bar's width as a number: jsdom normalises `25.0%` to `25%`. */
const width = (): number =>
  Number.parseFloat((document.querySelector('.toast-fill') as HTMLElement).style.width)

describe('progressToast', () => {
  it('calls off the work when it is dismissed while running', () => {
    const cancel = vi.fn()
    progressToast('Writing .mcool', cancel)
    close().click()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('does not call off work that has already finished', () => {
    const cancel = vi.fn()
    const toast = progressToast('Writing .mcool', cancel)
    toast.finish('done.mcool')
    close().click()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('does not call off work that already failed', () => {
    const cancel = vi.fn()
    const toast = progressToast('Writing .mcool', cancel)
    toast.fail('out of memory')
    close().click()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shows the note beside the percentage', () => {
    const toast = progressToast('Writing .mcool')
    toast.update(1, 4, 'writing pixels')
    expect(note()).toBe('writing pixels — 25%')
    expect(width()).toBe(25)
    toast.update(1, 4)
    expect(note()).toBe('25%')
  })

  it('survives a zero denominator rather than showing NaN', () => {
    const toast = progressToast('Writing .mcool')
    toast.update(0, 0)
    expect(note()).toBe('0%')
    expect(width()).toBe(0)
  })

  it('takes the bar away on a failure and leaves the message standing', () => {
    const toast = progressToast('Writing .mcool')
    toast.fail('could not write it')
    expect(document.querySelector('.toast-bar')).toBeNull()
    expect(note()).toBe('could not write it')
    expect(document.querySelector('.toast')).not.toBeNull()
  })
})

/**
 * The one-shot note, and the two things about it that are not cosmetic either.
 *
 * A bar on it would promise a second event that never comes — there is nothing
 * running behind this note, the thing it reports has already happened — and a
 * second note landing on top of the first would leave one illegible box with two
 * × in it. The share dialog produces exactly that pair: it copies the link when
 * it opens and copies the shortened one a moment later, well inside the four
 * seconds the first note stays.
 */
describe('messageToast', () => {
  it('is one settled line, with nothing that suggests work in progress', () => {
    messageToast('Link copied to the clipboard.')
    const toast = document.querySelector('.toast') as HTMLElement
    expect(toast).not.toBeNull()
    expect(toast.getAttribute('role')).toBe('status')
    expect(document.querySelector('.toast-label')?.textContent).toBe('Link copied to the clipboard.')
    expect(document.querySelector('.toast-bar')).toBeNull()
    expect(document.querySelector('.toast-note')).toBeNull()
    expect(toast.classList.contains('toast-done')).toBe(true)
  })

  it('replaces the note already standing rather than stacking on it', () => {
    messageToast('Link copied to the clipboard.')
    messageToast('Short link copied to the clipboard.')
    expect(document.querySelectorAll('.toast')).toHaveLength(1)
    expect(document.querySelector('.toast-label')?.textContent).toBe(
      'Short link copied to the clipboard.',
    )
  })

  it('goes on its own, and goes when it is closed', () => {
    vi.useFakeTimers()
    try {
      messageToast('Link copied to the clipboard.')
      close().click()
      expect(document.querySelector('.toast')).toBeNull()

      messageToast('Link copied to the clipboard.')
      vi.advanceTimersByTime(4_000)
      expect(document.querySelector('.toast')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
