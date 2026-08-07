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
}

/**
 * `message`, with a credential on its source if one covers that URL.
 *
 * Returns the message untouched — the same object, not a copy — when there is
 * nothing to add, which is every request in a session that has configured no
 * buckets. The common path allocates nothing and reads `localStorage` only when
 * the message actually carries a remote URL.
 */
export function withCredential<T>(message: T): T {
  if (typeof message !== 'object' || message === null) return message
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return message
  const remote = source as Remoteish
  if (remote.kind !== 'remote' || typeof remote.url !== 'string') return message
  // Already stamped: a caller that knows its own credential — the bucket
  // browser opening a file it just listed — must not have it replaced by a
  // lookup that could, in principle, resolve differently.
  if (remote.credential !== undefined) return message
  const credential = credentialFor(remote.url)
  if (credential === null) return message
  return { ...message, source: { ...remote, credential } }
}
