/**
 * The one place a credential is attached to an outbound worker message.
 *
 * Remote sources are constructed all over the main thread — the URL box, the
 * compare card, a session config being resolved, a track row being restored
 * from storage, the examples list. Making each of those look up a key would be
 * a dozen call sites that have to remember to, and the one that forgot would
 * present as a single private track failing while the rest of the session
 * worked.
 *
 * So none of them do. They build a plain `{ kind: 'remote', url }` exactly as
 * before, and the credential is stamped on at the boundary the message crosses
 * — `worker/client.ts` and `annotations/worker/client.ts`, one `postMessage`
 * each. That is also the last moment the answer can be right: a key edited
 * after a track was constructed is picked up, because the lookup happens when
 * the request goes out rather than when the object was made.
 *
 * The two worker protocols disagree about almost everything and agree about
 * this: the field is called `source`, it is a discriminated union, and the
 * remote arm has a `url`. That is all this needs to know, which is why one
 * function serves both.
 */

import { credentialFor } from './credentials'
import type { S3Credential } from './sigv4'

/** The shape both protocols' remote arm shares. */
interface Remoteish {
  kind: string
  url?: unknown
  credential?: S3Credential
  /**
   * The sidecar half of a two-file format, when the source has one.
   *
   * Only a HiC-Pro matrix carries this today: the counts are in one file and
   * the bin coordinates in another, and `#bins=` names the second (§3.9). It is
   * a source in its own right, under its own key, and that is the whole reason
   * it needs its own line below.
   */
  bins?: Remoteish
}

/**
 * That source with a credential on it, or the same object when none applies.
 *
 * Split out of {@link withCredential} because a source can carry a second
 * source, and both have to be asked separately rather than the outer one
 * standing for the pair.
 *
 * A source that already carries a credential is left exactly as it is: a caller
 * that knows its own — the bucket browser opening a file it just listed — must
 * not have it replaced by a lookup that could, in principle, resolve
 * differently.
 */
function signed(source: Remoteish): Remoteish {
  if (source.kind !== 'remote' || typeof source.url !== 'string') return source
  if (source.credential !== undefined) return source
  const credential = credentialFor(source.url)
  return credential === null ? source : { ...source, credential }
}

/**
 * `message`, with a credential on its source — and on that source's sidecar.
 *
 * Returns the message untouched — the same object, not a copy — when there is
 * nothing to add, which is every request in a session that has configured no
 * buckets. The common path allocates nothing and reads `localStorage` only when
 * the message actually carries a remote URL.
 *
 * ## Why the sidecar is asked separately
 *
 * This used to stamp `message.source` and stop, and it returned early the
 * moment the outer source was already signed or was not remote. A HiC-Pro pair
 * is one source with another inside it, so both guards were wrong for it: the
 * matrix went out signed and **the bin file went out bare**, and the half
 * carrying every coordinate came back 403 while the half carrying the counts
 * arrived. What that looks like from the outside is a private matrix that opens
 * and then fails to be a matrix, which names neither file.
 *
 * The two halves are looked up **independently**, on their own URLs, because
 * `#bins=` exists precisely so the two can live under unrelated keys — a
 * matrix in one prefix and a shared bin grid in another is the arrangement the
 * fragment was added for. Signing the second with the first's key would be a
 * request scoped to a bucket it is not for.
 *
 * `app/Session.ts` also stamps the bins as it builds them, which is not
 * redundant: this is the last moment the answer can be right, so a key added
 * *after* a pair was opened is picked up here on the next request. The two
 * compose safely — {@link signed} declines to touch a source that already
 * carries a credential, so whichever runs first wins and neither overwrites the
 * other.
 */
export function withCredential<T>(message: T): T {
  if (typeof message !== 'object' || message === null) return message
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return message
  const remote = source as Remoteish

  const outer = signed(remote)
  const sidecar =
    typeof remote.bins === 'object' && remote.bins !== null ? signed(remote.bins) : undefined

  // Identity, not deep equality: `signed` returns its argument unchanged when
  // it has nothing to add, so an untouched pair is two reference comparisons
  // and no allocation at all.
  const outerSame = outer === remote
  const sidecarSame = sidecar === undefined || sidecar === remote.bins
  if (outerSame && sidecarSame) return message

  return {
    ...message,
    source: sidecarSame ? outer : { ...outer, bins: sidecar },
  }
}
