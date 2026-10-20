// @vitest-environment jsdom
/**
 * Dev features (§29): off unless the page's address asks for them, read once
 * per page, never in an embed, and no trace of them in *About*.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEV_FEATURES,
  devFeature,
  devFeaturesOn,
  readDevFeatures,
  resetDevFeatures,
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
    at('')
  })
  afterEach(() => at(''))

  it('is off unless the address asks', () => {
    expect(devFeaturesOn()).toBe(false)
    for (const name of Object.keys(DEV_FEATURES) as Array<keyof typeof DEV_FEATURES>) {
      expect(devFeature(name)).toBe(false)
    }
  })

  it('is on for a key that is present, and off for the three spellings of no', () => {
    for (const on of ['?dev', '?dev=1', '?dev=on', '?dev=true', '?config=a.json&dev']) {
      expect(readDevFeatures(on)).toBe(true)
    }
    for (const off of ['', '?dev=0', '?dev=false', '?dev=off', '?devel=1', '?embed=1']) {
      expect(readDevFeatures(off)).toBe(false)
    }
  })

  it('is read from the address once per page', () => {
    at('?dev')
    expect(devFeaturesOn()).toBe(true)
    expect(devFeature('metacool')).toBe(true)
    // Read once: a page built with one answer is not changed under it.
    window.history.replaceState(null, '', '/')
    expect(devFeaturesOn()).toBe(true)
  })

  it('keeps nothing in the browser', () => {
    window.localStorage.clear()
    at('?dev')
    expect(devFeaturesOn()).toBe(true)
    expect(window.localStorage.length).toBe(0)
    at('')
    expect(devFeaturesOn()).toBe(false)
  })

  it('is never on in an embed, whatever the address asks', () => {
    at('?embed=1&dev')
    expect(devFeaturesOn()).toBe(false)
  })
})

describe('About', () => {
  beforeEach(() => {
    setUpDom()
    at('')
  })
  afterEach(() => {
    document.body.replaceChildren()
    at('')
  })

  function openedText(): string {
    const modal = openAbout('https://example.org/repo')
    const text = document.querySelector('.about-body')?.textContent ?? ''
    modal.close()
    return text
  }

  it('carries no switch and says nothing of dev features or .metacool', () => {
    const text = openedText()
    expect(document.querySelector('.btn-switch')).toBeNull()
    expect(text).not.toMatch(/\bdev\b/i)
    expect(text).not.toMatch(/metacool/i)
    expect(text).not.toMatch(/multi-genome/i)
  })

  it('names .metacool once the page asked for the dev features, and still no switch', () => {
    at('?dev')
    const text = openedText()
    expect(text).toMatch(/\.metacool multi-genome/)
    expect(text).not.toMatch(/\bdev\b/i)
  })
})
