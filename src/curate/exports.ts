/**
 * What a curation writes (SPECS §33.8): three tables, each a new file through
 * the save dialog, none of them touching the file that was opened.
 *
 * - **contig → genome**: `contig_name` and `genome_name`, a header and every
 *   contig of the file in its order — one of no genome as `__unbinned__` — so
 *   `metacooler reassign --contigs` reads it with its default format and makes
 *   the curated binning the map's, elements included, whatever `--missing` says.
 * - **elements**: one row per mobile element — its name, length, contigs and
 *   hosts.
 * - **element ↔ host**: one row per element and MAG in contact, or linked: the
 *   contacts and the affinity between them, the share of the element's contacts
 *   with MAGs, the method's confidence, whether a link holds — and who decided
 *   it: the file, a suggestion, auto mode or the reader.
 *
 * Tab-separated, one header line, `\n` line ends, numbers as the method holds
 * them to four significant places: tables a pipeline reads back.
 */

import { UNBINNED, type CuratedBinning, type Curation } from '../genome/curation'
import type { HostPair } from './suggest'

/** A table written, and what to say about it. */
export interface CurationTable {
  text: string
  rows: number
  note: string
}

function cell(value: string): string {
  // Names are ASCII without tabs by the format's rules; a stray tab or line
  // break would shift every column after it, so it is a space here.
  return value.replace(/[\t\r\n]/g, ' ')
}

/** The contig → genome table, for `metacooler reassign`. */
export function contigGenomeTable(binning: CuratedBinning, names: readonly string[]): CurationTable {
  const lines = ['contig_name\tgenome_name']
  let pooled = 0
  for (let c = 0; c < names.length; c++) {
    const g = binning.genomeOf[c]
    if (g < 0) pooled++
    lines.push(`${cell(names[c])}\t${cell(g < 0 ? UNBINNED : binning.genomes[g].name)}`)
  }
  const genomes = binning.genomes.length
  const n = names.length
  return {
    text: `${lines.join('\n')}\n`,
    rows: n,
    note: `${n.toLocaleString('en-US')} contigs in ${genomes.toLocaleString('en-US')} genomes, ${pooled.toLocaleString('en-US')} in none: \`metacooler reassign MAP --contigs\` this table makes it the map’s.`,
  }
}

/** The elements table. */
export function elementsTable(binning: CuratedBinning, names: readonly string[], lengths: readonly number[]): CurationTable {
  const hostsOf = new Map<string, string[]>()
  for (const link of binning.links) {
    const element = binning.genomes[binning.indexOfId(link.element) ?? -1]
    const mag = binning.genomes[binning.indexOfId(link.mag) ?? -1]
    if (element === undefined || mag === undefined) continue
    const list = hostsOf.get(element.id) ?? []
    list.push(mag.name)
    hostsOf.set(element.id, list)
  }
  const lines = ['element\tlength\tn_contigs\tcontigs\tn_hosts\thosts']
  let rows = 0
  for (const genome of binning.genomes) {
    if (genome.kind !== 'element') continue
    const length = genome.contigs.reduce((sum, c) => sum + lengths[c], 0)
    const hosts = (hostsOf.get(genome.id) ?? []).sort()
    lines.push(
      [cell(genome.name), String(length), String(genome.contigs.length), genome.contigs.map((c) => cell(names[c])).join(','), String(hosts.length), hosts.map(cell).join(',')].join('\t'),
    )
    rows++
  }
  return { text: `${lines.join('\n')}\n`, rows, note: `${rows.toLocaleString('en-US')} mobile elements, each with its contigs and hosts.` }
}

/** Who decided a link last, by the steps applied: the file where none did. */
export function linkDeciders(curation: Curation | null): Map<string, { by: string; linked: boolean }> {
  const out = new Map<string, { by: string; linked: boolean }>()
  if (curation === null) return out
  for (const entry of curation.history.slice(0, curation.cursor)) {
    const step = entry.step
    if (step.op !== 'link' && step.op !== 'unlink') continue
    out.set(`${step.element}\t${step.mag}`, { by: entry.by, linked: step.op === 'link' })
  }
  return out
}

function number(x: number): string {
  if (!Number.isFinite(x)) return ''
  if (x === 0) return '0'
  return Number(x.toPrecision(4)).toString()
}

/** The element ↔ host table: every pair in contact or linked. */
export function elementHostTable(binning: CuratedBinning, hosts: readonly HostPair[], curation: Curation | null): CurationTable {
  const deciders = linkDeciders(curation)
  const linked = new Map(binning.links.map((link) => [`${link.element}\t${link.mag}`, link]))
  const lines = ['element\tmag\tcontacts\taffinity\tshare\tconfidence\tlinked\tdecided_by']
  const written = new Set<string>()
  const row = (e: number, m: number, pair: HostPair | null): void => {
    const element = binning.genomes[e]
    const mag = binning.genomes[m]
    const key = `${element.id}\t${mag.id}`
    if (written.has(key)) return
    written.add(key)
    const link = linked.get(key)
    const decided = deciders.get(key)
    const by = decided !== undefined ? decided.by : link?.fromFile === true ? 'file' : link !== undefined ? 'reader' : ''
    lines.push(
      [
        cell(element.name),
        cell(mag.name),
        pair === null ? '0' : String(pair.contacts),
        pair === null ? '0' : number(pair.affinity),
        pair === null ? '0' : number(pair.share),
        pair === null ? '' : number(pair.confidence),
        link === undefined ? 'no' : 'yes',
        by,
      ].join('\t'),
    )
  }
  for (const pair of [...hosts].sort((x, y) => x.element - y.element || y.contacts - x.contacts)) row(pair.element, pair.mag, pair)
  // A link between two genomes in no contact at all is written too: it holds.
  for (const link of binning.links) {
    const e = binning.indexOfId(link.element)
    const m = binning.indexOfId(link.mag)
    if (e !== undefined && m !== undefined) row(e, m, null)
  }
  const rows = lines.length - 1
  return {
    text: `${lines.join('\n')}\n`,
    rows,
    note: `${rows.toLocaleString('en-US')} pairs of an element and a MAG, ${binning.links.length.toLocaleString('en-US')} of them linked.`,
  }
}
