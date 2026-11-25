/**
 * The clustering rounds a `.metacool` may keep (metacooler's `/clusters`): the
 * successive steps of a binner — metaTOR's overlapping, recursive and final
 * clusters, and its mobile elements in the round `mge`, with their hosts.
 *
 * Read once, for the curation stage (SPECS §33.2), from the file as it is:
 * `@rounds` (a JSON list, one object per round, each with a `name`), `table/`
 * (one row per cluster: its round, name, parent and the tool's columns) and
 * `members/` (one row per cluster and contig). The `indexes/` are not read —
 * their datasets have other lengths than one table's, and `members/` sorted by
 * cluster is all a round's contigs need.
 */

import type { Hdf5Handle } from '../h5/api'
import type { Table } from '../types'

/** One round, as `@rounds` describes it. */
export interface ClusterRound {
  name: string
  [key: string]: unknown
}

export interface Clusters {
  rounds: ClusterRound[]
  /** `clusters/table`: `round`, `name`, `parent`, `n_contigs`, `length`, and the tool's columns. */
  table: Table
  /** `members/cluster_id` and `members/contig_id`: rows of the table, rows of `/contigs`. */
  memberCluster: Int32Array
  memberContig: Int32Array
}

/**
 * The file's clustering rounds, or `null` where it keeps none — or keeps them
 * in a shape this build cannot vouch for, which is no reason to refuse a map
 * whose genomes are what it opens for.
 */
export function readClusters(handle: Hdf5Handle, contigs: number): Clusters | null {
  if (!handle.has('clusters/table') || !handle.has('clusters/members')) return null
  let rounds: ClusterRound[]
  try {
    const raw = handle.attrsAt('clusters')['rounds']
    const parsed: unknown = JSON.parse(String(raw))
    if (!Array.isArray(parsed)) return null
    rounds = parsed.filter((round): round is ClusterRound => round !== null && typeof round === 'object' && typeof (round as { name?: unknown }).name === 'string')
    if (rounds.length !== parsed.length) return null
  } catch {
    return null
  }
  const table = handle.readTable('clusters/table')
  const memberCluster = handle.readInt32('clusters/members/cluster_id')
  const memberContig = handle.readInt32('clusters/members/contig_id')
  if (memberCluster.length !== memberContig.length) return null
  const roundOf = table.data['round']
  if (roundOf === undefined || typeof table.get('name', 0) !== 'string' && table.length > 0) return null
  for (let r = 0; r < table.length; r++) {
    const round = Number(table.get('round', r))
    if (!Number.isInteger(round) || round < 0 || round >= rounds.length) return null
  }
  for (let k = 0; k < memberCluster.length; k++) {
    if (memberCluster[k] < 0 || memberCluster[k] >= table.length || memberContig[k] < 0 || memberContig[k] >= contigs) return null
  }
  return { rounds, table, memberCluster, memberContig }
}

/** The clusters of one round: each its row of the table, its name and its contigs. */
export function roundClusters(clusters: Clusters, round: string): Array<{ row: number; name: string; contigs: number[] }> {
  const index = clusters.rounds.findIndex((entry) => entry.name === round)
  if (index < 0) return []
  const out = new Map<number, { row: number; name: string; contigs: number[] }>()
  for (let r = 0; r < clusters.table.length; r++) {
    if (Number(clusters.table.get('round', r)) !== index) continue
    out.set(r, { row: r, name: String(clusters.table.get('name', r) ?? ''), contigs: [] })
  }
  for (let k = 0; k < clusters.memberCluster.length; k++) out.get(clusters.memberCluster[k])?.contigs.push(clusters.memberContig[k])
  return [...out.values()]
}
