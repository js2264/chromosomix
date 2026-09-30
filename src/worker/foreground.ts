/**
 * Which of the reader's work somebody is waiting for, and which can wait (§12).
 *
 * One worker reads for everything: the views, and two walks nobody is looking
 * at — the census that counts a `.hic`'s contacts (§6.5) and the circularity
 * check's reads (§8.15). Their reads interleave with a view's, and over a
 * network each is a round trip that holds the thread, so a chromosome clicked
 * while they ran waited for theirs as well as its own: on a 1 GB `.hic` from
 * S3, 10 s for a picture that took 4 alone, under a veil that named the census.
 *
 * So a view's request counts itself in while it runs, and the background waits
 * until none has run for {@link SETTLE_MS} — long enough to cover the round trip
 * to the main thread between a view's `range` and its `matrix`, which would
 * otherwise be a gap for a walk to step into.
 */

import { yieldToEventLoop } from '../async'

/** Quiet a background step waits for after the last view request ends. */
export const SETTLE_MS = 250

/** How often a waiting step looks again. */
const POLL_MS = 50

export class Foreground {
  private reading = 0
  private quietSince = Number.NEGATIVE_INFINITY

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** A request somebody is waiting for has started; call what it returns when it ends. */
  begin(): () => void {
    this.reading += 1
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.reading -= 1
      this.quietSince = this.now()
    }
  }

  /**
   * Resolve once no view has been reading for {@link SETTLE_MS}, or as soon as
   * `stop` says the wait is over — a walk somebody has come to depend on, or a
   * request called off. Always a real yield first, as the walks had before.
   */
  async quiet(stop?: () => boolean): Promise<void> {
    await yieldToEventLoop()
    while (stop?.() !== true && (this.reading > 0 || this.now() - this.quietSince < SETTLE_MS)) {
      await this.sleep(POLL_MS)
    }
  }
}
