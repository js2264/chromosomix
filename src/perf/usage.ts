/**
 * What this tab is costing the machine: memory, and an estimate of CPU.
 *
 * The honest framing first, because both numbers are weaker than the ones a task
 * manager shows and a status bar that implied otherwise would be worse than no
 * status bar. A page cannot see its own process. It is not allowed to: a precise
 * per-process memory or CPU figure is a side channel that reads across origins,
 * so the platform gives a page a coarse view of itself and nothing at all of its
 * neighbours. What is available is
 *
 * - `performance.measureUserAgentSpecificMemory()` — the real answer, covering
 *   the whole JavaScript agent: this document, its workers, its typed arrays and
 *   its DOM. It requires cross-origin isolation, which this application does not
 *   ask for (§11: it opens files from wherever the reader points it, and COEP
 *   would refuse every server that does not send CORP). Used when a build *does*
 *   have it, which costs twenty lines and means the good number appears by
 *   itself the day the headers change.
 * - `performance.memory` — Chromium's older, non-standard property: the main
 *   thread's JavaScript heap and the limit it will be killed at. Not the tab's
 *   memory — a worker's heap and a canvas's backing store are outside it — but
 *   it is the number that moves when this application loads a gene model, and it
 *   is the only one Chromium offers without isolation.
 * - nothing, in Firefox and Safari, where the item is not drawn at all rather
 *   than drawn as an em dash that never fills in.
 *
 * CPU has no API whatsoever, so it is measured rather than read: every thread in
 * the tab times its own event loop (`busy.ts`) and the sum of those fractions is
 * how many cores' worth of work this tab is doing. That is the number a task
 * manager would show, arrived at from the inside, and it is an underestimate by
 * construction — work that never delays a timer never appears.
 */

import { BUSY_WINDOW_MS, LOAD_REPORT_MS, startBusyProbe, type BusyProbe } from './busy'
import { registerThread, threadReports, type ThreadHandle } from './threads'

/** How much memory, and what that is a share of. */
export interface MemoryReading {
  /** Bytes in use. */
  used: number
  /** What `used` is a fraction of, or `null` when nothing sensible bounds it. */
  ceiling: number | null
  /** What the ceiling *is*, for the tooltip. */
  ceilingLabel: string
  /** `tab` covers workers and the DOM; `heap` is the main thread's JS only. */
  scope: 'tab' | 'heap'
}

/** One thread's contribution. */
export interface ThreadBusy {
  label: string
  /** 0 to 1, or `null` while the thread has not said yet. */
  busy: number | null
}

export interface CpuReading {
  /** Cores' worth of work: the sum over every thread. */
  cores: number
  /** Of the whole machine, 0 to 1. */
  fraction: number
  /** How many cores there are to be a fraction of. */
  hardware: number
  threads: ThreadBusy[]
}

/**
 * A worker silent for this long is not idle — it is blocked.
 *
 * An idle worker still reports every {@link LOAD_REPORT_MS}, because reporting is
 * a timer and an idle thread runs its timers. One that has stopped reporting is
 * one whose event loop is not turning, which is the definition of busy, so the
 * absence is read as 100% rather than as 0%. Four report intervals, so an
 * ordinary scheduling hiccup does not trip it.
 */
const STALE_MS = LOAD_REPORT_MS * 4

/** How often to re-measure the tab, where measuring is expensive and async. */
const MEASURE_EVERY_MS = 10_000

interface HeapMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

interface MemorySample {
  bytes: number
  breakdown?: Array<{ bytes: number; types?: string[] }>
}

/** Chromium's non-standard heap numbers, if this engine has them. */
function heapMemory(): HeapMemory | null {
  const memory = (performance as Performance & { memory?: HeapMemory }).memory
  if (memory === undefined || typeof memory.usedJSHeapSize !== 'number') return null
  return memory
}

/** The standard whole-agent measurement, if this page is allowed to make one. */
function agentMemory(): (() => Promise<MemorySample>) | null {
  const measure = (
    performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<MemorySample>
    }
  ).measureUserAgentSpecificMemory
  if (typeof measure !== 'function') return null
  if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) return null
  return () => measure.call(performance)
}

export class UsageMeter {
  private readonly probe: BusyProbe
  private readonly thread: ThreadHandle
  private readonly measure = agentMemory()
  /** The last whole-agent measurement, and when it was taken. */
  private agent: { bytes: number; at: number } | null = null
  private measuring = false
  /**
   * When the page last became visible.
   *
   * Everything here is a rate over a window, and a hidden tab has its timers
   * clamped to once a minute — so the first readings after a tab comes back
   * describe the throttling rather than the work. Both the probe's history and
   * the staleness rule are held off until a window has passed.
   */
  private resumedAt = performance.now()
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return
    this.resumedAt = performance.now()
    this.probe.reset()
  }

  constructor() {
    this.probe = startBusyProbe()
    this.thread = registerThread('main thread')
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  /** Stop measuring. */
  destroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.probe.stop()
    this.thread.release()
  }

  /**
   * Memory, or `null` on an engine that reports none.
   *
   * Never awaits: the whole-agent measurement is asked for in the background and
   * read from the last answer, because it is allowed to take its time — the
   * specification lets an implementation defer it to the next garbage collection
   * — and a status bar that blocked on it would stutter once every ten seconds.
   */
  memory(): MemoryReading | null {
    if (this.measure !== null) {
      this.refreshAgentMemory()
      if (this.agent !== null) {
        const device = deviceBytes()
        return {
          used: this.agent.bytes,
          ceiling: device,
          ceilingLabel: device === null ? '' : 'of the memory this device reports',
          scope: 'tab',
        }
      }
    }
    const heap = heapMemory()
    if (heap === null) return null
    return {
      used: heap.usedJSHeapSize,
      ceiling: heap.jsHeapSizeLimit,
      ceilingLabel: 'of the heap this tab may grow to',
      scope: 'heap',
    }
  }

  /** CPU, summed over the main thread and every worker in the tab. */
  cpu(): CpuReading {
    const settled = performance.now() - this.resumedAt > BUSY_WINDOW_MS
    const mine = this.probe.busy()
    this.thread.report(mine)

    const threads: ThreadBusy[] = []
    let cores = 0
    for (const report of threadReports()) {
      const busy = this.readThread(report.busy, report.at, settled)
      threads.push({ label: report.label, busy })
      cores += busy ?? 0
    }

    const hardware = Math.max(1, navigator.hardwareConcurrency || 1)
    return { cores, fraction: Math.min(1, cores / hardware), hardware, threads }
  }

  /**
   * One thread's number, allowing for the two ways it can be missing.
   *
   * Never reported is `null` — a worker created half a second ago has nothing to
   * say yet, and calling that 0% would put a made-up number in a sum. Reported
   * and gone quiet is 100%, per {@link STALE_MS} — unless the tab has only just
   * come back, when quiet means it was throttled rather than blocked.
   */
  private readThread(busy: number | null, at: number | null, settled: boolean): number | null {
    if (busy === null || at === null) return null
    if (!settled) return busy
    return performance.now() - at > STALE_MS ? 1 : busy
  }

  private refreshAgentMemory(): void {
    if (this.measure === null || this.measuring) return
    if (this.agent !== null && performance.now() - this.agent.at < MEASURE_EVERY_MS) return
    this.measuring = true
    void this.measure()
      .then((sample) => {
        this.agent = { bytes: sample.bytes, at: performance.now() }
      })
      .catch(() => {
        /* a measurement that refuses is a number we do without */
      })
      .finally(() => {
        this.measuring = false
      })
  }
}

/**
 * How much memory this device says it has, in bytes, or `null`.
 *
 * `navigator.deviceMemory` is deliberately coarse — 0.25, 0.5, 1, 2, 4 or 8 —
 * and capped at 8 so that a 64 GB workstation and a 16 GB laptop are
 * indistinguishable, because the precise figure fingerprints the machine. It is
 * therefore a floor on real memory rather than the amount, which is why the
 * percentage it feeds is described as "of what this device reports" rather than
 * as a share of RAM.
 */
export function deviceBytes(): number | null {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (typeof gb !== 'number' || !Number.isFinite(gb) || gb <= 0) return null
  return gb * 1024 * 1024 * 1024
}
