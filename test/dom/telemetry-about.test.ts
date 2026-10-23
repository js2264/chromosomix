// @vitest-environment jsdom
/**
 * Telemetry as the reader meets it (§31): a section of About that says what is
 * sent and where it goes, with the switch, and a clause on the landing page's
 * privacy note — each present only where the site sends any.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openAbout } from '@/ui/dialogs'
import { resetTelemetryForTests, telemetryWanted } from '@/telemetry'
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
  resetTelemetryForTests()
})

const section = (): HTMLElement | null => document.querySelector('.about-telemetry')
const toggle = (): HTMLButtonElement | null => document.querySelector('.about-telemetry .btn-toggle')

describe('About, on the subject of telemetry', () => {
  it('says nothing in a build that counts nothing', () => {
    resetTelemetryForTests({ endpoint: '' })
    openAbout('https://example.org/repo')
    expect(section()).toBeNull()
  })

  it('says what is counted, where it goes and what never is, with the switch lit', () => {
    resetTelemetryForTests({ endpoint: 'https://plausible.io/api/event' })
    openAbout('https://example.org/repo')
    const text = section()?.textContent ?? ''
    expect(text).toContain('Telemetry')
    expect(text).toContain('plausible.io')
    expect(text).toContain('never a file name, an address, a place on the genome')
    expect(toggle()?.textContent).toBe('telemetry')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('turns them off for this browser, and on again', () => {
    resetTelemetryForTests({ endpoint: 'https://plausible.io/api/event' })
    openAbout('https://example.org/repo')
    toggle()?.click()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(telemetryWanted()).toBe(false)
    toggle()?.click()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(telemetryWanted()).toBe(true)
  })

  it('offers no switch to a browser that already asks not to be tracked, and says it is obeyed', () => {
    setNavigator('globalPrivacyControl', true)
    resetTelemetryForTests({ endpoint: 'https://plausible.io/api/event' })
    openAbout('https://example.org/repo')
    expect(toggle()).toBeNull()
    expect(section()?.textContent).toContain('so this one sends nothing')
  })
})
