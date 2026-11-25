// @vitest-environment jsdom
// @dev-feature metacool
/**
 * What the genome view asks its reader for (§5.2, §6.4).
 *
 * The pair, region and whole views asked for the score on every read — balanced
 * or not, and which `/pixels` column — and this one asked for neither: a
 * genome's map was its raw counts whatever its picker said, `balanced` on a
 * file with `weight`, a balance by a column by name, or another column of the
 * file. The picker and the caption said one thing and the picture another.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GenomeView } from '@/ui/GenomeView'
import type { ReaderClient } from '@/worker/client'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: GenomeView[] = []

beforeEach(() => {
  // `MatrixPanel` refuses to be built without a context; nothing here is drawn.
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const view of built.splice(0, built.length)) view.destroy()
  teardown()
})

/** The view, with a reader that answers the genome's extent and records every read after it. */
async function reads(props: { balance: boolean; value?: string; level: 'bin' | 'contig' }) {
  const asked: Array<Record<string, unknown>> = []
  const client = {
    request: (request: Record<string, unknown>) => {
      if (request['kind'] === 'range') return Promise.resolve({ extent: [0, 40], label: 'MAG_1' })
      asked.push(request)
      // The map stays loading: what was asked is all this file is about.
      return new Promise(() => {})
    },
    cancellable: (request: Record<string, unknown>) => {
      asked.push(request)
      return { cancel: () => {}, promise: new Promise(() => {}) }
    },
  } as unknown as ReaderClient
  const view = new GenomeView({
    client,
    binsize: 1000,
    genome: 'MAG_1',
    level: props.level,
    scale: {},
    balance: props.balance,
    hasWeights: props.balance,
    ...(props.value === undefined ? {} : { value: props.value }),
    onScoreChange: () => {},
    onScaleChange: () => {},
    onOpenRegion: () => {},
    onOpenContigPair: () => {},
    onError: () => {},
  })
  built.push(view)
  document.body.append(view.el)
  for (let i = 0; i < 20 && asked.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  return asked
}

describe('the genome view’s reads (§5.2)', () => {
  it('asks for the balanced map where its score is balanced', async () => {
    const asked = await reads({ balance: true, level: 'bin' })
    expect(asked[0]).toMatchObject({ kind: 'matrix', rows: [0, 40], balance: true })
  })

  it('asks for the counts where it is not, and for the column its score names', async () => {
    const asked = await reads({ balance: false, value: 'balanced_counts', level: 'bin' })
    expect(asked[0]).toMatchObject({ kind: 'matrix', balance: false, value: 'balanced_counts' })
  })

  it('asks for the balanced roll-up at contig level too', async () => {
    const asked = await reads({ balance: true, level: 'contig' })
    expect(asked[0]).toMatchObject({ kind: 'aggregate', level: 'contig', balance: true })
  })
})
