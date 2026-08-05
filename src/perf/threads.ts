/**
 * Every thread this tab is running, and how busy each one said it was.
 *
 * A module-level registry rather than a list threaded down from `App`, and the
 * scope is the argument: the status bar reports the *tab*, and a tab holds one
 * main thread plus one reader worker and one annotations worker per open
 * session. Passing that up would mean `App` asking each `Session` for its
 * clients on every tick, for a number neither of them has any other use for —
 * and would still miss a worker belonging to a session being torn down, which is
 * exactly a moment when the CPU figure is interesting.
 *
 * So a worker's client registers it when the worker is created and releases it
 * when it is terminated, and the meter reads whatever is registered. Nothing
 * here holds a reference to a worker, only to the last number it sent.
 */

/** What one thread last reported. */
export interface ThreadReport {
  /** For the tooltip: "reader", "annotations", "main thread". */
  label: string
  /** Its busy fraction at `at`, or `null` if it has not reported yet. */
  busy: number | null
  /** `performance.now()` when it last did, or `null` for never. */
  at: number | null
}

/** A registration, held by whoever owns the thread. */
export interface ThreadHandle {
  /** The thread reported a busy fraction. */
  report(busy: number): void
  /** The thread is gone. */
  release(): void
}

interface Entry {
  label: string
  busy: number | null
  at: number | null
}

const live = new Set<Entry>()

/**
 * Add a thread to the registry.
 *
 * The handle is the only way back to the entry, so releasing it is the only way
 * to leak one — and a client that forgets to release leaves a dead worker in
 * the CPU tooltip, which is a visible bug rather than a silent one.
 */
export function registerThread(label: string): ThreadHandle {
  const entry: Entry = { label, busy: null, at: null }
  live.add(entry)
  return {
    report(busy: number): void {
      entry.busy = busy
      entry.at = performance.now()
    },
    release(): void {
      live.delete(entry)
    },
  }
}

/** Everything registered, in registration order. */
export function threadReports(): ThreadReport[] {
  return [...live].map((entry) => ({ label: entry.label, busy: entry.busy, at: entry.at }))
}

/** Drop every registration. Tests only; the application never has a reason. */
export function clearThreads(): void {
  live.clear()
}
