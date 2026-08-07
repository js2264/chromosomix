/**
 * The bucket store, the boundary that stamps a key onto a request, and the
 * listing parser.
 *
 * These three are where a signer that is *correct* still fails to be *useful*:
 * the signature can be perfect and the wrong key can be chosen for the URL, or
 * the right key can be chosen and never reach the worker that does the reading,
 * or the listing can come back and be parsed into URLs that 404. None of that is
 * visible from `s3-sigv4.test.ts`, which only ever asks whether a given
 * credential signs a given URL correctly.
 *
 * The failure this file exists for, above all the others: **a public request
 * that gets signed anyway.** The demo bucket is read with no credential, and a
 * scope-matching bug that widened `collections/` to the whole bucket would send
 * an `Authorization` header with every demo read — turning each into a
 * preflight, and failing outright against a key scoped the way the dialog tells
 * users to scope it. It would look like "the demos broke" and be a matching bug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addressOf,
  credentialFor,
  normaliseBase,
  readScopes,
  scopeFor,
  writeScopes,
  type BucketScope,
} from '../../src/s3/credentials'
import { withCredential } from '../../src/s3/attach'
import { listPrefix } from '../../src/s3/list'

/** A `localStorage` that behaves, since the node test runtime has none. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => void store.set(key, value),
      removeItem: (key: string): void => void store.delete(key),
    },
  })
  return store
}

const PUBLIC = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_ATAC.bw'
const PRIVATE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/hum53/map.mcool'

function scope(overrides: Partial<BucketScope> = {}): BucketScope {
  return {
    id: 'b0',
    label: 'lab collections',
    base: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/',
    region: 'eu-west-3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    ...overrides,
  }
}

describe('normalising a prefix', () => {
  it('adds the trailing slash a prefix comparison depends on', () => {
    expect(normaliseBase('https://b.s3.eu-west-3.amazonaws.com/collections')).toBe(
      'https://b.s3.eu-west-3.amazonaws.com/collections/',
    )
  })

  it('assumes https for a bare host, since a bucket URL has no other scheme', () => {
    expect(normaliseBase('b.s3.eu-west-3.amazonaws.com/x')).toBe(
      'https://b.s3.eu-west-3.amazonaws.com/x/',
    )
  })

  it('drops a pasted query string and fragment', () => {
    expect(normaliseBase('https://b.s3.amazonaws.com/x/?versionId=3#frag')).toBe(
      'https://b.s3.amazonaws.com/x/',
    )
  })

  /**
   * `http://` is refused rather than upgraded.
   *
   * Over plain HTTP the `Authorization` header — a live SigV4 signature over
   * that exact request — crosses the wire readable. Silently rewriting the
   * scheme would also mean the app deciding which host the user meant, and
   * `https://internal-host/` may simply not exist.
   */
  it('refuses http, and does not quietly upgrade it', () => {
    expect(normaliseBase('http://b.s3.amazonaws.com/x/')).toBeNull()
  })

  it('refuses what is not a URL at all', () => {
    expect(normaliseBase('')).toBeNull()
    expect(normaliseBase('   ')).toBeNull()
    expect(normaliseBase('not a url')).toBeNull()
  })
})

describe('the stored scopes', () => {
  beforeEach(() => installStorage())
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips what was written', () => {
    writeScopes([scope()])
    expect(readScopes()).toEqual([scope()])
  })

  it('is empty before anything is stored', () => {
    expect(readScopes()).toEqual([])
  })

  /**
   * Stored state outlives the build that wrote it, so every row is untrusted.
   *
   * A row repaired rather than dropped would be a scope signing with a blank
   * secret: a 403 on every request under a prefix, with a dialog on screen
   * showing an entry that looks complete.
   */
  it('drops a row missing anything the signature needs', () => {
    const good = scope({ id: 'keep' })
    installStorage().set(
      'metacooler-viewer:buckets',
      JSON.stringify([
        good,
        { ...scope({ id: 'no-secret' }), secretAccessKey: '' },
        { ...scope({ id: 'no-region' }), region: '' },
        { ...scope({ id: 'no-key' }), accessKeyId: '' },
        { ...scope({ id: 'no-base' }), base: 'not a url' },
        { ...scope({ id: 'http-base' }), base: 'http://b.s3.amazonaws.com/x/' },
        'not an object',
        null,
      ]),
    )
    expect(readScopes().map((entry) => entry.id)).toEqual(['keep'])
  })

  it('survives storage holding something that is not JSON', () => {
    installStorage().set('metacooler-viewer:buckets', '{oh no')
    expect(readScopes()).toEqual([])
  })

  it('keeps only the first of two rows sharing an id', () => {
    installStorage().set(
      'metacooler-viewer:buckets',
      JSON.stringify([scope({ label: 'first' }), scope({ label: 'second' })]),
    )
    expect(readScopes().map((entry) => entry.label)).toEqual(['first'])
  })
})

describe('choosing a key for a URL', () => {
  /**
   * The one that matters most: a public URL gets no key.
   *
   * Signing it would work against a bucket-wide key and fail against the
   * prefix-scoped key the dialog asks for — and would add a preflight to every
   * one of the demo reads either way.
   */
  it('leaves a public prefix unsigned even when the same bucket has a key', () => {
    expect(credentialFor(PUBLIC, [scope()])).toBeNull()
  })

  it('signs a URL under the scope', () => {
    expect(credentialFor(PRIVATE, [scope()])?.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE')
  })

  it('carries the region and the session token into the credential', () => {
    const credential = credentialFor(PRIVATE, [scope({ sessionToken: 'tok' })])
    expect(credential?.region).toBe('eu-west-3')
    expect(credential?.sessionToken).toBe('tok')
  })

  it('omits the token entirely when the scope has none', () => {
    expect(credentialFor(PRIVATE, [scope()])).not.toHaveProperty('sessionToken')
  })

  /**
   * A narrower scope inside a wider one wins.
   *
   * This is what lets a per-project key with tighter IAM permissions sit inside
   * a general lab key without either being edited — and getting it backwards
   * would silently use the broad key for a project that has its own.
   */
  it('prefers the longest matching prefix', () => {
    const wide = scope({ id: 'wide', accessKeyId: 'WIDE' })
    const narrow = scope({
      id: 'narrow',
      accessKeyId: 'NARROW',
      base: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/hum53/',
    })
    // Both orders, because "longest wins" must not be "last one in the array".
    expect(credentialFor(PRIVATE, [wide, narrow])?.accessKeyId).toBe('NARROW')
    expect(credentialFor(PRIVATE, [narrow, wide])?.accessKeyId).toBe('NARROW')
  })

  /**
   * A sibling prefix that shares a leading substring is not a match.
   *
   * `collections/` and `collections-public/` differ by a character that a
   * `startsWith` on the path without the trailing slash would not notice, and
   * the mistake sends a private key to a public prefix.
   */
  it('does not match a prefix that merely starts the same way', () => {
    const url = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections-public/x.cool'
    expect(scopeFor(url, [scope()])).toBeNull()
  })

  it('does not match a different bucket on the same provider', () => {
    const url = 'https://other-bucket.s3.eu-west-3.amazonaws.com/collections/x.cool'
    expect(scopeFor(url, [scope()])).toBeNull()
  })
})

describe('stamping a worker message', () => {
  beforeEach(() => installStorage())
  afterEach(() => vi.unstubAllGlobals())

  it('adds the credential to a remote source under a scope', () => {
    writeScopes([scope()])
    const message = withCredential({ kind: 'open', uri: PRIVATE, source: { kind: 'remote', url: PRIVATE } })
    expect(message.source).toHaveProperty('credential')
  })

  it('leaves a public source alone', () => {
    writeScopes([scope()])
    const source = { kind: 'remote', url: PUBLIC }
    const message = withCredential({ kind: 'open', uri: PUBLIC, source })
    expect(message.source).not.toHaveProperty('credential')
    // The same object, not a copy: the common path must not allocate.
    expect(message.source).toBe(source)
  })

  it('leaves a local source alone', () => {
    writeScopes([scope()])
    const source = { kind: 'local', file: {} }
    expect(withCredential({ kind: 'open', uri: 'x', source }).source).toBe(source)
  })

  it('passes through a message with no source at all', () => {
    writeScopes([scope()])
    const message = { kind: 'cancel', target: 3 }
    expect(withCredential(message)).toBe(message)
  })

  /**
   * A caller that already knows its key keeps it.
   *
   * The bucket browser opens a file with the credential of the scope it was
   * listed under. A second lookup would find the same one today, and would be a
   * different answer the moment two scopes overlap — so the file a user reached
   * *through* a key is opened with that key.
   */
  it('does not replace a credential the caller supplied', () => {
    writeScopes([scope()])
    const message = withCredential({
      kind: 'open',
      uri: PRIVATE,
      source: { kind: 'remote', url: PRIVATE, credential: { accessKeyId: 'MINE' } },
    })
    expect((message.source as { credential: { accessKeyId: string } }).credential.accessKeyId).toBe(
      'MINE',
    )
  })
})

describe('taking a bucket URL apart', () => {
  it('reads a virtual-hosted URL, where the whole path is key', () => {
    expect(addressOf('https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/')).toEqual({
      endpoint: 'https://rsglab-data.s3.eu-west-3.amazonaws.com',
      bucket: 'rsglab-data',
      prefix: 'collections/',
    })
  })

  it('reads the region-less virtual-hosted form', () => {
    expect(addressOf('https://rsglab-data.s3.amazonaws.com/x/')?.bucket).toBe('rsglab-data')
  })

  it('reads a path-style URL, where the first segment is the bucket', () => {
    expect(addressOf('https://minio.lab.internal/rsglab-data/collections/')).toEqual({
      endpoint: 'https://minio.lab.internal',
      bucket: 'rsglab-data',
      prefix: 'collections/',
    })
  })

  it('reads a path-style URL naming only a bucket', () => {
    expect(addressOf('https://minio.lab.internal/rsglab-data/')).toEqual({
      endpoint: 'https://minio.lab.internal',
      bucket: 'rsglab-data',
      prefix: '',
    })
  })
})

describe('listing a prefix', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>rsglab-data</Name>
  <Prefix>collections/</Prefix>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes><Prefix>collections/hum53/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>collections/hum66/</Prefix></CommonPrefixes>
  <Contents><Key>collections/</Key><Size>0</Size></Contents>
  <Contents><Key>collections/notes.txt</Key><Size>124</Size></Contents>
  <Contents><Key>collections/ChIP_H3K4me3_&amp;_input.bw</Key><Size>2048</Size></Contents>
</ListBucketResult>`

  function respondWith(body: string, status = 200): typeof fetch {
    return (async () =>
      new Response(body, { status, statusText: status === 200 ? 'OK' : 'Forbidden' })) as never
  }

  it('separates folders from files', async () => {
    const listing = await listPrefix(scope(), 'collections/', { fetchImpl: respondWith(XML) })
    expect(listing.folders.map((folder) => folder.name)).toEqual(['hum53', 'hum66'])
    expect(listing.objects.map((object) => object.name)).toEqual([
      'notes.txt',
      'ChIP_H3K4me3_&_input.bw',
    ])
    expect(listing.truncated).toBe(false)
  })

  /**
   * The prefix itself comes back as a zero-byte key when someone made the
   * "folder" through the S3 console. It is not a file, and listing it as one
   * produces a row that opens nothing.
   */
  it('drops the placeholder key S3 returns for a console-made folder', async () => {
    const listing = await listPrefix(scope(), 'collections/', { fetchImpl: respondWith(XML) })
    expect(listing.objects.map((object) => object.key)).not.toContain('collections/')
  })

  /**
   * An ampersand in a key is escaped in the XML and must not stay escaped.
   *
   * `ChIP_H3K4me3_&_input.bw` is an ordinary name off a run sheet. Left as
   * `&amp;` it produces a URL that 404s while reading correctly in the list —
   * the worst combination, since the row looks right.
   */
  it('resolves XML entities in a key, and builds a URL that keeps them', async () => {
    const listing = await listPrefix(scope(), 'collections/', { fetchImpl: respondWith(XML) })
    const object = listing.objects[1]
    expect(object.key).toBe('collections/ChIP_H3K4me3_&_input.bw')
    expect(object.url).toBe(
      'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/ChIP_H3K4me3_%26_input.bw',
    )
  })

  it('reports truncation rather than drawing a partial folder silently', async () => {
    const listing = await listPrefix(scope(), 'collections/', {
      fetchImpl: respondWith(XML.replace('<IsTruncated>false', '<IsTruncated>true')),
    })
    expect(listing.truncated).toBe(true)
  })

  it('signs the listing request', async () => {
    let seen: Record<string, string> = {}
    await listPrefix(scope(), 'collections/', {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>
        return new Response(XML, { status: 200 })
      }) as never,
    })
    expect(seen['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//)
    expect(seen).toHaveProperty('x-amz-date')
  })

  it('asks S3 to do the grouping, so one request draws one level', async () => {
    let seen = ''
    await listPrefix(scope(), 'collections/hum53/', {
      fetchImpl: (async (url: string) => {
        seen = url
        return new Response(XML, { status: 200 })
      }) as never,
    })
    const query = new URL(seen).searchParams
    expect(query.get('list-type')).toBe('2')
    expect(query.get('delimiter')).toBe('/')
    expect(query.get('prefix')).toBe('collections/hum53/')
  })

  /**
   * A 403 on a listing is its own diagnosis.
   *
   * `s3:ListBucket` and `s3:GetObject` are different permissions, and a key
   * with only the second is a perfectly sensible key that simply cannot browse.
   * Reported as a generic failure it reads as "the bucket is broken", and the
   * user stops using a key that still opens every file they paste.
   */
  it('says what a refused listing actually means', async () => {
    await expect(
      listPrefix(scope(), 'collections/', { fetchImpl: respondWith('', 403) }),
    ).rejects.toThrow(/s3:ListBucket/)
  })

  it('names the preflight when the request never got a status at all', async () => {
    await expect(
      listPrefix(scope(), 'collections/', {
        fetchImpl: (() => Promise.reject(new TypeError('Failed to fetch'))) as never,
      }),
    ).rejects.toThrow(/AllowedOrigins/)
  })
})
