/**
 * When the picture on screen is finished, and what it is a picture of (§12).
 *
 * A view mounts, reads and draws, and is still not finished. The map's block
 * lands and is painted; the lanes beside it then ask for their own windows,
 * which land later; a track still opening lands later still and asks for its
 * own; a smoothing comes back after the unsmoothed map it replaces. "The view
 * mounted", "the map drew" and "the picture is finished" are three moments, and
 * nothing outside the page could tell them apart. A script timing the app
 * watched the network go quiet, which it never does here for the twenty seconds
 * the census and the circularity check read behind a view (§6.5, §8.15), and a
 * screenshot taken on the map's first paint caught its lanes reading
 * "fetching…".
 *
 * So everything that can still change the picture says so while it can: a
 * navigation being routed, a file opening, a map's veil, a paint asked for and
 * not yet made, a lane's read in flight, a track still opening, a finer block
 * being read for a frozen map. Once the last of it has ended, and a frame has
 * passed with nothing new started, the window says so once, three ways:
 *
 * - a `performance` mark named {@link RENDERED}, whose `startTime` is the moment
 *   the last of it ended — the end of the frame the picture was finished in —
 *   on the same clock as the page's own navigation timing, and whose `detail` is
 *   the {@link RenderedReport};
 * - an event of the same name on `window`, carrying the same report;
 * - and, in an embed, a message of the same name to the host (§21.4).
 *
 * **The report says what was drawn, not what was asked for.** Each map gives
 * the resolution it is on screen at — the rung it was read from times the bins
 * pooled into one cell — because a whole-genome view may read a coarser rung
 * than the open one and a wide window may pool its cells (§7.2), and a script
 * that asked for 5 kb and was shown 25 kb has to be told so rather than time a
 * picture it did not ask for.
 *
 * **What counts, and what does not.** The maps, in every cell of a deck, and
 * the lanes drawn beside them and in the 1D browser. Not the side columns, the
 * status bar or the console, which describe the picture rather than being it;
 * not an analysis task, whose result arrives as a new track and is counted then;
 * not the census or the circularity check, which read behind a view and change
 * nothing on it. A surface that has left the document is not waited for, so a
 * tab in the background holds nothing back.
 *
 * **A repaint alone is not a new picture.** Pointing at the map repaints it once
 * a frame, and a report per frame of hovering would bury the one a script is
 * waiting for. A paint keeps a picture unfinished but never starts one: a report
 * follows a navigation, a read, or a track arriving, and comes once the paints
 * they asked for have been made.
 */

/** The name of the mark, the event and the embed message. */
export const RENDERED = 'chromosomix:rendered'

/**
 * `drawn`, or why not: a whole-genome read waiting for the reader to agree to
 * it, or a refusal on screen in place of the picture.
 */
export type RenderedStatus = 'drawn' | 'gated' | 'error'

/** One map as it is on screen. */
export interface RenderedMap {
  /** Its heading — the region, as the title above it says it. */
  title: string
  /** The bin size of the rung the block was read from. */
  binsize: number
  /** Bins summed into one drawn cell: 1 for a block drawn at its own bins. */
  binsPerCell: number
  /** What is on screen: `binsize × binsPerCell`, in base pairs. */
  resolution: number
  rows: number
  cols: number
  level: 'bin' | 'contig' | 'genome'
}

/** What a report says, in all three of its forms. */
export interface RenderedReport {
  /** Counts the reports this page has made, from 1. */
  seq: number
  /**
   * `performance.now()` when the last thing the picture waited on ended — the
   * end of the frame it was finished in. The mark's `startTime`.
   */
  at: number
  status: RenderedStatus
  /** The view state on screen, as the address bar carries it (§5.5). */
  state: string
  maps: RenderedMap[]
  /** Track lanes on screen, beside the maps and in the 1D browser. */
  lanes: number
  /** Why a picture is not drawn, where it is not. */
  note?: string
}

/** What one surface has on screen, asked for when a report is made. */
export interface SurfaceAccount {
  maps?: readonly RenderedMap[]
  lanes?: number
}

/**
 * Waits that keep a picture unfinished but cannot, alone, make a new one: a
 * repaint asked for and not yet made. See the header.
 */
const QUIET_WAITS: ReadonlySet<string> = new Set(['paint'])

/**
 * How often a picture still waiting is looked at again, for a surface that left
 * the document without saying so — a view torn down by a path that never called
 * {@link Surface.forget}. A lookup over a handful of surfaces, four times a
 * second, and only while something is waiting.
 */
const RECHECK_MS = 250

/** Routing, opening and other waits with no element of their own. */
let tasks = 0
/** Reports made so far. */
let seq = 0
/** Something that makes a new picture has happened since the last report. */
let changed = false
/** When the last wait ended, while nothing has started since. */
let quietSince: number | null = null
/** The frame a report is confirmed in, once the last wait has ended. */
let frame = 0
let recheck: ReturnType<typeof setTimeout> | null = null
const surfaces = new Set<Surface>()

/**
 * Something on screen that draws a picture, and what it is waiting for.
 *
 * Built by the map panel and by the 1D browser. Its element is what says it is
 * still on screen: one that has been in the document and has left it is
 * dropped, so a surface its owner never {@link forget}s does not hold every
 * later picture back.
 */
export class Surface {
  private readonly waits = new Set<string>()
  private noted: { status: 'gated' | 'error'; note: string } | null = null
  /** Whether {@link el} has been in the document, so its leaving can be told from its not having arrived yet. */
  private attached = false

  constructor(
    readonly el: HTMLElement,
    private readonly accountOf: () => SurfaceAccount,
  ) {
    surfaces.add(this)
  }

  /** Start or stop waiting for one thing. Saying the same thing twice is saying it once. */
  wait(reason: string, on: boolean): void {
    if (on === this.waits.has(reason)) return
    if (on) {
      this.waits.add(reason)
      if (!QUIET_WAITS.has(reason)) changed = true
    } else {
      this.waits.delete(reason)
    }
    settle()
  }

  /**
   * Say that this surface shows something other than its picture, and why —
   * the whole-genome gate, a refusal in place of a block. `null` takes it back.
   * A change either way is a new picture.
   */
  note(status: 'gated' | 'error' | null, why = ''): void {
    const same =
      status === null ? this.noted === null : this.noted?.status === status && this.noted.note === why
    if (same) return
    this.noted = status === null ? null : { status, note: why }
    changed = true
    settle()
  }

  /** The surface is going: nothing of it is waited for or reported any more. */
  forget(): void {
    if (!surfaces.delete(this)) return
    settle()
  }

  /** @internal Whether this surface still counts, and drops it if it has left. */
  live(): boolean {
    if (this.el.isConnected) {
      this.attached = true
      return true
    }
    if (this.attached) surfaces.delete(this)
    return false
  }

  /** @internal Whether anything here holds the picture back. */
  get waiting(): boolean {
    return this.waits.size > 0
  }

  /** @internal What is on screen, for a report. */
  account(): SurfaceAccount & { noted: { status: 'gated' | 'error'; note: string } | null } {
    return { ...this.accountOf(), noted: this.noted }
  }
}

/**
 * Wait for something with no element of its own — a navigation being routed, a
 * file opening, a workspace being read. Returns the call that ends the wait,
 * which may be made more than once and counts once.
 */
export function begin(): () => void {
  tasks += 1
  changed = true
  quietSince = null
  let ended = false
  return () => {
    if (ended) return
    ended = true
    tasks -= 1
    settle()
  }
}

/** Whether anything on screen, or on its way to it, holds the picture back. */
function pending(): boolean {
  if (tasks > 0) return true
  for (const surface of surfaces) {
    if (surface.live() && surface.waiting) return true
  }
  return false
}

/** Look again after anything changed: report, or wait to. */
function settle(): void {
  if (pending()) {
    quietSince = null
    if (recheck === null) {
      recheck = setTimeout(() => {
        recheck = null
        settle()
      }, RECHECK_MS)
    }
    return
  }
  if (!changed) return
  quietSince ??= performance.now()
  // A frame later rather than now: the last wait to end is often a paint, and
  // what the paint asked for — a lane's first read, a frame of its own — is
  // asked for inside it, so "nothing waiting" can be true for the length of a
  // task and false again before the next frame.
  if (frame === 0) frame = requestAnimationFrame(confirm)
}

function confirm(): void {
  frame = 0
  if (pending()) {
    settle()
    return
  }
  if (!changed || quietSince === null) return
  report(quietSince)
}

function report(at: number): void {
  changed = false
  quietSince = null
  seq += 1
  const maps: RenderedMap[] = []
  let lanes = 0
  let status: RenderedStatus = 'drawn'
  let note: string | undefined
  for (const surface of surfaces) {
    if (!surface.live()) continue
    const account = surface.account()
    maps.push(...(account.maps ?? []))
    lanes += account.lanes ?? 0
    // A refusal outranks a gate: a page showing both has failed somewhere, and
    // that is what a script waiting on it needs to hear first.
    const noted = account.noted
    if (noted !== null && (status === 'drawn' || noted.status === 'error')) {
      status = noted.status
      note = noted.note
    }
  }
  const detail: RenderedReport = {
    seq,
    at,
    status,
    state: window.location.hash.replace(/^#/, ''),
    maps,
    lanes,
    ...(note === undefined || note === '' ? {} : { note }),
  }
  try {
    performance.mark(RENDERED, { startTime: at, detail })
  } catch {
    // A browser that cannot place a mark in the past still gets the event.
  }
  window.dispatchEvent(new CustomEvent<RenderedReport>(RENDERED, { detail }))
}

/** @internal Back to a page that has drawn nothing, for tests. */
export function resetRendered(): void {
  tasks = 0
  seq = 0
  changed = false
  quietSince = null
  if (frame !== 0) cancelAnimationFrame(frame)
  frame = 0
  if (recheck !== null) clearTimeout(recheck)
  recheck = null
  surfaces.clear()
}
