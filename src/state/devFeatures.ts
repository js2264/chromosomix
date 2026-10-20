/**
 * Dev features: on `main`, invisible unless the page asked for them (§29).
 *
 * A dev feature is built, specified and tested like any other, and a reader
 * who has not asked for it sees **nothing** of it — no row, no task, no
 * command, no example, no clause in a sentence. Not greyed, not listed with an
 * instruction: §8.5's corrected form would list a control the reader could make
 * work, and this is the one case where there is something they could do and
 * they are deliberately not told.
 *
 * **The registry is the list below**, one line each with the reason it is not
 * public yet. Making a feature public is deleting its line — and then the
 * compiler names every gate it leaves behind, because {@link DevFeature} is the
 * registry's keys: a `devFeature('metacool')` whose key no longer exists is a
 * type error rather than a gate that quietly always opens.
 *
 * **The switch is the page's address**, read once per page, so nothing about
 * it is kept in the browser. The answer must not change under a page that was
 * built with the other one: every surface is built once with it, so no card,
 * task list, worker or cached command list can disagree with it.
 *
 * **Never in an embed** (§21): a host page is not a developer's browser.
 * **Always on where there is no page** — the command line has no switch and
 * shows everything (§29.5), and it shares the task registry and the examples
 * that ask this.
 */

import { embedded } from '../embed'

/** What is dev today, and why. Delete a line to make that feature public. */
export const DEV_FEATURES = {
  /**
   * Both containers, the genome layer, its views and tasks, and every sentence naming them —
   * and the DNA Bacterial Zoo's store, which is published with them (§24.3).
   */
  metacool: 'The multi-genome format, and the bacterial zoo made beside it, are not published yet.',
  /** The reference editor (§27): the stage, its task, its keys and the lens. */
  edit: 'Editing the reference is not validated yet.',
  /** Two sequences on two axes (§28). */
  dotplot: 'The dot plot is not validated yet.',
} as const

export type DevFeature = keyof typeof DEV_FEATURES

let cached: boolean | null = null

/**
 * Whether the dev features are on in this page.
 *
 * Read once and remembered: the answer must not change under a page that was
 * built with the other one. `false` always in an embed.
 */
export function devFeaturesOn(): boolean {
  if (cached !== null) return cached
  cached = read()
  return cached
}

/**
 * Whether one dev feature is to be shown.
 *
 * Every registered feature answers to the one switch; the name is taken so that
 * each gate says which feature it is, and so that deleting a registry line turns
 * that feature's gates into compile errors (see the header).
 */
export function devFeature(feature: DevFeature): boolean {
  return DEV_FEATURES[feature] !== undefined && devFeaturesOn()
}

/**
 * Whether a query string asks for the dev features.
 *
 * Pure, so the whole contract is testable without a `location`. On for a key
 * that is present, off for the three spellings of "no" — the same reading as
 * `embed` (`embed.ts`).
 */
export function readDevFeatures(search: string): boolean {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return false
  }
  const flag = params.get('dev')
  return flag !== null && flag !== '0' && flag !== 'false' && flag !== 'off'
}

function read(): boolean {
  // No page, no switch: the command line — which imports the same task
  // registry and the same examples — sees everything, as §29.5 says it does. A
  // worker has no `window` either, and is told the page's answer on each open
  // instead of asking this.
  if (typeof window === 'undefined') return true
  if (embedded()) return false
  return readDevFeatures(window.location.search)
}

/**
 * Forget the remembered answer, or state one. Tests only: a page reads it once,
 * and a test under `node` has no address to put an answer in.
 */
export function resetDevFeatures(on: boolean | null = null): void {
  cached = on
}
