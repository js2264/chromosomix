/**
 * A demo map with an assembly that is wrong where no picture cell has an edge
 * (SPECS §27.5, §27.11): the yeast demo's `.hic`, every rung lifted through a
 * scramble at kilobase breakpoints — IV turned from 403 to 797 kb, 196 kb of XI
 * moved into II at 303 kb turned, IX joined to III — and written as an
 * `.mcool` under `data/scrambled/`, with a session config beside the gallery's
 * others under `out/scrambled/`. For the stage's gallery of the refinement:
 *
 *   npx vite-node scripts/make-scrambled-demo.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'

import { writableEdit } from '../src/edit/exports'
import { liftedTable } from '../src/edit/liftedContacts'
import { emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../src/genome/edit'
import { MetaCooler } from '../src/metacooler/MetaCooler'
import type { BinnedPixels } from '../src/pairs/bin'
import type { PairsHeader } from '../src/pairs/format'
import { writeMcool } from '../src/pairs/write'
import { LocalFileSource } from '../src/sources/LocalFileSource'

const HIC = new URL('../demo/yeast/Yeast_hic.hic', import.meta.url).pathname
const RUNGS = [1000, 2000, 4000, 8000, 16000]
const SCRAMBLE: EditStep[] = [
  { op: 'invert', sequence: 'IV', from: 403_000, to: 797_000 },
  { op: 'move', sequence: 'XI', from: 101_000, to: 297_000, into: 'II', at: 303_000, strand: -1 },
  { op: 'join', a: 'IX', aEnd: 'end', b: 'III', bEnd: 'start', gap: 0 },
]

async function main(): Promise<void> {
  const tables = new Map<number, BinnedPixels>()
  let contigs: PairsHeader['contigs'] = []
  for (const size of RUNGS) {
    const source = await LocalFileSource.fromPath(HIC)
    await source.mount()
    const hic = MetaCooler.fromHic(`${HIC}::/resolutions/${size}`, source)
    try {
      let edit: ReferenceEdit = emptyEdit({ names: [...hic.chromnames], lengths: Array.from(hic.coords.contigLengths) })
      SCRAMBLE.forEach((step, i) => {
        edit = withStep(edit, step, 'reader', i)
      })
      const { map, refusal } = MetaCooler.withLens(hic, writableEdit(edit))
      if (refusal !== null) throw new Error(refusal)
      const table = await liftedTable(map)
      if (table === null) throw new Error('cancelled')
      tables.set(size, table)
      contigs = table.contigs
    } finally {
      hic.close()
    }
  }
  const header: PairsHeader = {
    version: '',
    assembly: null,
    sorted: null,
    shape: null,
    contigs,
    columns: { chrom1: 1, pos1: 2, chrom2: 3, pos2: 4, strand1: -1, strand2: -1 } as PairsHeader['columns'],
    text: '',
  }
  const bytes = await writeMcool(
    { header, rungs: RUNGS, tables, indexed: false, declaredRecords: null },
    { about: { generatedBy: 'metacooler scripts/make-scrambled-demo', metadata: () => ({ scrambled: SCRAMBLE }) } },
  )
  if (bytes === null) throw new Error('cancelled')
  const data = new URL('../data/scrambled/', import.meta.url).pathname
  mkdirSync(data, { recursive: true })
  writeFileSync(`${data}Yeast_scrambled.mcool`, bytes)
  const out = new URL('../out/scrambled/', import.meta.url).pathname
  mkdirSync(out, { recursive: true })
  writeFileSync(
    `${out}Scrambled.metacooler.json`,
    JSON.stringify(
      {
        kind: 'metacooler.workspace',
        version: 1,
        createdAt: '2026-09-30T00:00:00.000Z',
        active: 0,
        tabs: [
          {
            version: 1,
            createdAt: '2026-09-30T00:00:00.000Z',
            state: {
              uri: '/data/scrambled/Yeast_scrambled.mcool::/resolutions/1000',
              view: 'region',
              region: 'IV_e1:1-1531933',
              level: 'bin',
              balance: false,
              transform: 'log10',
              colormap: 'default',
            },
            tracks: [],
          },
        ],
      },
      null,
      2,
    ),
  )
  console.log('wrote', bytes.length, 'bytes;', [...tables].map(([size, table]) => `${size}: ${table.nnz}`).join(', '))
}

await main()
