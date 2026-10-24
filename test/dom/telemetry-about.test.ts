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

const WEBSITE = '4fb3a1c2-6d0e-4b7a-9c35-1e2f3a4b5c6d'

const section = (): HTMLElement | null => document.querySelector('.about-telemetry')
const toggle = (): HTMLButtonElement | null => document.querySelector('.about-telemetry .btn-toggle')

describe('About, on the subject of telemetry', () => {
  it('says nothing in a build that counts nothing', () => {
    resetTelemetryForTests({ endpoint: '' })
    openAbout('https://example.org/repo')
    expect(section()).toBeNull()
  })

  it('says what is counted, where it goes and what never is, with the switch lit', () => {
    resetTelemetryForTests({ endpoint: 'https://cloud.umami.is/api/send', website: WEBSITE })
    openAbout('https://example.org/repo')
    const text = section()?.textContent ?? ''
    expect(text).toContain('Telemetry')
    expect(text).toContain('cloud.umami.is')
    expect(text).toContain('Never a file name, an address or a place on the genome')
    // Short, and in sentences rather than asides: no dash anywhere in it.
    expect(text).not.toMatch(/[—–]/)
    expect(toggle()?.textContent).toBe('telemetry')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('turns them off for this browser, and on again', () => {
    resetTelemetryForTests({ endpoint: 'https://cloud.umami.is/api/send', website: WEBSITE })
    openAbout('https://example.org/repo')
    toggle()?.click()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(telemetryWanted()).toBe(false)
    toggle()?.click()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(telemetryWanted()).toBe(true)
  })

  it('offers no switch to a browser sending Global Privacy Control, and says it is obeyed', () => {
    setNavigator('globalPrivacyControl', true)
    resetTelemetryForTests({ endpoint: 'https://cloud.umami.is/api/send', website: WEBSITE })
    openAbout('https://example.org/repo')
    expect(toggle()).toBeNull()
    expect(section()?.textContent).toContain('Your browser sends Global Privacy Control, so this site sends nothing')
  })

  it('offers the switch to a browser sending Do Not Track, which is not read', () => {
    setNavigator('doNotTrack', '1')
    resetTelemetryForTests({ endpoint: 'https://cloud.umami.is/api/send', website: WEBSITE })
    openAbout('https://example.org/repo')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })
})
