/**
 * The viewer and the files it reads, served to one browser on this machine.
 *
 * `metacooler-plot` (§27) opens the app in a headless browser, and a browser
 * reads a local file only when a reader hands it one — which is the rule this
 * whole app is built on (§11) and the one thing a program cannot do on a
 * reader's behalf. So the command serves each file it was asked about over
 * HTTP, from `127.0.0.1`, and the page reads it the way it reads a file on a
 * bucket: byte ranges, through the same `RemoteRangeSource` and the same
 * sidecar probing. Nothing about a local file is special on the far side, and
 * that is the point — the picture saved is the one a reader opening the same
 * files from a bucket would see.
 *
 * **Directories, not files.** A file here is served at a URL inside the
 * directory it is in, because a `.bam` looks for its `.bai` beside it, a FASTA
 * for its `.fai`, a `.pairs` for its `.px2` and a HiC-Pro matrix for its bin
 * file, all by name. Serving the one file would leave every one of those looking
 * at nothing.
 *
 * **Only to the page, and only while the command runs.** It listens on the
 * loopback interface alone, on a port the system picks, and every data URL
 * carries a random token — so another program on the machine that happens to
 * find the port finds no path to a file under it. A request whose `Host` is not
 * this server's is refused, which is what stops a page elsewhere from reaching
 * it through a name that resolves here.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** What the app's own files are served as; anything else is bytes. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** Where the viewer comes from: a built copy on disk, or a server to relay (`npm run dev`). */
export type ViewerSource = { kind: 'dir'; path: string } | { kind: 'url'; url: string }

/** A byte range asked for, in inclusive offsets, or `null` for the whole file. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // A multi-range or a malformed one is answered with the whole file, which is
  // a legal answer to any range request and one the app never asks for anyway.
  if (match === null) return null
  const [, from, to] = match
  if (from === '' && to === '') return null
  if (from === '') {
    // `bytes=-500` is the last 500 bytes.
    const length = Number(to)
    if (length === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(from)
  if (start >= size) return 'unsatisfiable'
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

export class PlotServer {
  /** `http://127.0.0.1:<port>` once {@link start} has resolved. */
  origin = ''
  private readonly token = randomBytes(16).toString('hex')
  private readonly roots: string[] = []
  private readonly server: Server

  constructor(private readonly viewer: ViewerSource) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(error instanceof Error ? error.message : String(error))
      })
    })
    // Range reads come in bursts of a few hundred small requests; keeping the
    // sockets open is most of what makes a local file as quick here as on disk.
    this.server.keepAliveTimeout = 60_000
  }

  /** Listen on the loopback interface, on a port the system picks. */
  start(): Promise<void> {
    return new Promise((resolveStart, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('the local server has no port'))
          return
        }
        this.origin = `http://127.0.0.1:${address.port}`
        resolveStart()
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolveClose) => {
      this.server.closeAllConnections?.()
      this.server.close(() => resolveClose())
    })
  }

  /** The page's own address, with the mount flag on. */
  viewerUrl(): string {
    return `${this.origin}/?plot=1`
  }

  /**
   * The URL a local file is read at: its directory mounted under the token,
   * and the file's own name last, so what the page calls it — a caption, a
   * track's label, a map's name — is the name the file has.
   */
  urlFor(path: string): string {
    const absolute = resolve(path)
    const directory = resolve(absolute, '..')
    let index = this.roots.indexOf(directory)
    if (index < 0) {
      this.roots.push(directory)
      index = this.roots.length - 1
    }
    const name = relative(directory, absolute)
    return `${this.origin}/${this.token}/${index}/${name.split(sep).map(encodeURIComponent).join('/')}`
  }

  /**
   * A message with every URL this server made turned back into the path it
   * serves. The page names a file by the address it read, and the reader at
   * the shell named it by a path: a failure that says
   * `http://127.0.0.1:41213/9f…/0/rep1.cool` is about a file they cannot see.
   */
  localise(text: string): string {
    if (this.origin === '') return text
    const prefix = `${this.origin}/${this.token}/`
    let out = ''
    let from = 0
    for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, from)) {
      out += text.slice(from, at)
      const rest = /^(\d+)\/([^\s'"<>()]+)/.exec(text.slice(at + prefix.length))
      const root = rest === null ? undefined : this.roots[Number(rest[1])]
      if (rest === null || root === undefined) {
        out += prefix
        from = at + prefix.length
        continue
      }
      // A sentence may end on the name: the stop is not part of it.
      const [name, trailing] = /^(.*?)([.,;:]*)$/.exec(rest[2])?.slice(1) ?? [rest[2], '']
      let decoded = name
      try {
        decoded = name.split('/').map(decodeURIComponent).join(sep)
      } catch {
        /* a name the page mangled is shown as it arrived */
      }
      out += join(root, decoded) + trailing
      from = at + prefix.length + rest[0].length
    }
    return out + text.slice(from)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The page and nothing else: a request that names this server by another
    // host arrived through a name somebody pointed here.
    if (req.headers.host !== this.origin.slice('http://'.length)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not for this host')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', this.origin)
    const parts = url.pathname.split('/').filter((part) => part !== '')
    if (parts[0] === this.token) {
      this.serveData(parts.slice(1), req, res)
      return
    }
    if (this.viewer.kind === 'url') {
      await this.relay(url, req, res)
      return
    }
    this.serveViewer(url.pathname, req, res)
  }

  /** A file under a mounted directory, by range. */
  private serveData(parts: string[], req: IncomingMessage, res: ServerResponse): void {
    const root = this.roots[Number(parts[0])]
    if (root === undefined || parts.length < 2) {
      res.writeHead(404)
      res.end()
      return
    }
    const path = inside(root, parts.slice(1).map(decodeURIComponent).join('/'))
    if (path === null) {
      res.writeHead(404)
      res.end()
      return
    }
    // Bytes as they are on disk, whatever the name says: a `.gz` here is a
    // format rather than a transfer encoding (a `.g3d.gz`, a bgzipped BED), and
    // a range into it has to address the file's own octets.
    this.sendFile(path, 'application/octet-stream', 'no-store', req, res)
  }

  /** The built viewer, from its directory. */
  private serveViewer(pathname: string, req: IncomingMessage, res: ServerResponse): void {
    if (this.viewer.kind !== 'dir') return
    const wanted = pathname === '/' || pathname === '' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    const path = inside(this.viewer.path, wanted)
    if (path === null) {
      res.writeHead(404)
      res.end()
      return
    }
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    // Hashed assets never change under a name; the page itself is read fresh.
    const cache = wanted === 'index.html' ? 'no-cache' : 'max-age=3600'
    this.sendFile(path, type, cache, req, res)
  }

  private sendFile(path: string, type: string, cache: string, req: IncomingMessage, res: ServerResponse): void {
    let size: number
    try {
      const stat = statSync(path)
      if (!stat.isFile()) throw new Error('not a file')
      size = stat.size
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
      res.end()
      return
    }
    const headers: Record<string, string | number> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
    }
    if (range === null) {
      res.writeHead(200, { ...headers, 'Content-Length': size })
      if (req.method === 'HEAD' || size === 0) {
        res.end()
        return
      }
      createReadStream(path).pipe(res)
      return
    }
    res.writeHead(206, {
      ...headers,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(path, { start: range.start, end: range.end }).pipe(res)
  }

  /**
   * Hand a request for the app to a running viewer — `npm run dev`, for a run
   * against the source rather than a build — and its answer back.
   *
   * Relayed rather than pointed at, so the page and the files it reads stay one
   * origin: a viewer on one port reading data on another is a cross-origin read,
   * and every header the range reader needs would then have to be exposed.
   */
  private relay(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.viewer.kind !== 'url') return Promise.resolve()
    const target = new URL(url.pathname + url.search, this.viewer.url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise((done) => {
      const upstream = send(
        target,
        { method: req.method, headers: { ...req.headers, host: target.host } },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(res)
          answer.on('end', () => done())
        },
      )
      upstream.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`the viewer at ${this.viewer.kind === 'url' ? this.viewer.url : ''} did not answer: ${error.message}`)
        done()
      })
      req.pipe(upstream)
    })
  }
}

/** `root/name`, or `null` for a name that climbs out of `root`. */
function inside(root: string, name: string): string | null {
  const joined = normalize(join(root, name))
  const back = relative(root, joined)
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return null
  return joined
}
