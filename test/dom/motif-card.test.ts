// @vitest-environment jsdom
/**
 * The **Find a sequence** card: what it offers, and what it makes.
 *
 * `motif.test.ts` proves the matcher, `motif-worker.test.ts` proves the request
 * and `motif-track.test.ts` proves the two builders. What is left — and what
 * this file is about — is the part none of those can see: that the card refuses
 * to exist without a reference, that a refusal comes back as a sentence under
 * the field rather than as a thrown error, and that a search leaves exactly two
 * ordinary rows in the store, named so that running the same search twice
 * replaces them instead of stacking a ninth copy up.
 *
 * The worker is a stub. Nothing here reads a FASTA: the point is the wiring
 * between a result and the store, and a real genome would only make it slower to
 * be sure which of the two was being tested.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import type { MotifScanResult } from '@/annotations/worker/protocol'
import { MotifCard } from '@/ui/MotifCard'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MotifCard[] = []

beforeEach(() => {
  teardown = setUpDom()
  sessionStorage.clear()
})

afterEach(() => {
  for (const card of built.splice(0, built.length)) card.destroy()
  teardown()
  sessionStorage.clear()
})

const CONTIGS = [
  { name: 'chrI', length: 1000 },
  { name: 'chrII', length: 500 },
]

/** A scan result in the shape the worker posts back. */
function scan(sites: Record<string, Array<[number, number, number]>>): MotifScanResult {
  const hits = Object.entries(sites).map(([contig, rows]) => ({
    contig,
    starts: Int32Array.from(rows.map((row) => row[0])),
    ends: Int32Array.from(rows.map((row) => row[1])),
    strands: Int8Array.from(rows.map((row) => row[2])),
  }))
  return {
    hits,
    total: Object.values(sites).reduce((sum, rows) => sum + rows.length, 0),
    truncated: false,
    refusal: null,
  }
}

interface Made {
  store: AnnotationStore
  card: MotifCard
  /** Every request the card sent, in order. */
  sent: Array<{ kind: string; [key: string]: unknown }>
}

/**
 * A mounted card over a store, with a stub worker that answers `answer`.
 *
 * `register` is answered with `null`, which is what the real worker returns —
 * the density row's readiness depends on that promise resolving, so a stub that
 * ignored the kind would leave it loading forever and the assertion would be
 * about the stub.
 */
function make(answer: MotifScanResult | Error, sequences = 1): Made {
  const store = new AnnotationStore('ref.fa', { persist: false })
  for (let at = 0; at < sequences; at++) {
    const entry = store.begin({
      card: 'linear',
      kind: 'sequence',
      id: `seq-${at}`,
      label: at === 0 ? 'genome.fa' : `other-${at}.fa`,
      source: { kind: 'remote', name: 'genome.fa', url: 'genome.fa' },
    })
    store.update(entry.id, { status: 'ready' })
  }

  const sent: Array<{ kind: string; [key: string]: unknown }> = []
  const client = {
    request: (payload: { kind: string }) => {
      sent.push(payload as { kind: string })
      if (payload.kind === 'register') return Promise.resolve(null)
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer)
    },
  } as unknown as AnnotationClient

  const card = new MotifCard({ store, client, contigs: () => CONTIGS })
  built.push(card)
  document.body.append(card.el)
  return { store, card, sent }
}

/** Type a pattern and press the button, then let the promise chain settle. */
async function find(card: MotifCard, pattern: string, bothStrands = false): Promise<void> {
  const field = card.el.querySelector('input[type=text]') as HTMLInputElement
  const strands = card.el.querySelector('input[type=checkbox]') as HTMLInputElement
  const go = card.el.querySelector('button') as HTMLButtonElement
  field.value = pattern
  strands.checked = bothStrands
  go.click()
  // Two turns: the search itself, then the register the density row waits on.
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function note(card: MotifCard): string {
  return (card.el.querySelector('.motif-note') as HTMLElement).textContent ?? ''
}

describe('when there is nothing to search', () => {
  it('hides itself rather than offering a control that can only refuse', () => {
    const store = new AnnotationStore('none', { persist: false })
    const card = new MotifCard({
      store,
      client: { request: () => Promise.resolve(null) } as unknown as AnnotationClient,
      contigs: () => CONTIGS,
    })
    built.push(card)
    expect(card.el.classList.contains('hidden')).toBe(true)
  })

  it('appears as soon as a reference finishes loading', () => {
    const store = new AnnotationStore('none', { persist: false })
    const card = new MotifCard({
      store,
      client: { request: () => Promise.resolve(null) } as unknown as AnnotationClient,
      contigs: () => CONTIGS,
    })
    built.push(card)
    const entry = store.begin({
      card: 'linear',
      kind: 'sequence',
      label: 'genome.fa',
      source: { kind: 'remote', name: 'genome.fa', url: 'genome.fa' },
    })
    expect(card.el.classList.contains('hidden'), 'still loading').toBe(true)
    store.update(entry.id, { status: 'ready' })
    expect(card.el.classList.contains('hidden')).toBe(false)
  })
})

describe('choosing which reference to search', () => {
  it('offers no choice when there is one', () => {
    const { card } = make(scan({}))
    const row = card.el.querySelector('.motif-row') as HTMLElement
    expect(row.classList.contains('hidden')).toBe(true)
  })

  it('offers one when there are two', () => {
    const { card } = make(scan({}), 2)
    const row = card.el.querySelector('.motif-row') as HTMLElement
    expect(row.classList.contains('hidden')).toBe(false)
    expect(all(row, 'option').map((node) => node.textContent)).toEqual(['genome.fa', 'other-1.fa'])
  })
})

describe('a search that finds something', () => {
  it('sends the pattern and the strand choice to the worker', async () => {
    const { card, sent } = make(scan({ chrI: [[10, 14, 1]] }))
    await find(card, 'ga tc', true)
    expect(sent[0]).toMatchObject({
      kind: 'motif',
      entry: 'seq-0',
      pattern: 'ga tc',
      bothStrands: true,
    })
  })

  it('leaves a feature row and a density row, and says so', async () => {
    const { store, card } = make(scan({ chrI: [[10, 14, 1], [20, 24, -1]], chrII: [[0, 4, 1]] }))
    await find(card, 'GATC')
    const made = store.entries.filter((entry) => entry.id.startsWith('motif:'))
    expect(made.map((entry) => [entry.kind, entry.status])).toEqual([
      ['segments', 'ready'],
      ['track', 'ready'],
    ])
    expect(note(card)).toContain('3 sites')
  })

  it('puts the sites in the feature row, sorted and with their strands', async () => {
    const { store, card } = make(scan({ chrI: [[20, 24, -1], [10, 14, 1]] }))
    await find(card, 'GATC')
    const row = store.entries.find((entry) => entry.kind === 'segments')
    const payload = row?.payload
    expect(payload?.kind).toBe('features')
    if (payload?.kind !== 'features') throw new Error('not a feature set')
    expect(Array.from(payload.data.start)).toEqual([10, 20])
    expect(Array.from(payload.data.strand)).toEqual([1, -1])
  })

  it('registers the density vector with the worker', async () => {
    const { card, sent } = make(scan({ chrI: [[10, 14, 1]] }))
    await find(card, 'GATC')
    const registered = sent.find((message) => message.kind === 'register')
    expect(registered).toBeDefined()
    expect((registered as unknown as { entry: string }).entry).toMatch(/^motif:density:/)
  })

  /**
   * The reason the ids are derived from the pattern rather than minted. A reader
   * refining a motif runs the same search several times, and nine stacked lanes
   * differing only in an invisible id is a card nobody can tidy.
   */
  it('replaces its own rows when the same search is run again', async () => {
    const { store, card } = make(scan({ chrI: [[10, 14, 1]] }))
    await find(card, 'GATC')
    await find(card, 'GATC')
    expect(store.entries.filter((entry) => entry.id.startsWith('motif:')).length).toBe(2)
  })

  it('makes a separate pair for a different pattern', async () => {
    const { store, card } = make(scan({ chrI: [[10, 14, 1]] }))
    await find(card, 'GATC')
    await find(card, 'AAGG')
    expect(store.entries.filter((entry) => entry.id.startsWith('motif:')).length).toBe(4)
  })

  it('tells the two strand choices apart, so they are two lanes not one', async () => {
    const { store, card } = make(scan({ chrI: [[10, 14, 1]] }))
    await find(card, 'GATC', false)
    await find(card, 'GATC', true)
    const labels = store.entries
      .filter((entry) => entry.kind === 'segments')
      .map((entry) => entry.label)
    expect(labels).toEqual(['GATC', 'GATC (both strands)'])
  })
})

describe('a search that finds nothing, or cannot be run', () => {
  it('says so and makes no rows', async () => {
    const { store, card } = make(scan({}))
    await find(card, 'CCCCCC')
    expect(note(card)).toContain('No match')
    expect(store.entries.filter((entry) => entry.id.startsWith('motif:'))).toEqual([])
  })

  /**
   * A refusal is a fact about what the reader typed. It belongs under the field
   * as a sentence, not as an error banner and not as a thrown promise.
   */
  it('shows a refusal under the field, and marks it', async () => {
    const { store, card } = make({ ...scan({}), refusal: '“X” is not a IUPAC base.' })
    await find(card, 'ACGX')
    expect(note(card)).toContain('X')
    expect((card.el.querySelector('.motif-note') as HTMLElement).classList.contains('warn')).toBe(
      true,
    )
    expect(store.entries.filter((entry) => entry.id.startsWith('motif:'))).toEqual([])
  })

  it('reports a failed request without leaving the button disabled', async () => {
    const { card } = make(new Error('the reference is no longer open'))
    await find(card, 'GATC')
    expect(note(card)).toContain('no longer open')
    expect((card.el.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does nothing at all for an empty field', async () => {
    const { card, sent } = make(scan({}))
    await find(card, '   ')
    expect(sent).toEqual([])
  })
})
