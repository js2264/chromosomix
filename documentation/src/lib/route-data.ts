/**
 * Every copy's pages name the root copy's as canonical: the copy of the latest
 * release, which is where a search engine should send a reader. A page of
 * `/v0.19.0/` is the older edition of a page of `/`, and `/dev/` is not for
 * indexing at all: every page of it carries `noindex` (`astro.config.mjs`).
 */

import { defineRouteMiddleware } from '@astrojs/starlight/route-data'
import { BASE, SITE } from './site.mjs'

/** A pathname of this copy, as the root copy's. */
function atRoot(pathname: string): string {
  if (BASE === '/' || !pathname.startsWith(BASE)) return pathname
  return `/${pathname.slice(BASE.length)}`
}

export const onRequest = defineRouteMiddleware((context) => {
  if (BASE === '/') return
  const root = new URL(atRoot(context.url.pathname), SITE).href
  for (const entry of context.locals.starlightRoute.head) {
    if (entry.tag === 'link' && entry.attrs?.rel === 'canonical') entry.attrs.href = root
    if (entry.tag === 'meta' && entry.attrs?.property === 'og:url') entry.attrs.content = root
  }
})
