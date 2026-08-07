/**
 * What an archived build is allowed to look like.
 *
 * Shared by `scripts/check-pinned-build.mjs`, which walks the built directory,
 * and by `test/unit/pinned-shape.test.ts`, which is the only way to check a
 * rule without publishing a wrong one first. The same arrangement as
 * `desktop-shape.mjs`, and for the same reason: every rule here is a mistake
 * somebody makes, and every one of them produces a build that succeeds and is
 * published and is wrong.
 *
 * The four that matter, in the order of how much they cost:
 *
 * 1. **No data, and nothing else out of `public/`.** `vite.pinned.config.ts`
 *    turns `publicDir` off. The demo datasets moved to a bucket, so today that
 *    saves only the icons — but the failure it was written for is one line
 *    away in either direction: turning `publicDir` back on (a plausible-sounding
 *    fix for a missing icon) or dropping a dataset back beside the app puts
 *    250 MB into *every archived commit*. Twenty of those is 5 GB against a
 *    1 GB Pages site: the deployment starts failing days later, for a reason
 *    nothing connects to the change that caused it.
 * 2. **The base has to be the pinned one.** Vite bakes absolute asset URLs at
 *    build time, so a copy built for `/` and served from `/v/<commit>/` is a
 *    blank page with three 404s — and archived builds are exactly the thing
 *    nobody loads for months, so it would be found by a reader and not by us.
 * 3. **Not installable, and no worker.** The manifest link and the touch icon
 *    point at files this build does not emit, and a service worker under a
 *    nested scope would cache a build somebody pinned once, in July, for as
 *    long as the browser felt like keeping it.
 * 4. **A budget.** Everything above is a way of spending the archive's size, so
 *    the size itself is asserted too — one number that fails if any of the
 *    reasons for it is quietly removed, including reasons nobody has thought of
 *    yet.
 *
 * Pure predicates over names, sizes and strings: the caller reads, this
 * decides. Each returns a list of human-readable problems, empty when there are
 * none — a boolean would say that something is wrong and not what.
 */

import { isDataFile } from './desktop-shape.mjs'

/**
 * What one archived build may weigh, in bytes.
 *
 * A build is ~5 MB, almost all of it the HDF5 chunk. The cap is generous
 * against that — it is not a diet, it is a tripwire — but it is far below the
 * ~19 MB a build with source maps weighs and nowhere near the ~258 MB one with
 * the demo data does, which are the two regressions it exists to catch.
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
export function pinnedFileProblems(files) {
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
      problems.push(`${file.name}: a service worker was emitted for an archived build`)
    } else if (base === 'manifest.webmanifest') {
      problems.push(`${file.name}: a web manifest was emitted; an archived build is not installable`)
    } else if (file.name.endsWith('.map')) {
      problems.push(`${file.name}: source maps are ~13 MB and are not archived`)
    } else if (file.name.split('/').includes('demo')) {
      problems.push(`${file.name}: the demo directory is data and is published once, at the site root`)
    } else if (isDataFile(base)) {
      problems.push(`${file.name}: a data file reached an archived build`)
    }
  }

  if (total > SIZE_LIMIT) {
    problems.push(
      `the build is ${mb(total)} against a ${mb(SIZE_LIMIT)} cap — ` +
        'twenty of these are published at once, inside a 1 GB Pages site',
    )
  }
  return problems
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * What is wrong with the built `index.html`, given the base it was built for.
 *
 * The positive assertion comes first and is the important one: a build that
 * emitted no module script at all would pass every negative check here.
 */
export function pinnedIndexProblems(html, base) {
  const problems = []
  if (!html.includes(`src="${base}assets/`)) {
    problems.push(
      `index.html has no module script under ${base} — the build used a different base, ` +
        'and every asset it asks for will 404',
    )
  }
  if (/<link\s[^>]*rel="manifest"/i.test(html)) {
    problems.push('index.html still links a web manifest; stripPwaTags() did not run')
  }
  if (/<link\s[^>]*rel="apple-touch-icon"/i.test(html)) {
    problems.push('index.html still links an apple-touch-icon; stripPwaTags() did not run')
  }
  // Anything root-absolute that is not under this build's own base belongs to
  // some other build. It resolves — that is the trouble — to the newest one.
  for (const match of html.matchAll(/\s(?:src|href)="(\/[^"]*)"/g)) {
    const url = match[1]
    if (!url.startsWith(base)) {
      problems.push(`index.html references ${url}, which is outside this build's base ${base}`)
    }
  }
  return problems
}
