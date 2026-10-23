// @vitest-environment jsdom
/**
 * The usage counts as the reader meets them (§31): a section of About that
 * says what is counted and where it goes, with the switch, and a clause on the
 * landing page's privacy note — each present only where the site counts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openAbout } from '@/ui/dialogs'
import { resetUsageForTests, usageCountsWanted } from '@/telemetry'
import { setUpDom } from '../support/dom'

function setNavigator(field: string, value: unknown): void {
  Object.defineProperty(window.navigator, field, { value, configurable: true })
}

beforeEach(() => {
  setUpDom()
  window.localStorage.clear()
  setNavigator('globalPrivacyControl', undefined)
  setNavigator('doNotTrack', null)
})

afterEach(() => {
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
  window.localStorage.clear()
  resetUsageForTests()
})

const section = (): HTMLElement | null => document.querySelector('.about-usage')
const toggle = (): HTMLButtonElement | null => document.querySelector('.about-usage .btn-toggle')

describe('About, on the subject of usage counts', () => {
  it('says nothing in a build that counts nothing', () => {
    resetUsageForTests({ endpoint: '' })
    openAbout('https://example.org/repo')
    expect(section()).toBeNull()
  })

  it('says what is counted, where it goes and what never is, with the switch lit', () => {
    resetUsageForTests({ endpoint: 'https://plausible.io/api/event' })
    openAbout('https://example.org/repo')
    const text = section()?.textContent ?? ''
    expect(text).toContain('Usage counts')
    expect(text).toContain('plausible.io')
    expect(text).toContain('never a file name, an address, a place on the genome')
    expect(toggle()?.textContent).toBe('usage counts')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('turns them off for this browser, and on again', () => {
    resetUsageForTests({ endpoint: 'https://plausible.io/api/event' })
    openAbout('https://example.org/repo')
    toggle()?.click()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(usageCountsWanted()).toBe(false)
    toggle()?.click()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(usageCountsWanted()).toBe(true)
  })

  it('offers no switch to a browser that already asks not to be tracked, and says it is obeyed', () => {
    setNavigator('globalPrivacyControl', true)
    resetUsageForTests({ endpoint: 'https://plausible.io/api/event' })
    openAbout('https://example.org/repo')
    expect(toggle()).toBeNull()
    expect(section()?.textContent).toContain('so this one sends nothing')
  })
})
