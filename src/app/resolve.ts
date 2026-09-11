/**
 * How to obtain the bytes behind a URI — asked three ways, on purpose.
 *
 * There used to be one function for this, `inferSource`, and six callers. They
 * looked like six askings of one question and they are not: two of them gate a
 * **write to the URL hash**, one runs inside a synchronous repaint, and three
 * want bytes. Collapsing them onto one async resolver would have been the
 * obvious refactor and would have broken the first two in ways nothing would
 * have reported.
 *
 * So:
 *
 * | | asks | answers |
 * |---|---|---|
 * | {@link inferSource} | "can **anybody** open this?" | sync, remote-only |
 * | {@link mayResolve} | "would it be worth asking?" | sync, from a snapshot |
 * | {@link resolveSource} | "give me the bytes" | async, remote **or** a grant |
 *
 * ## Why `inferSource` must stay exactly what it was
 *
 * It is the **shareability** test. `Session` calls it before writing `uri2` into
 * the view state and before accepting one out of it, and the hash is a public
 * artifact: it goes into links, into the address bar, and through
 * `state/shareLink.ts` into something a reader sends a colleague. A local file
 * name in there is a private filename posted to a stranger — which
 * `shareLink.shortenable` already refuses to do — and a recipient's deck would
 * try to *fetch* it, relative to the site root on the web and against
 * `app://viewer/` in the desktop build.
 *
 * A remembered grant does not change that. This browser being able to reopen
 * `rep1.cool` says nothing about anybody else's, so the hash gates keep asking
 * the question they have always asked, and the answer is still no.
 *
 * ## Why `mayResolve` is separate, and synchronous
 *
 * `Session.tabHint` is a getter, read in a loop by `App.paintTabs` on every
 * state change. Making it async would make the tab strip repaint a frame late
 * and flicker while a reader drags a colour slider. It reads a set hydrated at
 * boot instead, so a tab can say *"remembered — click to reopen"* rather than
 * *"drop the same file again"* without waiting for storage.
 */

import { canonicalUrl } from '../sources/rewrite'
import { hasHandle, resolveHandle } from '../state/handles'
import { splitUri } from '../ui/labels'
import type { SourceSpec } from '../worker/protocol'

/**
 * Work out how to obtain the bytes for a URI that arrived **in a link**.
 *
 * A remote URL is re-openable from the hash alone; a local file is not — no
 * browser re-reads a dropped file without another gesture, which is a privacy
 * property rather than a limitation (§11). Returning `null` sends the user to
 * the picker with an explanation.
 *
 * ## Canonicalised first, and the test itself is untouched
 *
 * `sources/rewrite.ts` runs before the `https?:` test rather than after it, and
 * that ordering is the whole of what changed here (SPECS §24.5). The test still
 * asks *can anybody open this*, and still answers it about an `http(s)` URL
 * alone; what moved is that `gs://bucket/file.mcool` and `s3://bucket/file.cool`
 * now **are** such a URL by the time it is asked. Both were already admitted by
 * `state/shareLink.ts`'s `openableElsewhere` as addresses that mean the same
 * thing in anybody's browser, which is the same question from the other side, so
 * this closes a disagreement rather than widening a gate: a scheme that could
 * travel in a link could not be opened out of one.
 *
 * A local file name is unchanged by the rewrite table and still answers `null`,
 * which is the property this function exists for and the one its tests pin.
 */
export function inferSource(uri: string): SourceSpec | null {
  const path = canonicalUrl(splitUri(uri).path)
  return /^https?:\/\//i.test(path) ? { kind: 'remote', url: path } : null
}

/**
 * `true` when {@link resolveSource} has some chance of answering.
 *
 * A guess, deliberately: the grant may since have been revoked and the file may
 * have been deleted, neither of which is knowable without asking. It is used
 * only to choose the *wording* of a tooltip and a note, where being optimistic
 * costs a reader one click and being pessimistic costs them the feature.
 */
export function mayResolve(uri: string): boolean {
  return inferSource(uri) !== null || hasHandle(uri)
}

/**
 * The bytes, or `null`.
 *
 * Remote first, because that path touches no storage and is what every demo,
 * every published session and every shared link takes.
 *
 * `prompt` may only be `true` inside a user gesture — a click, a key. Without
 * transient activation the permission request resolves without ever showing a
 * dialog, so passing it from a boot path would silently leave every remembered
 * file unopened and look exactly like the feature not working.
 */
export async function resolveSource(
  uri: string,
  options: { prompt?: boolean } = {},
): Promise<SourceSpec | null> {
  const remote = inferSource(uri)
  if (remote !== null) return remote
  const file = await resolveHandle(uri, options)
  return file === null ? null : { kind: 'local', file }
}
