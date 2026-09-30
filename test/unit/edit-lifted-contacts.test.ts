/**
 * A contact map lifted through an edit (SPECS §27.8), written and read back:
 * the demo `.hic` at 16 kb, a stretch of IV turned and a stretch of XI set
 * aside, every pixel carried to the edited bins, sorted, summed, written as a
 * `.mcool` by the writer the `.pairs` import uses — and opened again as a file
 * of the edited assembly whose contacts are the original's, less exactly those
 * the set-aside stretch held.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { writableEdit } from '../../src/edit/exports'
import { liftedTable } from '../../src/edit/liftedContacts'
import { emptyEdit, withStep, type ReferenceEdit } from '../../src/genome/edit'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import type { PairsHeader } from '../../src/pairs/format'
import { writeMcool } from '../../src/pairs/write'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname

async function sumOf(map: MetaCooler): Promise<number> {
  let sum = 0
  await map.storedPixels.scanAll({
    onChunk: (chunk) => {
      for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
    },
  })
  return sum
}

describe('a map lifted through an edit', () => {
  it('writes every contact to the edited bins it lands in, and reads back as the edited assembly', async () => {
    const source = await LocalFileSource.fromPath(HIC)
    await source.mount()
    const hic = MetaCooler.fromHic(`${HIC}::/resolutions/16000`, source)
    const dir = mkdtempSync(join(tmpdir(), 'lifted-'))
    try {
      let edit: ReferenceEdit = emptyEdit({ names: [...hic.chromnames], lengths: Array.from(hic.coords.contigLengths) })
      edit = withStep(edit, { op: 'invert', sequence: 'IV', from: 400_000, to: 800_000 }, 'reader', 0)
      edit = withStep(edit, { op: 'aside', sequence: 'XI', from: 0, to: 160_000, why: 'debris' }, 'reader', 1)
      const { map, refusal } = MetaCooler.withLens(hic, writableEdit(edit))
      expect(refusal).toBeNull()
      const table = await liftedTable(map)
      if (table === null) throw new Error('cancelled')
      expect(table.contigs.map((contig) => contig.name).slice(3, 5)).toEqual(['IV_e1', 'IX'])

      // What XI's first 160 kb held — with itself and with everything — is all that is lost.
      const original = await sumOf(hic)
      let lost = 0
      const xi = hic.chromnames.indexOf('XI')
      const first = hic.coords.chromOffset[xi]
      const setAside = (bin: number): boolean => bin >= first && bin < first + 10
      await hic.storedPixels.scanAll({
        onChunk: (chunk) => {
          for (let i = 0; i < chunk.length; i++) if (setAside(chunk.bin1[i]) || setAside(chunk.bin2[i])) lost += chunk.count[i]
        },
      })
      expect(table.sum).toBe(original - lost)
      // Upper triangle, sorted, each pixel once.
      for (let i = 1; i < table.nnz; i++) {
        expect(table.bin1[i] <= table.bin2[i]).toBe(true)
        expect(table.bin1[i] > table.bin1[i - 1] || (table.bin1[i] === table.bin1[i - 1] && table.bin2[i] > table.bin2[i - 1])).toBe(true)
      }

      // Written as an .mcool, and opened again.
      const header: PairsHeader = { version: '', assembly: null, sorted: null, shape: null, contigs: table.contigs, columns: { chrom1: 1, pos1: 2, chrom2: 3, pos2: 4, strand1: -1, strand2: -1 } as PairsHeader['columns'], text: '' }
      const bytes = await writeMcool(
        { header, rungs: [16_000], tables: new Map([[16_000, table]]), indexed: false, declaredRecords: null },
        { about: { generatedBy: 'test (lifted)', metadata: () => ({ lifted: true }) } },
      )
      if (bytes === null) throw new Error('cancelled')
      const path = join(dir, 'lifted.mcool')
      writeFileSync(path, bytes)
      const back = await LocalFileSource.fromPath(path)
      await back.mount()
      const reopened = await MetaCooler.open(`${path}::/resolutions/16000`, back)
      try {
        expect([...reopened.chromnames]).toEqual(table.contigs.map((contig) => contig.name))
        expect(await sumOf(reopened)).toBe(table.sum)
        // A contact between IV's first turned bin and a bin past the turn: in
        // the file IV:400-416 kb, lifted to IV_e1:784-800 kb.
        const iv = reopened.chromnames.indexOf('IV_e1')
        const ivFile = hic.chromnames.indexOf('IV')
        const fileBin = hic.coords.chromOffset[ivFile] + 25
        const liftedBin = reopened.coords.chromOffset[iv] + 49
        let inFile = 0
        let lifted = 0
        await hic.storedPixels.scanAll({
          onChunk: (chunk) => {
            for (let i = 0; i < chunk.length; i++) if (chunk.bin1[i] === fileBin && chunk.bin2[i] === hic.coords.chromOffset[ivFile] + 60) inFile += chunk.count[i]
          },
        })
        await reopened.storedPixels.scanAll({
          onChunk: (chunk) => {
            for (let i = 0; i < chunk.length; i++) if (chunk.bin1[i] === liftedBin && chunk.bin2[i] === reopened.coords.chromOffset[iv] + 60) lifted += chunk.count[i]
          },
        })
        expect(inFile).toBeGreaterThan(0)
        expect(lifted).toBe(inFile)
      } finally {
        reopened.close()
      }
    } finally {
      hic.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
