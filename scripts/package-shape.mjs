/**
 * What the copy that goes to npm is allowed to look like.
 *
 * Shared by `scripts/check-package-build.mjs`, which walks the built directory,
 * and by `test/unit/package-shape.test.ts`, which is the only way to check a
 * rule without publishing a wrong one first. The same arrangement as
 * `pinned-shape.mjs` and `desktop-shape.mjs`, and for the same reason: every
 * rule here is a mistake somebody makes, and every one of them produces a build
 * that succeeds and is published and is wrong.
 *
 * **A published version is immutable.** That is the whole of why this file is
 * strict. A wrong archived build can be rebuilt over; a wrong tarball is on a
 * registry for ever, mirrored by every CDN that has seen it, pinned in
 * somebody's lockfile, and the only remedy is another version and a note asking
 * people to move. So the four things that would make one wrong are asserted
 * before it can be packed:
 *
 * 1. **The base has to be relative.** This is the rule the whole build exists
 *    for. A root-absolute asset URL works on exactly one mount — the site root —
 *    and 404s on every other, which is all of them: a lab site's `/viewer/`, a
 *    CDN's `/npm/<pkg>@<version>/dist/`, an institutional server's deep path.
 *    The failure is a blank frame in somebody else's page, found by their
 *    readers.
 * 2. **No service worker, and not installable.** A copy mounted under a path it
 *    does not own must not claim a scope there; on a shared CDN that scope
 *    belongs to other packages. The manifest and the touch icon point at files
 *    this build does not emit anyway.
 * 3. **No source maps and no data.** Both are about somebody else's bandwidth
 *    rather than ours: a tarball is downloaded by everyone who installs the
 *    package and cached for ever by every registry mirror. Maps are ~20 MB of a
 *    ~26 MB site build, and the demo datasets are 250 MB one careless
 *    `publicDir` away.
 * 4. **A budget**, which is the tripwire under all three — one number that fails
 *    if any of the reasons for it is quietly removed, including reasons nobody
 *    has thought of yet.
 * 5. **The site's Content-Security-Policy**, as a meta ahead of everything it
 *    governs (`csp.mjs`). The servers a tarball is unpacked onto are exactly
 *    the ones whose headers nobody here can know, so the policy travels inside
 *    the page or not at all.
 *
 * Pure predicates over names, sizes and strings: the caller reads, this decides.
 * Each returns a list of human-readable problems, empty when there are none — a
 * boolean would say that something is wrong and not what.
 */

import { webCspProblems } from './csp.mjs'
import { isDataFile } from './desktop-shape.mjs'

/**
 * What the published `dist/` may weigh, in bytes.
 *
 * A package build is ~6 MB, nearly all of it the HDF5 chunk. The cap is
 * generous against that and far below the ~26 MB a site build weighs with its
 * maps, which is the regression it is actually watching for — `dist/` is the
 * directory both builds write to, so a tarball packed over a stale site build
 * is the one mistake this cannot be reached without making.
 */
export const SIZE_LIMIT = 12 * 1024 * 1024

/** Files that must be there. Their absence is silent in the same way. */
const REQUIRED = [
  ['index.html', 'the build produced no document'],
  ['icon-192.png', 'the header mark would be a broken image (`src/ui/mark.ts`)'],
]

/**
 * What is wrong with the *set* of files, and with their total size.
 *
 * Takes `{ name, size }` with names relative to the build root and `/`
 * separators, so the caller owns the walk and this owns the policy.
 */
export function packageFileProblems(files) {
  const problems = []
  const names = new Set([...files].map((file) => file.name))

  for (const [name, why] of REQUIRED) {
    if (!names.has(name)) problems.push(`${name} is missing — ${why}`)
  }

  let total = 0
  for (const file of files) {
    total += file.size
    const base = file.name.split('/').pop() ?? file.name
    if (base === 'sw.js') {
      problems.push(`${file.name}: a service worker was emitted for a copy that owns no scope`)
    } else if (base === 'manifest.webmanifest') {
      problems.push(`${file.name}: a web manifest was emitted; a vendored copy is not installable`)
    } else if (file.name.endsWith('.map')) {
      problems.push(`${file.name}: source maps are ~20 MB and are not published to a registry`)
    } else if (file.name.split('/').includes('demo')) {
      problems.push(`${file.name}: the demo directory is data and is published once, on the bucket`)
    } else if (isDataFile(base)) {
      problems.push(`${file.name}: a data file reached the package`)
    }
  }

  if (total > SIZE_LIMIT) {
    problems.push(
      `the build is ${mb(total)} against a ${mb(SIZE_LIMIT)} cap — ` +
        'this is downloaded by everyone who installs the package, for ever',
    )
  }
  return problems
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * What is wrong with the built `index.html`.
 *
 * The positive assertion comes first and is the important one: a build that
 * emitted no module script at all would pass every negative check here.
 */
export function packageIndexProblems(html) {
  const problems = []
  if (!html.includes('src="./assets/')) {
    problems.push(
      'index.html has no module script under ./assets/ — the build did not use a relative ' +
        'base, and every asset it asks for will 404 on any mount but the site root',
    )
  }
  if (/<link\s[^>]*rel="manifest"/i.test(html)) {
    problems.push('index.html still links a web manifest; stripPwaTags() did not run')
  }
  if (/<link\s[^>]*rel="apple-touch-icon"/i.test(html)) {
    problems.push('index.html still links an apple-touch-icon; stripPwaTags() did not run')
  }
  // Every remaining reference has to be relative or self-contained. A
  // root-absolute one is the same failure as a wrong base, arriving one
  // attribute at a time — and it resolves, which is what makes it dangerous: it
  // points at whatever the *host site* happens to serve at that path.
  for (const match of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
    const url = match[1]
    if (url.startsWith('/')) {
      problems.push(`index.html references ${url}, which is root-absolute and cannot be vendored`)
    }
  }
  problems.push(...webCspProblems(html))
  return problems
}
