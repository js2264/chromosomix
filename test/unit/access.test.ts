/**
 * The credentials that are not a bucket key (SPECS §23.7), and the one function
 * that puts them on a request.
 *
 * Three things are asserted here and each of them is a way the feature fails
 * *silently* if it is wrong:
 *
 * - **Which hosts get the key.** A credential sent to a host that did not ask
 *   for it is a credential published to that host, and nothing reports it — the
 *   request succeeds, because the extra header is ignored. So the boundary is
 *   pinned from both sides: the two Google endpoints that need it, and the GCS
 *   XML host beside one of them that does not.
 * - **Expiry.** A token that outlives its own `expiresAt` produces a `401` from
 *   a host that was working a minute ago, which reads as the file having gone
 *   away.
 * - **The merge order.** The signature must land on top of the static headers,
 *   because it is a statement about which headers were sent (`SignedHeaders`);
 *   a static header overwriting `Authorization` is a 403 whose cause is
 *   invisible from either end.
 *
 * And one about the boundary they cross: `withAccess` asks for the two
 * **independently**, so a source that already carries a bucket key still picks
 * up the header its host wants. An earlier draft returned as soon as it found
 * one, which would have left the key off exactly the sources that need both.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  accessHeadersFor,
  bearerFor,
  clearApiKey,
  clearBearer,
  readAccessRows,
  readApiKey,
  setBearer,
  writeApiKey,
} from '@/s3/credentials'
import { withAccess } from '@/s3/attach'
import { accessHeaders, applyAccess } from '@/sources/access'
import type { S3Credential } from '@/s3/sigv4'

const ACCESS = 'metacooler-viewer:access'
const DRIVE = 'https://www.googleapis.com/drive/v3/files/1Ab?alt=media&supportsAllDrives=true'
const GCS_JSON = 'https://storage.googleapis.com/storage/v1/b/lab/o/rep1.mcool?alt=media'
const GCS_XML = 'https://storage.googleapis.com/lab/rep1.mcool'

/** Every pattern any test here registers, cleared between them. */
const PATTERNS = ['*.googleapis.com', 'www.googleapis.com', 'data.example.org', '*']

beforeEach(() => {
  window.localStorage.clear()
  for (const pattern of PATTERNS) clearBearer(pattern)
})

afterEach(() => {
  window.localStorage.clear()
  for (const pattern of PATTERNS) clearBearer(pattern)
})

describe('the API key row', () => {
  it('round-trips through storage, and there is exactly one of it', async () => {
    expect(readApiKey()).toBeNull()
    writeApiKey('AIzaFIRST')
    expect(readApiKey()).toBe('AIzaFIRST')
    // Saving again replaces rather than appends: a reader who pastes a second
    // key means *this one now*, and a list would raise a question — which key
    // for which host — that the dialog has no way to ask.
    writeApiKey('AIzaSECOND')
    expect(readAccessRows()).toEqual([{ id: 'google-api-key', kind: 'google-api-key', key: 'AIzaSECOND' }])
  })

  it('trims, and treats an empty box as forgetting', () => {
    writeApiKey('  AIzaPADDED  ')
    expect(readApiKey()).toBe('AIzaPADDED')
    writeApiKey('   ')
    expect(readApiKey()).toBeNull()
    expect(window.localStorage.getItem(ACCESS)).toBeNull()
  })

  it('forgets on request', () => {
    writeApiKey('AIzaX')
    clearApiKey()
    expect(readApiKey()).toBeNull()
    expect(readAccessRows()).toEqual([])
  })

  it('drops a stored row that is not one, rather than repairing it', () => {
    // Stored state outlives the build that wrote it, exactly as a bucket scope
    // does. A row with an empty key would send `x-goog-api-key:` and get a 403
    // from Google naming the header, which looks exactly like a wrong key.
    window.localStorage.setItem(
      ACCESS,
      JSON.stringify([
        { id: 'a', kind: 'google-api-key', key: '' },
        { id: '', kind: 'google-api-key', key: 'AIzaX' },
        { id: 'c', kind: 'something-else', key: 'AIzaY' },
        'not an object',
        { id: 'd', kind: 'google-api-key', key: 'AIzaGOOD' },
      ]),
    )
    expect(readAccessRows()).toEqual([{ id: 'd', kind: 'google-api-key', key: 'AIzaGOOD' }])
  })

  it('answers nothing for a body that is not a list', () => {
    window.localStorage.setItem(ACCESS, '{"key":"AIzaX"}')
    expect(readAccessRows()).toEqual([])
    window.localStorage.setItem(ACCESS, 'not json')
    expect(readAccessRows()).toEqual([])
  })
})

describe('accessHeadersFor — which hosts get the key', () => {
  beforeEach(() => {
    writeApiKey('AIzaKEY')
  })

  it('sends it to the Drive API', () => {
    expect(accessHeadersFor(DRIVE)).toEqual({ 'x-goog-api-key': 'AIzaKEY' })
  })

  it('sends it to the GCS JSON API', () => {
    expect(accessHeadersFor(GCS_JSON)).toEqual({ 'x-goog-api-key': 'AIzaKEY' })
  })

  it('does not send it to the GCS XML host, which is a bucket scope’s base', () => {
    // Same host, different API. This one is signed with SigV4 when it is
    // private (§20.3) and a Google key means nothing to it.
    expect(accessHeadersFor(GCS_XML)).toEqual({})
  })

  it('does not send it anywhere else, which is every other file this app opens', () => {
    expect(accessHeadersFor('https://lab.s3.eu-west-3.amazonaws.com/x.cool')).toEqual({})
    expect(accessHeadersFor('https://bucket.example.org/Hum53.metacool')).toEqual({})
  })

  it('sends nothing when no key is stored', () => {
    clearApiKey()
    expect(accessHeadersFor(DRIVE)).toEqual({})
  })

  it('answers an empty bag for a string that is not a URL', () => {
    expect(accessHeadersFor('yeast.cool')).toEqual({})
  })
})

describe('bearer tokens', () => {
  const hour = () => Date.now() + 3_600_000

  it('matches a wildcard host pattern across the hosts one sign-in covers', () => {
    // One token, two hosts: Drive is `www.googleapis.com` and GCS is
    // `storage.googleapis.com`. Registering them one at a time would be two
    // places to forget the second.
    setToken('*.googleapis.com', 'ya29.TOKEN', hour())
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
    expect(bearerFor(GCS_JSON)).toBe('ya29.TOKEN')
    expect(bearerFor('https://lab.s3.amazonaws.com/x.cool')).toBeNull()
  })

  it('anchors the pattern at both ends', () => {
    setToken('*.googleapis.com', 'ya29.TOKEN', hour())
    // The reason this is a converted regex rather than an `endsWith`.
    expect(bearerFor('https://storage.googleapis.com.example.org/x')).toBeNull()
  })

  it('honours the expiry, and drops the entry as it finds it', () => {
    setToken('data.example.org', 'expired', Date.now() - 1)
    expect(bearerFor('https://data.example.org/x.cool')).toBeNull()
    // Asked again: still nothing, and now nothing is held either.
    expect(bearerFor('https://data.example.org/x.cool')).toBeNull()
  })

  it('is forgotten on request', () => {
    setToken('data.example.org', 'live', hour())
    expect(bearerFor('https://data.example.org/x.cool')).toBe('live')
    clearBearer('data.example.org')
    expect(bearerFor('https://data.example.org/x.cool')).toBeNull()
  })

  it('is never written to storage', () => {
    // The whole of why it is a registry and not a row: it expires inside the
    // session that obtained it, so storing it would buy nothing and would put a
    // secret on the disk that the stored-data screen cannot honestly account
    // for (SPECS §23.7).
    setToken('data.example.org', 'live', hour())
    expect(window.localStorage.length).toBe(0)
  })

  it('joins the API key on a host that wants both', () => {
    writeApiKey('AIzaKEY')
    setToken('*.googleapis.com', 'ya29.TOKEN', hour())
    expect(accessHeadersFor(DRIVE)).toEqual({
      'x-goog-api-key': 'AIzaKEY',
      Authorization: 'Bearer ya29.TOKEN',
    })
  })

  it('is matched case-insensitively, as a host is', () => {
    setToken('  *.GoogleAPIs.com  ', 'ya29.TOKEN', hour())
    expect(bearerFor('https://WWW.GOOGLEAPIS.COM/drive/v3/files/1Ab')).toBe('ya29.TOKEN')
  })

  /** Through the module's own entry point, so trimming and casing are exercised. */
  function setToken(pattern: string, token: string, expiresAt: number): void {
    setBearer(pattern, token, expiresAt)
  }
})

describe('withAccess — what is stamped on an outbound message', () => {
  const GOOGLE_SOURCE = { kind: 'remote', url: GCS_JSON }

  /** The stamped bag, off a source the message type does not describe. */
  const headersOf = (source: unknown): Record<string, string> | undefined =>
    (source as { headers?: Record<string, string> }).headers

  it('stamps the headers a URL wants, on the source and on its bins sidecar', () => {
    writeApiKey('AIzaKEY')
    const message = withAccess({
      kind: 'open',
      uri: GCS_JSON,
      source: { ...GOOGLE_SOURCE, bins: { kind: 'remote', url: DRIVE } },
    })
    // Independently, on their own URLs: `#bins=` exists precisely so the two
    // halves can live on unrelated hosts.
    expect(headersOf(message.source)).toEqual({ 'x-goog-api-key': 'AIzaKEY' })
    expect(headersOf((message.source as { bins: unknown }).bins)).toEqual({
      'x-goog-api-key': 'AIzaKEY',
    })
  })

  it('stamps headers on a source that already carries a credential', () => {
    // The bug the two-field shape exists to make impossible. An earlier draft
    // returned as soon as it found the outer source already signed, which would
    // have left the key off exactly the sources that carry both.
    writeApiKey('AIzaKEY')
    const credential: S3Credential = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'eu-west-3',
    }
    const message = withAccess({ kind: 'open', source: { ...GOOGLE_SOURCE, credential } })
    expect((message.source as { credential: S3Credential }).credential).toBe(credential)
    expect(headersOf(message.source)).toEqual({ 'x-goog-api-key': 'AIzaKEY' })
  })

  it('leaves a source that already carries headers exactly as it is', () => {
    writeApiKey('AIzaKEY')
    const source = { ...GOOGLE_SOURCE, headers: { 'x-goog-api-key': 'AIzaCHOSEN' } }
    expect(withAccess({ kind: 'open', source }).source).toBe(source)
  })

  it('returns the message itself when there is nothing to add', () => {
    // Every request in a session that has configured nothing: two reference
    // comparisons and no allocation.
    const message = { kind: 'open', source: { kind: 'remote', url: 'https://x.example/a.cool' } }
    expect(withAccess(message)).toBe(message)
  })
})

describe('applyAccess — the merge', () => {
  const credential: S3Credential = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'eu-west-3',
  }
  const url = 'https://lab.s3.eu-west-3.amazonaws.com/private/rep1.cool'

  it('carries the caller’s own headers under both', () => {
    // `generic-filehandle2` builds the `Range` for each read and hands it here;
    // losing it turns a bounded read into a download of the file.
    const init = applyAccess({ headers: { range: 'bytes=0-1023' } }, { url, headers: { 'x-goog-api-key': 'AIzaKEY' } })
    expect(init.headers).toEqual({ range: 'bytes=0-1023', 'x-goog-api-key': 'AIzaKEY' })
  })

  it('puts the signature on top of the static headers, never under them', () => {
    const headers = accessHeaders({
      url,
      method: 'GET',
      headers: { Authorization: 'Bearer SHOULD-NOT-WIN', 'x-goog-api-key': 'AIzaKEY' },
      credential,
    })
    expect(headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/)
    // The one that is not part of the signature survives beside it.
    expect(headers['x-goog-api-key']).toBe('AIzaKEY')
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it('signs the method the init names when the caller names none', () => {
    // The library that supplies the init also decided the method, and signing a
    // `GET` over a request that turns out to be a `HEAD` is a 403 with nothing
    // in it to read.
    const head = applyAccess({ method: 'HEAD' }, { url, credential })
    const get = applyAccess({ method: 'GET' }, { url, credential })
    expect((head.headers as Record<string, string>)['Authorization']).not.toBe(
      (get.headers as Record<string, string>)['Authorization'],
    )
  })

  it('lets an explicit method win over the init’s', () => {
    const named = applyAccess({ method: 'GET' }, { url, method: 'HEAD', credential })
    const plain = applyAccess({ method: 'HEAD' }, { url, credential })
    expect((named.headers as Record<string, string>)['Authorization']).toBe(
      (plain.headers as Record<string, string>)['Authorization'],
    )
  })

  it('reads a Headers object and an entry list, not only a record', () => {
    // A form this could not read would silently drop the caller's own headers.
    const fromHeaders = applyAccess({ headers: new Headers({ range: 'bytes=0-0' }) }, { url })
    expect(fromHeaders.headers).toEqual({ range: 'bytes=0-0' })
    const fromList = applyAccess({ headers: [['range', 'bytes=0-0']] }, { url })
    expect(fromList.headers).toEqual({ range: 'bytes=0-0' })
  })

  it('adds nothing at all when there is nothing to add', () => {
    // The public path, which is every demo: a range read with no headers is a
    // *simple* cross-origin request and costs no preflight.
    expect(applyAccess(undefined, { url }).headers).toEqual({})
    expect(accessHeaders({ url })).toEqual({})
  })

  it('keeps the rest of the init', () => {
    const init = applyAccess({ method: 'GET', redirect: 'follow' }, { url })
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('follow')
  })
})
