/**
 * A binary g3d through the annotations worker's own door (§25.2).
 *
 * The reader has its oracle test (`g3d-binary-oracle.test.ts`); this is the
 * wiring — that `load` recognises the container by its magic before any text
 * sniffer sees it, opens the finest model, names the others under the row, and
 * that a text g3d beside it still goes the text road. Skipped without the
 * fixtures `scripts/make_g3d_fixtures.py` writes.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { AnnotationPayload, FeatureSet } from '@/annotations/types'

const DIR = join(__dirname, '..', 'fixtures', 'structure')
const TOY = join(DIR, 'toy.g3d')
const TOY_TEXT = join(DIR, 'toy.g3d.txt')
const MANIFEST = join(DIR, 'g3d-manifest.json')
const suite = [TOY, TOY_TEXT, MANIFEST].every((path) => existsSync(path)) ? describe : describe.skip

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (message: AnnotationResponse) => {
    posted.push(message)
  }
  await import('@/annotations/worker/annotations.worker')
  const handler = (globalThis as unknown as { onmessage: (event: { data: AnnotationRequest }) => void })
    .onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1
type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

function settled(id: number): AnnotationResponse | undefined {
  return posted.find((message) => 'id' in message && message.id === id && message.type !== 'progress')
}

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  await vi.waitFor(() => {
    expect(settled(id)).toBeDefined()
  })
  return settled(id) as AnnotationResponse
}

function payloadOf(response: AnnotationResponse): { format: string; summary: string; data: FeatureSet } {
  expect(response.type, JSON.stringify(response)).toBe('result')
  const held = response as { payload: { format: string; summary: string; payload: AnnotationPayload } }
  expect(held.payload.payload.kind).toBe('features')
  return {
    format: held.payload.format,
    summary: held.payload.summary,
    data: (held.payload.payload as { kind: 'features'; data: FeatureSet }).data,
  }
}

const MAP = [
  { name: 'chr1', length: 1_000_000 },
  { name: 'chr2', length: 600_000 },
]

suite('a binary g3d through the worker', () => {
  it('is recognised by its magic and opened at its finest resolution', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      toy: { resolutions: number[]; categories: string[] }
    }
    const finest = Math.min(...manifest.toy.resolutions)
    const response = await ask({
      kind: 'load',
      entry: 'g3d-bin',
      source: { kind: 'local', file: new File([readFileSync(TOY)], 'toy.g3d'), name: 'toy.g3d' },
      mapContigs: MAP,
    })
    const { format, summary, data } = payloadOf(response)
    expect(format).toBe('structure')
    expect(data.model?.width).toBe(finest)
    expect(data.model?.haplotypes).toEqual(manifest.toy.categories)
    expect(summary).toContain('binary g3d')
    expect(summary).toContain(`${manifest.toy.resolutions.length} resolutions`)
    for (const other of manifest.toy.resolutions.filter((r) => r !== finest)) {
      expect(summary).toContain(`${other}`)
    }
  })

  it('lands on the same beads as the text g3d it was written from', async () => {
    const binary = payloadOf(
      await ask({
        kind: 'load',
        entry: 'g3d-bin-2',
        source: { kind: 'local', file: new File([readFileSync(TOY)], 'toy.g3d'), name: 'toy.g3d' },
        mapContigs: MAP,
      }),
    )
    const text = payloadOf(
      await ask({
        kind: 'load',
        entry: 'g3d-text',
        source: {
          kind: 'local',
          file: new File([readFileSync(TOY_TEXT)], 'toy.g3d.txt'),
          name: 'toy.g3d.txt',
        },
        mapContigs: MAP,
      }),
    )
    expect(text.format).toBe('structure')
    expect(text.summary).not.toContain('binary')
    // The container was written at the finest rung from these very rows, so
    // the two readers agree bead for bead — coordinates within float precision.
    // Compared by name and locus rather than by row: the two roads number
    // their sequences in the order they first met them, and the text file's
    // rows are not in the container's sorted order.
    const key = (set: FeatureSet, i: number): string => `${set.contigs[set.contig[i]]}:${set.start[i]}:${set.detail[i]}`
    const beadsOf = (set: FeatureSet): Map<string, number> =>
      new Map(Array.from({ length: set.length }, (_, i) => [key(set, i), set.model?.x[i] ?? Number.NaN]))
    const fromBinary = beadsOf(binary.data)
    const fromText = beadsOf(text.data)
    expect(fromBinary.size).toBe(text.data.length)
    expect([...fromBinary.keys()].sort()).toEqual([...fromText.keys()].sort())
    for (const [bead, x] of fromBinary) expect(x).toBeCloseTo(fromText.get(bead) ?? Number.NaN, 4)
  })
})
