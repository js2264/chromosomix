/**
 * A text structure through the annotations worker: what it opens as (§25.2).
 *
 * `g3d-parse.test.ts` proves the readers read. This proves the **routing**,
 * which is where every format-shaped bug in this app has actually lived:
 * `sniffFormat` has no "none of mine" answer — its last line is `return 'bed'`
 * — so a file the worker does not recognise first is silently parsed as a BED.
 *
 * The file that brought this test is a real one: `myco.nb.bed3d` and the
 * `myco.nb.g3d` beside it, 1,683 beads at 8 kb from a pastis-NB run, with 33
 * bins the solver was given nothing to place and wrote `nan` for. The first of
 * those `nan` rows is 31 rows in, and it made the sniffer answer *not a
 * structure* for the whole file. What the reader saw was the pair of failures
 * this file exists to keep shut:
 *
 * - the **bed3d** was drawn as a **track** — its third column is an integer
 *   end, so `parseBed` took it happily and made a lane of 1,683 boxes whose
 *   name is an x coordinate;
 * - the **g3d** landed on the Structures card, because `guessOf` routes a drop
 *   by name, and then failed with *"all 1,683 lines failed the contig, start,
 *   end test that every BED-like format begins with"* — a message naming a
 *   format the reader never handed over, on a card that had already said the
 *   file was a structure.
 *
 * Driven through `self.onmessage`, the worker's real front door, so the sniff
 * order and the dispatch are both in the path. Not jsdom, for the reason
 * `vcf-lane.test.ts` gives: the worker wants `self`, `File` and `Blob`.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { AnnotationPayload, FeatureSet } from '@/annotations/types'
import { cardFor, kindFor } from '@/annotations/loader'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (m: AnnotationResponse) => {
    posted.push(m)
  }
  await import('@/annotations/worker/annotations.worker')
  const handler = (globalThis as unknown as { onmessage: (e: { data: AnnotationRequest }) => void })
    .onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1

type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  for (let turn = 0; turn < 4000; turn++) {
    const found = posted.find((m) => 'id' in m && m.id === id && m.type !== 'progress')
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`no answer for request ${id}`)
}

/**
 * Forty beads on two sequences at 8 kb, in the notation numpy writes, with
 * three the solver could not place — the shape of the file this test is about,
 * at a size a test can read.
 */
function model(layout: 'g3d' | 'bed3d'): string {
  const lines: string[] = []
  for (const contig of ['chrI', 'chrII']) {
    for (let at = 0; at < 20; at++) {
      const place = (turn: number): string =>
        (Math.cos(at / 3 + turn) * (1 + at / 40)).toExponential(18)
      // Three bins nothing mapped to: `nan` where the coordinates go, and the
      // genomic columns filled in like any other row.
      const spot = contig === 'chrI' && (at === 4 || at === 5) ? 'nan' : contig === 'chrII' && at === 11 ? 'nan' : null
      const columns = [contig, String(at * 8000)]
      if (layout === 'bed3d') columns.push(String((at + 1) * 8000))
      columns.push(...(spot === null ? [place(0), place(2), place(4)] : [spot, spot, spot]))
      lines.push(columns.join('\t'))
    }
  }
  return lines.join('\n') + '\n'
}

const MAP = [
  { name: 'chrI', length: 160_000 },
  { name: 'chrII', length: 160_000 },
]

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

describe('opening a structure whose solver left bins unplaced', () => {
  for (const [layout, name] of [
    ['bed3d', 'myco.nb.bed3d'],
    ['g3d', 'myco.nb.g3d'],
  ] as const) {
    it(`opens a ${layout} as a structure, not as a lane of boxes`, async () => {
      const response = await ask({
        kind: 'load',
        entry: `s-${layout}`,
        source: { kind: 'local', file: new File([model(layout)], name), name },
        mapContigs: MAP,
      })
      const { format, data } = payloadOf(response)
      expect(format).toBe('structure')
      // The three unplaced beads are dropped and the other thirty-seven are all
      // there, each with the place its row gave it.
      expect(data.length).toBe(37)
      expect(data.model?.width).toBe(8000)
      expect(data.contigs).toEqual(['chrI', 'chrII'])
      // …and the row it makes is a Structures row, which is the whole of what
      // the reader was missing: the card follows the format, not the zone.
      expect(cardFor(format as 'structure')).toBe('structure')
      expect(kindFor('structure', 'structure')).toBe('structure')
    })

    it(`names the genome a ${layout} is on, so the drop takes the structure road`, async () => {
      // The other question the worker is asked about a dropped file, and it is
      // asked *first*: `assembly` decides whether the file opens a browser and
      // over which sequences. It has a sniff order of its own, so it is pinned
      // here rather than assumed from the load above.
      const response = await ask({
        kind: 'assembly',
        source: { kind: 'local', file: new File([model(layout)], name), name },
      })
      expect(response.type, JSON.stringify(response)).toBe('result')
      const held = response as { payload: { format: string; contigs: { name: string; length: number }[] } }
      expect(held.payload.format).toBe('structure')
      // Every sequence ends at its last bead, rounded up the way `contigsOf`
      // rounds every inferred length: the lower bound any feature file gives
      // (§5.8), not a length the file states.
      expect(held.payload.contigs.map((contig) => contig.name)).toEqual(['chrI', 'chrII'])
      expect(held.payload.contigs[0].length).toBe(161_000)
      expect((held.payload as unknown as { exact: boolean }).exact).toBe(false)
    })
  }

  it('is still a BED when it is one, whatever the name on the file', async () => {
    // The other side of the rule: a name claims the *format*, and the parser
    // then says what is wrong with a file that is not one. What it must not do
    // is draw the file as something else and say nothing.
    const bed = ['chrI\t0\t5000\tpeak1\t900\t+', 'chrI\t5000\t10000\tpeak2\t850\t-'].join('\n')
    const response = await ask({
      kind: 'load',
      entry: 's-not',
      source: { kind: 'local', file: new File([bed], 'muddle.bed3d'), name: 'muddle.bed3d' },
      mapContigs: MAP,
    })
    expect(response.type).toBe('error')
    expect((response as { message: string }).message).toMatch(/chromosome, start, end, x, y, z/)
  })
})
