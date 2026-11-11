/**
 * What a session holds back until the reader has a picture (§8.6, §12).
 *
 * The map is the picture a reader opened, and until it is drawn nothing else a
 * file brings with it should be competing with it — for the connection, or for
 * the one reader thread every view reads through. Three things wait here: a
 * file's track downloads (a session's twelve-megabyte FASTA and ten-megabyte
 * gene model among them), the census that counts a `.hic`'s contacts (§6.5)
 * and the first-open measurement of which sequences are circles (§8.15).
 *
 * Each waits for the first block of the next view that draws a map, or for a
 * cap, whichever comes first — and **a table on the way to a map holds them for
 * that map**. A file lands on its Chromosomes table (§5.1), and the reader's
 * next move is a click on a row: started when the table showed, the census and
 * the circularity check were mid-step when the click came, and the chromosome
 * waited for the step in flight. A view whose picture has no map at all — the
 * 1D browser, whose tracks *are* its picture — lets them go at once.
 */
export class PictureGate {
  private waiters: Array<() => void> = []

  constructor(
    /** The longest anything waits, from the moment it starts waiting. */
    private readonly capMs: number,
  ) {}

  /** How many are waiting: for the tests. */
  get waiting(): number {
    return this.waiters.length
  }

  /**
   * Settles once the next view that draws a map has its first block, a view
   * with no map to wait for is shown, or after the cap — whichever comes first.
   */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(done, this.capMs)
      this.waiters.push(done)
    })
  }

  /**
   * A view went on screen.
   *
   * - `firstData`, for a view that draws a map: what waits goes when the map
   *   has its first block — or when the view goes away without one, which
   *   settles it too.
   * - `waypoint`, for a table a reader passes through on the way to a map:
   *   what waits stays held, for the map opened from it or the cap.
   * - Neither: a view whose picture is there already, and what waits goes now.
   *
   * A screen that is not a view — a loading line, the picker, an error — is
   * not reported here at all, and releases nothing: the cap does.
   */
  shown(view: { firstData?: Promise<void>; waypoint?: boolean }): void {
    if (view.waypoint === true || this.waiters.length === 0) return
    const waiting = this.waiters.splice(0)
    const release = (): void => {
      for (const done of waiting) done()
    }
    void (view.firstData ?? Promise.resolve()).then(release, release)
  }
}
