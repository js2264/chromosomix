/**
 * A structure as a PDB, for PyMOL and the other molecular viewers (§25.7), and
 * a PDB read back where it says where its beads are on the genome (§25.2).
 *
 * The PDB is the one format every molecular viewer opens — PyMOL, ChimeraX,
 * VMD, Mol*, Jmol — and the one a reader reaches for when they want a
 * ray-traced picture of a fold or two models laid over each other. pastis
 * writes one (`pastis/io/write_struct/pdb.py`), which is why the design names
 * "ChimeraX / PyMOL with pastis' PDB" as what a reader had before this app
 * (docs/structure-3d.md §1.2). That file is a list of atoms in bin order: one
 * chain, `A`, for every chromosome, no residue numbers, no bonds, and `nan`
 * where a bead could not be placed — which PyMOL draws as a cloud joined by
 * guesswork. This writes the file a viewer can draw as the fibre it is:
 *
 * - **One HETATM per bead**, a carbon named `C` in a residue named `BEA`. A
 *   bead is no amino acid and no nucleotide, and HETATM is the record a group
 *   outside the standard residues takes.
 * - **One chain per sequence and haplotype** — the scene's own chains
 *   (`structure/scene.ts`), in its order — so colouring by chain tells the
 *   chromosomes apart, and the two homologues of a phased model apart. The
 *   residues are numbered along the chain from `1`, so a rainbow by residue
 *   runs from one end of each chromosome to the other.
 * - **CONECT between neighbouring beads and nowhere else**: a bond for every
 *   step of every run the cell draws its tube along, none across a gap the
 *   model left, none between chains. Measured against PyMOL 3.2 rather than
 *   read in a manual: a file with CONECT records has its distance-based bonding
 *   switched off, so two beads 0.6 apart on different chains stay apart.
 *   Without them PyMOL joins every pair closer than about two units, and a
 *   model whose beads are a unit apart comes out as a lattice.
 * - **Coordinates the columns can hold.** A PDB coordinate is eight columns
 *   with three decimals, and a model is in its solver's units — a unit
 *   sphere, where three decimals is a fortieth of a step, or nanometres, where
 *   a nucleus overflows the column. So the model is centred on its placed
 *   beads and multiplied until neighbouring beads are {@link PDB_STEP} apart,
 *   which is the step of a Cα trace and so what PyMOL's spheres, sticks and
 *   cartoon trace are sized for. The centre and the factor are written down
 *   and the reader below undoes them; the file still claims no unit.
 *
 * ## Where each bead is on the genome
 *
 * Nowhere in an atom record: a residue number is four columns and a chain one
 * character. So the file carries a table, in REMARK 250 lines a viewer skips —
 * each chain's sequence and haplotype by atom serial, and each run of beads
 * laid end to end as its first serial, count, start and width — and that table
 * is the whole of what lets a PDB be **read** here. A PDB from anywhere else
 * says where its atoms are in space and nothing about the genome, and the
 * parser refuses it with the sentence that says so rather than placing beads
 * by their order, which would be a guess drawn as a fact. So does a PDB this
 * app wrote and PyMOL saved again: PyMOL keeps every atom and every bond and
 * drops every REMARK.
 */

import { FeatureBuilder, type StructureSchema } from './featureset'
import { G3D_FIELD_HAPLOTYPE, isPdbName } from './g3d'
import { defaultStructureStyle, type FeatureSet } from './types'
import { buildStructure, type Structure } from '../structure/scene'
import { fmt } from '../units'

/**
 * The distance a written model's neighbouring beads are apart, in the file's
 * coordinates: the 3.8 between two Cα atoms of a protein, which PyMOL's
 * default sphere and stick radii, and its cartoon trace, are drawn to suit.
 */
export const PDB_STEP = 3.8

/** The most atoms a PDB can number: its serial is five columns. */
export const PDB_MAX_ATOMS = 99_999

/** The longest chain a PDB can number: a residue number is four columns. */
export const PDB_MAX_RESIDUES = 9_999

/**
 * The residue name every bead is written under, and the one the reader looks
 * for when it has to say a file was written here and lost its table.
 */
export const PDB_RESIDUE = 'BEA'

/**
 * The chain identifiers, in the order the chains take them.
 *
 * Both cases, which PyMOL keeps apart (`ignore_case_chain` is off), then the
 * digits: sixty-two chains, which is a phased human genome with room to spare.
 * A model with more — a metagenome's contigs — takes them round again, and the
 * segment identifier, which PyMOL selects by too, tells the two `A`s apart.
 */
const CHAIN_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** The most chains the segment identifier, four columns, can count. */
const MAX_CHAINS = 9_999

/**
 * The furthest a written coordinate is put from the centre. The column holds
 * `-999.999`, and a unit short of that leaves the factor's rounding room.
 */
const REACH = 999

/** The radius PyMOL draws a carbon's sphere at, which `sphere_scale` multiplies. */
const CARBON_RADIUS = 1.7

/** Every line of the placement table starts with this. */
const TABLE = 'REMARK 250 CHROMOSOMIX'

/** The placement table's layout, so a later one can be told from this one. */
const TABLE_VERSION = 1

export interface PdbContext {
  label?: string
  file?: string
  created?: string
}

/**
 * Why this model cannot be written as a PDB, or `null` where it can.
 *
 * One pass over the set rather than the scene, because the Structures card
 * asks on every refresh, to say on the button why it is disabled. The limits
 * are the format's columns, and each refusal names the format that has none.
 */
export function pdbRefusal(set: FeatureSet): string | null {
  const model = set.model
  if (model === undefined) return 'This row holds no model to write.'
  const haplotypes = Math.max(1, model.haplotypes.length)
  // A chain's residue number is its bead's place along it, counting the beads
  // the model left unplaced, which is what the writer numbers by.
  const along = new Map<number, number>()
  const placedOn = new Set<number>()
  let placed = 0
  let longest = 0
  let longestChain = -1
  for (let i = 0; i < set.length; i++) {
    const chain = set.contig[i] * haplotypes + model.hap[i]
    const position = (along.get(chain) ?? 0) + 1
    along.set(chain, position)
    if (!isPlaced(model.x[i], model.y[i], model.z[i])) continue
    placed++
    placedOn.add(chain)
    if (position > longest) {
      longest = position
      longestChain = chain
    }
  }
  if (placed === 0) return 'No bead of this model has a place, so there is nothing to write.'
  if (placed > PDB_MAX_ATOMS) {
    return (
      `A PDB numbers its atoms in five columns, so it holds at most ${fmt.int(PDB_MAX_ATOMS)} ` +
      `beads and this model has ${fmt.int(placed)}; the bed3d holds any number.`
    )
  }
  if (longest > PDB_MAX_RESIDUES) {
    const name = set.contigs[Math.floor(longestChain / haplotypes)] ?? 'one sequence'
    return (
      `A PDB numbers a chain’s beads in four columns, so no chain can be longer than ` +
      `${fmt.int(PDB_MAX_RESIDUES)} beads and ${name} has ${fmt.int(longest)}; the bed3d holds any length.`
    )
  }
  if (placedOn.size > MAX_CHAINS) {
    return (
      `A PDB tells at most ${fmt.int(MAX_CHAINS)} chains apart and this model has ` +
      `${fmt.int(placedOn.size)}; the bed3d holds any number.`
    )
  }
  return null
}

/**
 * A structure row as a PDB.
 *
 * Throws {@link pdbRefusal}'s sentence for a model the format cannot hold, so
 * no caller writes a file whose serials or residue numbers have run into the
 * next column.
 */
export function writePdb(set: FeatureSet, context: PdbContext = {}): string {
  const refusal = pdbRefusal(set)
  if (refusal !== null) throw new Error(refusal)
  const structure = buildStructure(set)
  if (structure === null) throw new Error('This row holds no model to write.')
  const model = structure.model
  const frame = frameOf(structure)

  // Only the chains with a bead to draw take an identifier: a chain the
  // solver placed nothing on would be a letter in the table with no atom.
  const chains = structure.chains.filter((chain) => chain.beads.some((bead) => structure.present[bead] === 1))
  const segmented = chains.length > CHAIN_IDS.length

  const atoms: string[] = []
  const table: string[] = []
  const serialOf = new Int32Array(set.length)
  let serial = 0
  chains.forEach((chain, c) => {
    const id = CHAIN_IDS[c % CHAIN_IDS.length]
    const segment = segmented ? String(c + 1) : ''
    const first = serial + 1
    // Runs of beads laid end to end at one width, which is every bead of a
    // model made from a map: a line per gap rather than a line per bead.
    let run: { first: number; count: number; start: number; width: number } | null = null
    const runs: string[] = []
    for (let k = 0; k < chain.beads.length; k++) {
      const bead = chain.beads[k]
      if (structure.present[bead] === 0) continue
      serial++
      serialOf[bead] = serial
      atoms.push(
        hetatm(
          serial,
          id,
          k + 1,
          (model.x[bead] - frame.cx) * frame.factor,
          (model.y[bead] - frame.cy) * frame.factor,
          (model.z[bead] - frame.cz) * frame.factor,
          segment,
        ),
      )
      const start = set.start[bead]
      const width = set.end[bead] - start
      if (run !== null && start === run.start + run.count * run.width && width === run.width) {
        run.count++
        continue
      }
      if (run !== null) runs.push(`${TABLE} RUN ${run.first} ${run.count} ${run.start} ${run.width}`)
      run = { first: serial, count: 1, start, width }
    }
    if (run !== null) runs.push(`${TABLE} RUN ${run.first} ${run.count} ${run.start} ${run.width}`)
    table.push(
      `${TABLE} CHAIN ${id} ${segment === '' ? '-' : segment} ${first} ${serial} ` +
        `${encodeURIComponent(model.haplotypes[chain.hap] ?? 'shared')} ` +
        `${encodeURIComponent(structure.contigs[chain.contig] ?? '')}`,
      ...runs,
    )
  })

  // Each bonded atom lists its neighbours, both ways round, as the format asks
  // of a HETATM: one line per bead, since a bead on a chain has two at most.
  const neighbours: number[][] = Array.from({ length: serial + 1 }, () => [])
  for (const chain of chains) {
    for (let r = 0; r < chain.runs.length; r += 2) {
      for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
        const a = serialOf[chain.beads[k - 1]]
        const b = serialOf[chain.beads[k]]
        neighbours[a].push(b)
        neighbours[b].push(a)
      }
    }
  }
  const bonds: string[] = []
  for (let at = 1; at <= serial; at++) {
    if (neighbours[at].length === 0) continue
    const listed = neighbours[at].sort((p, q) => p - q).map((other) => String(other).padStart(5))
    bonds.push(`CONECT${String(at).padStart(5)}${listed.join('')}`)
  }

  // The radii the cell draws a model at by default, in this file's
  // coordinates, so the lines below draw it in PyMOL as it is drawn here. The
  // cell's step is floored at a fraction of the model's size (`scene.ts`), which
  // is what keeps a long fibre — a bacterial ring, a yeast arm — from being a
  // hairline: PyMOL's own tube is half a unit whatever the model.
  const style = defaultStructureStyle()
  const drawn = structure.step * structure.scale * frame.factor
  const tube = (drawn * style.tubeRadius).toFixed(2)
  const sphere = ((drawn * style.beadRadius) / CARBON_RADIUS).toFixed(2)

  const what = context.label === undefined ? 'structure' : context.label
  const from = context.file === undefined ? '' : ` from ${context.file}`
  const when = context.created === undefined ? '' : ` on ${context.created}`
  const lines = [
    ...titleLines(`chromosomix ${what}${from}${when}`),
    'REMARK 250',
    ...prose(
      'A chromatin model written by chromosomix: one HETATM per bead, one chain per sequence and ' +
        'haplotype with its residues numbered along it, and CONECT between neighbouring beads only, ' +
        "so a gap the model left is a break in its chain. The coordinates are the model's own, " +
        `centred and multiplied by ${frame.factor} so that neighbouring beads are ${PDB_STEP} apart: ` +
        'no unit in this file is an angstrom.',
    ),
    'REMARK 250',
    'REMARK 250 In PyMOL, drawn as chromosomix draws it:',
    `REMARK 250   set cartoon_trace_atoms, 1; set cartoon_tube_radius, ${tube}`,
    'REMARK 250   as cartoon; util.cbc',
    'REMARK 250 or as beads:',
    `REMARK 250   set sphere_scale, ${sphere}; as spheres; util.cbc`,
    'REMARK 250',
    ...prose(
      'The CHROMOSOMIX lines below say where each atom is on the genome, which is how chromosomix ' +
        'reads this file back: FRAME is the centre and the factor; CHAIN names a chain, its ' +
        'segment, its first and last atom, its haplotype and its sequence; RUN puts that many atoms, ' +
        'from the first, on beads of that width laid end to end from that start, in base pairs from ' +
        'zero. PyMOL keeps no REMARK line when it saves a file.',
    ),
    'REMARK 250',
    `${TABLE} PLACEMENT ${TABLE_VERSION}`,
    `${TABLE} FRAME ${frame.cx} ${frame.cy} ${frame.cz} ${frame.factor}`,
    `${TABLE} WIDTH ${model.width}`,
    `${TABLE} HAPLOTYPES ${model.haplotypes.map((name) => encodeURIComponent(name)).join(' ')}`,
    ...table,
    ...atoms,
    ...bonds,
    'END',
  ]
  return lines.join('\n') + '\n'
}

interface Frame {
  /** The centre subtracted, in the file's units, as written in the table. */
  cx: number
  cy: number
  cz: number
  /** What the centred coordinates are multiplied by, as written in the table. */
  factor: number
}

/**
 * The centre and the factor a model is written with.
 *
 * The factor makes the **median** step between neighbouring beads
 * {@link PDB_STEP} — unfloored, unlike the scene's, whose floor is about a
 * bead staying visible on a screen. A model with no two neighbours has no
 * step, and is sized so its radius of gyration is ten of them. Either way the
 * factor shrinks if the furthest bead would then overflow its column, so a
 * model that sprawls is written with shorter steps rather than not at all.
 *
 * Both rounded before they are used, and used as rounded: the reader divides
 * by the number on the page, so the number on the page is the one multiplied by.
 */
function frameOf(structure: Structure): Frame {
  const model = structure.model
  const n = structure.set.length
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    if (structure.present[i] === 0) continue
    cx += model.x[i]
    cy += model.y[i]
    cz += model.z[i]
  }
  const steps: number[] = []
  for (const chain of structure.chains) {
    for (let r = 0; r < chain.runs.length; r += 2) {
      for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
        const a = chain.beads[k - 1]
        const b = chain.beads[k]
        steps.push(Math.hypot(model.x[b] - model.x[a], model.y[b] - model.y[a], model.z[b] - model.z[a]))
      }
    }
  }
  steps.sort((a, b) => a - b)
  const median = steps.length === 0 ? 0 : steps[steps.length >> 1]
  // The scene's radius of gyration, which it keeps as the factor back to the
  // file's units: zero only for a model that is one point.
  const gyration = structure.placed > 1 ? structure.scale : 0
  let factor = median > 0 ? PDB_STEP / median : gyration > 0 ? (10 * PDB_STEP) / gyration : 1
  // The centre to a thousandth of a step, which is as fine as the coordinates
  // are written: what it is for is keeping them inside their columns, and the
  // reader adds back the number on the page whatever it is. Rounded harder,
  // a model the solver had already centred was written centred on noise.
  const decimals = Math.min(20, Math.max(0, 3 - Math.floor(Math.log10(PDB_STEP / factor))))
  cx = Number((cx / structure.placed).toFixed(decimals)) || 0
  cy = Number((cy / structure.placed).toFixed(decimals)) || 0
  cz = Number((cz / structure.placed).toFixed(decimals)) || 0
  let reach = 0
  for (let i = 0; i < n; i++) {
    if (structure.present[i] === 0) continue
    reach = Math.max(reach, Math.abs(model.x[i] - cx), Math.abs(model.y[i] - cy), Math.abs(model.z[i] - cz))
  }
  if (reach * factor > REACH) factor = REACH / reach
  return { cx, cy, cz, factor: Number(factor.toPrecision(6)) }
}

function isPlaced(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
}

/**
 * One bead as a HETATM record, column for column as the format lays it out:
 * the serial in 7–11, the atom name in 13–16 with its one-letter element in
 * 14, the residue in 18–20, the chain in 22, the residue number in 23–26,
 * the three coordinates in 31–54, occupancy and B-factor after them, the
 * segment in 73–76 and the element in 77–78. Eighty columns, every line.
 */
function hetatm(
  serial: number,
  chain: string,
  residue: number,
  x: number,
  y: number,
  z: number,
  segment: string,
): string {
  return (
    'HETATM' +
    String(serial).padStart(5) +
    '  C   ' +
    PDB_RESIDUE +
    ' ' +
    chain +
    String(residue).padStart(4) +
    '    ' +
    column(x) +
    column(y) +
    column(z) +
    '  1.00  0.00      ' +
    segment.padEnd(4) +
    ' C  '
  )
}

/** A coordinate in its eight columns, with no `-0.000`. */
function column(value: number): string {
  const text = value.toFixed(3)
  return (text === '-0.000' ? '0.000' : text).padStart(8)
}

/**
 * The TITLE record, continued over as many lines as it takes.
 *
 * In ASCII, which is what the format is: the label's middle dots and dashes
 * become hyphens, and anything else outside it a question mark, rather than
 * bytes a strict reader stops at.
 */
function titleLines(text: string): string[] {
  // A word longer than a line — a path, a URL — is cut into lines' worth, so
  // it continues on the next line rather than losing its end.
  const words = ascii(text)
    .split(/\s+/)
    .filter((word) => word !== '')
    .flatMap((word) => word.match(/.{1,69}/g) ?? [])
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const room = lines.length === 0 ? 70 : 69
    if (line !== '' && line.length + 1 + word.length > room) {
      lines.push(line)
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') lines.push(line)
  // The continuation number is two columns, so ninety-nine lines at most.
  return lines
    .slice(0, 99)
    .map((part, at) => (at === 0 ? `TITLE     ${part}` : `TITLE   ${String(at + 1).padStart(2)} ${part}`))
}

/** A paragraph as REMARK 250 lines, wrapped inside the eighty columns. */
function prose(text: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of ascii(text).split(/\s+/)) {
    if (word === '') continue
    if (line !== '' && line.length + 1 + word.length > 69) {
      lines.push(`REMARK 250 ${line}`)
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') lines.push(`REMARK 250 ${line}`)
  return lines
}

function ascii(text: string): string {
  return text
    .replace(/[·•]/g, '-')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\x7e]/g, '?')
}

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

/**
 * Whether these lines are a PDB: named so, or opening on one of the records
 * a PDB opens on and holding an atom.
 *
 * Asked before the text sniffers, for the reason a g3d is: the BED sniffer's
 * last answer is `bed`, and a PDB read as one is a lane of nonsense. Nothing
 * in the BED family begins a line with `HETATM` or `REMARK`.
 */
export function sniffPdb(text: string, fileName = ''): boolean {
  if (isPdbName(fileName)) return true
  const first = /^[ \t]*(\S[^\n]*)/m.exec(text)?.[1] ?? ''
  if (!/^(HEADER|TITLE |COMPND|SOURCE|KEYWDS|EXPDTA|AUTHOR|REMARK|CRYST1|MODEL |ATOM  |HETATM)/.test(first)) {
    return false
  }
  return /^(ATOM  |HETATM)/m.test(text)
}

interface TableChain {
  first: number
  last: number
  hap: string
  sequence: string
}

interface TableRun {
  first: number
  count: number
  start: number
  width: number
}

/**
 * Read a PDB this app wrote into the beads it was written from.
 *
 * The atoms' coordinates, put back into the model's own units through the
 * table's FRAME, and their loci from its CHAIN and RUN lines — the same
 * builder and the same schema a bed3d goes through, so the row is a structure
 * like any other. The first MODEL only, where a file has several: a row holds
 * one model (§25.8). An atom the table does not place is passed over; a table
 * that places none of them, or no table, is a refusal.
 */
export function parsePdb(text: string, fileName = ''): FeatureSet {
  const chains: TableChain[] = []
  const runs: TableRun[] = []
  let version: number | null = null
  let frame: Frame | null = null
  let width: number | null = null
  let haplotypes: string[] | null = null
  const atoms: Array<{ serial: number; x: number; y: number; z: number }> = []
  let ours = 0
  let ended = false

  let index = 0
  const length = text.length
  while (index < length) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const line = text.slice(index, stop)
    index = end + 1
    if (line.startsWith(`${TABLE} `)) {
      const words = line.slice(TABLE.length + 1).trim().split(/\s+/)
      const [key, ...rest] = words
      if (key === 'PLACEMENT') version = Number(rest[0])
      else if (key === 'FRAME' && rest.length === 4) {
        const [cx, cy, cz, factor] = rest.map(Number)
        if ([cx, cy, cz].every(Number.isFinite) && factor > 0) frame = { cx, cy, cz, factor }
      } else if (key === 'WIDTH') {
        const value = Number(rest[0])
        if (Number.isInteger(value) && value > 0) width = value
      } else if (key === 'HAPLOTYPES') haplotypes = rest.map(decoded)
      else if (key === 'CHAIN' && rest.length >= 6) {
        const first = Number(rest[2])
        const last = Number(rest[3])
        if (isSerial(first) && isSerial(last) && first <= last) {
          chains.push({ first, last, hap: decoded(rest[4]), sequence: decoded(rest.slice(5).join(' ')) })
        }
      } else if (key === 'RUN' && rest.length === 4) {
        const [first, count, start, runWidth] = rest.map(Number)
        if (
          isSerial(first) &&
          Number.isInteger(count) &&
          count > 0 &&
          first + count - 1 <= PDB_MAX_ATOMS &&
          Number.isInteger(start) &&
          start >= 0 &&
          Number.isInteger(runWidth) &&
          runWidth > 0
        ) {
          runs.push({ first, count, start, width: runWidth })
        }
      }
      continue
    }
    if (ended) continue
    if (line.startsWith('ENDMDL')) {
      ended = true
      continue
    }
    if (!line.startsWith('HETATM') && !line.startsWith('ATOM  ')) continue
    const serial = Number(line.slice(6, 11))
    const x = Number(line.slice(30, 38))
    const y = Number(line.slice(38, 46))
    const z = Number(line.slice(46, 54))
    if (!isSerial(serial) || !isPlaced(x, y, z)) continue
    if (line.slice(17, 20) === PDB_RESIDUE) ours++
    atoms.push({ serial, x, y, z })
  }

  const name = fileName === '' ? 'This file' : fileName
  if (atoms.length === 0) throw new Error(`${name} has no ATOM or HETATM record with a place, so there is no bead to read.`)
  if (version === null || chains.length === 0 || runs.length === 0) {
    throw new Error(
      ours === atoms.length
        ? 'These beads are named the way this app writes a PDB, but the lines that said where each one ' +
          'is on the genome are gone: PyMOL drops REMARK records when it saves. Open the PDB as this ' +
          'app wrote it, or its bed3d.'
        : 'A PDB says where each bead is in space and not where it is on the genome, and this one does ' +
          'not say: pastis and the other solvers write their beads in bin order and nothing else. Write ' +
          'the coordinates beside the bins they were modelled at, as a bed3d (chrom, start, end, x, y, ' +
          'z), and open that.',
    )
  }
  if (version !== TABLE_VERSION) {
    throw new Error(
      `This PDB's placement table is version ${String(version)}, and this reader understands ` +
        `version ${TABLE_VERSION}.`,
    )
  }

  // Serial to chain and to bead, through the table. Bounded by the format's
  // own ceiling on a serial, so a table cannot ask for more than that.
  const chainOf = new Int32Array(PDB_MAX_ATOMS + 1).fill(-1)
  chains.forEach((chain, c) => {
    for (let at = chain.first; at <= chain.last; at++) chainOf[at] = c
  })
  const startOf = new Float64Array(PDB_MAX_ATOMS + 1).fill(-1)
  const widthOf = new Float64Array(PDB_MAX_ATOMS + 1)
  for (const run of runs) {
    for (let k = 0; k < run.count; k++) {
      startOf[run.first + k] = run.start + k * run.width
      widthOf[run.first + k] = run.width
    }
  }

  const names = haplotypes ?? []
  const hapIds = new Map<string, number>()
  names.forEach((hap, at) => hapIds.set(hap, at))
  // A table with no FRAME wrote the coordinates as they were.
  const written = frame ?? { cx: 0, cy: 0, cz: 0, factor: 1 }
  const seen = new Uint8Array(PDB_MAX_ATOMS + 1)
  const beads: Array<{ contig: string; start: number; end: number; xyz: [number, number, number]; hap: string }> = []
  for (const atom of atoms) {
    const c = chainOf[atom.serial]
    const start = startOf[atom.serial]
    if (c < 0 || start < 0 || seen[atom.serial] === 1) continue
    seen[atom.serial] = 1
    const chain = chains[c]
    if (!hapIds.has(chain.hap)) {
      hapIds.set(chain.hap, names.length)
      names.push(chain.hap)
    }
    beads.push({
      contig: chain.sequence,
      start,
      end: start + widthOf[atom.serial],
      xyz: [
        atom.x / written.factor + written.cx,
        atom.y / written.factor + written.cy,
        atom.z / written.factor + written.cz,
      ],
      hap: chain.hap,
    })
  }
  if (beads.length === 0) {
    throw new Error(`${name} has a placement table, and it places none of the file's ${fmt.int(atoms.length)} atoms.`)
  }

  const phased = names.length > 1
  const builder = new FeatureBuilder()
  for (const bead of beads) {
    builder.add(bead.contig, bead.start, bead.end, {
      xyz: bead.xyz,
      hap: hapIds.get(bead.hap) ?? 0,
      detail: phased ? `${G3D_FIELD_HAPLOTYPE} ${bead.hap}` : '',
    })
  }
  const schema: StructureSchema = { width: width ?? modeOf(beads.map((bead) => bead.end - bead.start)), haplotypes: names }
  return builder.finish(null, schema)
}

function isSerial(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= PDB_MAX_ATOMS
}

/** A name from the table, which writes every name URI-encoded so it is one word. */
function decoded(word: string): string {
  try {
    return decodeURIComponent(word)
  } catch {
    return word
  }
}

/** The commonest of some lengths, ties to the smaller; 1 where there are none. */
function modeOf(lengths: readonly number[]): number {
  const votes = new Map<number, number>()
  for (const value of lengths) if (value > 0) votes.set(value, (votes.get(value) ?? 0) + 1)
  let best = 0
  let mode = 1
  for (const [value, count] of votes) {
    if (count > best || (count === best && value < mode)) {
      best = count
      mode = value
    }
  }
  return mode
}
