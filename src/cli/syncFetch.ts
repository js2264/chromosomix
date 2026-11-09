/**
 * A synchronous range request for Node — what lets the command line read an
 * address by range, as the app does, rather than download it whole (§23.1).
 *
 * The app reads a remote file through `RemoteRangeSource`, whose reads are
 * synchronous because HDF5's are: Emscripten's stream `read` must return a byte
 * count, and a browser worker answers it with a synchronous `XMLHttpRequest`.
 * Node has no such request, which is why the command used to fetch every
 * address to `$TMPDIR` first — seven gigabytes of `.mcool` for a window of one
 * rung.
 *
 * What Node has instead is a thread that may block. A helper thread makes the
 * request with `fetch`, and this one waits for it on a shared word with
 * `Atomics.wait`, then takes the answer off the port it was posted to with
 * `receiveMessageOnPort` — both synchronous, so a read that has to return
 * bytes does. The helper is one short script run from a string, so the command
 * stays one file, and it is `unref`'d: a command that has finished does not wait
 * for a thread that is only waiting for it.
 *
 * Every request asks for `identity`, as the downloader always has: a body the
 * host compressed on the way out is not the bytes the range named. Node, unlike
 * a page, may say so.
 */

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'

import type { SyncRangeAnswer, SyncRangeFetch } from '../sources/RemoteRangeSource'

/** The helper: a request in, the answer out, and the shared word set when it is there. */
const HELPER = `
const { workerData } = require('node:worker_threads')
const { port, signal } = workerData
const flag = new Int32Array(signal)
port.on('message', async (request) => {
  let reply
  try {
    const response = await fetch(request.url, { headers: request.headers })
    const body = new Uint8Array(await response.arrayBuffer())
    reply = { status: response.status, contentRange: response.headers.get('content-range'), body }
  } catch (error) {
    const cause = error && error.cause && error.cause.message ? ' (' + error.cause.message + ')' : ''
    reply = { error: String((error && error.message) || error) + cause }
  }
  port.postMessage(reply, reply.body ? [reply.body.buffer] : [])
  Atomics.store(flag, 0, 1)
  Atomics.notify(flag, 0)
})
`

interface Helper {
  worker: Worker
  port: MessagePort
  flag: Int32Array
}

let helper: Helper | null = null

/** The helper thread, started on the first request and not before. */
function started(): Helper {
  if (helper !== null) return helper
  const { port1, port2 } = new MessageChannel()
  const signal = new SharedArrayBuffer(4)
  const worker = new Worker(HELPER, {
    eval: true,
    workerData: { port: port2, signal },
    transferList: [port2],
  })
  worker.unref()
  port1.unref()
  helper = { worker, port: port1, flag: new Int32Array(signal) }
  return helper
}

/** A synchronous `GET`, through the helper thread. */
export const nodeSyncFetch: SyncRangeFetch = (url, headers): SyncRangeAnswer => {
  const { port, flag } = started()
  Atomics.store(flag, 0, 0)
  port.postMessage({ url, headers: { ...headers, 'accept-encoding': 'identity' } })
  Atomics.wait(flag, 0, 0)
  const received = receiveMessageOnPort(port)
  const reply = received?.message as
    | { status: number; contentRange: string | null; body: Uint8Array }
    | { error: string }
    | undefined
  if (reply === undefined) throw new Error(`${url}: the request thread answered nothing.`)
  if ('error' in reply) throw new Error(`${url} could not be fetched: ${reply.error}.`)
  return { status: reply.status, contentRange: reply.contentRange, body: reply.body }
}

/** The `fetch` a range source probes and reads exactly with, asking for the bytes as they are. */
export const identityFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('accept-encoding', 'identity')
  return fetch(input, { ...init, headers })
}

/** Stop the helper thread, if one was started. Safe to call twice. */
export async function closeSyncFetch(): Promise<void> {
  const held = helper
  helper = null
  if (held === null) return
  held.port.close()
  await held.worker.terminate()
}
