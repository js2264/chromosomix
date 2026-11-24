/**
 * The file's binning as the curation starts from it (SPECS §33.2), read from the
 * file itself — never from tables a curation's lens already answers.
 *
 * - The **genomes** are `/genomes` but the pool, `__unbinned__`, which is matched
 *   by name and never by index (§7.4).
 * - A genome is an **element** when its `mge` column says `True`, or its name is
 *   a cluster's of metaTOR's round `mge`; a MAG otherwise.
 * - The clusters of round `mge` are elements **even where the file did not make
 *   them genomes**: their contigs are the element's, out of whatever genome
 *   holds them, as `metator host` counts them — so the binning is exclusive from
 *   the first step.
 * - The **host links** are round `mge`'s `hosts`, else every MAG's `mges` column.
 * - With them, what the stage draws and weighs per contig: its GC content, where
 *   the map has one, and its marker genes under each set `metator markers`
 *   stored, with the sets' markers and weights from the map's metadata.
 */

import type { MetaCooler } from '../metacooler/MetaCooler'
import { readClusters, roundClusters } from '../metacooler/clusters'
import { UNBINNED, fileBinning, type BaseBinning, type FileBinning, type GenomeKind } from '../genome/curation'
import { markerTable, type ContigMarkers, type MarkerSet } from './quality'

/** The round metaTOR keeps its mobile elements in. */
export const MGE_ROUND = 'mge'

/** Everything the curation reads of the file, once. */
export interface FileBinningRead {
  base: BaseBinning
  file: FileBinning
  /** Where the elements came from: none, genomes flagged or named after round `mge`, or that round alone. */
  elements: { count: number; fromRoundOnly: number }
  /** Each contig's GC content, in percent; `null` where the map has none. */
  gc: Float64Array | null
  /** One table per marker set the map holds, bacteria first as metaTOR stores them. */
  markers: ContigMarkers[]
}

/** The text of a column at a row, `''` where it is missing. */
function textAt(value: string | number | undefined): string {
  return value === undefined || value === null ? '' : String(value)
}

/** Read the file's binning from the map as it is: pass `mc.unlensed ?? mc`. */
export function readFileBinning(mc: MetaCooler): FileBinningRead {
  const names = [...mc.chromnames]
  const lengths = mc.contigs.numbers('length')
  const fileIds = mc.contigGenomeIds
  const genomeNames = mc.genomeNames
  const full = mc.fullGenomes()
  const flagged = new Set<string>()
  if (full !== null && full.columns.includes('mge')) {
    for (let r = 0; r < full.length; r++) if (textAt(full.get('mge', r)).toLowerCase() === 'true') flagged.add(textAt(full.get('name', r)))
  }
  const clusters = readClusters(mc.handle, names.length)
  const mgeRound = clusters === null ? [] : roundClusters(clusters, MGE_ROUND)
  const roundNames = new Set(mgeRound.map((cluster) => cluster.name))

  // The file's genomes, but the pool.
  const genomes: Array<{ name: string; kind: GenomeKind }> = []
  const indexOf = new Map<string, number>()
  const fileToBase = new Int32Array(genomeNames.length).fill(-1)
  genomeNames.forEach((name, g) => {
    if (name === UNBINNED) return
    fileToBase[g] = genomes.length
    indexOf.set(name, genomes.length)
    genomes.push({ name, kind: flagged.has(name) || roundNames.has(name) ? 'element' : 'mag' })
  })
  const genomeOf = new Int32Array(names.length)
  for (let c = 0; c < names.length; c++) genomeOf[c] = fileIds[c] >= 0 ? fileToBase[fileIds[c]] : -1

  // Round mge's clusters the file did not make genomes: elements all the same.
  let fromRoundOnly = 0
  for (const cluster of mgeRound) {
    let g = indexOf.get(cluster.name)
    if (g === undefined) {
      g = genomes.length
      indexOf.set(cluster.name, g)
      genomes.push({ name: cluster.name, kind: 'element' })
      fromRoundOnly++
    }
    for (const c of cluster.contigs) genomeOf[c] = g
  }

  // The links: round mge's hosts, else the MAGs' own lists.
  const links: Array<{ element: string; mag: string }> = []
  const seen = new Set<string>()
  const addLink = (element: string, mag: string): void => {
    const e = indexOf.get(element)
    const m = indexOf.get(mag)
    if (e === undefined || m === undefined || genomes[e].kind !== 'element' || genomes[m].kind !== 'mag') return
    const key = `${element}\t${mag}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ element, mag })
  }
  if (clusters !== null && clusters.table.columns.includes('hosts')) {
    for (const cluster of mgeRound) for (const host of textAt(clusters.table.get('hosts', cluster.row)).split(',')) if (host.trim() !== '') addLink(cluster.name, host.trim())
  } else if (full !== null && full.columns.includes('mges')) {
    for (let r = 0; r < full.length; r++) {
      const mag = textAt(full.get('name', r))
      for (const element of textAt(full.get('mges', r)).split(',')) if (element.trim() !== '') addLink(element.trim(), mag)
    }
  }

  const base: BaseBinning = { names, lengths, genomeOf, genomes, links }
  const contigsTable = mc.fullContigs()
  let gc: Float64Array | null = null
  const gcColumn = contigsTable.columns.find((column) => /^gc(_content|-content|content)?$/i.test(column))
  if (gcColumn !== undefined) {
    const values = contigsTable.numbers(gcColumn)
    const percent = values.some((v) => v > 1)
    gc = Float64Array.from(values, (v) => (Number.isFinite(v) ? (percent ? v : v * 100) : Number.NaN))
  }
  return {
    base,
    file: fileBinning(base),
    elements: { count: genomes.filter((genome) => genome.kind === 'element').length, fromRoundOnly },
    gc,
    markers: readMarkers(mc, contigsTable),
  }
}

/**
 * The marker sets `metator markers` stored: each set's markers and weights
 * from the map's metadata (`metator.markers.sets`), each contig's from its
 * column `markers_<set>`. None where either half is missing or malformed.
 */
function readMarkers(mc: MetaCooler, contigs: ReturnType<MetaCooler['fullContigs']>): ContigMarkers[] {
  const metator = (mc.metadata as Record<string, unknown>)['metator']
  const entry = metator !== null && typeof metator === 'object' ? (metator as Record<string, unknown>)['markers'] : undefined
  const sets = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['sets'] : undefined
  if (sets === null || typeof sets !== 'object') return []
  const out: ContigMarkers[] = []
  for (const [name, value] of Object.entries(sets as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const { markers, weights } = value as Record<string, unknown>
    if (!Array.isArray(markers) || !Array.isArray(weights) || markers.length !== weights.length) continue
    if (!markers.every((m) => typeof m === 'string') || !weights.every((w) => typeof w === 'number' && Number.isFinite(w))) continue
    const column = `markers_${name}`
    if (!contigs.columns.includes(column)) continue
    const set: MarkerSet = { name, markers: markers as string[], weights: weights as number[] }
    out.push(markerTable(set, contigs.strings(column)))
  }
  return out
}
