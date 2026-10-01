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
  credentialOf,
  isSigned,
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
/** The other half of a HiC-Pro pair, under the same private scope. */
const BINS = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/hum53/map_abs.bed'

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

  it('takes an s3:// prefix, on the bucket’s own endpoint when the region is known', () => {
    // How a bucket is written everywhere but a browser; the same prefix as the
    // https form, and the https form is what is stored.
    expect(normaliseBase('s3://my-lab/hic')).toBe('https://my-lab.s3.amazonaws.com/hic/')
    expect(normaliseBase('s3://my-lab/hic/', { region: 'eu-west-3' })).toBe(
      'https://my-lab.s3.eu-west-3.amazonaws.com/hic/',
    )
    expect(normaliseBase('s3://my-lab', { region: ' ' })).toBe('https://my-lab.s3.amazonaws.com/')
    expect(normaliseBase('s3://')).toBeNull()
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

  /**
   * A row with **no** key half is a public prefix and is kept.
   *
   * The rule is all three or none, and the middle is what gets dropped: a scope
   * holding an access key and no secret cannot sign, and *falling back* to an
   * unsigned request would turn a mistyped secret into a bucket that 403s on
   * data the reader believes they have a key for — attributing the failure to
   * the bucket rather than to the field two lines up.
   */
  it('keeps a row with no key at all, and still drops a half-filled one', () => {
    installStorage().set(
      'metacooler-viewer:buckets',
      JSON.stringify([
        { id: 'public', label: 'demos', base: 'https://b.s3.amazonaws.com/demo/' },
        { id: 'half', label: 'oops', base: 'https://b.s3.amazonaws.com/x/', region: 'eu-west-3' },
        scope({ id: 'signed' }),
      ]),
    )
    expect(readScopes().map((entry) => entry.id)).toEqual(['public', 'signed'])
    expect(isSigned(readScopes()[0])).toBe(false)
    expect(isSigned(readScopes()[1])).toBe(true)
  })

  it('round-trips a public scope without inventing a key half', () => {
    const open: BucketScope = { id: 'p0', label: 'demos', base: 'https://b.s3.amazonaws.com/demo/' }
    writeScopes([open])
    expect(readScopes()).toEqual([open])
    expect(credentialOf(readScopes()[0])).toBeNull()
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

  /**
   * A HiC-Pro pair is one source carrying another, and both have to be asked.
   *
   * This used to stamp `message.source` and stop, so the matrix went out signed
   * and the bin file went out bare: a 403 on the half carrying every
   * coordinate, while the half carrying the counts arrived. From the outside
   * that is a private matrix that opens and then fails to be a matrix, naming
   * neither file.
   */
  it('signs the bin file beside the matrix it belongs to', () => {
    writeScopes([scope()])
    const message = withCredential({
      kind: 'open',
      uri: PRIVATE,
      source: {
        kind: 'remote',
        url: PRIVATE,
        bins: { kind: 'remote', url: BINS },
      },
    })
    const source = message.source as { credential?: unknown; bins: { credential?: unknown } }
    expect(source.credential, 'the matrix').toBeDefined()
    expect(source.bins.credential, 'the bin file').toBeDefined()
  })

  /**
   * `#bins=` exists so the two halves can live under unrelated keys, so each is
   * looked up on its own URL. Signing the bin file with the matrix's key would
   * scope a request to a bucket it is not for.
   */
  it('signs the bin file even when the matrix is public', () => {
    writeScopes([scope()])
    const message = withCredential({
      kind: 'open',
      uri: PUBLIC,
      source: { kind: 'remote', url: PUBLIC, bins: { kind: 'remote', url: BINS } },
    })
    const source = message.source as { credential?: unknown; bins: { credential?: unknown } }
    expect(source.credential, 'the public matrix').toBeUndefined()
    expect(source.bins.credential, 'the private bin file').toBeDefined()
  })

  it('leaves a bin file the caller already signed', () => {
    writeScopes([scope()])
    const message = withCredential({
      kind: 'open',
      uri: PRIVATE,
      source: {
        kind: 'remote',
        url: PRIVATE,
        bins: { kind: 'remote', url: BINS, credential: { accessKeyId: 'MINE' } },
      },
    })
    const bins = (message.source as { bins: { credential: { accessKeyId: string } } }).bins
    expect(bins.credential.accessKeyId).toBe('MINE')
  })

  it('allocates nothing when neither half needs a key', () => {
    writeScopes([scope()])
    const source = { kind: 'remote', url: PUBLIC, bins: { kind: 'remote', url: PUBLIC } }
    const message = { kind: 'open', uri: PUBLIC, source }
    // The same object, not a copy — the guard that keeps the common path free.
    expect(withCredential(message)).toBe(message)
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

  /**
   * The prefix comes back as a **key**, not as the URL path it was cut from.
   *
   * `normaliseBase` stores what the reader typed as `url.href`, so a space in
   * the folder name is `%20` from that point on. Handed straight to
   * `listPrefix` that string is encoded a second time and S3 is asked for keys
   * beginning with the literal text `Hi-C%20runs/` — which nothing is. The
   * answer is a 200 with an empty `ListBucketResult`, so a bucket full of files
   * draws as an empty folder with no error anywhere to act on. Everything
   * below is that one bug seen from a different character.
   */
  it('decodes the key prefix, since S3 matches keys and not URL paths', () => {
    expect(addressOf('https://rsglab-data.s3.eu-west-3.amazonaws.com/Hi-C%20runs/')?.prefix).toBe(
      'Hi-C runs/',
    )
  })

  /**
   * Non-ASCII is the likelier way to meet this than a space: a `données/`
   * folder is an ordinary thing on a lab bucket, and `URL` escapes it to
   * `donn%C3%A9es/` without anyone typing an escape.
   */
  it('decodes a non-ASCII prefix', () => {
    expect(addressOf('https://rsglab-data.s3.eu-west-3.amazonaws.com/donn%C3%A9es/')?.prefix).toBe(
      'données/',
    )
  })

  /** Path-style splits the bucket off first, so the decode reaches only the key. */
  it('decodes the key half of a path-style URL and leaves the bucket alone', () => {
    expect(addressOf('https://minio.lab.internal/rsglab-data/Hi-C%20runs/')).toEqual({
      endpoint: 'https://minio.lab.internal',
      bucket: 'rsglab-data',
      prefix: 'Hi-C runs/',
    })
  })

  /**
   * A `+` in a key is a `+`, and decoding must not read it as a space.
   *
   * `+` means space in a *query string*, never in a path, and a key such as
   * `runs+extra/` is left alone by `URL` precisely because of that. Unescaping
   * with anything query-flavoured would rename the folder to `runs extra/` and
   * list nothing — the same empty panel, arrived at from the opposite mistake.
   */
  it('leaves a plus in a key as a plus, not a space', () => {
    expect(addressOf('https://rsglab-data.s3.eu-west-3.amazonaws.com/runs+extra/')?.prefix).toBe(
      'runs+extra/',
    )
  })

  /**
   * A literal `%` is legal in a key and survives `URL` unescaped, so decoding
   * it throws. Losing the whole address to that would take out browsing for a
   * bucket that lists perfectly well, so the offending segment is kept as it
   * came and its neighbours are still decoded.
   */
  it('keeps a segment that is not valid escaping, rather than losing the address', () => {
    expect(addressOf('https://minio.lab.internal/rsglab-data/Hi-C%20runs/100%_reads/')).toEqual({
      endpoint: 'https://minio.lab.internal',
      bucket: 'rsglab-data',
      prefix: 'Hi-C runs/100%_reads/',
    })
  })

  /** Plain ASCII round-trips, which is why the demo scopes never showed this. */
  it('leaves a prefix that needs no escaping untouched', () => {
    expect(addressOf('https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/')?.prefix).toBe(
      'collections/',
    )
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

  /**
   * A public prefix is listed with **no headers at all**, and that is not a
   * detail.
   *
   * An unsigned `GET` carrying no custom header is a *simple* CORS request, so
   * the browser does not preflight it — which means the ordinary public-data
   * policy (`GET`, `HEAD`, `Range`) answers it as it stands. Add one header here
   * and every public bucket in the world starts needing a CORS change before it
   * can be browsed, and the failure would arrive as an opaque `TypeError` with
   * nothing naming the cause.
   */
  it('sends a public listing unsigned, with no headers to preflight', async () => {
    let seen: Record<string, string> = { sentinel: 'unset' }
    const open: BucketScope = {
      id: 'p0',
      label: 'demos',
      base: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/',
    }
    await listPrefix(open, 'demo/', {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>
        return new Response(XML, { status: 200 })
      }) as never,
    })
    expect(Object.keys(seen)).toEqual([])
  })

  /**
   * And the 403 it gets says which of the two grants is missing.
   *
   * A bucket published for downloads grants `s3:GetObject` to `*` and stops
   * there, so "cannot list" is the *normal* state of a public bucket rather than
   * a fault — and with no backend (C1) there is nothing the app can do but say
   * so accurately and point at the URL box.
   */
  it('blames the bucket policy, not a key, when a public listing is refused', async () => {
    const open: BucketScope = {
      id: 'p0',
      label: 'demos',
      base: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/',
    }
    await expect(
      listPrefix(open, 'demo/', { fetchImpl: respondWith('<Error/>', 403) }),
    ).rejects.toThrow(/anonymous listing.*s3:ListBucket.*bucket policy/s)
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
   * The whole road from a typed URL to the wire, for a prefix that needs
   * escaping.
   *
   * `bucketFolder` starts a browse at `addressOf(base).prefix`, so this is the
   * first request a reader makes after adding such a bucket. Asserting the
   * *decoded* query parameter is the point: `Hi-C%20runs/` on the wire would
   * read back as `Hi-C%20runs/` here, and only `Hi-C runs/` means S3 was asked
   * for the folder that exists.
   */
  it('sends the root prefix of an escaped base as the key S3 stores', async () => {
    const base = normaliseBase('https://rsglab-data.s3.eu-west-3.amazonaws.com/Hi-C runs')
    expect(base).toBe('https://rsglab-data.s3.eu-west-3.amazonaws.com/Hi-C%20runs/')
    const escaped = scope({ base: base as string })
    let seen = ''
    await listPrefix(escaped, addressOf(escaped.base)?.prefix ?? '', {
      fetchImpl: (async (url: string) => {
        seen = url
        return new Response(XML, { status: 200 })
      }) as never,
    })
    expect(new URL(seen).searchParams.get('prefix')).toBe('Hi-C runs/')
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

  /**
   * And names `AllowedHeaders`, which is the setting that is actually wrong.
   *
   * The message used to send the reader to `AllowedOrigins` and tell them `*`
   * could not answer a "credentialed" request. It can: credentialed means
   * cookies, and there are none here — `Authorization` is set from script like
   * any other header. Following that advice narrows the origin list, changes
   * nothing, and leaves the one broken line untouched.
   */
  it('names the preflight when the request never got a status at all', async () => {
    await expect(
      listPrefix(scope(), 'collections/', {
        fetchImpl: (() => Promise.reject(new TypeError('Failed to fetch'))) as never,
      }),
    ).rejects.toThrow(/AllowedHeaders/)
  })

  /**
   * And every one of them is plain text (§26.4).
   *
   * They are drawn as DOM text, in the Files column and the Connect dialog,
   * where nothing renders Markdown: backticks round `s3:ListBucket` were two
   * stray marks either side of the very word a reader copies into a policy.
   */
  it('writes its refusals without Markdown, the names in them bare', async () => {
    const open: BucketScope = {
      id: 'p0',
      label: 'demos',
      base: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/',
    }
    const refused = (): Promise<never> => Promise.reject(new TypeError('Failed to fetch'))
    const messages: string[] = []
    for (const [target, fetchImpl] of [
      [open, respondWith('<Error/>', 403)],
      [scope(), respondWith('', 403)],
      [open, refused],
      [scope(), refused],
    ] as const) {
      await listPrefix(target, 'collections/', { fetchImpl: fetchImpl as never }).catch((err: unknown) =>
        messages.push(err instanceof Error ? err.message : String(err)),
      )
    }
    expect(messages).toHaveLength(4)
    for (const message of messages) expect(message).not.toContain('`')
    expect(messages[0]).toContain('s3:ListBucket')
    expect(messages[3]).toContain('AllowedHeaders')
  })
})
