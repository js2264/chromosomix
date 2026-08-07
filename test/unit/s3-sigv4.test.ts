/**
 * The synchronous signer, against implementations that are not it.
 *
 * A signer is the worst kind of thing to test against itself: every part of it
 * is a hash of a hash, so a wrong answer looks exactly like a right one and the
 * only symptom in the field is a 403 with `SignatureDoesNotMatch` and no
 * indication of which of the six steps was wrong. So nothing here asserts a
 * value this repository produced.
 *
 * Three independent oracles:
 *
 * 1. **`node:crypto`** for the hashing, over random inputs at every length
 *    around the block boundary. That is where a hand-rolled SHA-256 goes wrong
 *    — the padding, and the two-word length — and it goes wrong for one input
 *    length in sixty-four, which a fixed vector will not find.
 * 2. **The published AWS vectors** for the derivation: the signing key and the
 *    signature from the SigV4 documentation's own worked example, which pins
 *    every step between the string to sign and the `Authorization` header.
 * 3. **A reimplementation from `node:crypto`** for whole requests, including
 *    the ones with characters in the key that `encodeURIComponent` disagrees
 *    with AWS about.
 */

import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { EMPTY_SHA256, hex, hmacSha256, sha256, utf8 } from '../../src/s3/sha256'
import { amzDate, forgetSigningKey, signS3Request } from '../../src/s3/sigv4'

/** A deterministic byte stream, so a failure is reproducible from its seed. */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    // xorshift32: no dependency, and the distribution does not matter here —
    // what matters is that it is not all zeros and not the same every length.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = state & 0xff
  }
  return out
}

describe('SHA-256', () => {
  it('agrees with node:crypto on the empty input', () => {
    expect(hex(sha256(new Uint8Array(0)))).toBe(createHash('sha256').digest('hex'))
    expect(hex(sha256(new Uint8Array(0)))).toBe(EMPTY_SHA256)
  })

  /**
   * Every length from 0 to 200, which straddles three block boundaries.
   *
   * The interesting lengths are 55, 56 and 64: at 56 the length field no longer
   * fits in the final block and the padding grows by a whole block. An
   * implementation that gets that wrong passes every test with a short fixed
   * input and fails on roughly one message in eight.
   */
  it('agrees with node:crypto at every length across the padding boundary', () => {
    for (let length = 0; length <= 200; length++) {
      const input = bytes(length, length + 1)
      expect(hex(sha256(input)), `length ${length}`).toBe(
        createHash('sha256').update(input).digest('hex'),
      )
    }
  })

  it('agrees with node:crypto on inputs spanning many blocks', () => {
    for (const length of [1000, 4096, 65_536]) {
      const input = bytes(length, length)
      expect(hex(sha256(input)), `length ${length}`).toBe(
        createHash('sha256').update(input).digest('hex'),
      )
    }
  })
})

describe('HMAC-SHA256', () => {
  /**
   * Keys shorter than, equal to and longer than the 64-byte block.
   *
   * All three are reachable from SigV4's own key derivation — `"AWS4" + secret`
   * is whatever length the secret is — and the long case is the one with a
   * separate code path, since the key is hashed before it is padded.
   */
  it('agrees with node:crypto across the key-length cases', () => {
    for (const keyLength of [0, 1, 32, 63, 64, 65, 128, 200]) {
      for (const dataLength of [0, 1, 55, 64, 100]) {
        const key = bytes(keyLength, keyLength + 7)
        const data = bytes(dataLength, dataLength + 11)
        expect(hex(hmacSha256(key, data)), `key ${keyLength}, data ${dataLength}`).toBe(
          createHmac('sha256', key).update(data).digest('hex'),
        )
      }
    }
  })
})

describe('the timestamp', () => {
  it('is YYYYMMDDTHHMMSSZ in UTC', () => {
    expect(amzDate(new Date(Date.UTC(2015, 7, 30, 12, 36, 0)))).toBe('20150830T123600Z')
  })

  it('pads every field', () => {
    expect(amzDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('20260102T030405Z')
  })

  it('reads the clock as UTC whatever the local zone is', () => {
    // A moment that is a different *day* in most of the world. Building the
    // stamp from local getters would put the wrong date in the credential
    // scope, which fails as `SignatureDoesNotMatch` rather than as a clock bug.
    expect(amzDate(new Date(Date.UTC(2026, 5, 1, 0, 30, 0)))).toBe('20260601T003000Z')
  })
})

/**
 * The worked example from AWS's own SigV4 documentation.
 *
 * These are the numbers every SDK is checked against. They pin the derivation
 * end to end: get any of the four HMACs wrong, or the service string, or the
 * terminator, and the key differs; get the canonical request or the string to
 * sign wrong and the signature differs while the key still matches.
 */
describe('the AWS documentation vectors', () => {
  const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'

  it('derives the documented signing key', () => {
    const dateKey = hmacSha256(utf8(`AWS4${SECRET}`), utf8('20150830'))
    const regionKey = hmacSha256(dateKey, utf8('us-east-1'))
    const serviceKey = hmacSha256(regionKey, utf8('iam'))
    const signing = hmacSha256(serviceKey, utf8('aws4_request'))
    expect(hex(signing)).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9')
  })

  it('produces the documented signature for the documented string to sign', () => {
    const dateKey = hmacSha256(utf8(`AWS4${SECRET}`), utf8('20150830'))
    const regionKey = hmacSha256(dateKey, utf8('us-east-1'))
    const serviceKey = hmacSha256(regionKey, utf8('iam'))
    const signing = hmacSha256(serviceKey, utf8('aws4_request'))
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/iam/aws4_request',
      'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
    ].join('\n')
    expect(hex(hmacSha256(signing, utf8(stringToSign)))).toBe(
      '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    )
  })
})

// ---------------------------------------------------------------------------
// Whole requests, against a second implementation
// ---------------------------------------------------------------------------

/**
 * SigV4 again, written against `node:crypto` and the spec text.
 *
 * Deliberately not sharing a line with the module under test — not its
 * encoder, not its header ordering, not its canonical path. Two implementations
 * agreeing is evidence; one implementation agreeing with itself is not.
 */
function referenceSignature(options: {
  method: string
  url: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
  timestamp: string
}): string {
  const url = new URL(options.url)
  const date = options.timestamp.slice(0, 8)
  const escape = (value: string): string =>
    value.replace(/[^A-Za-z0-9\-_.~]/g, (char) => {
      const encoded = Buffer.from(char, 'utf8')
      let out = ''
      for (const byte of encoded) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      return out
    })

  const path =
    url.pathname === ''
      ? '/'
      : url.pathname
          .split('/')
          .map((segment) => escape(decodeURIComponent(segment)))
          .join('/')

  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [escape(name), escape(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

  const headers: Array<[string, string]> = [
    ['host', url.host],
    ['x-amz-content-sha256', EMPTY_SHA256],
    ['x-amz-date', options.timestamp],
  ]
  if (options.sessionToken !== undefined) {
    headers.push(['x-amz-security-token', options.sessionToken])
  }
  const signedHeaders = headers.map(([name]) => name).join(';')
  const canonical = [
    options.method,
    path,
    query,
    `${headers.map(([name, value]) => `${name}:${value}`).join('\n')}\n`,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n')

  const scope = `${date}/${options.region}/s3/aws4_request`
  const toSign = [
    'AWS4-HMAC-SHA256',
    options.timestamp,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')

  const mac = (key: Buffer | string, data: string): Buffer =>
    createHmac('sha256', key).update(data).digest()
  const key = mac(
    mac(mac(mac(`AWS4${options.secretAccessKey}`, date), options.region), 's3'),
    'aws4_request',
  )
  return createHmac('sha256', key).update(toSign).digest('hex')
}

/** Pull the `Signature=` value out of an `Authorization` header. */
function signatureOf(headers: Record<string, string>): string {
  return /Signature=([0-9a-f]{64})$/.exec(headers['Authorization'])?.[1] ?? ''
}

describe('signing a request', () => {
  const CREDENTIAL = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'eu-west-3',
  }
  const NOW = new Date(Date.UTC(2026, 7, 7, 9, 30, 0))
  const TIMESTAMP = '20260807T093000Z'

  /**
   * The keys worth signing, and why each is here.
   *
   * The apostrophe and the parentheses are the ones `encodeURIComponent` leaves
   * alone and AWS does not, so a signer built on it straight signs a different
   * path than it sends. The space and the accent cover ordinary percent- and
   * UTF-8 encoding. The `..` segment covers S3's refusal to normalise a path
   * before signing it — every other AWS service does, and a signer that tidies
   * would be right everywhere but here.
   */
  const KEYS = [
    'collections/project-a/Hum53.metacool',
    "collections/o'brien/run 1/map.cool",
    'collections/(2026) draft/résumé.bw',
    'collections/a/../b/map.cool',
    'collections/plus+and=equals/x.cool',
    'collections/tilde~and-dash_dot./y.cool',
  ]

  for (const key of KEYS) {
    it(`matches an independent implementation for ${key}`, () => {
      forgetSigningKey()
      const url = `https://rsglab-data.s3.eu-west-3.amazonaws.com/${key}`
      const headers = signS3Request({ method: 'GET', url, credential: CREDENTIAL, now: NOW })
      expect(signatureOf(headers)).toBe(
        referenceSignature({ method: 'GET', url, ...CREDENTIAL, timestamp: TIMESTAMP }),
      )
    })
  }

  it('matches for a listing request, whose query string must be sorted', () => {
    forgetSigningKey()
    // Deliberately written out of order: `prefix` before `delimiter` before
    // `list-type` is insertion order, and byte order is the opposite. A signer
    // that trusted `URLSearchParams` iteration would pass every single-parameter
    // test above and fail exactly here.
    const url =
      'https://rsglab-data.s3.eu-west-3.amazonaws.com/' +
      '?prefix=collections%2F&delimiter=%2F&list-type=2&max-keys=1000'
    const headers = signS3Request({ method: 'GET', url, credential: CREDENTIAL, now: NOW })
    expect(signatureOf(headers)).toBe(
      referenceSignature({ method: 'GET', url, ...CREDENTIAL, timestamp: TIMESTAMP }),
    )
  })

  it('signs and sends a session token when the credential is a temporary one', () => {
    forgetSigningKey()
    const url = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/x.cool'
    const credential = { ...CREDENTIAL, sessionToken: 'FQoGZXIvYXdzEExample//////wEaDA' }
    const headers = signS3Request({ method: 'GET', url, credential, now: NOW })
    expect(headers['x-amz-security-token']).toBe(credential.sessionToken)
    expect(headers['Authorization']).toContain('x-amz-security-token')
    expect(signatureOf(headers)).toBe(
      referenceSignature({ method: 'GET', url, ...credential, timestamp: TIMESTAMP }),
    )
  })

  it('leaves the token out entirely when there is not one', () => {
    forgetSigningKey()
    const headers = signS3Request({
      method: 'GET',
      url: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/a.cool',
      credential: { ...CREDENTIAL, sessionToken: '' },
      now: NOW,
    })
    // An empty token signed as a header is not the same request as no token,
    // and S3 rejects the first. The empty string reaches here from a form field
    // the user left blank, so it is the likely case rather than an exotic one.
    expect(headers['x-amz-security-token']).toBeUndefined()
    expect(headers['Authorization']).not.toContain('x-amz-security-token')
  })

  /**
   * `host` is in the signature and not in the output.
   *
   * Both halves matter and they fail differently: dropping it from the
   * signature is a mismatch on every request, and returning it makes the
   * browser throw when the caller tries to set a forbidden header.
   */
  it('signs host without returning it', () => {
    const headers = signS3Request({
      method: 'GET',
      url: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/a.cool',
      credential: CREDENTIAL,
      now: NOW,
    })
    expect(headers['Authorization']).toContain('SignedHeaders=host;')
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('host')
  })

  it('carries the credential scope in the Authorization header', () => {
    const headers = signS3Request({
      method: 'GET',
      url: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/a.cool',
      credential: CREDENTIAL,
      now: NOW,
    })
    expect(headers['Authorization']).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20260807/eu-west-3/s3/aws4_request',
    )
    expect(headers['x-amz-date']).toBe(TIMESTAMP)
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA256)
  })

  /**
   * The cached signing key is keyed on what it was derived from.
   *
   * The cache exists because the derivation is four HMACs on a path that runs
   * thousands of times a session. It would be a serious bug if editing a
   * credential — or reading a second bucket in another region — were answered
   * from the previous entry: every request would be signed with the old key and
   * fail, and the only way back would be a reload.
   */
  it('does not answer a different secret or region from the cache', () => {
    forgetSigningKey()
    const url = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/a.cool'
    const first = signS3Request({ method: 'GET', url, credential: CREDENTIAL, now: NOW })
    const otherSecret = signS3Request({
      method: 'GET',
      url,
      credential: { ...CREDENTIAL, secretAccessKey: 'a-completely-different-secret' },
      now: NOW,
    })
    const otherRegion = signS3Request({
      method: 'GET',
      url,
      credential: { ...CREDENTIAL, region: 'us-east-1' },
      now: NOW,
    })
    expect(signatureOf(otherSecret)).not.toBe(signatureOf(first))
    expect(signatureOf(otherRegion)).not.toBe(signatureOf(first))
    // And back again: the first credential must still sign the way it did, or
    // the cache is not a cache but a one-shot.
    expect(
      signatureOf(signS3Request({ method: 'GET', url, credential: CREDENTIAL, now: NOW })),
    ).toBe(signatureOf(first))
  })

  it('signs a new key once the date rolls over', () => {
    forgetSigningKey()
    const url = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/a.cool'
    const before = signS3Request({
      method: 'GET',
      url,
      credential: CREDENTIAL,
      now: new Date(Date.UTC(2026, 7, 7, 23, 59, 59)),
    })
    const after = signS3Request({
      method: 'GET',
      url,
      credential: CREDENTIAL,
      now: new Date(Date.UTC(2026, 7, 8, 0, 0, 1)),
    })
    expect(after['Authorization']).toContain('/20260808/')
    expect(before['Authorization']).toContain('/20260807/')
    expect(signatureOf(after)).not.toBe(signatureOf(before))
  })
})
