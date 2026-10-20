/**
 * A PDB through the annotations worker's own door (§25.2).
 *
 * The reader has its own tests (`pdb.test.ts`); this is the wiring — that
 * `load` sends a PDB to the PDB reader before any text sniffer can take it for
 * a BED, that one this app wrote lands as the structure it was written from,
 * that any other comes back as the refusal under the row, and that a PDB
 * dropped on an empty window declares the genome its beads cover, as a bed3d
 * does.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { structureFromBeads, writeBed3d, type ModelBead } from '@/annotations/g3d'
import { writePdb } from '@/annotations/pdb'
import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { AnnotationPayload, FeatureSet } from '@/annotations/types'

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

function local(text: string, name: string): { kind: 'local'; file: File; name: string } {
  return { kind: 'local', file: new File([text], name), name }
}

const BEADS: ModelBead[] = [
  { contig: 'chrI', start: 0, end: 5000, x: 0, y: 0, z: 0 },
  { contig: 'chrI', start: 5000, end: 10000, x: 1, y: 0, z: 0 },
  { contig: 'chrI', start: 10000, end: 15000, x: 1, y: 1, z: 0 },
  { contig: 'chrII', start: 0, end: 5000, x: -1, y: -1, z: 0 },
  { contig: 'chrII', start: 5000, end: 10000, x: -1, y: -2, z: 0.5 },
]

const MAP = [
  { name: 'chrI', length: 230_218 },
  { name: 'chrII', length: 813_184 },
]

describe('a PDB through the worker', () => {
  it('lands as the structure it was written from, under its own name or any other', async () => {
    const set = structureFromBeads(BEADS, 5000)
    const text = writePdb(set, { label: 'yeast model' })
    for (const name of ['model.pdb', 'model.txt']) {
      const response = await ask({ kind: 'load', entry: `pdb-${name}`, source: local(text, name), mapContigs: MAP })
      expect(response.type, JSON.stringify(response)).toBe('result')
      const held = (response as { payload: { format: string; summary: string; payload: AnnotationPayload } }).payload
      expect(held.format).toBe('structure')
      expect(held.summary).toBe('5 beads · 5 kb · 2 sequences')
      const data = (held.payload as { kind: 'features'; data: FeatureSet }).data
      expect(data.contigs).toEqual(['chrI', 'chrII'])
      expect(Array.from(data.start)).toEqual(Array.from(set.start))
      expect(data.model?.y[4]).toBeCloseTo(-2, 3)
    }
  })

  it('comes back refused, in the reader’s words, for a PDB that does not place its beads', async () => {
    const pastis = 'ATOM      0 O    NOD A         276.405 140.016 197.874  1.00 50.00    \n' +
      'ATOM      1 O    EDG A         324.089 286.756   2.272  1.00 75.00    \n'
    const response = await ask({ kind: 'load', entry: 'pdb-pastis', source: local(pastis, 'MDS.structure.pdb'), mapContigs: MAP })
    expect(response.type).toBe('error')
    expect((response as { message: string }).message).toMatch(/bin order and nothing else/)
  })

  it('declares the genome its beads cover, dropped on an empty window, as its bed3d does', async () => {
    const set = structureFromBeads(BEADS, 5000)
    const declared = async (text: string, name: string) => {
      const response = await ask({ kind: 'assembly', source: local(text, name) })
      expect(response.type, JSON.stringify(response)).toBe('result')
      return (response as { payload: { format: string; contigs: Array<{ name: string }>; exact: boolean } }).payload
    }
    const pdb = await declared(writePdb(set), 'model.pdb')
    const bed3d = await declared(writeBed3d(set), 'model.bed3d')
    expect(pdb.format).toBe('structure')
    expect(pdb.exact).toBe(false)
    expect(pdb.contigs.map((contig) => contig.name)).toEqual(['chrI', 'chrII'])
    expect(pdb.contigs).toEqual(bed3d.contigs)
  })
})
