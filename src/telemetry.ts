/**
 * Telemetry: what the site is used for, counted, and nothing about who used it
 * or on what (§31).
 *
 * The site sends a handful of small counts to an analytics endpoint — a visit,
 * a file opened, a task run, an error met, the app installed, a remembered file
 * allowed again — so that the work spent on this viewer goes where its readers
 * are. Every one of them is a **name from a fixed list with values from fixed
 * lists**: a format (`mcool`, `bigwig`), a task id from the registry, an error
 * code, an outcome, a duration bucket. Nothing a reader typed, dropped, named or
 * pointed at can reach a payload, because no function here takes a string that
 * did not come from one of the lists below, and {@link wire} refuses any value
 * that is not in its list before anything is queued.
 *
 * ## What is never sent
 *
 * A file's name or contents, a URL — a bucket's, a store's, a signed link's —
 * a locus, a hash, a workspace, a search, a setting, the page's own address
 * (every count names the site's root, never `location`), the referring page.
 * No cookie is set and none is sent (`credentials: 'omit'`), nothing is written
 * to identify this browser, and the request carries no referrer. What tells
 * visitors apart is the analytics service's own: Umami hashes the request's
 * address and browser with a salt it rotates every month, places the visit in a
 * country, region and city from the address, and stores the address nowhere.
 *
 * ## Where it runs
 *
 * The site, as deployed, and nothing else: the web target, built with an
 * endpoint and the site's id there (`TELEMETRY_ENDPOINT` and `TELEMETRY_WEBSITE`,
 * repository variables the deploy passes, empty in every other build), at the
 * site's own address, not an archived or package
 * copy, not inside somebody else's page, and not under automation — a test, the
 * gallery, a crawler that says it is one. The desktop app and the single file
 * never send any; the single file could not if it tried (§19's policy).
 *
 * ## The reader's switch, and the browser's
 *
 * On by default, with no question asked first: there is nothing personal in a
 * count, so there is nothing to consent to (§31 says why). The About dialog
 * turns it off, for this browser, at once — the queue is dropped as well — and
 * *forget everything* keeps that answer, since forgetting a refusal would be
 * the one way the sweep could make the page send more. A browser that sends
 * Global Privacy Control is taken at its word and sends nothing, without being
 * asked either. Do Not Track is not read: the browsers that offered it have
 * retired it — Safari in 2019, Firefox in 2025, pointing its users to GPC — and
 * GPC is the signal a reader can still set and the one the law now names.
 */

import type { LayoutKind } from './types'
import type { DetectedFormat } from './annotations/worker/protocol'
import type { ErrorCode } from './errors'
import { embedded } from './embed'
import { installedApp } from './installed'
import { HOMEPAGE, TARGET, VERSION } from './version'
import { IS_PINNED, IS_PORTABLE } from './versions'

declare const __TELEMETRY_ENDPOINT__: string
declare const __TELEMETRY_WEBSITE__: string

/** The endpoint this build counts to, or `''`: the site's build alone carries one. */
let endpoint = (typeof __TELEMETRY_ENDPOINT__ === 'string' ? __TELEMETRY_ENDPOINT__ : '').trim()

/**
 * The site's id at that endpoint — Umami's *website id*, a UUID it shows in the
 * site's settings — or `''`. Not a secret: it names where counts are filed and
 * authorises nothing, which is why Umami's own snippet prints it in the page.
 */
let website = (typeof __TELEMETRY_WEBSITE__ === 'string' ? __TELEMETRY_WEBSITE__ : '').trim()

/** A website id as Umami writes one; anything else is a build that counts nothing. */
const WEBSITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The site's own address, from `package.json`'s `homepage`; replaced only by a test. */
let homepage = HOMEPAGE

/** The one key the switch is kept under, under the prefix `state/stored.ts` sweeps. */
const KEY = 'chromosomix:telemetry'

/** How many counts one page load sends at most: a loop of errors is not a usage pattern. */
const MAX_PER_PAGE = 200

// ---------------------------------------------------------------------------
// The lists. Each is checked against its type in both directions — a member
// missing or one too many fails the build — so a new format or error code is a
// decision about whether to count it, made where the type grows.
// ---------------------------------------------------------------------------

const MAP_FORMATS = {
  mmetacool: true,
  metacool: true,
  mcool: true,
  scool: true,
  cool: true,
  hic: true,
  hicpro: true,
  pairs: true,
} as const satisfies Record<LayoutKind, true>

const TRACK_FORMATS = {
  bigwig: true,
  bigbed: true,
  bedgraph: true,
  wig: true,
  gtf: true,
  bed: true,
  bedpe: true,
  vcf: true,
  barchart: true,
  interact: true,
  longrange: true,
  genepred: true,
  bedmethyl: true,
  cytoband: true,
  junctions: true,
  structure: true,
  sizes: true,
  hdf5: true,
  fasta: true,
  twobit: true,
  bam: true,
} as const satisfies Record<DetectedFormat, true>

const ERROR_CODES = {
  'not-hdf5': true,
  'not-a-table': true,
  'not-a-cooler': true,
  'mmetacool-root': true,
  'mcool-root': true,
  'pairs-binning-needed': true,
  'entry-not-found': true,
  'bad-format-version': true,
  'bad-ordering': true,
  'variable-bins': true,
  'unbinned-not-displayable': true,
  'dense-too-large': true,
  'unknown-label': true,
  'cell-not-found': true,
  'scool-listing-cost': true,
  'hicpro-load-cost': true,
  'hicpro-no-bins': true,
  'bad-range': true,
  'genome-coordinate-suffix': true,
  unsupported: true,
  'bigwig-no-overlap': true,
  'remote-no-ranges': true,
  'remote-compressed': true,
  'remote-cors': true,
  'remote-too-large': true,
  'bad-uri': true,
  format: true,
} as const satisfies Record<ErrorCode, true>

/** A task id as the registry spells them: checked by shape here, by the registry at the call. */
const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/

/** A version as `package.json` spells one. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/

/** How long a task took, in five buckets: the count, never the time. */
export type Took = 'under-1s' | '1-10s' | '10-60s' | '1-10min' | 'over-10min'

export function tookBucket(ms: number): Took {
  if (!(ms >= 1_000)) return 'under-1s'
  if (ms < 10_000) return '1-10s'
  if (ms < 60_000) return '10-60s'
  if (ms < 600_000) return '1-10min'
  return 'over-10min'
}

/** Everything the app can count, and nothing else. */
export type TelemetryEvent =
  | { name: 'open'; what: 'map'; format: LayoutKind; from: 'local' | 'remote' }
  | { name: 'open'; what: 'track'; format: DetectedFormat; from: 'local' | 'remote' }
  | { name: 'task'; task: string; outcome: 'done' | 'failed' | 'cancelled'; ms: number }
  | { name: 'error'; code: ErrorCode | 'other' }
  | { name: 'allow'; outcome: 'allowed' | 'refused' }
  | { name: 'install' }
  | { name: 'pageview' }

const has = (list: object, value: unknown): boolean =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(list, value)

const oneOf = (value: unknown, ...allowed: string[]): boolean =>
  typeof value === 'string' && allowed.includes(value)

/**
 * The properties one count is sent with, or `null` where anything in it is not
 * on its list.
 *
 * The last line of defence and the one that matters: the types above keep an
 * honest caller to the lists, and this keeps a cast, a stale build or a future
 * caller to them too. A refused count is dropped whole, never sent with the
 * offending value blanked, because a count with a hole in it is a count of
 * something else.
 */
export function wire(event: TelemetryEvent): Record<string, string> | null {
  switch (event.name) {
    case 'open': {
      const formats = event.what === 'map' ? MAP_FORMATS : event.what === 'track' ? TRACK_FORMATS : null
      if (formats === null || !has(formats, event.format) || !oneOf(event.from, 'local', 'remote')) return null
      return { what: event.what, format: event.format, from: event.from }
    }
    case 'task':
      if (typeof event.task !== 'string' || !TASK_ID.test(event.task)) return null
      if (!oneOf(event.outcome, 'done', 'failed', 'cancelled')) return null
      if (typeof event.ms !== 'number' || !Number.isFinite(event.ms)) return null
      return { task: event.task, outcome: event.outcome, took: tookBucket(event.ms) }
    case 'error':
      return event.code === 'other' || has(ERROR_CODES, event.code) ? { code: event.code } : null
    case 'allow':
      return oneOf(event.outcome, 'allowed', 'refused') ? { outcome: event.outcome } : null
    case 'install':
      return {}
    case 'pageview':
      return {
        version: VERSION_SHAPE.test(VERSION) ? VERSION : 'other',
        installed: installedApp() ? 'yes' : 'no',
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Where it runs
// ---------------------------------------------------------------------------

/** The site's own address, from `package.json`'s `homepage`, or `null`. */
function siteUrl(): URL | null {
  try {
    return homepage === '' ? null : new URL(homepage)
  } catch {
    return null
  }
}

/**
 * Whether this build counts at all: the site's build, with an endpoint and a
 * website id, not an archived or package copy, not inside somebody else's page. The About dialog
 * offers the switch where this is true and says nothing where it is not — a
 * build that never counts has nothing to turn off (§8.5).
 */
export function telemetryOffered(): boolean {
  return (
    endpoint !== '' &&
    WEBSITE_ID.test(website) &&
    TARGET === 'web' &&
    !IS_PINNED &&
    !IS_PORTABLE &&
    !embedded()
  )
}

/** The endpoint's host, for the sentence that says where the counts go. */
export function telemetryHost(): string {
  try {
    return new URL(endpoint).hostname
  } catch {
    return ''
  }
}

/**
 * `true` when the browser sends Global Privacy Control — Brave and DuckDuckGo
 * by default, Firefox in its private windows, any browser where the reader
 * turned it on. Do Not Track is not read; the module's header says why.
 */
export function browserDeclines(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
  return nav.globalPrivacyControl === true
}

/** The reader's switch: on unless turned off in this browser. */
export function telemetryWanted(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

/** Turn the counts on or off for this browser, at once. */
export function setTelemetry(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, 'off')
  } catch {
    // A storage that refuses keeps nothing; the switch then lasts the page.
    refusedForPage = !on
  }
  if (!on) queue.length = 0
}

/** The switch, where storage would not keep it. */
let refusedForPage = false

/**
 * Every condition at once: offered, wanted, not declined by the browser, at
 * the site's own address, and not under automation.
 *
 * The address is checked as well as the build because a copy of the site's
 * build can be served from anywhere — a fork, a lab's mirror, `vite preview`
 * on a laptop — and none of those is the site whose counts these are.
 */
export function telemetrySending(): boolean {
  if (!telemetryOffered() || refusedForPage || !telemetryWanted() || browserDeclines()) return false
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (navigator.webdriver === true) return false
  const site = siteUrl()
  return site !== null && window.location.origin === site.origin
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * One count, in the shape Umami's `/api/send` takes. A payload with no `name`
 * is a pageview there, so the visit is sent nameless and every other count
 * under its own name, with its values as `data` — each of which Umami counts
 * against the plan as an event of its own, so a count carries no value it
 * does not need.
 */
interface Body {
  type: 'event'
  payload: {
    website: string
    hostname: string
    url: '/'
    name?: string
    data?: Record<string, string>
  }
}

const queue: Body[] = []
let sent = 0
let scheduled = false
let started = false

/**
 * Count one thing.
 *
 * Synchronous and silent for the caller: nothing is awaited and nothing can
 * fail where it is called. The count is queued and sent when the page is idle,
 * behind whatever the reader is waiting on, so it never shares a connection
 * with a map's first read.
 */
export function recordTelemetry(event: TelemetryEvent): void {
  if (!telemetrySending()) return
  const props = wire(event)
  const site = siteUrl()
  if (props === null || site === null || sent >= MAX_PER_PAGE) return
  sent += 1
  queue.push({
    type: 'event',
    payload: {
      website,
      hostname: site.hostname,
      url: '/',
      ...(event.name === 'pageview' ? {} : { name: event.name }),
      ...(Object.keys(props).length === 0 ? {} : { data: props }),
    },
  })
  schedule()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  const idle = (window as Window & { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof idle === 'function') idle.call(window, flush, { timeout: 10_000 })
  else window.setTimeout(flush, 2_000)
}

function flush(): void {
  scheduled = false
  // Asked again: the switch may have been turned off while the count waited.
  if (!telemetrySending()) {
    queue.length = 0
    return
  }
  for (const body of queue.splice(0)) post(body)
}

/**
 * One count, out.
 *
 * `fetch` rather than `sendBeacon`, because a beacon always carries the
 * endpoint's cookies and this must carry none: `credentials: 'omit'`, no
 * referrer, `no-cors` so nothing is preflighted and nothing is read back, and
 * `keepalive` so a count queued as the page closes still leaves. The body is
 * JSON sent as plain text, which keeps the request simple enough to need no
 * preflight; Umami reads the body as JSON whatever its type.
 */
function post(body: Body): void {
  try {
    void fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    /* a count that could not be sent is a count not made, and nothing else */
  }
}

/**
 * Start counting, once, at boot: the visit itself, an install when the
 * browser reports one, and whatever is still queued when the page goes.
 */
export function startTelemetry(): void {
  if (started || !telemetrySending()) return
  started = true
  recordTelemetry({ name: 'pageview' })
  window.addEventListener('appinstalled', () => recordTelemetry({ name: 'install' }))
  window.addEventListener('pagehide', flush)
}

/** Back to a fresh page, counting to `endpoint` as `website` for a site at `site`. **Tests only.** */
export function resetTelemetryForTests(
  options: { endpoint?: string; website?: string; site?: string } = {},
): void {
  endpoint = options.endpoint ?? ''
  website = options.website ?? ''
  homepage = options.site ?? ''
  queue.length = 0
  sent = 0
  scheduled = false
  started = false
  refusedForPage = false
}

/** What is queued and not yet sent. **Tests only.** */
export function queuedForTests(): readonly Body[] {
  return queue
}

/** Send what is queued now rather than when the page is idle. **Tests only.** */
export function flushForTests(): void {
  flush()
}
