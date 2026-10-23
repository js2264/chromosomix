/**
 * Telemetry (§31): what may be sent, where, and the switches that stop it.
 *
 * The refusals are the subject, as in `handles.test.ts`. A count that goes
 * out is one line of `fetch`; what is worth pinning is everything that must
 * never reach a payload — a file name, an address, the page's own URL — and
 * every place the counting must be silent: another build, another address, an
 * embed, a browser that says not to, a reader who turned it off.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  browserDeclines,
  recordTelemetry,
  flushForTests,
  queuedForTests,
  resetTelemetryForTests,
  setTelemetry,
  startTelemetry,
  tookBucket,
  telemetryHost,
  telemetryOffered,
  telemetrySending,
  telemetryWanted,
  wire,
  type TelemetryEvent,
} from '@/telemetry'
import { TASKS } from '@/analysis/registry'
import { resetMounting } from '@/embed'

const ENDPOINT = 'https://plausible.io/api/event'

/** The site is wherever jsdom says this page is, so the address check passes. */
function asTheSite(): void {
  resetTelemetryForTests({ endpoint: ENDPOINT, site: `${window.location.origin}/` })
}

function setNavigator(field: string, value: unknown): void {
  Object.defineProperty(window.navigator, field, { value, configurable: true })
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
  setNavigator('webdriver', false)
  setNavigator('globalPrivacyControl', undefined)
  setNavigator('doNotTrack', null)
  asTheSite()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetTelemetryForTests()
})

describe('wire — the last line of defence', () => {
  it('sends a word from each list and nothing beside it', () => {
    expect(wire({ name: 'open', what: 'map', format: 'mcool', from: 'local' })).toEqual({
      what: 'map',
      format: 'mcool',
      from: 'local',
    })
    expect(wire({ name: 'open', what: 'track', format: 'bigwig', from: 'remote' })).toEqual({
      what: 'track',
      format: 'bigwig',
      from: 'remote',
    })
    expect(wire({ name: 'error', code: 'remote-cors' })).toEqual({ code: 'remote-cors' })
    expect(wire({ name: 'error', code: 'other' })).toEqual({ code: 'other' })
    expect(wire({ name: 'allow', outcome: 'allowed' })).toEqual({ outcome: 'allowed' })
    expect(wire({ name: 'install' })).toEqual({})
  })

  it('sends a task as its id, how it ended and a bucket — never the time itself', () => {
    expect(wire({ name: 'task', task: 'insulation', outcome: 'done', ms: 12_345.6 })).toEqual({
      task: 'insulation',
      outcome: 'done',
      took: '10-60s',
    })
  })

  it('refuses a whole count when one value is off its list', () => {
    // Each of these is what a cast, a stale caller or a mistake would hand it:
    // a file's name where a format goes, a sentence where a task id goes, a
    // message where a code goes. None is sent with the value blanked — the count
    // is dropped.
    const bad = [
      { name: 'open', what: 'map', format: 'patient_04.mcool', from: 'local' },
      { name: 'open', what: 'map', format: 'bigwig', from: 'local' },
      { name: 'open', what: 'track', format: 'mcool', from: 'local' },
      { name: 'open', what: 'track', format: 'bigwig', from: 'https://bucket.example/x.bw' },
      { name: 'open', what: 'genome', format: 'fasta', from: 'local' },
      { name: 'task', task: 'Insulation on rep1.cool', outcome: 'done', ms: 1 },
      { name: 'task', task: 'insulation', outcome: 'ok', ms: 1 },
      { name: 'task', task: 'insulation', outcome: 'done', ms: Number.NaN },
      { name: 'error', code: 'rep1.cool is not an HDF5 file' },
      { name: 'allow', outcome: 'rep1.cool' },
      { name: 'open-file', file: 'rep1.cool' },
    ] as unknown as TelemetryEvent[]
    for (const event of bad) expect(wire(event), JSON.stringify(event)).toBeNull()
  })

  it('takes every registered task id, so no task is silently uncounted', () => {
    for (const task of TASKS) {
      expect(wire({ name: 'task', task: task.id, outcome: 'done', ms: 0 }), task.id).not.toBeNull()
    }
  })

  it('says only the version and whether this is the installed app on a visit', () => {
    const props = wire({ name: 'pageview' })
    expect(Object.keys(props ?? {}).sort()).toEqual(['installed', 'version'])
    expect(props?.installed).toBe('no')
  })
})

describe('tookBucket', () => {
  it('puts each duration in one of five buckets', () => {
    expect(tookBucket(0)).toBe('under-1s')
    expect(tookBucket(999)).toBe('under-1s')
    expect(tookBucket(1_000)).toBe('1-10s')
    expect(tookBucket(59_999)).toBe('10-60s')
    expect(tookBucket(60_000)).toBe('1-10min')
    expect(tookBucket(600_000)).toBe('over-10min')
    expect(tookBucket(Number.NaN)).toBe('under-1s')
  })
})

describe('where it counts', () => {
  it('counts nothing in a build with no endpoint, which is every build but the site', () => {
    resetTelemetryForTests({ endpoint: '', site: `${window.location.origin}/` })
    expect(telemetryOffered()).toBe(false)
    recordTelemetry({ name: 'install' })
    expect(queuedForTests()).toHaveLength(0)
  })

  it('counts nothing away from the site’s own address — a fork, a mirror, a preview', () => {
    resetTelemetryForTests({ endpoint: ENDPOINT, site: 'https://chromosomix.app/' })
    expect(telemetryOffered()).toBe(true)
    expect(telemetrySending()).toBe(false)
    recordTelemetry({ name: 'install' })
    expect(queuedForTests()).toHaveLength(0)
  })

  it('counts nothing inside somebody else’s page', () => {
    window.history.replaceState(null, '', '/?embed=1')
    resetMounting()
    expect(telemetryOffered()).toBe(false)
    expect(telemetrySending()).toBe(false)
  })

  it('counts nothing under automation', () => {
    setNavigator('webdriver', true)
    expect(telemetrySending()).toBe(false)
  })

  it('takes Global Privacy Control and Do Not Track at their word, without asking', () => {
    setNavigator('globalPrivacyControl', true)
    expect(browserDeclines()).toBe(true)
    expect(telemetrySending()).toBe(false)
    setNavigator('globalPrivacyControl', undefined)
    setNavigator('doNotTrack', '1')
    expect(telemetrySending()).toBe(false)
    setNavigator('doNotTrack', null)
    expect(telemetrySending()).toBe(true)
  })

  it('names the endpoint’s host for the sentence in About', () => {
    expect(telemetryHost()).toBe('plausible.io')
  })
})

describe('the switch', () => {
  it('is on by default, with nothing asked and nothing stored', () => {
    expect(telemetryWanted()).toBe(true)
    expect(window.localStorage.length).toBe(0)
  })

  it('stops counting at once, and drops what was waiting', () => {
    recordTelemetry({ name: 'install' })
    expect(queuedForTests()).toHaveLength(1)
    setTelemetry(false)
    expect(queuedForTests()).toHaveLength(0)
    expect(window.localStorage.getItem('chromosomix:telemetry')).toBe('off')
    recordTelemetry({ name: 'install' })
    expect(queuedForTests()).toHaveLength(0)
    setTelemetry(true)
    expect(window.localStorage.getItem('chromosomix:telemetry')).toBeNull()
    recordTelemetry({ name: 'install' })
    expect(queuedForTests()).toHaveLength(1)
  })
})

describe('what goes out', () => {
  it('names the site’s root and never the page’s own address', () => {
    // A hash naming a local file, and a query naming a private workspace: both
    // are on the page's URL, and neither may reach a count.
    window.history.replaceState(null, '', '/?config=https://private.example/ws.json#uri=patient_04.mcool')
    resetMounting()
    recordTelemetry({ name: 'open', what: 'map', format: 'mcool', from: 'local' })
    const [body] = queuedForTests()
    expect(body.url).toBe(`${window.location.origin}/`)
    expect(body.domain).toBe(window.location.hostname)
    const text = JSON.stringify(queuedForTests())
    expect(text).not.toContain('patient_04')
    expect(text).not.toContain('private.example')
  })

  it('posts with no cookie, no referrer and nothing read back', () => {
    const fetched = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetched)
    recordTelemetry({ name: 'error', code: 'remote-cors' })
    flushForTests()
    expect(fetched).toHaveBeenCalledTimes(1)
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ENDPOINT)
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    })
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'error',
      url: `${window.location.origin}/`,
      domain: window.location.hostname,
      props: { code: 'remote-cors' },
    })
  })

  it('sends nothing that waited while the switch was turned off', () => {
    const fetched = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetched)
    recordTelemetry({ name: 'install' })
    window.localStorage.setItem('chromosomix:telemetry', 'off')
    flushForTests()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('stops at two hundred counts a page', () => {
    for (let n = 0; n < 250; n++) recordTelemetry({ name: 'error', code: 'other' })
    expect(queuedForTests()).toHaveLength(200)
  })

  it('counts the visit once, however often it is started', () => {
    startTelemetry()
    startTelemetry()
    expect(queuedForTests().filter((body) => body.name === 'pageview')).toHaveLength(1)
  })
})
