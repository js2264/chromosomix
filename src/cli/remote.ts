/**
 * Files named by an address: read by range where their format allows it, and
 * fetched to disk where it does not.
 *
 * ## By range, as the app reads one
 *
 * The app reads an address a megabyte at a time through `RemoteRangeSource`,
 * whose reads are synchronous because HDF5's are. A browser worker has a
 * synchronous request and Node does not, so for a long time the command fetched
 * every address whole first — seven gigabytes of `.mcool` to read one rung of
 * it. It has one now (`cli/syncFetch.ts`), and so a map — a cooler, an
 * `.mcool`, a `.hic`, an `.scool`, a `.pairs` — and a bigWig, a `.2bit` or an
 * indexed FASTA are read where they are, by the same source and the same
 * coalescing and read-ahead the app reads them with ({@link Downloads.ranged},
 * {@link Downloads.where}). Nothing is written to disk for them.
 *
 * A host that will not serve a range — that answers `200` with the whole object,
 * or compresses what it sends — is said so on stderr, and the file is fetched
 * whole instead, as it always was: the command works on the hosts it worked on.
 *
 * ## Whole, for what is read whole anyway
 *
 * A feature file, a bedGraph, a HiC-Pro matrix, a workspace: every one is parsed
 * from all of its bytes, so there is nothing a range would save, and the copy
 * is what the roads that read a name — a HiC-Pro matrix's bin file beside it —
 * read. These are fetched to disk ({@link Downloads.local}).
 *
 * ## Three decisions about a copy
 *
 * - **Streamed to disk, never held.** A 4DN `.mcool` is seven gigabytes, and a
 *   download that passes through memory is a download that ends the process.
 *   Each chunk is written as it arrives, and the progress goes to stderr unless
 *   `--quiet` says otherwise, because a command that sits silent for twenty
 *   minutes reads as a hang.
 * - **The copy keeps its name.** Several roads read a name rather than bytes —
 *   a HiC-Pro matrix is one by its `.matrix`, a FASTA is read by range where
 *   `<name>.fai` lies beside it, a feature file's sniffers look at its
 *   extension — so the copy is `<slot>/<name>`, one slot per address so that two
 *   addresses ending in the same name cannot meet, and the sidecar each of those
 *   formats reads beside itself is fetched beside it wherever the server has one.
 * - **Gone when the command ends.** One directory per command, under the
 *   system's temporary directory (`$TMPDIR`), removed on success, on failure and
 *   on Ctrl-C. A batch lets each map go once its run is done, so a command over
 *   two hundred addresses holds one map at a time rather than two hundred; what
 *   every run reads — a `--sequence`, a `--tracks`, an `--against` — is kept to
 *   the end.
 *
 * Only `http` and `https`. An `s3://` address needs credentials this command
 * has not got, and any other scheme is refused by name rather than handed to
 * `stat` as a path.
 */

import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type {
  BufferEncoding,
  FilehandleOptions,
  GenericFilehandle,
  Stats,
} from 'generic-filehandle2'

import { FASTA_NAME, hicProBinsNames, isHicProMatrix } from '../annotations/sidecar'
import { ViewerError } from '../errors'
import { RemoteRangeSource } from '../sources/RemoteRangeSource'
import { closeSyncFetch, identityFetch, nodeSyncFetch } from './syncFetch'

/** Whether a string the reader typed is an address this command fetches. */
export function isAddress(text: string): boolean {
  return /^https?:\/\//i.test(text.trim())
}

/** The scheme of an address this command does not fetch — `s3`, `gs`, `file` — or `null`. */
function otherScheme(text: string): string | null {
  if (isAddress(text)) return null
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(text.trim())?.[1] ?? null
}

/** The file half of `file::group`, as `parseUri` splits it, without its refusal of an empty one. */
function fileHalf(text: string): string {
  const sep = text.indexOf('::')
  return (sep < 0 ? text : text.slice(0, sep)).trim()
}

/**
 * What a file is called, whether a path or an address names it: the `::` group,
 * an address's query and its percent-encoding taken off.
 *
 * `basename` of an address keeps the query — a presigned link's
 * `sample.mcool?X-Amz-Signature=…` — and a name made of that is no name. So an
 * address is read as one, and its last segment decoded. What decoding can put
 * back that a file name must not hold — a `/`, a `\`, a control character — is
 * replaced, because the name becomes a path under `--out` and under the
 * download directory, and `%2F..%2F` must walk out of neither.
 */
export function fileNameOf(text: string): string {
  const file = fileHalf(text)
  if (!isAddress(file)) return basename(file)
  let last: string
  try {
    last = new URL(file).pathname.split('/').filter((part) => part !== '').pop() ?? ''
  } catch {
    return 'download'
  }
  let name = last
  try {
    name = decodeURIComponent(last)
  } catch {
    // A `%` that begins no escape: the segment as it was written is the better name.
  }
  const safe = [...name].map((char) => (char === '/' || char === '\\' || char < ' ' ? '_' : char)).join('')
  return safe === '' || safe === '.' || safe === '..' ? 'download' : safe
}

/**
 * The directories an address's file sits in, nearest first, then its host —
 * what the outputs of two addresses ending in one name are told apart by.
 * Empty for a path, whose directories are the filesystem's to say.
 */
export function addressDirectories(text: string): string[] {
  const file = fileHalf(text)
  if (!isAddress(file)) return []
  try {
    const url = new URL(file)
    const parts = url.pathname.split('/').filter((part) => part !== '').slice(0, -1)
    return [...parts.reverse(), url.host].map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
  } catch {
    return []
  }
}

/**
 * The sidecars a format reads beside itself, by the names a server would serve
 * them under: a FASTA's `samtools faidx` index, without which a genome past
 * 2 GiB cannot be read at all (`cli/reference.ts`), and the bin file a HiC-Pro
 * matrix has no coordinates without (§3.9).
 */
function companionsOf(name: string): string[] {
  if (FASTA_NAME.test(name)) return [`${name}.fai`]
  if (isHicProMatrix(name)) return hicProBinsNames(name)
  return []
}

/** `7.0 GB`, `512.0 MB`, `40 kB` — decimal, as `cli/reference.ts` writes a size. */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`
  return `${bytes} B`
}

/**
 * An address as a sentence about it names it: without its query, which on a
 * presigned link is the signature, and has no business in a log.
 */
function shownOf(address: string): string {
  try {
    const url = new URL(address)
    return `${url.origin}${url.pathname}${url.search === '' ? '' : '?…'}`
  } catch {
    return address
  }
}

/**
 * What stderr calls a file named on the line: a path as it was typed, and an
 * address as {@link shownOf} has it, its `::` group kept.
 */
export function displayOf(typed: string): string {
  if (!isAddress(typed)) return typed
  const sep = typed.indexOf('::')
  return sep < 0 ? shownOf(typed.trim()) : `${shownOf(fileHalf(typed))}${typed.slice(sep).trim()}`
}

/** What `fetch` threw, with the cause it hides: `fetch failed` names nothing. */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && cause.message !== ''
    ? `${error.message} (${cause.message})`
    : error.message
}

/**
 * Whether a refusal to open an address by range says the host *has* the file
 * and will not serve it in pieces — a `200` with the whole object, or a body
 * compressed in transit — which a whole download answers. A `404` or a `403`
 * to the range probe a signed link is opened with is not that: it is the
 * address's answer, and fetching it whole would only get it again.
 */
function servedWhole(error: unknown): error is ViewerError {
  if (!(error instanceof ViewerError)) return false
  if (error.code === 'remote-compressed') return true
  if (error.code !== 'remote-no-ranges') return false
  const status = (error.detail as { status?: unknown }).status
  return typeof status !== 'number' || (status >= 200 && status < 300)
}

/**
 * What opening an address by range was refused with, as this command says it.
 *
 * `RemoteRangeSource` speaks to a page — a bucket's CORS, *Open a file →
 * Private buckets* — and names the address whole, signature and all. A shell's
 * sentence names the status, or the cause of a request that got no answer, and
 * the address as {@link shownOf} has it.
 */
function refusalOf(address: string, error: unknown): string {
  const shown = shownOf(address)
  if (error instanceof ViewerError) {
    const detail = error.detail as { status?: unknown; cause?: unknown }
    if (typeof detail.status === 'number') return `${shown} answered ${detail.status}.`
    if (typeof detail.cause === 'string') return `${shown} could not be fetched: ${detail.cause}.`
  }
  const message = error instanceof Error ? reasonOf(error) : String(error)
  return `${shown}: ${message.split(address).join(shown)}`
}

/** How a {@link Downloads} fetches, and whether it says so. */
export interface DownloadOptions {
  /** Nothing on stderr: the command's own `--quiet`. */
  quiet: boolean
  /** The `fetch` to fetch with — the global one, unless a test hands another. */
  fetch?: typeof fetch
}

interface Held {
  /** The copy on disk, once it is there. */
  readonly at: Promise<string>
  /** Kept to the end of the command, rather than let go after one run. */
  keep: boolean
}

/**
 * Where a file's bytes are read from: a path on this machine — the file the
 * reader named, or the copy of an address fetched whole — or a source reading
 * an address by range.
 */
export type Where = { kind: 'disk'; path: string } | { kind: 'range'; source: RemoteRangeSource }

/**
 * What a range source keeps of a track or a reference, rather than a map's
 * 64 MiB: a run over two hundred bigWigs holds two hundred of them, and a track
 * is read a few blocks at a time.
 */
export const SIDE_CACHE_BYTES = 8 << 20

/** A sidecar's address beside its file's: the same directory, the query left off. */
export function besideAddress(address: string, name: string): string {
  return new URL(encodeURIComponent(name), fileHalf(address)).href
}

/** Every byte of a file, wherever it is: one exact request for a ranged address. */
export async function wholeBytes(where: Where): Promise<Uint8Array> {
  if (where.kind === 'disk') return new Uint8Array(await readFile(where.path))
  const { source } = where
  return source.readExact === undefined ? source.readBytes(0, source.size) : source.readExact(0, source.size)
}

/**
 * A ranged source as the filehandle `@gmod/bbi` and the `.2bit` reader take:
 * each read through the source's cache, coalescing and read-ahead — the reads
 * the annotations worker makes of a bigWig at an address.
 */
export class SourceHandle implements GenericFilehandle {
  constructor(private readonly source: RemoteRangeSource) {}

  async read(length: number, position = 0): Promise<Uint8Array<ArrayBuffer>> {
    return this.source.readBytes(position, length) as Uint8Array<ArrayBuffer>
  }

  readFile(options?: Omit<FilehandleOptions, 'encoding'>): Promise<Uint8Array<ArrayBuffer>>
  readFile(
    options: BufferEncoding | (Omit<FilehandleOptions, 'encoding'> & { encoding: BufferEncoding }),
  ): Promise<string>
  async readFile(options?: BufferEncoding | FilehandleOptions): Promise<Uint8Array<ArrayBuffer> | string> {
    const bytes = (await wholeBytes({ kind: 'range', source: this.source })) as Uint8Array<ArrayBuffer>
    // Text as UTF-8, whichever spelling asked: nothing here reads another.
    const encoding = typeof options === 'string' ? options : options?.encoding
    return encoding === undefined ? bytes : new TextDecoder().decode(bytes)
  }

  async stat(): Promise<Stats> {
    return { size: this.source.size } as Stats
  }

  async close(): Promise<void> {
    this.source.close()
  }
}

/**
 * Every address one command fetched, and the directory they are in.
 *
 * One per command, closed by `main` whatever way the command ended. An address
 * is fetched once however often it is named — `x.mcool::/resolutions/1000` and
 * `x.mcool::/resolutions/5000` are one file — and a path is left alone.
 */
export class Downloads {
  private made: Promise<string> | null = null
  private root: string | null = null
  private slots = 0
  private readonly held = new Map<string, Held>()
  /** Addresses whose host would not serve a range, said once and fetched whole from then on. */
  private readonly whole = new Set<string>()

  constructor(private readonly options: DownloadOptions) {}

  /**
   * A source reading `typed`'s address by range — a new one each call, each
   * the caller's to close — or `null` where its host will not serve a range,
   * which is said on stderr the first time and is the caller's cue to fetch it
   * whole with {@link local}.
   *
   * Every other refusal is a sentence about the address, its query left off:
   * a `404`, a host that cannot be reached.
   */
  async ranged(typed: string, maxCacheBytes?: number): Promise<RemoteRangeSource | null> {
    this.refuseScheme(typed)
    const address = fileHalf(typed)
    if (!isAddress(address)) throw new Error(`${address} is not an address.`)
    if (this.whole.has(address)) return null
    const doFetch = this.options.fetch ?? identityFetch
    // What a request that got no answer was refused with — `ECONNREFUSED`, a
    // name that does not resolve — which the source's own refusal folds into
    // `fetch failed`.
    let unanswered: string | null = null
    try {
      return await RemoteRangeSource.open(address, {
        fetchImpl: (input, init) =>
          doFetch(input, init).catch((error: unknown) => {
            unanswered ??= reasonOf(error)
            throw error
          }),
        syncFetch: nodeSyncFetch,
        ...(maxCacheBytes === undefined ? {} : { maxCacheBytes }),
      })
    } catch (error) {
      if (unanswered !== null) throw new Error(`${shownOf(address)} could not be fetched: ${unanswered}.`)
      if (servedWhole(error)) {
        this.whole.add(address)
        if (!this.options.quiet) {
          process.stderr.write(
            `  ${shownOf(address)} is not served by range ` +
              `(${error.code === 'remote-compressed' ? 'it is compressed in transit' : 'it ignores Range'}); ` +
              'fetching it whole\n',
          )
        }
        return null
      }
      throw new Error(refusalOf(address, error))
    }
  }

  /**
   * Where `typed`'s bytes are read from: the path itself, an address by range,
   * or — where its host serves no range — the copy {@link local} fetched.
   */
  async where(typed: string, keep: boolean, maxCacheBytes?: number): Promise<Where> {
    this.refuseScheme(typed)
    const file = fileHalf(typed)
    if (!isAddress(file)) return { kind: 'disk', path: file }
    const source = await this.ranged(file, maxCacheBytes)
    if (source !== null) return { kind: 'range', source }
    return { kind: 'disk', path: (await this.local(file, keep)) ?? file }
  }

  /**
   * A sidecar's text beside the file `typed` names — a FASTA's `.fai` — or
   * `null` where there is none. An address's is fetched beside it, and a
   * missing one is no error: its format reads the file without it.
   */
  async sidecarText(typed: string, name: string): Promise<string | null> {
    const file = fileHalf(typed)
    if (!isAddress(file)) {
      const path = join(dirname(file), name)
      return existsSync(path) ? readFile(path, 'utf8') : null
    }
    try {
      const response = await (this.options.fetch ?? identityFetch)(besideAddress(file, name))
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      return await response.text()
    } catch {
      return null
    }
  }

  /**
   * A sidecar beside an address as a ranged source — a `.pairs` file's `.px2`
   * — or `null` where there is none to range over. Quietly: an index that is
   * not there is an index the reader did not make, and the file is read
   * without it.
   */
  async sidecarRanged(typed: string, name: string): Promise<RemoteRangeSource | null> {
    try {
      return await RemoteRangeSource.open(besideAddress(typed, name), {
        fetchImpl: this.options.fetch ?? identityFetch,
        syncFetch: nodeSyncFetch,
      })
    } catch {
      return null
    }
  }

  /**
   * Make sure a map every run reads can be had, before the first run: a range
   * opened and let go, or the copy fetched where it is read whole — a HiC-Pro
   * matrix, or a host that serves no range. A path is the filesystem's to say.
   */
  async reach(typed: string, keep: boolean): Promise<void> {
    this.refuseScheme(typed)
    const file = fileHalf(typed)
    if (!isAddress(file)) return
    if (!isHicProMatrix(fileNameOf(file))) {
      const source = await this.ranged(file)
      if (source !== null) {
        source.close()
        return
      }
    }
    await this.local(file, keep)
  }

  /** Refuse a scheme this command does not fetch, by name, rather than `stat` it as a path. */
  refuseScheme(typed: string): void {
    const scheme = otherScheme(typed)
    if (scheme !== null) {
      throw new Error(
        `${fileHalf(typed)}: this command fetches http and https addresses, and ${scheme}:// is ` +
          'neither. Copy the file to disk and name the copy.',
      )
    }
  }

  /**
   * Where the bytes of the file `typed` names are on this machine: `undefined`
   * for a path, which is read where it lies, and the copy for an address.
   *
   * `keep` is for what every run of the command reads. A map named as a
   * positional is fetched without it and let go by {@link release} once its
   * run is done, so a batch holds one at a time.
   */
  async local(typed: string, keep: boolean): Promise<string | undefined> {
    this.refuseScheme(typed)
    if (!isAddress(typed)) return undefined
    const address = fileHalf(typed)
    const held = this.held.get(address)
    if (held !== undefined) {
      held.keep ||= keep
      return held.at
    }
    const at = this.fetchOne(address)
    this.held.set(address, { at, keep })
    try {
      return await at
    } catch (error) {
      this.held.delete(address)
      throw error
    }
  }

  /** Let go of a copy one run read, unless something every run reads holds it too. */
  async release(typed: string): Promise<void> {
    if (!isAddress(typed)) return
    const address = fileHalf(typed)
    const held = this.held.get(address)
    if (held === undefined || held.keep) return
    this.held.delete(address)
    const at = await held.at.catch(() => null)
    if (at !== null) await rm(dirname(at), { recursive: true, force: true }).catch(() => undefined)
  }

  /** Remove every copy, and the directory they were in, and stop the request thread. Safe to call twice. */
  async close(): Promise<void> {
    await closeSyncFetch()
    this.unwatch()
    const root = this.root
    this.root = null
    this.made = null
    this.held.clear()
    if (root !== null) await rm(root, { recursive: true, force: true })
  }

  /** The command's directory, made on the first fetch and not before. */
  private directory(): Promise<string> {
    this.made ??= mkdtemp(join(tmpdir(), 'chromosomix-')).then((root) => {
      this.root = root
      process.once('SIGINT', this.interrupted)
      process.once('SIGTERM', this.interrupted)
      return root
    })
    return this.made
  }

  /**
   * Ctrl-C in the middle of a seven-gigabyte download: the copies go, and then
   * the signal does what it would have done had nothing been listening.
   */
  private readonly interrupted = (signal: NodeJS.Signals): void => {
    this.unwatch()
    if (this.root !== null) rmSync(this.root, { recursive: true, force: true })
    process.kill(process.pid, signal)
  }

  private unwatch(): void {
    process.off('SIGINT', this.interrupted)
    process.off('SIGTERM', this.interrupted)
  }

  private async fetchOne(address: string): Promise<string> {
    this.slots += 1
    const slot = join(await this.directory(), String(this.slots))
    await mkdir(slot)
    const name = fileNameOf(address)
    const to = join(slot, name)
    await this.fetchTo(address, to, name, !this.options.quiet)
    for (const companion of companionsOf(name)) {
      // Taken where the server has one, and nothing said where it has not: each
      // is a sidecar its format looks for beside the file, and a format that
      // cannot do without one says so in its own words.
      await this.fetchTo(
        new URL(encodeURIComponent(companion), address).href,
        join(slot, companion),
        companion,
        false,
      ).catch(() => undefined)
    }
    return to
  }

  private async fetchTo(address: string, to: string, name: string, report: boolean): Promise<void> {
    let response: Response
    try {
      // `identity`, so the bytes are the file's: a server that compressed the
      // response on the way out would hand back a count its length does not
      // match, and a `.gz` decompressed in transit is a file misnamed on disk.
      response = await (this.options.fetch ?? fetch)(address, {
        headers: { 'accept-encoding': 'identity' },
      })
    } catch (error) {
      throw new Error(`${shownOf(address)} could not be fetched: ${reasonOf(error)}.`)
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      const status = `${response.status} ${response.statusText}`.trim()
      throw new Error(`${shownOf(address)} answered ${status}.`)
    }
    const announced = Number(response.headers.get('content-length') ?? Number.NaN)
    const total = Number.isFinite(announced) && announced > 0 ? announced : null
    const encoded = (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity'
    const shown = report ? progressOf(name, total) : null
    const body = response.body
    const handle = await open(to, 'w').catch(async (error: unknown) => {
      await body.cancel().catch(() => undefined)
      throw error
    })
    const reader = body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await handle.write(value)
        received += value.byteLength
        shown?.step(received)
      }
    } catch (error) {
      // A disk that filled is a stream still open, and a socket held for it.
      await reader.cancel().catch(() => undefined)
      await handle.close().catch(() => undefined)
      await rm(to, { force: true })
      if (shown !== null) process.stderr.write('\n')
      throw new Error(`${shownOf(address)} stopped after ${sizeText(received)}: ${reasonOf(error)}.`)
    }
    await handle.close()
    // A length is a promise about the bytes, and a copy that fell short of it
    // is a map that fails later with a sentence about HDF5 rather than about
    // the download. Not where the server compressed anyway: its length is then
    // of the compressed body, and `fetch` has already undone the compression.
    if (total !== null && !encoded && received !== total) {
      await rm(to, { force: true })
      if (shown !== null) process.stderr.write('\n')
      throw new Error(
        `${shownOf(address)} sent ${sizeText(received)} of the ${sizeText(total)} it announced.`,
      )
    }
    shown?.done(received)
  }
}

/**
 * A download's line on stderr, redrawn in place.
 *
 * On a change of percent, or of 8 MB where the server named no length: a line
 * per chunk is a terminal redrawn ten thousand times a gigabyte.
 */
function progressOf(
  name: string,
  total: number | null,
): { step(received: number): void; done(received: number): void } {
  let shown = -1
  return {
    step: (received) => {
      const mark = total === null ? Math.floor(received / 8e6) : Math.floor((received / total) * 100)
      if (mark === shown) return
      shown = mark
      process.stderr.write(
        total === null
          ? `\r  downloading ${name}: ${sizeText(received)}   `
          : `\r  downloading ${name}: ${mark}% of ${sizeText(total)}   `,
      )
    },
    done: (received) => {
      process.stderr.write(`\r  downloaded ${name}, ${sizeText(received)}${' '.repeat(12)}\n`)
    },
  }
}
