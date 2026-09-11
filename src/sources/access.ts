/**
 * Everything a request for a remote byte needs on it, in one place.
 *
 * There are two of these things and they are not alike (SPECS §23.7). A bucket
 * key **signs**: the headers it produces are computed per request, over the
 * method and a timestamp S3 refuses more than fifteen minutes old, so they cannot
 * be worked out once and kept. An API key or a bearer token is **static**: the
 * same header on every request for that URL, decided on the main thread where the
 * storage is and carried to the worker on the message that opens the file.
 *
 * They compose in one order and only one: the static bag first, the signature
 * over it. A signature is a statement about a specific set of headers
 * (`SignedHeaders` in `s3/sigv4.ts`), and letting a static header land on top of
 * `Authorization` would produce a request whose signature covers a different
 * request than the one sent — a 403 whose cause is invisible from either side.
 * The one line of merge order below is why this is a module and not four copies:
 * there are six places a remote request is made in this repository and they were
 * already four different spellings of the same three lines.
 *
 * Both halves are optional and the common path has neither: a public object on a
 * public bucket is read with no headers at all, which is what every demo does and
 * what keeps a range read a *simple* cross-origin request.
 */

import { signS3Request, type S3Credential } from '../s3/sigv4'

/** What this URL needs, and which request is being made for it. */
export interface Access {
  /** The absolute URL the request goes to. Signed over, so it must be exact. */
  url: string
  /** Defaults to the init's own method, then to `GET`. */
  method?: string
  /**
   * Static headers for this URL — an API key, a bearer token — as decided by
   * `s3/credentials.ts`'s `accessHeadersFor` on the main thread.
   */
  headers?: Record<string, string>
  /** The bucket key that signs this request, for a private prefix. */
  credential?: S3Credential
}

/**
 * The headers to put on this request, static ones then the signature.
 *
 * Returned as a plain record rather than applied, for `signS3Request`'s own
 * reason: the callers apply them three ways — `xhr.setRequestHeader`, a `fetch`
 * init, and `generic-filehandle2`'s header bag — and a function that took a
 * request object would have to know which of the three it had. {@link applyAccess}
 * is the second of those three, written once here because it is the one two
 * unrelated workers both need.
 */
export function accessHeaders(access: Access): Record<string, string> {
  const headers: Record<string, string> = { ...access.headers }
  if (access.credential === undefined) return headers
  return {
    ...headers,
    ...signS3Request({
      method: (access.method ?? 'GET').toUpperCase(),
      url: access.url,
      credential: access.credential,
    }),
  }
}

/**
 * `init` with this URL's access headers merged into it.
 *
 * The init's own headers go **under** both, which is the order the one caller
 * that has any needs: `generic-filehandle2` builds the `Range` for each read and
 * hands it here, and a `Range` must not displace an `Authorization`. It is also
 * the safe order in general — the argument this function exists to settle is
 * about authorisation, and authorisation wins.
 *
 * The init's `method` is what gets signed when the caller did not name one,
 * because the library that supplies the init is also the thing that decided the
 * method, and signing a `GET` over a request that turns out to be a `HEAD` is a
 * 403 with nothing in it to read.
 */
export function applyAccess(init: RequestInit | undefined, access: Access): RequestInit {
  const method = access.method ?? methodOf(init)
  return {
    ...init,
    headers: {
      ...headerRecord(init?.headers),
      ...accessHeaders({ ...access, method }),
    },
  }
}

function methodOf(init: RequestInit | undefined): string {
  const method = init?.method
  return typeof method === 'string' && method !== '' ? method : 'GET'
}

/**
 * A `HeadersInit` as the record the merge above spreads.
 *
 * All three forms, because this is handed whatever a library built: the record
 * every caller in this repository writes, the `Headers` object `fetch` itself
 * produces, and the entry array. A form this cannot read would silently drop the
 * caller's own headers, which for `generic-filehandle2` is the `Range` — the one
 * header whose loss turns a bounded read into a download of the file.
 */
function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((value, name) => {
      out[name] = value
    })
    return out
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...(headers as Record<string, string>) }
}
