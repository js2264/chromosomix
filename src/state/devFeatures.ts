/**
 * Dev features: on `main`, invisible until the switch in *About* is on (§29).
 *
 * A dev feature is built, specified and tested like any other, and a reader
 * who has not turned the switch on sees **nothing** of it — no row, no task, no
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
 * **The switch is a preference**, in `localStorage`: a fact about this browser,
 * not about a file or a tab, on the same side of the persistence tiers' line as
 * the theme. It is read once per page. Changing it reloads the window, which
 * keeps its tabs: every surface is then built from scratch with the new answer,
 * so no card, task list, worker or cached command list can disagree with it —
 * which a live re-render of a hundred surfaces could not promise.
 *
 * **Never in an embed** (§21): an embedded page has no *About*, and a host page
 * is not a developer's browser. **Always on where there is no page** — the
 * command line has no switch and shows everything (§29.5), and it shares the
 * task registry and the examples that ask this.
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
  /**
   * A metagenome drawn round (§7.6): the toggle, the Genomes table's button,
   * the command, and the key it writes in a link. Its own line rather than a
   * clause of `metacool`'s, so the format can be published without it.
   */
  circle: 'The circle of genomes is not validated yet.',
} as const

export type DevFeature = keyof typeof DEV_FEATURES

/** The `localStorage` key, named like the theme's. */
export const DEV_FEATURES_KEY = 'chromosomix:dev-features'

let cached: boolean | null = null

/**
 * Whether the switch is on in this page.
 *
 * Read once and remembered: the answer must not change under a page that was
 * built with the other one, which is why {@link setDevFeatures} reloads rather
 * than notifies. `false` wherever storage is refused, and always in an embed.
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

function read(): boolean {
  // No page, no switch: the command line — which imports the same task
  // registry and the same examples — sees everything, as §29.5 says it does. A
  // worker has no `window` either, and is told the page's answer on each open
  // instead of asking this.
  if (typeof window === 'undefined') return true
  if (embedded()) return false
  try {
    return window.localStorage.getItem(DEV_FEATURES_KEY) === 'on'
  } catch {
    return false
  }
}

/**
 * Turn the switch, and rebuild the window under the new answer.
 *
 * `reload` is a parameter so a test can watch the call rather than lose its
 * document to it.
 */
export function setDevFeatures(on: boolean, reload: () => void = () => window.location.reload()): void {
  try {
    if (on) window.localStorage.setItem(DEV_FEATURES_KEY, 'on')
    else window.localStorage.removeItem(DEV_FEATURES_KEY)
  } catch {
    // A browser that refuses storage cannot keep the switch, so there is
    // nothing to rebuild for: the page would come back as it is.
    return
  }
  cached = on
  reload()
}

/**
 * Forget the remembered answer, or state one. Tests only: a page reads it once,
 * and a test under `node` has no `localStorage` to put an answer in.
 */
export function resetDevFeatures(on: boolean | null = null): void {
  cached = on
}
