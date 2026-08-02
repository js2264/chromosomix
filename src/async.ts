/**
 * The one asynchronous primitive this codebase needs, and the reason it is not
 * a one-liner at its call site.
 */

/**
 * Hand the event loop back, so a message already queued for this thread is
 * actually delivered before the caller continues.
 *
 * **`await Promise.resolve()` does not do this.** It schedules a *microtask*,
 * and the microtask queue is drained inside the task that scheduled it —
 * including microtasks queued while draining. A loop that yielded that way runs
 * to completion inside a single task, so nothing else on the thread ever gets a
 * turn.
 *
 * That is not academic here. The full pixel scan behind the whole-metagenome
 * overview (spec §7.3) yielded with `Promise.resolve()` between chunks and was
 * therefore **uncancellable**: the `cancel` message sat in the worker's queue
 * untouched until the scan had already finished, every other request queued
 * behind it, and the completed overview was posted to a user who had asked for
 * it to stop.
 *
 * A `MessageChannel` round trip is a real task. It is preferred over
 * `setTimeout(0)` because nested timeouts are clamped to 4 ms after the fifth
 * level, which over a thousand chunks would add seconds to a scan; a channel
 * message costs microseconds. `setTimeout` remains the fallback for runtimes
 * with no `MessageChannel`.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = (): void => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}
