/**
 * The small amount of DOM plumbing the views share.
 *
 * There is no framework here on purpose: the whole app is a handful of views
 * over data that arrives once, so a virtual DOM would buy nothing that a
 * `textContent` assignment does not. What *is* worth centralising is number
 * formatting — a genomes table full of raw `4573673`s is unreadable, and the
 * unassigned QC statistic of §7.4 is specified down to its thousands
 * separators.
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

/** Remove every child of a node. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

const INTEGER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const DECIMAL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 })

export const fmt = {
  /** `4573673` → `4,573,673`. */
  int(value: number): string {
    if (!Number.isFinite(value)) return '—'
    return INTEGER.format(value)
  },
  /** Compact but honest: integers keep their separators, floats keep 3 places. */
  num(value: number): string {
    if (!Number.isFinite(value)) return '—'
    return Number.isInteger(value) ? INTEGER.format(value) : DECIMAL.format(value)
  },
  /** `0.083` → `8.3%`. */
  pct(fraction: number, digits = 1): string {
    if (!Number.isFinite(fraction)) return '—'
    return `${(fraction * 100).toFixed(digits)}%`
  },
  /** Base pairs with a unit, for axis readouts. */
  bp(value: number): string {
    if (!Number.isFinite(value)) return '—'
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)} Mb`
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)} kb`
    return `${INTEGER.format(value)} bp`
  },
  /** Byte counts for the debug panel (§12). */
  bytes(value: number): string {
    if (!Number.isFinite(value)) return '—'
    const units = ['B', 'kB', 'MB', 'GB', 'TB']
    let scaled = value
    let unit = 0
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024
      unit++
    }
    return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`
  },
}

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
