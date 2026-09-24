/**
 * What `metacooler-plot` (§27) can ask of a window, a tab and its analyses.
 *
 * Interfaces only, in a module of their own, because both ends of them are big
 * files that must not import each other for this: `App` and `Session` implement
 * them with closures over what they already hold, and `plot/harness.ts` — its
 * own chunk, fetched only on a plot mount — drives them. Nothing here draws or
 * decides anything; every figure is the one the tab's own Export card would
 * save, and every analysis is the one its own Run button would start.
 */

import type { ViewState } from '../types'

/** The two files a figure is written as, as the Export cards name them. */
export type PlotFormat = 'png' | 'pdf'

/** How a figure is asked for. `dpi` is ignored where the page is vector. */
export interface PlotRequest {
  format: PlotFormat
  dpi: number
  now: Date
}

/** Which of the tab's pictures the main figure is, or why there is none. */
export type FigureKind =
  | { kind: 'map' | 'deck' | 'browser' }
  | { kind: null; why: string }

/** The window, as the harness sees it (`App`). */
export interface PlotHost {
  /**
   * Open a workspace file's text as this window's tabs, replacing what is there.
   * Returns the sentence the window would have shown for a file it refused, or
   * `null` when the tabs are seated.
   */
  openWorkspace(text: string, label: string): string | null
  /** The tabs, in strip order. */
  tabs(): readonly SessionPlot[]
  /** Which is in front. */
  active(): number
  /** Bring one in front, as a press on it does. */
  activate(index: number): void
  /** What the window has said in its notice slot since the last call, oldest first. */
  takeNotices(): string[]
}

/** One tab, as the harness sees it (`Session`). */
export interface SessionPlot {
  /** What the strip calls it. */
  label(): string
  state(): ViewState | null
  /**
   * What is still running in this tab — opening, a loading screen, a track
   * still loading, the analysis chunk — as one short phrase each. Empty is
   * *nothing the tab knows of*; the worker requests are counted apart
   * (`perf/inflight.ts`).
   */
  busy(): string[]
  /** Why this tab shows no picture: its error screen, or the note over its picker. */
  failure(): string | null
  /** What the Export card would save here, or why nothing. */
  figureKind(): FigureKind
  /** The figure the Export card (or the `S` key) would save, or `null` for none. */
  figure(request: PlotRequest): Promise<Blob | null>
  /** Saved places, as the Bookmarks card lists them. */
  bookmarks(): Array<{ label: string; locus: string }>
  /** Go to a saved place, as the card's row does. */
  goToBookmark(index: number): void
  /**
   * Frame the picture at a locus, keeping everything else the tab is showing:
   * the region of a map view (cut at the locus), the window of a 1D browser.
   * Returns a sentence when the view has nothing a locus can name.
   */
  goToLocus(locus: string): string | null
  /** The deck's structure cells, in grid order. */
  structures(): Array<{ label: string; figure(request: PlotRequest): Promise<Blob | null> }>
  /** The Analysis panel's side of the tab, or `null` while there is none. */
  analysis(): AnalysisPlot | null
}

/** A recorded task, as the Analysis panel would list it on this tab. */
export interface RecordedTask {
  id: string
  title: string
  /** `waiting` with what to load, or `absent` for a task that means nothing here (§18.1). */
  state: 'ready' | 'waiting' | 'absent' | 'unknown'
  needs?: string
}

/** One figure a run drew in the drawer, with what names it. */
export interface RunFigure {
  /** The output's id and label, as a TSV of it would be named. */
  output: string
  label: string
  /** Whether it can be drawn at all — a table left as a table cannot. */
  drawable: boolean
  figure(request: PlotRequest): Promise<Blob | null>
}

/** The analysis side of a tab. */
export interface AnalysisPlot {
  /** The tasks this tab recorded parameters for, in catalogue order. */
  recorded(): RecordedTask[]
  /**
   * Open the drawer on a task and press Run, with the parameters the tab
   * recorded; settles when the run has. `refused` carries the drawer's own
   * refusal (a price past its budget, no map starred).
   */
  run(task: string): Promise<
    | { status: 'done'; figures: RunFigure[]; notes: string[] }
    | { status: 'failed' | 'refused' | 'cancelled' | 'unknown'; message: string }
  >
  /** Put the drawer down. */
  close(): void
}
