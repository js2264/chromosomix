/**
 * The small amount of DOM plumbing the views share.
 *
 * There is no framework here on purpose: the whole app is a handful of views
 * over data that arrives once, so a virtual DOM would buy nothing that a
 * `textContent` assignment does not. Number formatting lives in `src/units.ts`,
 * where a worker can reach it, and is re-exported here so the views keep one
 * import.
 */

export type Child = Node | string | null | undefined | false

export interface ElementOptions {
  class?: string
  text?: string
  title?: string
  id?: string
  type?: string
  value?: string
  placeholder?: string
  href?: string
  disabled?: boolean
  attrs?: Record<string, string>
  style?: Partial<CSSStyleDeclaration>
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>
}

/** Create an element, set the usual properties, append children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class !== undefined) node.className = options.class
  if (options.text !== undefined) node.textContent = options.text
  if (options.title !== undefined) node.title = options.title
  if (options.id !== undefined) node.id = options.id
  if (options.href !== undefined) node.setAttribute('href', options.href)
  if (options.type !== undefined) node.setAttribute('type', options.type)
  if (options.placeholder !== undefined) node.setAttribute('placeholder', options.placeholder)
  if (options.value !== undefined) (node as HTMLInputElement).value = options.value
  if (options.disabled === true) node.setAttribute('disabled', '')
  if (options.attrs) for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v)
  if (options.style) Object.assign(node.style, options.style)
  if (options.on) {
    for (const [name, handler] of Object.entries(options.on)) {
      node.addEventListener(name, handler as EventListener)
    }
  }
  append(node, children)
  return node
}

/** Append children, skipping the falsy ones so `cond && el(...)` reads well. */
export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/**
 * Whether a drag is carrying files, rather than text or a row from a card.
 *
 * Asked before any drop target lights up, because the Tracks card's own rows
 * are draggable — that is how a stack is reordered — and one dragged across the
 * card must not offer to load itself. `types` is the only thing a browser
 * exposes during a drag; the files themselves are readable at `drop` and not
 * before, which is exactly the moment it is too late to have highlighted.
 */
export function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/**
 * The type a dragged **track row** carries, so a target can tell it from a file
 * while the drag is still in the air.
 *
 * A custom MIME type and not `text/plain`, which the same drag also sets: a
 * plain string is what a text selection dragged out of any input carries too,
 * and the map's edge rectangles must not offer to move a track because someone
 * dragged a word across them. Lowercase, because a browser lowercases every
 * type it stores and a comparison against a capital would never match.
 */
export const TRACK_DRAG_TYPE = 'application/x-metacooler-track'

/** Whether a drag is carrying one of the Tracks card's rows. */
export function dragHasTrack(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(TRACK_DRAG_TYPE)
}

/**
 * A row of the **Structures** card, dragged onto a cell of the deck (§25.3).
 *
 * Its own type beside {@link TRACK_DRAG_TYPE} rather than a reuse of it,
 * because the two mean different things where they land: a track dropped on the
 * map's edge is drawn along that edge, and a structure dropped on an empty cell
 * turns that cell into the model. A single type would leave each drop target
 * guessing which it had caught from an id alone, and only `types` is readable
 * while the drag is still in the air.
 */
export const STRUCTURE_DRAG_TYPE = 'application/x-metacooler-structure'

/** Whether a drag is carrying one of the Structures card's rows. */
export function dragHasStructure(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(STRUCTURE_DRAG_TYPE)
}

/**
 * Give a one-line element its whole text as a tooltip, whenever the line is cut.
 *
 * For a line that ends in an ellipsis rather than wrapping — a view's summary
 * under its title, which changes on every pan and zoom and moved the map by a
 * line each time it wrapped (`ui/styles.css`). What the ellipsis hides has to
 * be somewhere, and the tooltip is where a reader pointing at the cut looks.
 * Only when it *is* cut: a tooltip repeating the line it sits on is noise.
 *
 * Watched rather than set by the views, because five of them write this line
 * from a dozen places, and one of those places is a child element another
 * object rewrites on every frame of a pan (`MatrixPanel.viewNote`).
 */
export function titleWhenCut(node: HTMLElement): void {
  const sync = (): void => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    const cut = node.scrollWidth > node.clientWidth + 1
    const title = cut ? text : ''
    if (node.title !== title) node.title = title
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(sync).observe(node, { childList: true, characterData: true, subtree: true })
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(node)
  sync()
}

/**
 * A **map** dragged by its grip on the Contact maps card, towards a cell of the
 * deck (§16.9). Its own type, beside the track's and the structure's, for their
 * reason: a cell has to tell what it is being offered while the drag is still
 * in the air, and only `types` can be read then.
 *
 * The payload says which map: the session's own (`lead`), the one in its lower
 * triangle (`compare`), a companion already in a cell, by the deck's id, or one
 * the reader's eye took out of the deck (`hidden`), by the session's id for it.
 */
export const MAP_ROW_DRAG_TYPE = 'application/x-metacooler-map'

export type MapRow =
  | { kind: 'lead' }
  | { kind: 'compare' }
  | { kind: 'companion'; id: string }
  | { kind: 'hidden'; id: string }

/** Whether a drag is carrying a row of the Contact maps card. */
export function dragHasMapRow(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(MAP_ROW_DRAG_TYPE)
}

/** The map a drop is carrying, or `null` where it carries none this build reads. */
export function readMapRow(event: DragEvent): MapRow | null {
  const raw = event.dataTransfer?.getData(MAP_ROW_DRAG_TYPE) ?? ''
  if (raw === '') return null
  try {
    const row = JSON.parse(raw) as Record<string, unknown>
    if (row['kind'] === 'lead' || row['kind'] === 'compare') return { kind: row['kind'] }
    if ((row['kind'] === 'companion' || row['kind'] === 'hidden') && typeof row['id'] === 'string' && row['id'] !== '') {
      return { kind: row['kind'], id: row['id'] }
    }
  } catch {
    // A payload this build did not write is a drop of nothing.
  }
  return null
}

/** Remove every child of a node. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export { fmt, trimNumber } from '../units'

/** Trailing-edge debounce, for the table's search and filter boxes. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/** A labelled control, the layout every toolbar in the app uses. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el(
    'label',
    { class: 'field', title: hint ?? '' },
    el('span', { class: 'field-label', text: label }),
    control,
  )
}

/** A `<button>` with a click handler. */
export function button(
  label: string,
  onClick: () => void,
  options: { class?: string; title?: string } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: options.class ?? 'btn',
    text: label,
    title: options.title ?? '',
    type: 'button',
  })
  node.addEventListener('click', onClick)
  return node
}
