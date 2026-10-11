/**
 * The app's own mark, as an element.
 *
 * The same drawing as the favicon, the install prompt and the dock icon — the
 * one `scripts/make-app-icons.py` renders from one description — reached here
 * through the 192 px file it already writes rather than through a second copy
 * of the shapes. A hand-inlined SVG would be a fourth place the mark lives and
 * the first that nothing regenerates, which is exactly how the two hand-kept
 * drawings this script replaced came to disagree.
 *
 * `BASE_URL` because the site is served from a subdirectory on GitHub Pages and
 * from the filesystem in the desktop build; a leading slash is right in neither.
 */

import { el } from './dom'

/**
 * A build that carries the mark inline rather than beside it; `''` for the rest.
 *
 * Set only by `vite.standalone.config.ts`, and only because that target may not
 * emit a second file *at all* — which is the one thing `vite.pinned.config.ts`'s
 * `shellIcon()` plugin does to solve the same problem. Same file, same drawing,
 * read from `public/` at build time and base64'd; still no second copy of the
 * shapes, which is what `scripts/make-app-icons.py` exists to prevent.
 */
declare const __MARK_URL__: string

/** Where the built icon lives, wherever the app is served from. */
export function markUrl(): string {
  // `typeof` because `vitest` applies no `define` block (see `version.ts`).
  if (typeof __MARK_URL__ !== 'undefined' && __MARK_URL__ !== '') return __MARK_URL__
  return `${import.meta.env.BASE_URL}icon-192.png`
}

/**
 * @param size Edge in CSS pixels, for a mark that sits beside text of a fixed
 *   size — the header. Omit it and the element carries no size of its own, so
 *   the stylesheet can scale it with whatever it stands next to: the landing
 *   page's mark is `1em` of a title that is itself `clamp`ed to the page, and a
 *   number here would fight that on every window width.
 */
export function appMark(size?: number): HTMLElement {
  const node = el('img', {
    class: 'app-mark',
    // Decorative in both places it appears: the header has the app's name
    // beside it and the landing page has it beside one too, so a screen reader
    // announcing "chromosomix logo, chromosomix" would be reading it twice.
    attrs: { src: markUrl(), alt: '' },
  })
  if (size !== undefined) {
    node.setAttribute('width', String(size))
    node.setAttribute('height', String(size))
    node.style.width = `${size}px`
    node.style.height = `${size}px`
  }
  return node
}
