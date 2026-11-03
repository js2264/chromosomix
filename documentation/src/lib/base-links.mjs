/**
 * Every root-relative link a page writes — `[Opening files](/files/opening/)`,
 * `<a href="/cli/install/">`, a `<Tile href>` or `<LinkCard href>` — put
 * under this copy's base, as a plugin of Astro's Markdown pipeline (Sätteri),
 * which renders both the `.md` and the `.mdx` pages.
 *
 * Pages are written as if the site were at the root, because the copy of the
 * latest release is, and because a link that carries a version is a link that
 * goes stale. The same page built for `/v0.20.0/` then links within
 * `/v0.20.0/`, and the one built for `/dev/` within `/dev/`. Starlight's own
 * links — the sidebar, the pagination, the search — already carry the base,
 * and so do the components', through `withBase`.
 */

import { defineHastPlugin } from 'satteri'

import { BASE, withBase } from './site.mjs'

/** An MDX element's attributes with its `href` rebased, or `null` where none moved. */
function rebasedAttributes(attributes) {
  let moved = false
  const next = attributes.map((attribute) => {
    if (attribute.type !== 'mdxJsxAttribute' || attribute.name !== 'href' || typeof attribute.value !== 'string') return attribute
    const value = withBase(attribute.value)
    if (value === attribute.value) return attribute
    moved = true
    return { ...attribute, value }
  })
  return moved ? next : null
}

const mdxElement = {
  filter: [],
  visit(node) {
    const attributes = rebasedAttributes(node.attributes ?? [])
    if (attributes !== null) return { ...node, attributes }
  },
}

export const baseLinks =
  BASE === '/'
    ? null
    : defineHastPlugin({
        name: 'chromosomix-base-links',
        element: {
          filter: ['a'],
          visit(node, ctx) {
            const href = node.properties?.href
            if (typeof href !== 'string') return
            const next = withBase(href)
            if (next !== href) ctx.setProperty(node, 'href', next)
          },
        },
        mdxJsxFlowElement: mdxElement,
        mdxJsxTextElement: mdxElement,
      })
