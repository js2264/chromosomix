/**
 * A host that compresses the file in transit (spec §11, §12).
 *
 * This is the GitHub Pages failure, reproduced. Pages serves every `.metacool`,
 * `.mcool` and `.cool` as `application/octet-stream`, and its CDN gzips that
 * content type. A browser always sends `Accept-Encoding: gzip` and cannot be
 * told not to — it is a forbidden header name, so neither `fetch` nor
 * `XMLHttpRequest` may set it — and the consequences are worse than a slow
 * download:
 *
 * - `Content-Length` from the probe is the **compressed** size, several MB
 *   short of the file, so the mounted node claims a length HDF5 reads past.
 * - `Range` addresses the octets of the *compressed* stream. `bytes=0-2047`
 *   inflates to a correct 6,990-byte prefix of the file — so the superblock
 *   reads fine and the open appears to succeed — while any later range is a
 *   slice out of the middle of a gzip stream.
 *
 * The observable end of that is `error - name not defined!` from inside the
 * wasm, hundreds of frames from the cause. These tests pin the two places that
 * now refuse it instead, and the fallback that makes the published demo files
 * open anyway.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

import { RemoteRangeSource } from '@/sources/RemoteRangeSource'
import { createSource } from '@/worker/sources'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { ViewerError } from '@/errors'

const FILE = new URL('../../public/demo/Mock_microbial_community.metacool', import.meta.url).pathname
const URL_UNDER_TEST = 'https://example.test/demo/Mock_microbial_community.metacool'

const identity = new Uint8Array(readFileSync(FILE))
const encoded = new Uint8Array(gzipSync(identity))

/** A `Headers`-alike over a plain record, which is all the reader reads. */
function headersOf(record: Record<string, string>): Headers {
  return {
    get: (key: string) => record[key.toLowerCase()] ?? null,
  } as unknown as Headers
}

/**
 * The HEAD a compressing CDN answers with: the **encoded** length, ranges
 * advertised, and `Content-Encoding` left in place — which is what a browser
 * does, since it decodes the body but not the header.
 */
function compressingFetch(options: { exposeEncoding: boolean }): typeof fetch {
  const headers: Record<string, string> = {
    'content-length': String(encoded.byteLength),
    'accept-ranges': 'bytes',
  }
  if (options.exposeEncoding) headers['content-encoding'] = 'gzip'
  return (async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'HEAD') {
      return { ok: true, status: 200, statusText: 'OK', headers: headersOf(headers) } as Response
    }
    // The unranged GET the fallback makes: a complete encoded stream, which the
    // browser inflates correctly, so what lands in JS is the identity bytes.
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: headersOf({ 'content-length': String(encoded.byteLength) }),
      arrayBuffer: async () =>
        identity.buffer.slice(identity.byteOffset, identity.byteOffset + identity.byteLength),
    } as unknown as Response
  }) as unknown as typeof fetch
}

const saved: Record<string, unknown> = {}

function stub(key: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>
  if (!(key in saved)) saved[key] = g[key]
  g[key] = value
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key]
    else g[key] = value
  }
  for (const key of Object.keys(saved)) delete saved[key]
})

describe('a host that applies transfer compression', () => {
  it('is refused at the probe, naming the encoding rather than the file', async () => {
    const err = await RemoteRangeSource.open(URL_UNDER_TEST, {
      fetchImpl: compressingFetch({ exposeEncoding: true }),
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ViewerError)
    const viewer = err as ViewerError
    expect(viewer.code).toBe('remote-compressed')
    expect(viewer.detail['encoding']).toBe('gzip')
    // The size it would otherwise have believed, kept so the caller can decide
    // whether one whole download is affordable.
    expect(viewer.detail['encodedLength']).toBe(encoded.byteLength)
    // Not the compressed length dressed up as the file's.
    expect(encoded.byteLength).toBeLessThan(identity.byteLength)
  })

  it('is caught on the first read when the browser hides Content-Encoding', async () => {
    // Same host, but the probe cannot see the header — so the source is built
    // and the corruption has to be caught by the bytes themselves.
    const source = await RemoteRangeSource.open(URL_UNDER_TEST, {
      fetchImpl: compressingFetch({ exposeEncoding: false }),
    })

    // A browser inflating a range of a gzip stream returns however many bytes
    // it decoded, while `Content-Range` still describes the compressed slice.
    class InflatingXhr {
      status = 0
      response: ArrayBuffer | null = null
      responseType = ''
      private range: [number, number] = [0, 0]
      open(): void {}
      setRequestHeader(header: string, value: string): void {
        const match = /bytes=(\d+)-(\d+)/.exec(value)
        if (header.toLowerCase() === 'range' && match) {
          this.range = [Number(match[1]), Number(match[2])]
        }
      }
      getResponseHeader(header: string): string | null {
        if (header.toLowerCase() !== 'content-range') return null
        return `bytes ${this.range[0]}-${this.range[1]}/${encoded.byteLength}`
      }
      send(): void {
        // 2048 compressed octets inflate to ~7 kB of the real file: more bytes
        // than the range claims, which is the tell.
        const inflated = identity.subarray(0, (this.range[1] - this.range[0] + 1) * 3)
        this.response = inflated.slice().buffer
        this.status = 206
      }
    }
    stub('XMLHttpRequest', InflatingXhr)

    let thrown: unknown = null
    try {
      source.readBytes(0, 2048)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ViewerError)
    expect((thrown as ViewerError).code).toBe('remote-compressed')
    // Silently truncating the inflated body to the window is the bug, not the
    // fix: the first chunk would have looked right and every later one would not.
    expect((thrown as ViewerError).message).toMatch(/re-encoded in transit/)
    expect((thrown as ViewerError).detail['received']).toBeGreaterThan(2048)
  })

  it('opens anyway: createSource falls back to one whole-object download', async () => {
    stub('fetch', compressingFetch({ exposeEncoding: true }))

    const source = await createSource({ kind: 'remote', url: URL_UNDER_TEST })
    // The identity size, not the 11 MB the compressing probe reported.
    expect(source.size).toBe(identity.byteLength)

    const mc = await MetaCooler.open(URL_UNDER_TEST, source)
    expect(mc.nGenomes).toBe(49)
    expect(mc.nContigs).toBe(20566)
    expect(mc.binsize).toBe(1000)
    mc.close()
    source.close()
  })
})
