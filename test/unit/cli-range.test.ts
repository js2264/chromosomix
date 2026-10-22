/**
 * The command line reads an address by range, as the app does (SPECS §23.1).
 *
 * It used to download every address whole before reading it, because the
 * app's range reader is synchronous and Node has no synchronous request. It
 * has one now (`cli/syncFetch.ts`): a helper thread fetches while this one
 * waits on a shared word. So what is held here is the thing that change is
 * for, measured where it is paid — at the server:
 *
 * - **the same numbers.** Every file a command writes over an address is the
 *   file it writes over the same bytes on disk, byte for byte below its header;
 * - **fewer bytes.** One rung of an `.mcool` costs that rung's pixels and the
 *   metadata to find them, not the other rungs; a bigWig sampled at a few
 *   thousand peaks costs the blocks under them;
 * - **nothing on disk.** No `chromosomix-` directory appears under `$TMPDIR`
 *   for a map, a bigWig, a `.2bit` or an indexed FASTA read by range, while the
 *   command runs or after it.
 *
 * The server runs on a thread of its own. The thread that runs the command
 * blocks while each range is fetched — that is the whole mechanism — so a
 * server on it would never answer.
 *
 * And the road back, for a host that will not serve a range, is
 * `test/unit/cli.test.ts`'s: its server answers every request whole, and every
 * address there is fetched to disk, as before.
 */

import { readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { main } from '@/cli/main'
import { lazyFilesMounted } from '@/h5/lazyFile'
import { buildTwoBit } from '../support/twoBitWriter'

const DEMO = resolve(__dirname, '../../demo')

/** A range-serving HTTP server, on a thread of its own, counting what it sent. */
const SERVER = `
const { createServer } = require('node:http')
const { openSync, readSync, closeSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')
const sent = {}
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const name = decodeURIComponent(url.pathname.replace(/^\\//, ''))
  let size
  try { size = statSync(join(workerData.root, name)).size } catch {
    response.writeHead(404, 'Not Found'); response.end(); return
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': size }); response.end(); return
  }
  const range = /bytes=(\\d+)-(\\d*)/.exec(request.headers.range || '')
  const from = range ? Number(range[1]) : 0
  const to = range && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1
  const bytes = Buffer.alloc(to - from + 1)
  const fd = openSync(join(workerData.root, name), 'r')
  readSync(fd, bytes, 0, bytes.length, from)
  closeSync(fd)
  const had = sent[name] || { requests: 0, bytes: 0 }
  sent[name] = { requests: had.requests + 1, bytes: had.bytes + bytes.length }
  response.writeHead(range ? 206 : 200, {
    'accept-ranges': 'bytes',
    'content-length': bytes.length,
    ...(range ? { 'content-range': 'bytes ' + from + '-' + to + '/' + size } : {}),
  })
  response.end(bytes)
})
parentPort.on('message', (message) => {
  if (message === 'sent') { parentPort.postMessage({ sent: { ...sent } }); for (const key in sent) delete sent[key] }
  if (message === 'close') server.close(() => parentPort.postMessage({ closed: true }))
})
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }))
`

let directory = ''
let served = ''
let base = ''
let worker: Worker
let scratch = ''
let previousTmp: string | undefined
const errors: string[] = []

/** The next message from the server thread that carries `key`. */
function reply<T>(key: string): Promise<T> {
  return new Promise((answered) => {
    const listen = (message: Record<string, unknown>): void => {
      if (!(key in message)) return
      worker.off('message', listen)
      answered(message[key] as T)
    }
    worker.on('message', listen)
  })
}

/** What the server sent since it was last asked, by file. */
async function sent(): Promise<Record<string, { requests: number; bytes: number }>> {
  const answer = reply<Record<string, { requests: number; bytes: number }>>('sent')
  worker.postMessage('sent')
  return answer
}

/** Every file a command wrote, with its `#` header lines left off, by name. */
async function outputsIn(where: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const name of (await readdir(where)).sort()) {
    const bytes = await readFile(join(where, name))
    const text = bytes.toString('latin1')
    // A text output opens with `# file: …`, which names the address or the
    // path; everything under it is the result.
    out.set(name, text.startsWith('#') ? Buffer.from(text.split('\n').filter((line) => !line.startsWith('#')).join('\n'), 'latin1') : bytes)
  }
  return out
}

/** Run one command over a path and over its address, and hand back both outputs. */
async function both(
  argsFor: (at: (name: string) => string) => string[],
): Promise<{ local: Map<string, Buffer>; remote: Map<string, Buffer>; leftovers: string[] }> {
  const local = await mkdtemp(join(directory, 'local-'))
  const remote = await mkdtemp(join(directory, 'remote-'))
  errors.length = 0
  expect(await main([...argsFor((name) => join(served, name)), '--out', local, '--quiet']), errors.join('')).toBe(0)
  errors.length = 0
  expect(await main([...argsFor((name) => `${base}/${name}`), '--out', remote, '--quiet']), errors.join('')).toBe(0)
  return { local: await outputsIn(local), remote: await outputsIn(remote), leftovers: readdirSync(scratch) }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chromosomix-cli-range-'))
  served = join(directory, 'served')
  await mkdir(served)
  for (const name of ['ecoli/Ecoli.mcool', 'yeast/Yeast_ATAC.bw', 'yeast/Yeast_ATAC.narrowPeak']) {
    await copyFile(join(DEMO, name), join(served, name.split('/')[1]))
  }
  // A two-sequence reference, as a `.2bit` and as a FASTA with its `.fai`.
  const sequences = [
    { name: 'chrI', bases: 'GCGTACGTAT'.repeat(12_000) },
    { name: 'chrII', bases: 'ATATGCGCAT'.repeat(6_000) },
  ]
  await writeFile(join(served, 'genome.2bit'), buildTwoBit(sequences))
  await writeFile(join(served, 'genome.fa'), sequences.map((s) => `>${s.name}\n${s.bases}\n`).join(''))
  let offset = 0
  const fai = sequences.map((s) => {
    offset += s.name.length + 2
    const line = `${s.name}\t${s.bases.length}\t${offset}\t${s.bases.length}\t${s.bases.length + 1}`
    offset += s.bases.length + 1
    return line
  })
  await writeFile(join(served, 'genome.fa.fai'), `${fai.join('\n')}\n`)
  // A contact list, binned on import.
  const rows = ['## pairs format v1.0', '#chromsize: chrI 120000', '#chromsize: chrII 60000',
    '#columns: readID chrom1 pos1 chrom2 pos2 strand1 strand2']
  for (let i = 0; i < 4000; i++) {
    const pos1 = 1 + ((i * 271) % 110_000)
    const pos2 = Math.min(120_000, pos1 + 500 + ((i * 37) % 20_000))
    rows.push(`r${i}\tchrI\t${pos1}\tchrI\t${pos2}\t${'+-'[i % 2]}\t${'+-'[(i >> 1) % 2]}`)
  }
  await writeFile(join(served, 'contacts.pairs'), `${rows.join('\n')}\n`)

  worker = new Worker(SERVER, { eval: true, workerData: { root: served } })
  base = `http://127.0.0.1:${await reply<number>('port')}`

  // Downloads go to $TMPDIR: a fresh one, so that anything left there is ours.
  scratch = await mkdtemp(join(tmpdir(), 'chromosomix-tmpdir-'))
  previousTmp = process.env.TMPDIR
  process.env.TMPDIR = scratch
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  if (previousTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmp
  const closed = reply<boolean>('closed')
  worker.postMessage('close')
  await closed
  await worker.terminate()
  await rm(scratch, { recursive: true, force: true })
  await rm(directory, { recursive: true, force: true })
})

describe('an address read by range', () => {
  it('reads one rung of an .mcool for the numbers its file on disk gives, and not the rest of it', async () => {
    await sent()
    const { local, remote, leftovers } = await both((at) => [
      'insulation',
      `${at('Ecoli.mcool')}::/resolutions/5000`,
    ])
    expect([...remote.keys()]).toEqual([...local.keys()])
    for (const [name, bytes] of local) expect(remote.get(name)?.equals(bytes), name).toBe(true)
    const size = (await stat(join(served, 'Ecoli.mcool'))).size
    const cost = (await sent())['Ecoli.mcool']
    // The 5 kb rung and the metadata to find it: a few megabytes of forty-five.
    expect(cost.bytes).toBeLessThan(size / 4)
    expect(leftovers).toEqual([])
    // Every lazy file the command mounted, unmounted with its map.
    expect(lazyFilesMounted()).toBe(0)
  })

  it('samples a bigWig at an address through the blocks under the features, and no others', async () => {
    await sent()
    const { local, remote, leftovers } = await both((at) => [
      'metaplot',
      '--tracks',
      at('Yeast_ATAC.bw'),
      '--features',
      join(served, 'Yeast_ATAC.narrowPeak'),
    ])
    expect([...remote.keys()]).toEqual([...local.keys()])
    for (const [name, bytes] of local) expect(remote.get(name)?.equals(bytes), name).toBe(true)
    const size = (await stat(join(served, 'Yeast_ATAC.bw'))).size
    expect((await sent())['Yeast_ATAC.bw'].bytes).toBeLessThan(size / 2)
    expect(leftovers).toEqual([])
  })

  it('reads a .2bit and an indexed FASTA at an address by range, the index from beside it', async () => {
    for (const reference of ['genome.2bit', 'genome.fa']) {
      await sent()
      const { local, remote, leftovers } = await both((at) => [
        'motif',
        '--sequence',
        at(reference),
        '--pattern',
        'GTACG',
      ])
      expect([...remote.keys()], reference).toEqual([...local.keys()])
      for (const [name, bytes] of local) expect(remote.get(name)?.equals(bytes), `${reference} ${name}`).toBe(true)
      const cost = await sent()
      // The index beside a FASTA is what makes it ranged: fetched, once.
      if (reference === 'genome.fa') expect(cost['genome.fa.fai']?.requests).toBe(1)
      expect(leftovers).toEqual([])
    }
  })

  it('imports a .pairs at an address as it imports one on disk', async () => {
    const { local, remote, leftovers } = await both((at) => [
      'coverage',
      at('contacts.pairs'),
      '--bin-size',
      '5000',
      '--rungs',
      '2',
    ])
    expect([...remote.keys()]).toEqual([...local.keys()])
    for (const [name, bytes] of local) expect(remote.get(name)?.equals(bytes), name).toBe(true)
    expect(leftovers).toEqual([])
  })

  it('compares a map with one at an address, by range', async () => {
    const map = `${join(served, 'Ecoli.mcool')}::/resolutions/10000`
    const { local, remote } = await both((at) => [
      'hicrep',
      map,
      '--against',
      `${at('Ecoli.mcool')}::/resolutions/10000`,
    ])
    // The pair is named by its file in both, so every table is the same table.
    for (const [name, bytes] of local) expect(remote.get(name)?.equals(bytes), name).toBe(true)
  })

  it('names an address that is not there, with its status, and reads nothing else for it', async () => {
    errors.length = 0
    const where = await mkdtemp(join(directory, 'missing-'))
    expect(await main(['coverage', `${base}/absent.cool`, '--out', where, '--quiet'])).toBe(1)
    expect(errors.join('')).toMatch(/absent\.cool answered 404\./)
    expect(readdirSync(scratch)).toEqual([])
  })
})
