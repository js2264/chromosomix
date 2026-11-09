/**
 * What a host's error status is called when a remote file is opened (§10,
 * §24.6). A `404` or `403` is the address's answer — no file, or not for this
 * page — and not a host that ignores `Range`: a presigned link that has
 * expired, which skips the `HEAD`, failed the range probe under *does not serve
 * HTTP range requests*, and a refused `HEAD` sent a reader to a menu, *Open a
 * file → Private buckets*, that no longer exists.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError } from '@/errors'
import { RemoteRangeSource } from '@/sources/RemoteRangeSource'

const PRESIGNED =
  'https://bucket.example/sample.mcool?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600' +
  '&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefdeadbeef'

/** A host that answers every request with one status. */
function answering(status: number, statusText: string): typeof fetch {
  return (async () => new Response(null, { status, statusText })) as unknown as typeof fetch
}

async function refusal(url: string, status: number, statusText: string): Promise<ViewerError> {
  const error = await RemoteRangeSource.open(url, { fetchImpl: answering(status, statusText) }).then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof ViewerError)) throw new Error(`expected a ViewerError, got ${String(error)}`)
  return error
}

describe('a host that answers with an error status', () => {
  it('says a presigned link it refuses has expired, rather than that it serves no ranges', async () => {
    const error = await refusal(PRESIGNED, 403, 'Forbidden')
    expect(error.code).toBe('remote-no-ranges')
    expect(error.detail['status']).toBe(403)
    expect(error.message).toMatch(/presigned link, and a host refuses one once it has expired/)
    expect(error.message).not.toMatch(/does not serve HTTP range requests/)
  })

  it('names the bucket door there is, when a public address’s HEAD is refused', async () => {
    const error = await refusal('https://bucket.example/sample.mcool', 404, 'Not Found')
    expect(error.code).toBe('bad-uri')
    expect(error.detail['status']).toBe(404)
    expect(error.message).toContain('connect a bucket…')
    expect(error.message).not.toContain('Private buckets')
  })

  it('still calls a host that answers a range with the whole file one that serves no ranges', async () => {
    const error = await refusal(PRESIGNED, 200, 'OK')
    expect(error.message).toMatch(/does not serve HTTP range requests/)
  })
})
