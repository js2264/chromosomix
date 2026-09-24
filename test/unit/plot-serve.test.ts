/**
 * The server `metacooler-plot` reads a workspace's local files through (§27.4).
 *
 * Two things here are worth holding. The first is that it answers the page
 * exactly as a bucket would — byte ranges, a whole file, a 416 past the end —
 * because every reader in the app is a range reader and a server that answered
 * a range with the whole file would still draw, slowly and with every map read
 * in full. The second is what it refuses: a request under another `Host`, a
 * path that climbs out of the directory a file was named in, and any path at
 * all without the token.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PlotServer, parseRange } from '@/cli/serve'

describe('parseRange', () => {
  it('reads the three forms of one range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('clamps an end past the file, and a suffix longer than it', () => {
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('refuses what no byte satisfies', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=10-5', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })

  // The whole file is a legal answer to any range request.
  it('answers what it does not read with the whole file', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
  })
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (chunk: Buffer) => parts.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('PlotServer', () => {
  let root = ''
  let server: PlotServer
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index))

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'metacooler-plot-serve-'))
    mkdirSync(join(root, 'viewer'))
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'viewer', 'index.html'), '<!doctype html><title>viewer</title>')
    writeFileSync(join(root, 'viewer', 'app.wasm'), 'wasm')
    writeFileSync(join(root, 'data', 'reads 1.bam'), bytes)
    writeFileSync(join(root, 'data', 'reads 1.bam.bai'), 'index')
    writeFileSync(join(root, 'data', 'track.bed.gz'), 'gz')
    writeFileSync(join(root, 'secret.txt'), 'not for the page')
    server = new PlotServer({ kind: 'dir', path: join(root, 'viewer') })
    await server.start()
  })

  afterAll(async () => {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('listens on the loopback interface, and opens the page with the plot flag', () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server.viewerUrl()).toBe(`${server.origin}/?plot=1`)
  })

  it('serves the viewer with the types a browser insists on', async () => {
    const page = await get(server.viewerUrl())
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body.toString()).toContain('<title>viewer</title>')
    expect((await get(`${server.origin}/app.wasm`)).headers['content-type']).toBe('application/wasm')
  })

  it('serves a file at a URL ending in its own name, and its sidecars beside it', async () => {
    const url = server.urlFor(join(root, 'data', 'reads 1.bam'))
    expect(url.startsWith(`${server.origin}/`)).toBe(true)
    expect(url.endsWith('/reads%201.bam')).toBe(true)
    const whole = await get(url)
    expect(whole.status).toBe(200)
    expect(whole.body.equals(bytes)).toBe(true)
    expect(whole.headers['accept-ranges']).toBe('bytes')
    // The page guesses an index by appending to the URL, as it would on a bucket.
    expect((await get(`${url}.bai`)).body.toString()).toBe('index')
  })

  it('answers a range with those bytes and nothing else', async () => {
    const url = server.urlFor(join(root, 'data', 'reads 1.bam'))
    const part = await get(url, { Range: 'bytes=10-19' })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 10-19/256')
    expect([...part.body]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    const past = await get(url, { Range: 'bytes=300-' })
    expect(past.status).toBe(416)
    expect(past.headers['content-range']).toBe('bytes */256')
    const head = await get(url, {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe('256')
    expect(head.body.length).toBe(0)
  })

  // A `.gz` here is a format, not a transfer encoding: a range into it has to
  // address the file's own octets.
  it('serves a compressed file as the bytes on disk', async () => {
    const answer = await get(server.urlFor(join(root, 'data', 'track.bed.gz')))
    expect(answer.headers['content-type']).toBe('application/octet-stream')
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.body.toString()).toBe('gz')
  })

  it('gives one directory one mount, however many of its files are named', () => {
    const a = server.urlFor(join(root, 'data', 'reads 1.bam'))
    const b = server.urlFor(join(root, 'data', 'track.bed.gz'))
    expect(a.slice(0, a.lastIndexOf('/'))).toBe(b.slice(0, b.lastIndexOf('/')))
  })

  it('refuses a path that climbs out of a mount, and a mount it never made', async () => {
    const url = server.urlFor(join(root, 'data', 'reads 1.bam'))
    const mount = url.slice(0, url.lastIndexOf('/'))
    expect((await get(`${mount}/..%2Fsecret.txt`)).status).toBe(404)
    expect((await get(`${mount}/%2E%2E/secret.txt`)).status).toBe(404)
    const token = new URL(url).pathname.split('/')[1]
    expect((await get(`${server.origin}/${token}/99/secret.txt`)).status).toBe(404)
  })

  it('serves no file without the token', async () => {
    const answer = await get(`${server.origin}/../secret.txt`)
    expect(answer.status).toBe(404)
    expect((await get(`${server.origin}/data/reads%201.bam`)).status).toBe(404)
  })

  // What stops a page elsewhere reaching this through a name that resolves here.
  it('refuses a request under any host but its own', async () => {
    const url = server.urlFor(join(root, 'data', 'reads 1.bam'))
    expect((await get(url, { Host: 'evil.example' })).status).toBe(403)
    expect((await get(url, { Host: `localhost:${new URL(server.origin).port}` })).status).toBe(403)
  })

  // The page names a file by the address it read; the reader named it by a path.
  it('names a served file by its path in a message the page wrote', () => {
    const url = server.urlFor(join(root, 'data', 'reads 1.bam'))
    expect(server.localise(`This is not a BAM: ${url} does not start with BAM\\1.`)).toBe(
      `This is not a BAM: ${join(root, 'data', 'reads 1.bam')} does not start with BAM\\1.`,
    )
    expect(server.localise(`(${url}.bai) and ${url}`)).toBe(
      `(${join(root, 'data', 'reads 1.bam.bai')}) and ${join(root, 'data', 'reads 1.bam')}`,
    )
    // Anything else it leaves as it was: another host, another token, a mount it never made.
    expect(server.localise('https://host/x.cool failed')).toBe('https://host/x.cool failed')
    const token = new URL(url).pathname.split('/')[1]
    expect(server.localise(`${server.origin}/${token}/99/x.cool`)).toBe(`${server.origin}/${token}/99/x.cool`)
  })

  it('reads nothing but GET and HEAD', async () => {
    expect((await get(server.viewerUrl(), {}, 'POST')).status).toBe(405)
  })
})

describe('PlotServer, relaying a running viewer', () => {
  it('passes the page’s requests to the viewer, and serves the data itself', async () => {
    // A stand-in for `npm run dev`: it answers every path with the path.
    const dev = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`dev:${req.url}`)
    })
    await new Promise<void>((done) => dev.listen(0, '127.0.0.1', () => done()))
    const address = dev.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const relay = new PlotServer({ kind: 'url', url: `http://127.0.0.1:${address.port}/` })
    await relay.start()
    try {
      const answer = await get(relay.viewerUrl())
      expect(answer.body.toString()).toBe('dev:/?plot=1')
    } finally {
      await relay.close()
      await new Promise<void>((done) => dev.close(() => done()))
    }
  })

  it('says which viewer did not answer', async () => {
    const relay = new PlotServer({ kind: 'url', url: 'http://127.0.0.1:9/' })
    await relay.start()
    try {
      const answer = await get(relay.viewerUrl())
      expect(answer.status).toBe(502)
      expect(answer.body.toString()).toMatch(/the viewer at http:\/\/127\.0\.0\.1:9\/ did not answer/)
    } finally {
      await relay.close()
    }
  })
})
