/**
 * The correlation matrix shared across helper workers (`analysis/pearsonThreads.ts`).
 *
 * What has to hold is that sharing changes nothing but the time: every line is
 * the line one thread would have computed, handed over in row order with the
 * caller asked before each; a helper that cannot start, or fails partway, leaves
 * its rows to be computed by the thread that asked; a stop terminates every
 * helper still working; and a helper that finished is kept for the next square,
 * where nothing it sent for the last one can be taken for the next one's. The
 * helpers here are in-process stand-ins that run the real job (`runGramJob`) and
 * hand its messages over a task apart, as a worker would, so it is the real
 * arithmetic crossing a real message boundary — the transfer of its buffers
 * included.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { BAND, pearsonRows } from '@/analysis/pearsonRows'
import {
  pearsonRowsThreaded,
  runGramJob,
  stretchesFor,
  useCorrelationThreads,
  type GramJob,
  type GramMessage,
} from '@/analysis/pearsonThreads'

afterEach(() => useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 0))

/**
 * A helper that runs the job and hands its messages over a task apart, and can be
 * told to fail, or to send first a band it says belongs to the job before.
 */
class FakeHelper {
  static started = 0
  static terminated = 0
  onmessage: ((event: MessageEvent<GramMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  jobs = 0
  private alive = true
  private lastId: number | null = null
  constructor(
    private readonly failAfter = Number.POSITIVE_INFINITY,
    private readonly echo = false,
  ) {
    FakeHelper.started++
  }
  postMessage(job: GramJob, transfer: Transferable[]): void {
    // Transferred buffers are the sender's no longer: a copy stands in for the move.
    expect(transfer.length).toBeGreaterThan(0)
    this.jobs++
    const messages: GramMessage[] = []
    if (this.echo && this.lastId !== null) {
      // A band of the job before, arriving late: lines that are all wrong.
      const r1 = Math.min(job.to, job.first + BAND)
      messages.push({ kind: 'band', id: this.lastId, r0: job.first, r1, lines: new Float32Array((r1 - job.first) * job.m).fill(0.5) })
    }
    this.lastId = job.id
    runGramJob(structuredClone(job), (message) => messages.push(message))
    let sent = 0
    const next = (): void => {
      const message = messages.shift()
      if (!this.alive || message === undefined) return
      if (message.kind === 'band' && message.id === job.id && sent++ >= this.failAfter) {
        this.onerror?.({ preventDefault: () => {} } as ErrorEvent)
        this.alive = false
        return
      }
      this.onmessage?.({ data: message } as MessageEvent<GramMessage>)
      setTimeout(next, 0)
    }
    setTimeout(next, 0)
  }
  terminate(): void {
    this.alive = false
    FakeHelper.terminated++
  }
}

/** A seeded O/E-like square with a few gaps, or with whole blocks missing. */
function square(m: number, blocks = false): Float64Array {
  let s = 5
  const out = new Float64Array(m * m)
  for (let r = 0; r < m; r++) {
    for (let c = r; c < m; c++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const value = 1 + ((r % 40 < 20) === (c % 40 < 20) ? 0.3 : -0.2) + (s / 0x7fffffff - 0.5) * 0.6
      out[r * m + c] = value
      out[c * m + r] = value
    }
  }
  for (let r = 0; r < m; r++) {
    for (let c = Math.max(0, r - 1); c <= Math.min(m - 1, r + 1); c++) out[r * m + c] = Number.NaN
  }
  if (blocks) {
    const group = (i: number): number => Math.floor((i * 3) / m)
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) if (group(r) === group(c)) out[r * m + c] = Number.NaN
  }
  return out
}

/** Every line, and the rows the caller was asked about, by the road given. */
async function lines(values: Float64Array, m: number, threaded: boolean) {
  const out = new Float64Array(m * m).fill(Number.NaN)
  const asked: number[] = []
  const run = threaded ? pearsonRowsThreaded : pearsonRows
  await run(
    { m, row: (r, into) => into.set(values.subarray(r * m, (r + 1) * m)) },
    (a, line) => {
      for (let b = a + 1; b < m; b++) out[a * m + b] = line[b]
    },
    (row) => {
      asked.push(row)
    },
  )
  return { out, asked }
}

function worstDifference(a: Float64Array, b: Float64Array): number {
  let worst = 0
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) !== Number.isNaN(b[i])) return Number.POSITIVE_INFINITY
    if (!Number.isNaN(a[i])) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  }
  return worst
}

describe('where the stretches start', () => {
  it('divides the triangle evenly among the helpers, on whole bands, and keeps a little less', () => {
    const m = 4096
    const edges = stretchesFor(m, m, 3)
    expect(edges[0]).toBe(0)
    expect(edges.at(-1)).toBe(m)
    expect(edges).toHaveLength(5)
    const work = (from: number, to: number): number => (m - from) ** 2 - (m - to) ** 2
    for (let t = 1; t < edges.length - 1; t++) expect(edges[t] % BAND).toBe(0)
    const [own, ...theirs] = edges.slice(1).map((to, t) => work(edges[t], to) / m ** 2)
    // Its own, less for the lines it writes out; the helpers', equal to a band.
    for (const share of theirs) expect(share).toBeCloseTo(1 / 3.9, 1)
    expect(own).toBeLessThan(Math.min(...theirs))
    expect(own).toBeGreaterThan(0.8 * Math.min(...theirs))
  })

  it('shares out fewer where the helpers’ copies would not fit', () => {
    // 8,192 bins is 256 MB of rows: three helpers would be sent twice that.
    expect(stretchesFor(8192, 8192, 3).length).toBeLessThan(5)
    expect(stretchesFor(8192, 8192, 3).length).toBeGreaterThan(2)
    expect(stretchesFor(4096, 4096, 0)).toEqual([0, 4096])
  })
})

describe('the correlation on several threads', () => {
  it('gives every line one thread gives, and asks after every row in order', async () => {
    const m = 1100
    useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 3)
    const started = FakeHelper.started
    const values = square(m)
    const one = await lines(values, m, false)
    const shared = await lines(values, m, true)
    expect(FakeHelper.started - started).toBe(3)
    expect(worstDifference(one.out, shared.out)).toBeLessThan(1e-6)
    expect(shared.asked).toEqual([...Array(m).keys()])
  })

  it('does the same where rows miss whole blocks', async () => {
    const m = 1100
    useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 2)
    const values = square(m, true)
    expect(worstDifference((await lines(values, m, false)).out, (await lines(values, m, true)).out)).toBeLessThan(1e-6)
  })

  it('computes here what a helper could not: one that failed partway, one that never started', async () => {
    const m = 1100
    let spawned = 0
    useCorrelationThreads(() => {
      spawned++
      if (spawned === 2) throw new Error('no workers from here')
      return new FakeHelper(spawned === 1 ? 1 : Number.POSITIVE_INFINITY) as unknown as Worker
    }, 3)
    const terminated = FakeHelper.terminated
    const values = square(m)
    const one = await lines(values, m, false)
    const shared = await lines(values, m, true)
    expect(worstDifference(one.out, shared.out)).toBeLessThan(1e-6)
    expect(shared.asked).toEqual([...Array(m).keys()])
    // The one that failed is let go rather than kept for the next square.
    expect(FakeHelper.terminated - terminated).toBe(1)
  })

  it('stops every helper still working when the caller stops it, and keeps none of them', async () => {
    const m = 1100
    useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 3)
    const terminated = FakeHelper.terminated
    const started = FakeHelper.started
    const values = square(m)
    await expect(
      pearsonRowsThreaded(
        { m, row: (r, into) => into.set(values.subarray(r * m, (r + 1) * m)) },
        () => {},
        (row) => {
          if (row === 0) throw new Error('stopped')
        },
      ),
    ).rejects.toThrow('stopped')
    expect(FakeHelper.terminated - terminated).toBe(3)
    // …so the next square starts its own.
    await lines(values, m, true)
    expect(FakeHelper.started - started).toBe(6)
  })

  it('keeps the helpers that finished for the next square', async () => {
    const m = 1100
    const made: FakeHelper[] = []
    useCorrelationThreads(() => {
      const helper = new FakeHelper()
      made.push(helper)
      return helper as unknown as Worker
    }, 3)
    const terminated = FakeHelper.terminated
    const values = square(m)
    const one = await lines(values, m, false)
    await lines(values, m, true)
    const again = await lines(square(m, true), m, true)
    expect(made).toHaveLength(3)
    expect(made.map((helper) => helper.jobs)).toEqual([2, 2, 2])
    expect(FakeHelper.terminated - terminated).toBe(0)
    expect(worstDifference(again.out, (await lines(square(m, true), m, false)).out)).toBeLessThan(1e-6)
    expect(worstDifference(one.out, (await lines(values, m, true)).out)).toBeLessThan(1e-6)
    // Told to use none, it lets the ones it kept go.
    useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 0)
    expect(FakeHelper.terminated - terminated).toBe(3)
  })

  it('never reads a band a kept helper sent for the square before as the next one’s', async () => {
    const m = 1100
    useCorrelationThreads(() => new FakeHelper(Number.POSITIVE_INFINITY, true) as unknown as Worker, 3)
    const values = square(m)
    await lines(values, m, true)
    const one = await lines(values, m, false)
    expect(worstDifference(one.out, (await lines(values, m, true)).out)).toBeLessThan(1e-6)
  })

  it('stays on one thread for a small square, and where nothing allowed helpers', async () => {
    const started = FakeHelper.started
    useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 3)
    await lines(square(300), 300, true)
    useCorrelationThreads(() => new FakeHelper() as unknown as Worker, 0)
    await lines(square(1100), 1100, true)
    expect(FakeHelper.started).toBe(started)
  })
})
