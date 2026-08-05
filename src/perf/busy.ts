/**
 * How busy a thread is, measured from inside it.
 *
 * There is no browser API for the CPU a tab is using. `performance` reports
 * timings, `navigator.hardwareConcurrency` reports how many cores exist, and
 * nothing at all reports how much of them this page is burning — deliberately,
 * because a per-process CPU figure is a cross-origin side channel. So the number
 * has to be inferred, and the only honest way to infer it from inside a thread
 * is to ask that thread to do something trivial on a schedule and see how late
 * it is.
 *
 * A timer set for every `period` ms that fires 40 ms late spent those 40 ms
 * waiting behind something else on the same thread — one task, or several. Over
 * a window, the lateness sums to the time the thread was not available, and the
 * ratio of that to the window is the fraction of wall-clock the thread spent
 * working. That is what a task manager calls CPU for a single-threaded process,
 * and it is what this returns.
 *
 * What it is not: it cannot see work that finishes inside one period without
 * ever delaying the probe (a 2 ms task every 100 ms is invisible, and rightly —
 * it is 2% of nothing), and it cannot tell a thread that is *computing* from one
 * that is blocked on a synchronous read. For a viewer whose expensive moments
 * are all long ones — a whole-genome scan, a matrix decode, a full repaint —
 * both of those are the right trade.
 *
 * Runs unchanged on the main thread and in a worker: `setInterval` and
 * `performance.now` are the whole of its dependency list, and both exist in
 * every global this application has.
 */

/**
 * How often the probe asks to run.
 *
 * Short enough that a repaint of a few tens of milliseconds registers, long
 * enough that the probe is not itself the load: five wake-ups a second, each
 * doing an arithmetic mean over a bounded array, is beneath measurement. A 16 ms
 * period would resolve single frames and would also mean sixty wake-ups a second
 * in every thread, forever, on a laptop nobody is looking at.
 */
export const PROBE_PERIOD_MS = 200

/**
 * How much history one reading covers.
 *
 * Long enough to survive a single slow frame without the number jumping to 100%,
 * short enough that letting go of a pan is visibly the end of the load. Three
 * seconds is about fifteen samples.
 */
export const BUSY_WINDOW_MS = 3000

/**
 * A sample that is longer than this did not measure a busy thread.
 *
 * It measured a *suspended* one: a background tab has its timers clamped to once
 * a minute, and a machine coming back from sleep produces one gap of arbitrary
 * size. Both would otherwise read as a thread pinned for the whole interval,
 * which is the opposite of what happened.
 *
 * Thirty seconds, and the number matters. The obvious threshold — a second or
 * two, "longer than any task this application runs" — is wrong in the direction
 * that hurts: a whole-genome scan really does hold a worker for several seconds
 * at a stretch, and discarding those samples reported 0% during precisely the
 * operation the reader is watching. A throttled tab's gap is a minute by
 * construction and a sleep is longer again, so the two populations are an order
 * of magnitude apart and the line goes between them rather than under both.
 */
const SUSPENSION_MS = 30_000

/**
 * How often a worker tells the main thread what its probe says.
 *
 * A second, because that is the rate the status bar repaints at and a faster
 * report would be a message nobody reads. The reading itself is a three-second
 * average, so nothing is lost between reports.
 */
export const LOAD_REPORT_MS = 1000

export interface BusyProbe {
  /** The fraction of the last window this thread spent working, 0 to 1. */
  busy(): number
  /** Throw the history away — after a suspension the old samples describe nothing. */
  reset(): void
  /** Stop probing. */
  stop(): void
}

interface Sample {
  at: number
  span: number
  late: number
}

/** Start measuring the current thread. */
export function startBusyProbe(
  period: number = PROBE_PERIOD_MS,
  window: number = BUSY_WINDOW_MS,
): BusyProbe {
  const samples: Sample[] = []
  let last = performance.now()

  const timer = setInterval(() => {
    const at = performance.now()
    const span = at - last
    last = at
    // A timer implementation that catches up after a delay produces a *short*
    // span next, not a negative one; `Math.max` is against clock adjustments
    // rather than against that.
    if (span < SUSPENSION_MS) samples.push({ at, span, late: Math.max(0, span - period) })
    else samples.length = 0
    while (samples.length > 0 && at - samples[0].at > window) samples.shift()
  }, period)

  return {
    busy(): number {
      // One sample is a coin toss — a single 40 ms task lands as 20% or as 0%
      // depending on where the window fell. Below three, say zero rather than
      // publish the toss.
      if (samples.length < 3) return 0
      let span = 0
      let late = 0
      for (const sample of samples) {
        span += sample.span
        late += sample.late
      }
      if (span <= 0) return 0
      return Math.min(1, late / span)
    },
    reset(): void {
      samples.length = 0
      last = performance.now()
    },
    stop(): void {
      clearInterval(timer)
    },
  }
}
