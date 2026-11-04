/**
 * The app's pictures at the size the app drew them, as a plugin of Astro's
 * Markdown pipeline (Sätteri), like `base-links.mjs`.
 *
 * Every picture under `src/assets/screens/` is shot at twice the density of
 * the screen it shows (`scripts/screens/`), so it is sharp on a dense screen.
 * Drawn at its width in pixels, a narrow one — one card of a panel, a drawer's
 * figure — would be the app at twice its size, and a wide one at whatever the
 * column left of it: the pictures of one page at different scales. So each is
 * held to half its width in pixels, which is its width on the screen it was
 * shot on, and to the column where that is wider: one scale on every page.
 * Each is also marked `cx-screen`, which the stylesheet frames as the app frames
 * a card, so a white panel does not run into a white page.
 *
 * A picture whose title names a live view (`live.mjs`) is put in a holder that
 * carries the embed's address, for this copy's own app, and the page's script
 * puts a button on it (`components/LiveViews.astro`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineHastPlugin } from 'satteri'

import { embedAddress, liveLink, viewerAddress } from './live.mjs'
import { APP_URL } from './site.mjs'
import { webpWidth } from './webp-size.mjs'

const SCREENS = 'assets/screens/'
const ROOT = fileURLToPath(new URL(`../${SCREENS}`, import.meta.url))

/** The density the pictures are shot at (`scripts/screens/`). */
export const DENSITY = 2

/** The width a picture is shown at, in CSS pixels, for its `src` as a page writes it; `null` for any other image. */
export function screenWidth(src) {
  const at = src.indexOf(SCREENS)
  if (at < 0) return null
  const width = webpWidth(readFileSync(ROOT + src.slice(at + SCREENS.length)))
  return width === null ? null : Math.round(width / DENSITY)
}

export const trueSizeScreens = defineHastPlugin({
  name: 'chromosomix-true-size-screens',
  element: {
    filter: ['img'],
    visit(node, ctx) {
      const src = node.properties?.src
      if (typeof src !== 'string') return
      const width = screenWidth(src)
      if (width === null) return
      ctx.setProperty(node, 'style', `max-width: min(100%, ${width}px)`)
      // `class` and not hast's `className`: Astro hands every property of a
      // Markdown image to its image step as an attribute, and keeps `className`
      // on the element too, which would write the class twice.
      ctx.setProperty(node, 'class', 'cx-screen')
      const link = liveLink(node.properties?.title)
      if (link === null) return
      // The title was the mark, not a tooltip to show.
      ctx.setProperty(node, 'title', null)
      const alt = node.properties?.alt
      // A span, held to the picture's width: the picture is the only thing in
      // its paragraph, and a paragraph may not hold a block of its own.
      ctx.wrapNode(node, {
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['cx-live'],
          style: `max-width: min(100%, ${width}px)`,
          dataLive: embedAddress(APP_URL, link),
          dataLiveViewer: viewerAddress(APP_URL, link),
          dataLiveTitle: typeof alt === 'string' && alt !== '' ? alt : 'chromosomix, live',
        },
        children: [],
      })
    },
  },
})
