/**
 * The icon set: inline SVG, built in code, no glyphs and no font.
 *
 * Three reasons it is drawn rather than typed. A character like `⇤` or `ⓘ` is
 * rendered by whatever font the OS picks, so it is a different shape, weight
 * and baseline on every machine — and on some it is a box. An icon font is a
 * network request the CSP on a published artifact would block. And a glyph
 * cannot be given a stroke width that matches the rest of the interface.
 *
 * The shapes come from the upstream packages through `npm run icons`, so they
 * are Lucide's and Simple Icons' own geometry rather than an imitation of it:
 * one weight, round caps and joins, `currentColor`. The brand marks are filled
 * instead of stroked, because that is what a logo is.
 */

import { GENERATED_ICONS } from './icons.generated'

const SVG_NS = 'http://www.w3.org/2000/svg'

interface IconSpec {
  shapes: Array<[tag: string, attrs: Record<string, string>]>
  /** Filled rather than stroked, for the marks that are logos. */
  filled?: boolean
}

/**
 * The set, copied verbatim from upstream by `npm run icons`.
 *
 * Nothing is drawn here by hand any more. A sketched brand mark is wrong in a
 * way anyone can see, and a sketched interface icon drifts from the set it is
 * imitating — different corner radii, different optical weight, a chevron at a
 * slightly different angle. Lucide (ISC) supplies the interface icons and
 * Simple Icons (CC0) the GitHub mark; both are devDependencies of the
 * generator, not of the app.
 */
const ICONS: Record<string, IconSpec> = GENERATED_ICONS

export type IconName = keyof typeof GENERATED_ICONS

/**
 * Build one icon.
 *
 * `aria-hidden` because every caller is a control that already carries its own
 * label — an icon announced twice is worse than one not announced at all.
 */
export function icon(name: IconName, options: { size?: number; class?: string } = {}): SVGElement {
  const spec: IconSpec = ICONS[name]
  const size = options.size ?? 16
  const svg = document.createElementNS(SVG_NS, 'svg')
  // Both sources draw on a 24-unit grid, which is why one viewBox serves all.
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', options.class === undefined ? 'icon' : `icon ${options.class}`)
  if (spec.filled === true) {
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('stroke', 'none')
  } else {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  }
  for (const [tag, attrs] of spec.shapes) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    svg.appendChild(node)
  }
  return svg
}

/** A button whose whole content is one icon. The title is the accessible name. */
export function iconButton(
  name: IconName,
  title: string,
  onClick: () => void,
  options: { class?: string; size?: number } = {},
): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = options.class ?? 'btn btn-icon'
  node.title = title
  node.setAttribute('aria-label', title)
  node.appendChild(icon(name, options.size === undefined ? {} : { size: options.size }))
  node.addEventListener('click', onClick)
  return node
}
