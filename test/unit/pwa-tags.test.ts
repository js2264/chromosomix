/**
 * The three tags two of the three builds must not ship.
 *
 * `index.html` is written for the *site*, where the app is installable and
 * works offline; the desktop renderer and the archived copies are neither, and
 * the substitution that makes it true of them is four regexes over hand-written
 * HTML. That is exactly the kind of thing that keeps working until somebody
 * reformats the file — and when it stops working nothing fails: the desktop
 * build ships a link to a manifest it does not contain, and an archived build
 * quietly offers to install itself as "(meta)cooler" over the real one.
 *
 * `scripts/check-desktop-build.mjs` catches the desktop half after a build.
 * This catches both halves before one, against the real `index.html` rather
 * than a fixture, because a fixture is a copy of the file that stops being a
 * copy of it.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { stripPwaTagsFrom } from '../../scripts/pwa-tags.mjs'

const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const stripped = stripPwaTagsFrom(source)

describe('the shipped index.html', () => {
  it('has all three tags to strip, or this test is checking nothing', () => {
    expect(source).toContain('rel="manifest"')
    expect(source).toContain('rel="apple-touch-icon"')
    expect(source).toContain('name="theme-color"')
  })
})

describe('stripPwaTagsFrom', () => {
  it('takes out the two links that point at files these builds do not emit', () => {
    expect(stripped).not.toContain('rel="manifest"')
    expect(stripped).not.toContain('rel="apple-touch-icon"')
  })

  it('takes out the theme colour, which tints chrome that is not there', () => {
    expect(stripped).not.toContain('name="theme-color"')
  })

  it('leaves no root-absolute reference behind, which is the rule that catches a miss', () => {
    // `indexHtmlProblems()` checks the same thing after a desktop build. Both
    // stripped links were root-absolute; a survivor is a request for a file
    // that is not there, on the console of an app that claims to need none.
    //
    // The entry module is the one exception, and only here: this is the source
    // file, where `/src/main.ts` is what the dev server serves and what Vite
    // rewrites into a hashed asset URL. By the time `indexHtmlProblems()` reads
    // the built page it is gone, which is why that check has no exception in it.
    const absolute = [...stripped.matchAll(/\s(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1])
    expect(absolute).toEqual(['/src/main.ts'])
  })

  it('leaves a note where the manifest link was, rather than a silent gap', () => {
    // Somebody reading a stripped document is usually working out why there is
    // no service worker, and a sentence saying the tags were removed on purpose
    // is what answers them.
    expect(stripped).toContain('stripped for this build')
    // Once, and at the indentation of the tag it replaced.
    expect(stripped.match(/stripped for this build/g)).toHaveLength(1)
    expect(stripped).toContain(
      '    <!-- The manifest, touch-icon and theme-color tags are stripped for this build. -->',
    )
  })

  it('keys the note on a tag, because prose is the thing people edit', () => {
    // The regression this pins. The note used to replace the *paragraph* in
    // `index.html` that described the three tags, matched by `src/pwa.ts`
    // inside it — and a documentation pass removed that paragraph, at which
    // point the substitution matched nothing. No build check could see it: the
    // tags were still stripped and only the sentence explaining their absence
    // was gone. `index.html` cannot lose its manifest link the same way.
    const reworded = source.replace(/^[ \t]*<!--[\s\S]*?-->\r?\n/gm, '')
    expect(reworded).not.toContain('<!--')
    expect(stripPwaTagsFrom(reworded)).toContain('stripped for this build')
  })

  it('does nothing the second time, because it consumes its own anchor', () => {
    // `transformIndexHtml` is called once per build, but a substitution that
    // stacked a note per run would say so only in a build somebody ran twice.
    expect(stripPwaTagsFrom(stripped)).toBe(stripped)
  })

  it('keeps the favicon, the module script and the mount point', () => {
    // The negative checks above would all pass on an empty string.
    expect(stripped).toContain('rel="icon" href="data:image/svg+xml')
    expect(stripped).toContain('<div id="app"></div>')
    expect(stripped).toContain('src="/src/main.ts"')
  })

  it('does nothing the second time, so a double transform is not a hazard', () => {
    expect(stripPwaTagsFrom(stripped)).toBe(stripped)
  })
})
