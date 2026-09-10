/**
 * What `drain()` does with a `Content-Length` that does not match the body.
 *
 * `readWhole` is the one road into `drain`, and both of its callers — the two
 * halves of a HiC-Pro pair (`openHicPro`, worker/open.ts) — always pass a
 * watch, so production always takes the streaming branch rather than the
 * `arrayBuffer()` one. That branch used to trust `Content-Length` as the size
 * of the file, which it is not on a response the host re-encoded in transit:
 * there it counts *compressed* octets while the browser inflates the body and
 * hands JS the decoded stream. A 100 kB `.matrix` served pre-gzipped came back
 * as its 189-byte compressed size, with a progress bar reading 100% and no
 * error anywhere — `parseMatrix` then drew a contact map out of whatever
 * survived. Silent truncation of scientific data is the worst failure this
 * codebase has, and docs/hosting.md promises the opposite of it ("The viewer
 * refuses the case rather than reading corrupt bytes"), so the tests below pin
 * both halves of the mismatch:
 *
 * - a body **longer** than the declared length keeps every byte, because an
 *   unranged encoded stream inflates correctly and those bytes are the file;
 * - a body **shorter** than it raises, because the missing bytes cannot be
 *   recovered here and a partial file must not be mounted as a whole one.
 *
 * The honest case is pinned too: it must still allocate once and report a real
 * denominator, which is the reason the fast path exists at all.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'

import { readWhole } from '@/worker/sources'
import { ViewerError } from '@/errors'

const URL_UNDER_TEST = 'https://example.test/hicpro/sample_10000.matrix'

/** A plain HiC-Pro `.matrix`: three tab-separated columns, one pixel a line. */
function matrixText(rows: number): Uint8Array {
  const lines: string[] = []
  for (let i = 1; i <= rows; i += 1) lines.push(`${i}\t${i + 1}\t${(i % 97) + 1}`)
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

const identity = matrixText(2000)
const encoded = new Uint8Array(gzipSync(identity))

/** A `Headers`-alike over a plain record, which is all `drain` reads. */
function headersOf(record: Record<string, string>): Headers {
  return {
    get: (key: string) => record[key.toLowerCase()] ?? null,
  } as unknown as Headers
}

/**
 * The response a browser hands JS for a compressed transfer: the headers the
 * host sent, and a body that is already inflated. Chunked deliberately, since
 * the overflow is only visible part-way through the stream.
 */
function streamingResponse(options: { body: Uint8Array; headers: Record<string, string> }): Response {
  const { body } = options
  const chunk = 2048
  let at = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= body.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(at + chunk, body.byteLength)
      controller.enqueue(body.slice(at, end))
      at = end
    },
  })
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    url: URL_UNDER_TEST,
    headers: headersOf(options.headers),
    body: stream,
    arrayBuffer: async () => body.slice().buffer,
  } as unknown as Response
}

const saved: Record<string, unknown> = {}

function stub(key: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>
  if (!(key in saved)) saved[key] = g[key]
  g[key] = value
}

/** Serve one response, whatever is asked for. */
function serving(response: () => Response): typeof fetch {
  return (async () => response()) as unknown as typeof fetch
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key]
    else g[key] = value
  }
  for (const key of Object.keys(saved)) delete saved[key]
})

describe('readWhole over a response whose Content-Length disagrees with its body', () => {
  it('keeps the whole file when the host states the compressed length', async () => {
    // Pre-compressed static serving — GitHub Pages, and the case
    // docs/hosting.md measured: `Content-Encoding` *and* a `Content-Length`
    // that counts the gzipped octets, beside a body the browser has inflated.
    stub(
      'fetch',
      serving(() =>
        streamingResponse({
          body: identity,
          headers: { 'content-length': String(encoded.byteLength), 'content-encoding': 'gzip' },
        }),
      ),
    )

    const progress: Array<[number, number]> = []
    const bytes = await readWhole(
      { kind: 'remote', url: URL_UNDER_TEST },
      { onProgress: (received, total) => progress.push([received, total]) },
    )

    expect(bytes.byteLength).toBe(identity.byteLength)
    expect(bytes).toEqual(identity)
    // The old behaviour, named so a regression cannot pass as a rounding
    // difference: the file cut to the size of its own compressed form.
    expect(encoded.byteLength).toBeLessThan(identity.byteLength)
    expect(bytes.byteLength).not.toBe(encoded.byteLength)
    // The compressed length is not a denominator, so the bar goes
    // indeterminate rather than claiming 100% of the wrong number.
    expect(progress.at(-1)).toEqual([identity.byteLength, 0])
  })

  it('keeps the whole file when the browser hides Content-Encoding', async () => {
    // Same host, header not exposed to JS — which the Fetch standard permits
    // and RemoteRangeSource already allows for. All that is left of the tell
    // is a body that outruns the length beside it.
    stub(
      'fetch',
      serving(() =>
        streamingResponse({
          body: identity,
          headers: { 'content-length': String(encoded.byteLength) },
        }),
      ),
    )

    const progress: Array<[number, number]> = []
    const bytes = await readWhole(
      { kind: 'remote', url: URL_UNDER_TEST },
      { onProgress: (received, total) => progress.push([received, total]) },
    )

    expect(bytes.byteLength).toBe(identity.byteLength)
    expect(bytes).toEqual(identity)
    // Every byte is accounted for across the switch to the indeterminate
    // path: the counter never restarts, and it never goes backwards.
    expect(progress.at(-1)).toEqual([identity.byteLength, 0])
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]![0]).toBeGreaterThan(progress[i - 1]![0])
    }
  })

  it('refuses a body that ends short of the length it promised', async () => {
    // A cut transfer. Nothing here can recover the missing bytes, and handing
    // back what arrived is exactly the silent truncation above with the sign
    // flipped, so it is a refusal that names both numbers.
    const short = identity.subarray(0, 5000)
    stub(
      'fetch',
      serving(() =>
        streamingResponse({
          body: short,
          headers: { 'content-length': String(identity.byteLength) },
        }),
      ),
    )

    const err = await readWhole({ kind: 'remote', url: URL_UNDER_TEST }, {}).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ViewerError)
    const viewer = err as ViewerError
    expect(viewer.code).toBe('remote-cors')
    expect(viewer.message).toMatch(/short of/)
    expect(viewer.detail['received']).toBe(short.byteLength)
    expect(viewer.detail['declared']).toBe(identity.byteLength)
  })

  it('still fills a single allocation when the host is honest', async () => {
    stub(
      'fetch',
      serving(() =>
        streamingResponse({
          body: identity,
          headers: { 'content-length': String(identity.byteLength) },
        }),
      ),
    )

    const progress: Array<[number, number]> = []
    const bytes = await readWhole(
      { kind: 'remote', url: URL_UNDER_TEST },
      { onProgress: (received, total) => progress.push([received, total]) },
    )

    expect(bytes.byteLength).toBe(identity.byteLength)
    expect(bytes).toEqual(identity)
    // A real denominator throughout, which is what the fast path is for.
    expect(progress.every(([, total]) => total === identity.byteLength)).toBe(true)
    expect(progress.at(-1)).toEqual([identity.byteLength, identity.byteLength])
  })

  it('still collects a chunked response that states no length at all', async () => {
    // On-the-fly gzip (stock nginx) drops `Content-Length` and goes chunked;
    // this path was always correct and must stay so across the refactor.
    stub('fetch', serving(() => streamingResponse({ body: identity, headers: {} })))

    const progress: Array<[number, number]> = []
    const bytes = await readWhole(
      { kind: 'remote', url: URL_UNDER_TEST },
      { onProgress: (received, total) => progress.push([received, total]) },
    )

    expect(bytes).toEqual(identity)
    expect(progress.at(-1)).toEqual([identity.byteLength, 0])
  })

  it('answers a cancel mid-download on both paths', async () => {
    for (const headers of [
      { 'content-length': String(identity.byteLength) },
      {} as Record<string, string>,
    ]) {
      stub('fetch', serving(() => streamingResponse({ body: identity, headers })))
      let seen = 0
      const err = await readWhole(
        { kind: 'remote', url: URL_UNDER_TEST },
        {
          onProgress: () => {
            seen += 1
          },
          cancelled: () => seen > 0,
        },
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('AbortError')
    }
  })
})
