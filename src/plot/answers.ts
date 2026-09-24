/**
 * What a program says to the questions a file asks before it opens (§27).
 *
 * Four things in this app stop and ask a reader before they read: a `.pairs`
 * has no resolution and asks for one (§3.7); a single-cell container over the
 * network asks whether to fetch it whole or in pieces (§3.8, §12); a HiC-Pro
 * pair asks before it parses a gigabyte of text (§3.9); and a whole-file
 * picture waits behind a button that states its cost (§7.3). Every one of those
 * is a modal or a button, and a headless window has nobody to press it — so a
 * `metacooler-plot` run that met one would wait for its timeout and then report
 * a figure that was never going to arrive.
 *
 * So the program answers them, the way the shell answers the same questions for
 * `metacooler-run`: with its flags, set once before the workspace is opened.
 * Each site asks {@link plotAnswers} first and falls back to its dialog when it
 * says `null`, which it always does outside a plot mount — a reader's window
 * never reads anything from here.
 *
 * The answers are the same ones a reader pressing through would give, with one
 * choice the shell makes for them: an `.scool` is read **in pieces** unless the
 * command says otherwise, because the files a shell names are served from this
 * machine and a round trip to it is a fraction of a millisecond, while
 * downloading the whole container first costs its size in memory.
 */

import { plotting } from '../embed'
import type { PairsBinning } from '../worker/protocol'

export interface PlotAnswers {
  /** How a single-cell container over HTTP is read: fetched once, or in pieces. */
  scool: 'whole' | 'fine'
  /**
   * How to bin a `.pairs`, or `null` when the command named no resolution — in
   * which case the file is refused with a sentence naming the flag.
   */
  pairs: Pick<PairsBinning, 'base' | 'rungs'> | null
}

const DEFAULTS: PlotAnswers = { scool: 'fine', pairs: null }

let held: PlotAnswers = { ...DEFAULTS }

/** Set by the harness from the command's flags, before anything is opened. */
export function setPlotAnswers(answers: Partial<PlotAnswers>): void {
  held = { ...held, ...answers }
}

/** The answers in force, or `null` outside a plot mount — the reader's dialogs then ask. */
export function plotAnswers(): PlotAnswers | null {
  return plotting() ? held : null
}

/**
 * The sentence a `.pairs` is refused with when the command named no resolution.
 *
 * The flag's name rather than a description of the dialog, for the reason
 * `metacooler-run` gives the same refusal: the reader of this sentence is at a
 * shell, where there is no dialog to describe.
 */
export function pairsRefusal(label: string): string {
  return (
    `${label} is a .pairs file: a list of contacts with no resolution of its own. ` +
    'Say what to bin it at, e.g. `--bin-size 5000 --rungs 4`.'
  )
}
