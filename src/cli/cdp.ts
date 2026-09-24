/**
 * The Chrome DevTools protocol, over the two pipes a browser opens for it.
 *
 * `metacooler-plot` (§27) drives a headless Chromium, and every library that
 * does that is a dependency this repository has decided against for the same
 * reason `metacooler-run` parses its own arguments: what is needed is small and
 * fixed. It is this — a JSON message per request, an id to match the answer
 * by, a session id to address one page, and a handful of events.
 *
 * **Pipes rather than a port.** `--remote-debugging-pipe` makes the browser read
 * the protocol from its file descriptor 3 and write it to 4, one JSON message
 * after another with a NUL byte between them. No port is opened, so nothing
 * else on the machine can connect to the browser this command is driving, and
 * no WebSocket client is needed to talk to it. It is what the two big driver
 * libraries use by default for the same two reasons.
 */

import type { Readable, Writable } from 'node:stream'

/** A protocol message, either way. */
interface Message {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: string }
  sessionId?: string
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void

/** One browser's protocol connection. */
export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  /** Bytes after the last NUL, waiting for the rest of their message. */
  private partial: Buffer[] = []
  private failure: Error | null = null

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.on('data', (chunk: Buffer) => this.receive(chunk))
    output.on('close', () => this.fail(new Error('the browser closed its end of the DevTools pipe')))
    output.on('error', (error: Error) => this.fail(error))
    input.on('error', (error: Error) => this.fail(error))
  }

  /** Why the connection is gone, once it is. */
  get closed(): Error | null {
    return this.failure
  }

  /** Send one command and wait for its answer. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.failure !== null) return Promise.reject(this.failure)
    const id = this.nextId++
    const message: Message = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      this.input.write(`${JSON.stringify(message)}\0`)
    })
  }

  /** Listen for an event; returns the way to stop. */
  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  /** Fail everything still waiting, and refuse anything sent after. */
  fail(error: Error): void {
    if (this.failure !== null) return
    this.failure = error
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  private receive(chunk: Buffer): void {
    let from = 0
    for (let at = chunk.indexOf(0); at >= 0; at = chunk.indexOf(0, from)) {
      this.partial.push(chunk.subarray(from, at))
      const text = Buffer.concat(this.partial).toString('utf8')
      this.partial = []
      from = at + 1
      this.dispatch(text)
    }
    if (from < chunk.length) this.partial.push(chunk.subarray(from))
  }

  private dispatch(text: string): void {
    let message: Message
    try {
      message = JSON.parse(text) as Message
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}${message.error.data === undefined ? '' : ` (${message.error.data})`}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (message.method === undefined) return
    for (const listener of this.listeners.get(message.method) ?? []) {
      listener(message.params ?? {}, message.sessionId)
    }
  }
}

/** What `Runtime.evaluate` answers. */
interface EvaluateResult {
  result: { type: string; value?: unknown; description?: string }
  exceptionDetails?: {
    text: string
    exception?: { description?: string; value?: unknown }
  }
}

/** One page, addressed through its flattened session. */
export class CdpPage {
  constructor(
    readonly connection: CdpConnection,
    readonly sessionId: string,
  ) {}

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId)
  }

  /** Listen for one of this page's events. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) listener(params)
    })
  }

  /**
   * Evaluate an expression in the page, wait for it if it is a promise, and
   * hand back its value as JSON.
   *
   * A thrown error comes back as an `Error` carrying the page's own message —
   * its first line, which is the sentence; the stack under it is about this
   * app's bundle and says nothing to the person at the shell.
   */
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (answer.exceptionDetails !== undefined) {
      const described = answer.exceptionDetails.exception?.description
      const text =
        typeof described === 'string' && described !== ''
          ? described.split('\n')[0]
          : answer.exceptionDetails.text
      throw new Error(text.replace(/^(Uncaught )?(\w*Error: )?/, ''))
    }
    return answer.result.value as T
  }

  /** Call a method of an object on `window`, its arguments passed as JSON. */
  call<T>(target: string, method: string, ...args: unknown[]): Promise<T> {
    return this.evaluate<T>(`window.${target}.${method}(...${JSON.stringify(args)})`)
  }
}
