/**
 * What a saved figure carries that the screen does not decide for it.
 *
 * A sibling of `ui/plotOptions.ts`, and deliberately not a field in it. Those
 * are the overlays on screen, and a figure inherits them because a figure is
 * what was on screen; this is the one question a reader asks of the *figure*
 * alone — whether each track is captioned in it — and a caption that went off
 * on screen when it was turned off for the paper would take away the thing a
 * reader looks at to know which lane is which.
 *
 * One store for every Export card, because it is one preference: the map's
 * card and the 1D browser's both offer it, and the deck's figure is composed of
 * cells that each read it (§25.3).
 *
 * `localStorage`, not the URL hash, for §5.5's reason: how a reader likes their
 * figures captioned is not *what is being looked at*.
 */

import { el } from './dom'

const KEY = 'metacooler-viewer:export'

export interface ExportPrefs {
  /**
   * Whether an exported figure writes each track's caption — its name, the
   * colour chip before it and the range its values span — on its lane.
   *
   * On by default: a figure whose lanes are unlabelled is a picture of four
   * signals with no way to tell them apart, and the reader who wants that has a
   * legend of their own to put beside it. When on, it is written small (see
   * `figureLabelStyle` in `render/laneLabel.ts`), since on paper a caption is a
   * key, not a control to be read across a desk.
   */
  trackCaptions: boolean
}

export const DEFAULT_EXPORT_PREFS: ExportPrefs = { trackCaptions: true }

let current: ExportPrefs | null = null
const listeners = new Set<(prefs: ExportPrefs) => void>()

/** Stored state outlives the code that wrote it, so every field is checked. */
function read(): ExportPrefs {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return { ...DEFAULT_EXPORT_PREFS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_EXPORT_PREFS }
    const record = parsed as Record<string, unknown>
    return {
      trackCaptions:
        typeof record.trackCaptions === 'boolean' ? record.trackCaptions : DEFAULT_EXPORT_PREFS.trackCaptions,
    }
  } catch {
    return { ...DEFAULT_EXPORT_PREFS }
  }
}

/** The preferences in force, as a copy. */
export function getExportPrefs(): ExportPrefs {
  current ??= read()
  return { ...current }
}

/** Set one preference, and tell every Export card showing it. */
export function setExportPref<K extends keyof ExportPrefs>(key: K, value: ExportPrefs[K]): void {
  const next = { ...getExportPrefs(), [key]: value }
  current = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* a browser that refuses storage still honours the switch for this session */
  }
  for (const listener of listeners) listener({ ...next })
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeExportPrefs(listener: (prefs: ExportPrefs) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The Export card's switch for {@link ExportPrefs.trackCaptions}.
 *
 * A factory mounted on both Export cards, like `textScaleField`: one preference,
 * offered where a reader is standing when they want it. The box follows the
 * store, so turning it off beside the map finds it off in the browser too.
 */
export function trackCaptionsField(): HTMLElement {
  const box = el('input', { class: 'checkbox', type: 'checkbox' })
  box.checked = getExportPrefs().trackCaptions
  box.addEventListener('change', () => setExportPref('trackCaptions', box.checked))
  // The box before its words, unlike the card's other rows: the words are the
  // whole of what it says, and in the label column they broke over two lines.
  const row = el(
    'label',
    {
      class: 'field field-check',
      title:
        'Write each track’s name, colour and range on its lane in the saved figure — small, as a ' +
        'key. Off, the lanes are saved bare; the screen keeps its captions either way.',
    },
    box,
    el('span', { class: 'field-label', text: 'track captions' }),
  )
  // The store outlives this control — a card is rebuilt on every navigation and
  // nothing hands the outgoing one a teardown — so the listener retires itself
  // the first time it is spoken to after leaving the document.
  const off = subscribeExportPrefs((prefs) => {
    if (!row.isConnected) {
      off()
      return
    }
    box.checked = prefs.trackCaptions
  })
  return row
}

/** Forget the cached value: for tests, which swap `localStorage` between cases. */
export function resetExportPrefsForTests(): void {
  current = null
  listeners.clear()
}
