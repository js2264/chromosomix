/**
 * A structure as a PDB, and a PDB read back (§25.2, §25.7).
 *
 * The file is held to the format's fixed columns by reading them here, column
 * by column, rather than by asking the writer — a test that parsed the file
 * with the code that wrote it would prove only that the two agree. What PyMOL
 * makes of it was measured against PyMOL 3.2 itself (the module's docblock
 * says what); what these pin is what that measurement rests on: an atom per
 * bead in its columns, a chain per sequence and haplotype, bonds between
 * neighbours and nowhere else, and a frame that fits.
 */

import { describe, expect, it } from 'vitest'

import { isStructureName, parseG3d, sniffBed3d, sniffG3d, structureFromBeads, type ModelBead } from '@/annotations/g3d'
import { PDB_STEP, parsePdb, pdbRefusal, sniffPdb, writePdb } from '@/annotations/pdb'
import type { FeatureSet } from '@/annotations/types'

/** One HETATM or ATOM record, read by the columns the format fixes. */
interface Atom {
  record: string
  serial: number
  name: string
  residueName: string
  chain: string
  residue: number
  x: number
  y: number
  z: number
  occupancy: number
  segment: string
  element: string
}

function atomsOf(text: string): Atom[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('HETATM') || line.startsWith('ATOM  '))
    .map((line) => ({
      record: line.slice(0, 6),
      serial: Number(line.slice(6, 11)),
      name: line.slice(12, 16),
      residueName: line.slice(17, 20),
      chain: line.slice(21, 22),
      residue: Number(line.slice(22, 26)),
      x: Number(line.slice(30, 38)),
      y: Number(line.slice(38, 46)),
      z: Number(line.slice(46, 54)),
      occupancy: Number(line.slice(54, 60)),
      segment: line.slice(72, 76).trim(),
      element: line.slice(76, 78).trim(),
    }))
}

/** Every bond the CONECT records declare, as `a-b` with `a < b`, and who listed it. */
function bondsOf(text: string): { pairs: Set<string>; listed: Map<number, number[]> } {
  const pairs = new Set<string>()
  const listed = new Map<number, number[]>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('CONECT')) continue
    const numbers: number[] = []
    for (let at = 6; at + 5 <= line.length; at += 5) numbers.push(Number(line.slice(at, at + 5)))
    const [from, ...to] = numbers
    listed.set(from, to)
    for (const other of to) pairs.add(`${Math.min(from, other)}-${Math.max(from, other)}`)
  }
  return { pairs, listed }
}

/**
 * Two sequences: chrI four beads end to end, chrII three with a gap — the bin
 * at 10 kb left out, as a solver leaves a bin it had no counts for.
 */
const BEADS: ModelBead[] = [
  { contig: 'chrI', start: 0, end: 5000, x: 0, y: 0, z: 0 },
  { contig: 'chrI', start: 5000, end: 10000, x: 1, y: 0, z: 0 },
  { contig: 'chrI', start: 10000, end: 15000, x: 1, y: 1, z: 0 },
  { contig: 'chrI', start: 15000, end: 20000, x: 2, y: 1, z: 0.5 },
  { contig: 'chrII', start: 0, end: 5000, x: -1, y: -1, z: 0 },
  { contig: 'chrII', start: 5000, end: 10000, x: -1, y: -2, z: 0 },
  { contig: 'chrII', start: 15000, end: 20000, x: -3, y: -2, z: 1 },
]

function model(beads: readonly ModelBead[] = BEADS, width = 5000): FeatureSet {
  return structureFromBeads(beads, width)
}

/** The largest difference between two sets' coordinates, bead for bead. */
function drift(a: FeatureSet, b: FeatureSet): number {
  let worst = 0
  for (let i = 0; i < a.length; i++) {
    for (const axis of ['x', 'y', 'z'] as const) {
      worst = Math.max(worst, Math.abs((a.model?.[axis][i] ?? 0) - (b.model?.[axis][i] ?? Number.NaN)))
    }
  }
  return worst
}

describe('a structure written as a PDB (§25.7)', () => {
  it('writes one HETATM per bead, in the columns the format fixes', () => {
    const text = writePdb(model())
    for (const line of text.split('\n').filter((row) => /^(HETATM|ATOM {2}|CONECT|TITLE|REMARK)/.test(row))) {
      expect(line.length, line).toBeLessThanOrEqual(80)
    }
    for (const line of text.split('\n').filter((row) => row.startsWith('HETATM'))) expect(line).toHaveLength(80)
    const atoms = atomsOf(text)
    expect(atoms).toHaveLength(7)
    expect(atoms.map((atom) => atom.serial)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(atoms.map((atom) => atom.record))).toEqual(new Set(['HETATM']))
    // A carbon named in the columns a one-letter element takes, in a residue
    // that is no amino acid and no nucleotide.
    expect(new Set(atoms.map((atom) => atom.name))).toEqual(new Set([' C  ']))
    expect(new Set(atoms.map((atom) => atom.residueName))).toEqual(new Set(['BEA']))
    expect(new Set(atoms.map((atom) => atom.element))).toEqual(new Set(['C']))
    expect(new Set(atoms.map((atom) => atom.occupancy))).toEqual(new Set([1]))
    // A chain per sequence, its residues numbered along it.
    expect(atoms.map((atom) => atom.chain).join('')).toBe('AAAABBB')
    expect(atoms.map((atom) => atom.residue)).toEqual([1, 2, 3, 4, 1, 2, 3])
    expect(text.trimEnd().split('\n').at(-1)).toBe('END')
  })

  it('bonds neighbouring beads both ways round, and nothing across a gap or between chains', () => {
    const { pairs, listed } = bondsOf(writePdb(model()))
    // chrI is one run; chrII breaks at the bin the model left out, so its last
    // bead is bonded to nothing — the break PyMOL then draws.
    expect([...pairs].sort()).toEqual(['1-2', '2-3', '3-4', '5-6'])
    expect(listed.get(2)).toEqual([1, 3])
    expect(listed.get(1)).toEqual([2])
    expect(listed.has(7)).toBe(false)
  })

  it('centres the model and makes its median step the step a Cα trace has', () => {
    const text = writePdb(model())
    const atoms = atomsOf(text)
    const at = new Map(atoms.map((atom) => [atom.serial, atom]))
    const steps = [...bondsOf(text).pairs]
      .map((pair) => pair.split('-').map(Number))
      .map(([a, b]) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y, at.get(a)!.z - at.get(b)!.z))
      .sort((p, q) => p - q)
    expect(steps[steps.length >> 1]).toBeCloseTo(PDB_STEP, 2)
    for (const axis of ['x', 'y', 'z'] as const) {
      const mean = atoms.reduce((sum, atom) => sum + atom[axis], 0) / atoms.length
      expect(Math.abs(mean)).toBeLessThan(0.01)
    }
  })

  it('draws a sprawling model in until every coordinate fits its column', () => {
    // One bead a million units from the rest: at a 3.8 step it would land past
    // -999.999, the most eight columns with three decimals can say.
    const far = model([...BEADS, { contig: 'chrIII', start: 0, end: 5000, x: 1e6, y: -1e6, z: 1e6 }])
    const text = writePdb(far)
    for (const atom of atomsOf(text)) {
      for (const value of [atom.x, atom.y, atom.z]) expect(Math.abs(value)).toBeLessThanOrEqual(999.999)
    }
    for (const line of text.split('\n').filter((row) => row.startsWith('HETATM'))) expect(line).toHaveLength(80)
    expect(drift(far, parsePdb(text))).toBeLessThan(1e6 * 1e-5)
  })

  it('gives PyMOL the lines that draw it as the cell does', () => {
    const text = writePdb(model())
    expect(text).toMatch(/^REMARK 250 {3}set cartoon_trace_atoms, 1; set cartoon_tube_radius, \d+\.\d\d$/m)
    expect(text).toMatch(/^REMARK 250 {3}as cartoon; util\.cbc$/m)
    expect(text).toMatch(/^REMARK 250 {3}set sphere_scale, \d+\.\d\d; as spheres; util\.cbc$/m)
  })

  it('writes its TITLE in ASCII, continued over the lines it takes', () => {
    const label = '3D model · chr3:34,550,001–34,800,000 — a locus with a name long enough to fold over a line'
    const text = writePdb(model(), { label, file: 'whole file at 2 kb', created: '2026-10-11T18:44:05Z' })
    const titles = text.split('\n').filter((line) => line.startsWith('TITLE'))
    expect(titles.length).toBeGreaterThan(1)
    expect(titles[0]).toMatch(/^TITLE {5}chromosomix 3D model - chr3:34,550,001-34,800,000 - /)
    expect(titles[1]).toMatch(/^TITLE {4}2 /)
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x00-\x7f]*$/)
    // A word longer than a line — a framing that is a path — continues on the
    // next line rather than losing its end.
    const path = `/data/${'very_long_directory_name/'.repeat(8)}model.bed3d`
    const long = writePdb(model(), { label: 'model', file: path })
      .split('\n')
      .filter((line) => line.startsWith('TITLE'))
    for (const line of long) expect(line.length).toBeLessThanOrEqual(80)
    expect(long.map((line, at) => line.slice(at === 0 ? 10 : 11)).join('').replace(/ /g, '')).toBe(
      `chromosomixmodelfrom${path}`,
    )
  })

  it('takes the chain letters round again past sixty-two, and numbers the segments apart', () => {
    // A metagenome's contigs: seventy sequences of two beads each.
    const beads: ModelBead[] = []
    for (let c = 0; c < 70; c++) {
      beads.push({ contig: `contig_${c}`, start: 0, end: 1000, x: c, y: 0, z: 0 })
      beads.push({ contig: `contig_${c}`, start: 1000, end: 2000, x: c, y: 1, z: 0 })
    }
    const set = model(beads, 1000)
    const text = writePdb(set)
    const atoms = atomsOf(text)
    expect(atoms[0].chain).toBe('A')
    expect(atoms[2 * 62].chain).toBe('A')
    expect(atoms[0].segment).toBe('1')
    expect(atoms[2 * 62].segment).toBe('63')
    expect(atoms.at(-1)?.segment).toBe('70')
    const back = parsePdb(text)
    expect(back.contigs).toEqual(set.contigs)
    expect(Array.from(back.start)).toEqual(Array.from(set.start))
  })

  it('refuses what its columns cannot number, and says what can', () => {
    const long = Array.from({ length: 10_000 }, (_, i): ModelBead => ({
      contig: 'chrLong',
      start: i * 100,
      end: (i + 1) * 100,
      x: i,
      y: 0,
      z: 0,
    }))
    const refusal = pdbRefusal(model(long, 100))
    expect(refusal).toMatch(/no chain can be longer than 9,999 beads and chrLong has 10,000; the bed3d/)
    expect(() => writePdb(model(long, 100))).toThrow(/9,999/)
    // Past five columns of serials: eleven chains of 9,100 beads.
    const many: ModelBead[] = []
    for (let c = 0; c < 11; c++) {
      for (let i = 0; i < 9_100; i++) many.push({ contig: `s${c}`, start: i * 10, end: (i + 1) * 10, x: i, y: c, z: 0 })
    }
    expect(pdbRefusal(model(many, 10))).toMatch(/at most 99,999 beads and this model has 100,100/)
    const nowhere = model([{ contig: 'chrI', start: 0, end: 10, x: Number.NaN, y: Number.NaN, z: Number.NaN }], 10)
    expect(pdbRefusal(nowhere)).toMatch(/No bead of this model has a place/)
    expect(pdbRefusal(model())).toBeNull()
  })
})

describe('a PDB read back (§25.2)', () => {
  it('lands on the beads it was written from: loci, haplotypes, width and places', () => {
    const phased = parseG3d(
      [
        'chr7 0 0 0 0 m',
        'chr7 0 5 0 0 p',
        'chr7 10000 1 0 0 m',
        'chr7 10000 6 0 0.5 p',
        'chr7 20000 1 1 0 m',
        'chr7 20000 6 1 0 p',
        'chr8 0 -2 0 1 m',
        'chr8 10000 -2 1 1 m',
      ].join('\n'),
    )
    const text = writePdb(phased, { label: 'Dip-C model' })
    // Two chains of chr7, one per homologue, and chr8 on the maternal one only.
    expect(text).toMatch(/^REMARK 250 CHROMOSOMIX CHAIN A - 1 3 maternal chr7$/m)
    expect(text).toMatch(/^REMARK 250 CHROMOSOMIX CHAIN B - 4 6 paternal chr7$/m)
    expect(text).toMatch(/^REMARK 250 CHROMOSOMIX CHAIN C - 7 8 maternal chr8$/m)
    const back = parsePdb(text, 'model.pdb')
    expect(back.contigs).toEqual(phased.contigs)
    expect(Array.from(back.contig)).toEqual(Array.from(phased.contig))
    expect(Array.from(back.start)).toEqual(Array.from(phased.start))
    expect(Array.from(back.end)).toEqual(Array.from(phased.end))
    expect(back.model?.haplotypes).toEqual(phased.model?.haplotypes)
    expect(Array.from(back.model?.hap ?? [])).toEqual(Array.from(phased.model?.hap ?? []))
    expect(back.model?.width).toBe(phased.model?.width)
    expect(back.detail).toEqual(phased.detail)
    // To the three decimals a coordinate is written with, in the model's units.
    expect(drift(phased, back)).toBeLessThan(1e-3)
  })

  it('keeps a sequence name that is not one word', () => {
    const set = model([
      { contig: 'my contig #1 (α)', start: 0, end: 10, x: 0, y: 0, z: 0 },
      { contig: 'my contig #1 (α)', start: 10, end: 20, x: 1, y: 0, z: 0 },
      { contig: '100%_GC', start: 0, end: 10, x: 0, y: 1, z: 0 },
    ], 10)
    const text = writePdb(set)
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x00-\x7f]*$/)
    expect(parsePdb(text).contigs).toEqual(['my contig #1 (α)', '100%_GC'])
  })

  it('reads beads of any width, as a bed3d holds them', () => {
    const irregular = model([
      { contig: 'chrI', start: 0, end: 4000, x: 0, y: 0, z: 0 },
      { contig: 'chrI', start: 4000, end: 10000, x: 1, y: 0, z: 0 },
      { contig: 'chrI', start: 10000, end: 15000, x: 2, y: 0, z: 0 },
      { contig: 'chrI', start: 15000, end: 20000, x: 3, y: 0, z: 0 },
    ])
    const back = parsePdb(writePdb(irregular))
    expect(Array.from(back.start)).toEqual([0, 4000, 10000, 15000])
    expect(Array.from(back.end)).toEqual([4000, 10000, 15000, 20000])
  })

  it('refuses a PDB that does not say where its beads are on the genome', () => {
    // pastis' own writer, line for line (`pastis/io/write_struct/pdb.py`):
    // atoms counted from zero, one chain, no residue numbers, no bonds, and
    // `nan` where a bead could not be placed.
    const pastis = [0, 1, 2, 3]
      .map((i) => {
        const place = i === 2 ? '     nan     nan     nan' : [i, i + 1, i + 2].map((v) => ((v + 1) * 100).toFixed(3).padStart(8)).join('')
        return `ATOM  ${String(i).padStart(5)} O    ${i === 0 ? 'NOD' : 'EDG'} A        ${place}  1.00${i === 0 ? ' 50.00' : ' 75.00'}    `
      })
      .join('\n')
    expect(sniffPdb(pastis, 'MDS.structure.pdb')).toBe(true)
    expect(() => parsePdb(pastis, 'MDS.structure.pdb')).toThrow(/bin order and nothing else.*as a bed3d/)
  })

  it('says so when PyMOL has saved one of its PDBs again', () => {
    // What PyMOL keeps of a file when it saves it: every atom and every bond,
    // and not one REMARK.
    const resaved = writePdb(model())
      .split('\n')
      .filter((line) => !line.startsWith('REMARK') && !line.startsWith('TITLE'))
      .join('\n')
    expect(() => parsePdb(resaved, 'aligned.pdb')).toThrow(/PyMOL drops REMARK records when it saves/)
  })

  it('refuses a placement table it does not know the layout of', () => {
    const later = writePdb(model()).replace('CHROMOSOMIX PLACEMENT 1', 'CHROMOSOMIX PLACEMENT 2')
    expect(() => parsePdb(later)).toThrow(/version 2, and this reader understands version 1/)
  })

  it('refuses a file with no atom to place', () => {
    expect(() => parsePdb('HEADER    NOTHING\nEND\n', 'empty.pdb')).toThrow(/empty\.pdb has no ATOM or HETATM record/)
  })

  it('reads the first model of several, which is the one model a row holds', () => {
    const text = writePdb(model())
    const atoms = text.split('\n').filter((line) => line.startsWith('HETATM'))
    const moved = atoms.map((line) => `${line.slice(0, 30)}${'   0.000'.repeat(3)}${line.slice(54)}`)
    const rest = text.split('\n').filter((line) => !line.startsWith('HETATM'))
    const ensemble = [...rest.filter((line) => line !== 'END'), 'MODEL        1', ...atoms, 'ENDMDL', 'MODEL        2', ...moved, 'ENDMDL', 'END'].join('\n')
    expect(drift(model(), parsePdb(ensemble))).toBeLessThan(1e-3)
  })

  it('passes over an atom its table does not place, and asks the table for no more than the format holds', () => {
    const text = writePdb(model())
    const hostile = text.replace(
      'END\n',
      [
        'HETATM99999  C   BEA Z   1       1.000   2.000   3.000  1.00  0.00           C  ',
        'REMARK 250 CHROMOSOMIX RUN 1 999999999 0 5000',
        'REMARK 250 CHROMOSOMIX CHAIN Z - 1 4294967295 shared chrZ',
        'END\n',
      ].join('\n'),
    )
    const back = parsePdb(hostile)
    expect(back.length).toBe(7)
    expect(back.contigs).toEqual(['chrI', 'chrII'])
  })
})

describe('recognising a PDB', () => {
  it('by its name, wherever the name is read', () => {
    for (const name of ['model.pdb', 'MODEL.PDB', 'model.pdb.gz', 'https://x.org/dir/model.pdb?token=1', 'C:\\models\\a.pdb']) {
      expect(isStructureName(name), name).toBe(true)
      expect(sniffPdb('', name), name).toBe(true)
    }
    expect(isStructureName('ligand.pdbqt')).toBe(false)
    expect(sniffPdb('', 'peaks.bed')).toBe(false)
  })

  it('by its records, under any name, and never a BED or a model of the other formats', () => {
    const text = writePdb(model())
    expect(sniffPdb(text, 'model.txt')).toBe(true)
    expect(sniffPdb(text.split('\n').filter((line) => line.startsWith('HETATM')).join('\n'), 'model.txt')).toBe(true)
    expect(sniffPdb('chrI\t0\t100\tpeak1\nchrI\t200\t300\tpeak2\n', 'peaks.txt')).toBe(false)
    expect(sniffPdb('chr1\t0\t1.5\t2.5\t-3.5\n', 'model.txt')).toBe(false)
    // A file whose first word looks like a record but holds no atom is not one.
    expect(sniffPdb('HEADER_contig\t0\t100\n', 'contigs.txt')).toBe(false)
    // …and the g3d and bed3d readers leave a PDB alone, by name or not.
    expect(sniffG3d(text, 'model.pdb')).toBe(false)
    expect(sniffBed3d(text, 'model.pdb')).toBe(false)
    expect(sniffG3d(text, 'model.txt')).toBe(false)
  })
})
