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

import { progressToast } from '@/ui/toast'
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
