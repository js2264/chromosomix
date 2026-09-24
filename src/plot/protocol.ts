/**
 * What crosses the DevTools pipe between `metacooler-plot` and the page (§27).
 *
 * Its own module, with nothing in it that draws, because both ends import it:
 * the harness (`plot/harness.ts`) implements {@link PlotApi} inside the page,
 * and the command (`cli/plot.ts`) calls it from Node — where importing the
 * harness itself would bring the theme, the export preferences and the rest
 * of the window along with it.
 */

import type { PlotAnswers } from './answers'
import type { FigureKind, PlotFormat, RecordedTask } from './types'

/**
 * The version of this object's shape, which the command checks before it says
 * anything else. Bumped whenever a method changes meaning, since a viewer and a
 * command from two builds are the two halves most likely to disagree silently.
 */
export const PLOT_PROTOCOL = 1

/** Bytes held for the command, by reference. */
export interface BlobRef {
  ref: string
  size: number
  type: string
}

/** What the command asks the window to be before anything is opened. */
export interface PlotConfig {
  theme?: 'light' | 'dark'
  /** Whether a saved figure carries its caption (§7.2). */
  caption?: boolean
  /** The text scale, snapped to a rung of `ui/textScale.ts`. */
  textScale?: number
  /** How an `.scool` over HTTP is read, and how a `.pairs` is binned (`plot/answers.ts`). */
  scool?: PlotAnswers['scool']
  pairs?: PlotAnswers['pairs']
}

/** A figure asked for over the wire: `now` travels as an ISO string, when fixed. */
export interface WireRequest {
  format: PlotFormat
  dpi: number
  /** A fixed instant for captions and PDF dates — `SOURCE_DATE_EPOCH` — or absent for now. */
  now?: string
}

/** The active tab, as the command reads it between steps. */
export interface TabReport {
  index: number
  count: number
  label: string
  view: string | null
  uri: string | null
  failure: string | null
  figure: FigureKind
  bookmarks: Array<{ label: string; locus: string }>
  structures: Array<{ label: string }>
  notices: string[]
}

/**
 * How a run went: `done` with the figures the drawer drew — each by its index,
 * its output and its label — or another status with the sentence that says why.
 */
export interface RunReport {
  status: string
  message?: string
  notes?: string[]
  figures?: Array<{ index: number; output: string; label: string; drawable: boolean }>
}

export interface PlotApi {
  readonly protocol: number
  readonly build: { version: string; commit: string; producer: string }
  configure(config: PlotConfig): void
  /** Seat a workspace file's tabs; the refusal sentence, or `null`. */
  open(text: string, label: string): string | null
  /** Bring a tab in front, 0-based. */
  activate(index: number): void
  /** Wait until the tab in front has finished drawing; throws past `timeoutMs`. */
  settle(timeoutMs: number): Promise<{ ms: number }>
  describe(): TabReport
  figure(request: WireRequest): Promise<BlobRef | null>
  goToBookmark(index: number): void
  goToLocus(locus: string): string | null
  structureFigure(index: number, request: WireRequest): Promise<BlobRef | null>
  /** The tasks the tab in front recorded, or `null` where it has no Analysis panel. */
  analyses(): RecordedTask[] | null
  runAnalysis(task: string, timeoutMs: number): Promise<RunReport>
  analysisFigure(task: string, index: number, request: WireRequest): Promise<BlobRef | null>
  closeAnalysis(): void
  /** A piece of held bytes, as base64. */
  read(ref: string, offset: number, length: number): Promise<string>
  drop(ref: string): void
}

