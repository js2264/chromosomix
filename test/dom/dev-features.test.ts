// @vitest-environment jsdom
/**
 * Dev features (§29): one switch, off by default, kept per browser, never in an
 * embed, and the one trace a dev feature leaves — the switch in *About*.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_FEATURES,
  DEV_FEATURES_KEY,
  devFeature,
  devFeaturesOn,
  resetDevFeatures,
  setDevFeatures,
} from '../../src/state/devFeatures'
import { resetMounting } from '../../src/embed'
import { openAbout } from '../../src/ui/dialogs'
import { setUpDom } from '../support/dom'

function at(search: string): void {
  window.history.replaceState(null, '', `/${search}`)
  resetMounting()
  resetDevFeatures()
}

describe('the switch', () => {
  beforeEach(() => {
    setUpDom()
    window.localStorage.clear()
    at('')
  })
  afterEach(() => {
    window.localStorage.clear()
    at('')
  })

  it('is off until it is turned on', () => {
    expect(devFeaturesOn()).toBe(false)
    for (const name of Object.keys(DEV_FEATURES) as Array<keyof typeof DEV_FEATURES>) {
      expect(devFeature(name)).toBe(false)
    }
  })

  it('is kept in this browser, and read once per page', () => {
    window.localStorage.setItem(DEV_FEATURES_KEY, 'on')
    resetDevFeatures()
    expect(devFeaturesOn()).toBe(true)
    expect(devFeature('metacool')).toBe(true)
    // Read once: a page built with one answer is not changed under it.
    window.localStorage.removeItem(DEV_FEATURES_KEY)
    expect(devFeaturesOn()).toBe(true)
  })

  it('is never on in an embed, whatever the browser holds', () => {
    window.localStorage.setItem(DEV_FEATURES_KEY, 'on')
    at('?embed=1')
    expect(devFeaturesOn()).toBe(false)
  })

  it('writes the preference and rebuilds the window when it is turned', () => {
    const reload = vi.fn()
    setDevFeatures(true, reload)
    expect(window.localStorage.getItem(DEV_FEATURES_KEY)).toBe('on')
    expect(reload).toHaveBeenCalledTimes(1)
    setDevFeatures(false, reload)
    expect(window.localStorage.getItem(DEV_FEATURES_KEY)).toBeNull()
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

describe('About', () => {
  beforeEach(() => {
    setUpDom()
    window.localStorage.clear()
    at('')
  })
  afterEach(() => {
    document.body.replaceChildren()
    window.localStorage.clear()
    at('')
  })

  function openedText(): { text: string; toggle: HTMLButtonElement | null } {
    const modal = openAbout('https://example.org/repo')
    const body = document.querySelector('.about-body')
    const text = body?.textContent ?? ''
    const toggle = document.querySelector<HTMLButtonElement>('.about-dev .btn-switch')
    modal.close()
    return { text, toggle }
  }

  it('carries the switch, off, and says nothing of .metacool', () => {
    const { text, toggle } = openedText()
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
    expect(text).toContain('dev features')
    expect(text).not.toMatch(/metacool/i)
    expect(text).not.toMatch(/multi-genome/i)
  })

  it('names .metacool once the switch is on, and shows it lit', () => {
    window.localStorage.setItem(DEV_FEATURES_KEY, 'on')
    resetDevFeatures()
    const { text, toggle } = openedText()
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    expect(text).toMatch(/\.metacool multi-genome/)
  })
})
