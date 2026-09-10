// @vitest-environment jsdom
/**
 * Signing the *second* half of a HiC-Pro pair (§3.9).
 *
 * A HiC-Pro matrix is half a contact map: without the `_abs.bed` beside it
 * there are no coordinates at all. So a pair in a private bucket has to be read
 * with two signed requests, and it was being read with one. Everywhere else in
 * this app a credential is stamped at the worker boundary (`s3/attach.ts`), and
 * that boundary knows only `message.source` — it has never looked at the
 * `bins` hanging off it. The matrix went out signed, the bin file went out with
 * `headers: {}`, and S3 answered 403 to the half that carries the coordinates.
 *
 * What makes it worth a file of its own is that the *guessed* road already
 * worked: `probeBins` hands the matrix's credential to the conventional
 * `<prefix>_<res>_abs.bed` it finds (`worker/open.ts`). So the escape hatch —
 * `#bins=`, which exists precisely for a bucket that publishes the two halves
 * under unrelated keys — was the one road that failed, on exactly the
 * arrangement it was added for.
 *
 * The cases below are the two halves of getting that right: the named bin file
 * is signed, and it is signed with **its own** key. A bed outside every scope
 * stays unsigned, because a public request that gets signed anyway is the
 * failure this repo guards hardest against (`test/unit/s3-buckets.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { withHicProBins } from '@/app/Session'
import { withCredential } from '@/s3/attach'
import { writeScopes, type BucketScope } from '@/s3/credentials'
import type { S3Credential } from '@/s3/sigv4'
import type { SourceSpec } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
  teardown()
})

const HOST = 'https://lab.s3.eu-west-3.amazonaws.com'
const MATRIX = `${HOST}/private/hicpro/s_10000.matrix`
const BINS = `${HOST}/private/beds/s_10000_abs.bed`
/** What a reader pastes: the pair as one shareable string (§11). */
const URI = `${MATRIX}#bins=${BINS}`

function scope(overrides: Partial<BucketScope> = {}): BucketScope {
  return {
    id: 'b0',
    label: 'lab private',
    base: `${HOST}/private/`,
    region: 'eu-west-3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    ...overrides,
  }
}

/** What the URL box hands over: no credential, by design (`ui/FilePicker.ts`). */
const typed = (uri: string): SourceSpec => ({ kind: 'remote', url: uri })

/** The bin file's arm of the spec, in the shape the assertions below read. */
function binsOf(spec: SourceSpec): { kind: string; url?: string; credential?: S3Credential } {
  expect(spec.bins).toBeDefined()
  return spec.bins as { kind: string; url?: string; credential?: S3Credential }
}

describe('a bin file named on the URL', () => {
  it('is signed with the key that covers it', () => {
    writeScopes([scope()])
    const bins = binsOf(withHicProBins(URI, typed(URI)))
    expect(bins.url).toBe(BINS)
    expect(bins.credential?.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE')
  })

  /**
   * The whole point of the fragment, and the case the old code broke.
   *
   * `#bins=` is the escape hatch for a bucket whose two halves live under
   * unrelated keys, so the bed's key is looked up on the bed's URL rather than
   * inherited from the matrix. Inheriting would sign a request to a prefix that
   * never granted one.
   */
  it('is signed with its own key, not the matrix key', () => {
    writeScopes([
      scope(),
      scope({ id: 'b1', label: 'lab beds', base: `${HOST}/beds/`, accessKeyId: 'AKIABEDS' }),
    ])
    const uri = `${MATRIX}#bins=${HOST}/beds/s_10000_abs.bed`
    expect(binsOf(withHicProBins(uri, typed(uri))).credential?.accessKeyId).toBe('AKIABEDS')
  })

  it('stays unsigned when no scope covers it', () => {
    writeScopes([scope()])
    const uri = `${MATRIX}#bins=${HOST}/public/s_10000_abs.bed`
    expect(binsOf(withHicProBins(uri, typed(uri))).credential).toBeUndefined()
  })

  it('stays unsigned in a session with no buckets at all', () => {
    const bins = binsOf(withHicProBins(URI, typed(URI)))
    expect(bins.url).toBe(BINS)
    expect(bins.credential).toBeUndefined()
  })

  /**
   * The matrix half is still the boundary's job.
   *
   * Its credential is looked up when the message goes out, so a key added after
   * the source was built is picked up. Nothing here should pre-empt that.
   */
  it('leaves the matrix half for the worker boundary to stamp', () => {
    writeScopes([scope()])
    const spec = withHicProBins(URI, typed(URI))
    expect(spec.kind).toBe('remote')
    expect((spec as { credential?: S3Credential }).credential).toBeUndefined()
  })

  /** A dropped bed is bytes in hand; there is nothing to sign. */
  it('does not touch a bin file that was dropped alongside', () => {
    writeScopes([scope()])
    const bins = binsOf(withHicProBins(URI, typed(URI), new File([''], 's_10000_abs.bed')))
    expect(bins.kind).toBe('local')
    expect(bins.credential).toBeUndefined()
  })
})

describe('the message that reaches the worker', () => {
  /**
   * Both halves signed, which is the failure end to end: this is the message
   * `worker/client.ts` posts, and `binsFor` hands its `bins` arm straight to
   * `readWhole`, which sends `headers: {}` for a spec with no credential.
   */
  it('carries a credential on the matrix and on its bin file', () => {
    writeScopes([scope()])
    const message = withCredential({
      kind: 'open',
      uri: URI,
      source: withHicProBins(URI, typed(URI)),
    })
    const source = message.source as SourceSpec & { credential?: S3Credential }
    expect(source.credential?.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE')
    expect(binsOf(source).credential?.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE')
    // The fragment is stripped from the source and kept on the URI, so the two
    // signatures are over the two real keys.
    expect((source as { url: string }).url).toBe(MATRIX)
    expect(message.uri).toBe(URI)
  })
})
