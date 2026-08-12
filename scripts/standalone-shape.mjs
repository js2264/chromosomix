/**
 * What a standalone build must look like, as rules a test can hold.
 *
 * Split from the check that walks the directory for the reason
 * `pinned-shape.mjs` and `desktop-shape.mjs` are: the rules are the interesting
 * part and they should be assertable without running a build.
 *
 * Every rule here exists because its failure is **silent**. A standalone HTML
 * that references a sibling file opens, paints its shell, and then does nothing
 * — no error dialog, no console anybody is looking at. A build that kept the
 * module worker format opens and looks completely normal until a file is
 * dropped on it. The only cheap moment to notice either is the build.
 */

/** Bytes over which the file stops being something anybody will email. */
export const STANDALONE_MAX_BYTES = 24 * 1024 * 1024

/**
 * Bytes under which it cannot possibly be the whole app.
 *
 * h5wasm alone is over four megabytes, so anything near this is a build whose
 * inlining silently did nothing — which otherwise looks like a successful build
 * producing a small, tidy file.
 */
export const STANDALONE_MIN_BYTES = 4 * 1024 * 1024

/**
 * Everything wrong with the HTML, as sentences.
 *
 * All of them, never just the first: an operator has to fix every one, and a
 * check that names one of four turns one build into four.
 */
export function standaloneIndexProblems(html) {
  const problems = []

  // 1. Nothing may be fetched. A `file://` page has an opaque origin, so every
  //    one of these is a request that fails and a feature that is missing.
  const externalScript = /<script[^>]*\ssrc=/i.exec(html)
  if (externalScript !== null) {
    problems.push(
      `an external <script src> survived inlining: ${externalScript[0].slice(0, 90)} — a file:// ` +
        'page cannot fetch it, so the app will not start',
    )
  }
  const externalStyle = /<link[^>]*rel=["']?stylesheet/i.exec(html)
  if (externalStyle !== null) {
    problems.push(`an external stylesheet survived inlining: ${externalStyle[0].slice(0, 90)}`)
  }

  // 2. A root-absolute reference resolves to the *filesystem root* on a
  //    file:// page, which is both broken and slightly alarming.
  for (const match of html.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)) {
    problems.push(`a root-absolute reference has no meaning from a disk: ${match[1]}`)
  }

  // 3. The PWA tags point into a `public/` this target does not emit.
  if (/<link rel="manifest"/i.test(html)) problems.push('the web manifest link was not stripped')
  if (/rel="apple-touch-icon"/i.test(html)) problems.push('the apple-touch-icon link was not stripped')

  // 4. A module worker cannot be constructed from an opaque origin. Vite spells
  //    the option `{type:"module"}` in its emitted worker constructor, so its
  //    presence means `worker.format` was left at `es` and the app has an
  //    interface with no reader behind it.
  if (/new Worker\([^)]*\{\s*type:\s*["']module["']/.test(html)) {
    problems.push(
      'a module worker construction survived — set `worker: { format: "iife" }`, or the reader ' +
        'never starts from a file:// page',
    )
  }

  // 5. The app has to be in there. `createObjectURL` is how an inlined worker is
  //    constructed, so its absence means the workers were emitted as files.
  if (!html.includes('createObjectURL')) {
    problems.push(
      'no blob-URL worker construction found — the workers were probably emitted as sibling ' +
        'files rather than inlined (`?worker&inline`)',
    )
  }

  // 6. The build must know which target it is, or the interface will offer the
  //    remote affordances that cannot work.
  if (!html.includes('standalone')) {
    problems.push('the build does not identify itself as the standalone target')
  }

  return problems
}

/** Everything wrong with the directory the build produced. */
export function standaloneFileProblems(files) {
  const problems = []
  const names = files.map((file) => file.path)

  if (!names.includes('index.html')) {
    problems.push('index.html is missing')
    return problems
  }
  const extra = names.filter((name) => name !== 'index.html')
  if (extra.length > 0) {
    // The whole promise of the target, stated as a rule. One file, or it is not
    // a file somebody can email.
    problems.push(`the build is not one file; it also emitted: ${extra.join(', ')}`)
  }

  const index = files.find((file) => file.path === 'index.html')
  if (index !== undefined) {
    if (index.size > STANDALONE_MAX_BYTES) {
      problems.push(
        `index.html is ${mb(index.size)}, past the ${mb(STANDALONE_MAX_BYTES)} ceiling — ` +
          'something is being inlined that should not be',
      )
    }
    if (index.size < STANDALONE_MIN_BYTES) {
      problems.push(
        `index.html is only ${mb(index.size)}; h5wasm alone is over four, so the inlining did ` +
          'not happen',
      )
    }
  }
  return problems
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
