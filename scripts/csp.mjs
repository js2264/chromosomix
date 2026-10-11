/**
 * The Content-Security-Policy every web build carries, the one the single-file
 * build computes over itself, and the rules a built page is checked against.
 *
 * One file, because the policy is a string three Vite configs write and three
 * shape checks read (`check-pinned-build.mjs`, `check-package-build.mjs`,
 * `check-standalone-build.mjs`, through their `*-shape.mjs`), and a test holds
 * it besides: a policy written into a config and copied into a checker is two
 * policies, and the day they differ the checker passes the build it was
 * written to refuse. Plain JavaScript for the reason `pwa-tags.mjs` is — a
 * build input that needed compiling first would be a bootstrapping problem.
 *
 * ## Why a `<meta>`, where the desktop sends a header
 *
 * The desktop build delivers its policy as a response header and says why a
 * meta is not equivalent (`electron/protocol.cts`). Every argument there is
 * true here, and none of them can be acted on: GitHub Pages sends no header a
 * site chooses, and neither does a registry CDN serving the package or the lab
 * server it is unpacked onto. A meta is the only policy a static page can carry,
 * so this is that, with its two costs written down rather than discovered:
 *
 * - **It does not reach the workers.** A module worker served from the site's
 *   own origin takes its policy from its own response, which carries none — so
 *   the reader, annotation and analysis workers run unpoliced however strict
 *   this is. What is policed is the document: everything parsed into it,
 *   every script it loads and everything it fetches itself — a `?config=`
 *   workspace, a store's catalog, a folder listing.
 * - **It cannot say `frame-ancestors`**, and must not try: a meta that does has
 *   it ignored, with a console line saying so. These builds would leave it out
 *   anyway. An embed is a frame in somebody else's page (§21), and a policy
 *   deciding who may frame the viewer is a policy against its own third surface.
 *
 * ## What it allows, and why each
 *
 * - **`script-src 'self' 'wasm-unsafe-eval'`**, as on the desktop: h5wasm and
 *   the correlation kernel compile WebAssembly from bytes, and without the
 *   keyword every file open fails with a `CompileError` raised far from here.
 *   No `'unsafe-inline'`: the built document carries no inline script, which
 *   {@link webCspProblems} asserts, because one appearing would be refused.
 * - **Google Identity Services**, exactly the sources Google documents for it:
 *   its client script, its stylesheet, its frames and its endpoints. The script
 *   is fetched on a sign-in click and on no other occasion (§24.7). When it
 *   loads it also writes an inline `<style>` of button styles, which this
 *   refuses with one console line — and loses nothing by refusing, since the
 *   token client the app uses draws no button. Allowing it by hash would pin
 *   the policy to a script Google changes without telling anybody.
 * - **`style-src 'self'`**, and no `'unsafe-inline'`, because the tree sets
 *   styles through the CSSOM, which a policy does not govern, and writes no
 *   `style=` — the chart tooltips that did were given markup of their own for
 *   this reason (`src/figures/tooltip.ts`).
 * - **`img-src 'self' data: blob:`**: the mark beside the app's name, and the
 *   favicon, the cursors and the store logos, which are all data URIs.
 * - **`connect-src 'self' https:` and plain HTTP to `localhost`.** Remote files
 *   are the whole remote half of the app and live on whatever host a reader
 *   names; a dev server or a local object store serves over plain HTTP, which a
 *   page on `https:` may still reach on the loopback address.
 * - **`worker-src 'self'`**: the four workers and the service worker are files
 *   beside the page. None is built from a `blob:` URL in these builds; the
 *   single file is the one that does, and it has a policy of its own below.
 * - **`manifest-src 'self'`**, for the install prompt; the pinned and package
 *   builds strip the manifest link, and a source allowed for nothing costs
 *   nothing.
 * - **`object-src`, `base-uri` and `form-action` are `'none'`**: no plugin, no
 *   `<base>`, and no form — there is no `<form>` in the tree, and a box that
 *   acts on Enter does so in a key handler — so each is a door kept shut
 *   rather than one in use.
 *
 * Everything else falls to `default-src 'none'`, so a new kind of request is
 * refused until somebody decides to allow it — on their own page, with the
 * directive named in the console, rather than in the field.
 */

import { createHash } from 'node:crypto'

/** The web builds' policy, one directive per entry so a test can ask about each. */
export const WEB_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
  "style-src 'self' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // `https:` already admits Google's endpoint; it is named anyway, so that the
  // four sources Google documents read as one set and survive a narrowing of
  // the clause beside them.
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* https://accounts.google.com/gsi/",
  "worker-src 'self'",
  "frame-src https://accounts.google.com/gsi/",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

/** The web builds' policy, as the meta carries it. */
export const WEB_CSP = WEB_CSP_DIRECTIVES.join('; ')

/**
 * The tag, written once.
 *
 * Refuses a policy that would not survive a double-quoted attribute: every
 * source expression is quoted with `'`, so a `"` or a `<` in one is a mistake
 * in the policy rather than something to escape.
 */
export function cspMetaTag(policy) {
  if (/["<>&]/.test(policy)) throw new Error(`a policy cannot be written into a meta: ${policy}`)
  return `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
}

const CHARSET = /<meta\s+charset=["']?utf-8["']?\s*\/?>/i
const POLICY_META = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]*)"\s*\/?>/gi

/**
 * The page, with the policy as the first thing after its encoding.
 *
 * **Before everything it governs**, which is the whole of the placement rule: a
 * meta policy applies only to what the parser meets after it, so a policy below
 * a `<script>` polices nothing that script did. Immediately after the charset,
 * which has to stay inside the first kilobyte and is the one tag that must not
 * be pushed down.
 *
 * Throws rather than returning the page unchanged, on the two shapes that would
 * otherwise produce a page with no policy or with two: no charset to anchor on,
 * and a policy already there. Two policies are not a choice — the browser
 * enforces both, so the stricter wins clause by clause and the result is a
 * policy nobody wrote.
 */
export function withCsp(html, policy) {
  if (cspOf(html).length > 0) {
    throw new Error('the page already carries a Content-Security-Policy, and a second would be enforced beside it')
  }
  const charset = CHARSET.exec(html)
  if (charset === null) {
    throw new Error('the page has no <meta charset="utf-8"> to put its Content-Security-Policy after')
  }
  const at = charset.index + charset[0].length
  return `${html.slice(0, at)}\n    ${cspMetaTag(policy)}${html.slice(at)}`
}

/** Every policy a page carries in a meta, in document order. */
export function cspOf(html) {
  return [...html.matchAll(POLICY_META)].map((match) => match[1])
}

/**
 * A page's inline scripts and stylesheets, as the parser will hand them to the
 * policy.
 *
 * One pass over both, each match consuming its whole element, because the
 * single file's script is fourteen megabytes of JavaScript that contains the
 * strings `<style` and `<script` — scanned for separately, a `<style` inside
 * the script would be taken for an element. Inside an inlined body neither
 * closing tag can occur (`vite.standalone.config.ts` escapes both), so the
 * first closing tag after an opening one is its own.
 */
export function inlineElements(html) {
  const scripts = []
  const styles = []
  for (const match of html.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const [, tag, attributes, body] = match
    if (tag.toLowerCase() === 'style') styles.push(body)
    else if (!/\ssrc\s*=/i.test(attributes)) scripts.push(body)
  }
  return { scripts, styles }
}

/**
 * The `'sha256-…'` source a policy names an inline element by.
 *
 * Over the text as the **parser** hands it over, which is not quite the text in
 * the file: the input stream turns every CR LF and lone CR into LF before
 * tokenising, and a NUL inside a script or a stylesheet becomes U+FFFD. A hash
 * of the file's bytes would differ from the browser's on either, and the
 * element would be refused with no other symptom than a blank page.
 */
export function hashSource(body) {
  const parsed = body.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD')
  return `'sha256-${createHash('sha256').update(parsed, 'utf8').digest('base64')}'`
}

/**
 * The single file's policy, computed over the page it is for.
 *
 * A `file://` page can be sent no header, and a `'self'` policy would refuse
 * the very scripts the build inlined, so the page names its own: the hash of
 * each inline script and stylesheet, and nothing else. Workers come only from
 * `blob:`, which is how this build constructs them — and a worker built from a
 * blob URL inherits this policy, so here, unlike on the site, the workers are
 * policed too.
 *
 * `connect-src data:` makes §19's *no network at all* a rule the browser
 * enforces rather than a consequence of an opaque origin: nothing in the page
 * or its workers can reach a host, post a beacon or open a socket. The one
 * source it names is for a worker, and reaches nothing: the bigWig and bigBed
 * reader (`@gmod/bbi`) carries its inflate wasm as a `data:application/wasm`
 * URL and *fetches* it before its first read. Under `'none'` that fetch was
 * refused inside the annotations worker, where the page hears nothing of it,
 * and every bigWig lane said "fetching…" for good. A `data:` URL is its own
 * content; there is no server on the other end of one.
 */
export function standaloneCsp(html) {
  const { scripts, styles } = inlineElements(html)
  return [
    "default-src 'none'",
    `script-src ${[...scripts.map(hashSource), "'wasm-unsafe-eval'"].join(' ')}`,
    `style-src ${styles.length > 0 ? styles.map(hashSource).join(' ') : "'none'"}`,
    'img-src data: blob:',
    'connect-src data:',
    'worker-src blob:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** The single file, with the policy computed over it. */
export function withStandaloneCsp(html) {
  return withCsp(html, standaloneCsp(html))
}

/**
 * Where a page's one policy is, and what is wrong with it being there.
 *
 * Shared by both checks below: exactly one policy, and ahead of every element
 * it is meant to govern.
 */
function placementProblems(html) {
  const policies = cspOf(html)
  if (policies.length === 0) {
    return { policy: null, problems: ['index.html carries no Content-Security-Policy'] }
  }
  const problems = []
  if (policies.length > 1) {
    problems.push(
      `index.html carries ${policies.length} Content-Security-Policy metas, which the browser enforces together`,
    )
  }
  const meta = html.search(new RegExp(POLICY_META.source, 'i'))
  const governed = html.search(/<(?:script|style|link)\b/i)
  if (governed >= 0 && governed < meta) {
    problems.push(
      'the Content-Security-Policy comes after an element it governs — a meta polices only what the parser meets after it',
    )
  }
  return { policy: policies[0], problems }
}

/**
 * What is wrong with a web build's page, as far as its policy goes.
 *
 * Its policy has to be {@link WEB_CSP} and nothing else, ahead of everything it
 * governs — and the page has to be one that policy lets run. An inline script,
 * a `<style>` element or a `style=` attribute is refused by the browser with
 * nothing on screen to say so, so the build refuses it first.
 */
export function webCspProblems(html) {
  const { policy, problems } = placementProblems(html)
  if (policy !== null && policy !== WEB_CSP) {
    problems.push(`index.html carries a Content-Security-Policy other than the web builds' own: ${policy}`)
  }
  const { scripts, styles } = inlineElements(html)
  if (scripts.length > 0) problems.push('index.html has an inline <script>, which its policy refuses')
  if (styles.length > 0) problems.push('index.html has a <style> element, which its policy refuses')
  // Attribute values are emptied first: the favicon's data URI is a string of
  // SVG, and what matters is whether a *tag* carries the attribute.
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html.replace(/"[^"]*"/g, '""'))) {
    problems.push('index.html has a style= attribute, which its policy refuses')
  }
  return problems
}

/**
 * What is wrong with the single file's policy.
 *
 * Recomputed over the page this reads, so the check is the one that matters:
 * the policy names exactly the scripts and the stylesheet the page holds. A
 * page whose policy was computed before a last edit to it — another plugin
 * after this one, a hand fix to the file — names a hash nothing has, and its
 * one script is refused.
 */
export function standaloneCspProblems(html) {
  const { policy, problems } = placementProblems(html)
  if (policy === null) return problems
  const expected = standaloneCsp(html)
  if (policy !== expected) {
    problems.push(
      'the Content-Security-Policy does not name exactly the inline scripts and stylesheet this page holds, ' +
        `so what it does not name is refused: expected ${expected.slice(0, 160)}…`,
    )
  }
  return problems
}

/**
 * The web builds' policy as a Vite plugin: written into `index.html`, then
 * checked in the page the build actually emits.
 *
 * `apply: 'build'`, so `npm run dev` carries no policy: Vite's dev server
 * injects every stylesheet as a `<style>` element and talks to the page over a
 * websocket, and a second, looser policy kept for it would be one more to keep
 * in step with this one. A build is what is published, so a build is what is
 * policed — and `vite preview` serves one, policy included, for anybody who
 * wants to see it hold.
 *
 * The check runs again on the emitted page rather than trusting the transform,
 * for the reason `webCspProblems` exists: what arrives in `index.html` after
 * this plugin — a tag another plugin injects, an inline script a later Vite
 * writes — is refused by the browser silently, and refused here out loud.
 */
export function cspMeta() {
  return {
    name: 'chromosomix-csp-meta',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return withCsp(html, WEB_CSP)
      },
    },
    generateBundle(_options, bundle) {
      const page = bundle['index.html']
      if (page === undefined || page.type !== 'asset') {
        this.error('the build emitted no index.html to carry its Content-Security-Policy')
        return
      }
      const problems = webCspProblems(String(page.source))
      if (problems.length > 0) this.error(`index.html breaks its own policy:\n  ${problems.join('\n  ')}`)
    },
  }
}
