/**
 * What a saved figure carries that the screen does not decide for it.
 *
 * A sibling of `ui/plotOptions.ts`, and deliberately not a field in it. Those
 * are the overlays on screen, and a figure inherits them because a figure is
 * what was on screen; this is a question a reader asks of the *figure* alone —
 * whether it says under itself what it is — and the screen has no such line
 * to turn off.
 *
 * One store for every Export card, because it is one preference: the map's
 * card and the 1D browser's both offer it, and the deck's figure is composed of
 * cells that each read it (§16.5).
 *
 * `localStorage`, not the URL hash, for §5.5's reason: how a reader likes their
 * figures captioned is not *what is being looked at*.
 */

import { el } from './dom'

const KEY = 'metacooler-viewer:export'

export interface ExportPrefs {
  /**
   * Whether a saved figure writes its caption under itself: the region it
   * shows, then the file, the bins, the score and the colour range, and when.
   *
   * On by default, because a figure that says what it is survives being
   * forwarded without the email it came in. Off for the reader laying figures
   * out in a panel of their own, with a legend they wrote.
   */
  caption: boolean
}

export const DEFAULT_EXPORT_PREFS: ExportPrefs = { caption: true }

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
      caption: typeof record.caption === 'boolean' ? record.caption : DEFAULT_EXPORT_PREFS.caption,
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
 * The Export card's switch for {@link ExportPrefs.caption}.
 *
 * A factory mounted on both Export cards, like `textScaleField`: one preference,
 * offered where a reader is standing when they want it. The box follows the
 * store, so turning it off beside the map finds it off in the browser too.
 */
export function captionField(): HTMLElement {
  const box = el('input', { class: 'checkbox', type: 'checkbox' })
  box.checked = getExportPrefs().caption
  box.addEventListener('change', () => setExportPref('caption', box.checked))
  // The box before its word, unlike the card's other rows: the word is the
  // whole of what it says.
  const row = el(
    'label',
    {
      class: 'field field-check',
      title:
        'Write under the saved figure what it shows — the region, then the file, the total it ' +
        'was drawn to where that is not the file’s own, bins, score, colour range and date. ' +
        'Off, the figure ends at its lowest track.',
    },
    box,
    el('span', { class: 'field-label', text: 'caption' }),
  )
  // The store outlives this control — a card is rebuilt on every navigation and
  // nothing hands the outgoing one a teardown — so the listener retires itself
  // the first time it is spoken to after leaving the document.
  const off = subscribeExportPrefs((prefs) => {
    if (!row.isConnected) {
      off()
      return
    }
    box.checked = prefs.caption
  })
  return row
}

/** Forget the cached value: for tests, which swap `localStorage` between cases. */
export function resetExportPrefsForTests(): void {
  current = null
  listeners.clear()
}
