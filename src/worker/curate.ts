/**
 * The curation stage's requests, answered in the reader's worker (SPECS §33):
 * the file's binning, the contig network's pass, the method's state after each
 * step, and a close-up's contacts.
 *
 * **What is kept outlives a session.** Closing the stage re-opens the file
 * through the new curation, as a change of resolution re-opens it (§33.4), and a
 * session's fields go with it — so the binning read and the network are kept
 * here, at module scope, by the file they were read from: the map's URI, its
 * contigs and its stored pixels. A pass of seven million pixels is not paid
 * again for a re-open that changed nothing of them.
 *
 * Thin handlers over pure modules (`curate/base.ts`, `curate/network.ts`,
 * `curate/suggest.ts`): this one only reads, keeps and copies.
 */

import { CuratedBinning } from '../genome/curation'
import type { MetaCooler } from '../metacooler/MetaCooler'
import { readFileBinning, type FileBinningRead } from '../curate/base'
import { background, tally, visibility } from '../curate/method'
import { focusPicture } from '../curate/focus'
import { binContigs, NetworkBuilder } from '../curate/network'
import { bareAnswer, stateAnswer } from '../curate/answer'
import { methodBinning, neighbourLists, type CurationEvidence } from '../curate/suggest'
import type { CurationBaseResult, CurationFocusResult, CurationNetworkResult, CurationRequest, CurationStateResult } from './curateProtocol'

/** What one file's curation keeps. */
interface Held {
  key: string
  read: FileBinningRead
  evidence: CurationEvidence | null
  summary: CurationNetworkResult | null
}

let held: Held | null = null
/** The byte source what is held was read through. */
let heldSource: unknown = null

/**
 * A map opened through a byte source: what is held of another source is let
 * go of. A file dropped again under the same name, with the same contigs and
 * pixels — after `metacooler reassign` wrote the stage's table into it, or
 * `metator markers --inplace` stored its markers — is another file, and its
 * binning, markers and network are read again; the same source opened again
 * (another rung, the session through a curation) keeps them. A remote file is
 * one source per address for as long as the reader holds it.
 */
export function openedThrough(source: unknown): void {
  if (source === heldSource) return
  heldSource = source
  held = null
}

/** The file a map is read from, as what is kept is keyed: its URI, contigs and pixels. */
function fileKey(mc: MetaCooler): string {
  return `${mc.uri}\u0000${mc.nContigs}\u0000${mc.nnz}`
}

/** The kept read of this file, made on the first ask. */
function keptRead(mc: MetaCooler): Held {
  const key = fileKey(mc)
  if (held === null || held.key !== key) held = { key, read: readFileBinning(mc), evidence: null, summary: null }
  return held
}

/** Forget what is kept: on `close`, and before a file of another key is read. */
export function releaseCuration(): void {
  held = null
  heldSource = null
}

/** The scan's hooks, as `reader.worker.ts`'s `scanHooks` makes them. */
export interface CurationHooks {
  cancelled(): boolean
  onProgress(done: number, total: number, note?: string): void
  pause?: () => Promise<void>
}

export function handleCurationBase(mc: MetaCooler): CurationBaseResult {
  if (!mc.hasGenomes) throw new Error('Only a metagenome has a binning to curate.')
  const kept = keptRead(mc)
  const { base, file, elements, gc, markers } = kept.read
  // Copies: what is posted is moved out of this worker, and these are kept.
  return {
    base: { ...base, genomeOf: base.genomeOf.slice(), names: [...base.names], lengths: [...base.lengths], genomes: base.genomes.map((g) => ({ ...g })), links: base.links.map((l) => ({ ...l })) },
    file,
    elements,
    gc: gc === null ? null : gc.slice(),
    markerSets: markers.map((table) => table.set.name),
    pixels: mc.nnz,
    networkHeld: kept.evidence !== null,
  }
}

/**
 * The contig network's pass: every stored pixel of the file once, in file
 * order, summed by pair of contigs (§33.5). Cancelled as every scan is; a
 * partial network is never kept.
 */
export async function handleCurationNetwork(mc: MetaCooler, hooks: CurationHooks, abort: () => Error): Promise<CurationNetworkResult> {
  const kept = keptRead(mc)
  if (kept.evidence !== null && kept.summary !== null) return { ...kept.summary }
  const builder = new NetworkBuilder(binContigs(chromOffsetOf(mc)), mc.nContigs)
  await mc.storedPixels.scanAll({
    onChunk: (chunk) => {
      if (hooks.cancelled()) return false
      builder.add(chunk.bin1, chunk.bin2, chunk.count, chunk.length)
      return true
    },
    onProgress: (done, all) => hooks.onProgress(done, all, 'reading every contact between contigs'),
    ...(hooks.pause === undefined ? {} : { pause: hooks.pause }),
  })
  if (hooks.cancelled()) throw abort()
  const network = builder.finish()
  const t = visibility(network)
  const binning = CuratedBinning.of(kept.read.base, null)
  const method = methodBinning(binning)
  const bg = background(tally(network, t, method), method.kinds)
  kept.evidence = {
    network,
    visibility: t,
    ...neighbourLists(network),
    markers: kept.read.markers,
    background: bg,
    names: kept.read.base.names,
    lengths: kept.read.base.lengths,
  }
  let within = 0
  for (let c = 0; c < network.contigs; c++) within += network.within[c]
  let between = 0
  for (let k = 0; k < network.contacts.length; k++) between += network.contacts[k]
  kept.summary = { contigs: network.contigs, pairs: network.first.length, pixels: builder.pixels, within, between, background: bg }
  return { ...kept.summary }
}

/** Each contig's first bin, and the bins' end: `chrom_offset`, from the map's own coordinates. */
function chromOffsetOf(mc: MetaCooler): Float64Array {
  const out = new Float64Array(mc.nContigs + 1)
  for (let c = 0; c < mc.nContigs; c++) {
    const [lo, hi] = mc.coords.contigBinExtent(c)
    out[c] = lo
    out[c + 1] = hi
  }
  return out
}

function evidenceOf(mc: MetaCooler): { kept: Held; evidence: CurationEvidence } {
  const kept = keptRead(mc)
  if (kept.evidence === null) throw new Error('The contig network has not been read: the stage reads it first.')
  return { kept, evidence: kept.evidence }
}

export function handleCurationState(mc: MetaCooler, request: Extract<CurationRequest, { kind: 'curationState' }>): CurationStateResult {
  const kept = keptRead(mc)
  const binning = CuratedBinning.of(kept.read.base, request.curation)
  // Before the contacts are read: what the markers and the binning say alone.
  if (kept.evidence === null) return bareAnswer(binning, kept.read.base.lengths, kept.read.markers)
  return stateAnswer(kept.evidence, binning, request.weights ?? {})
}

export function handleCurationFocus(mc: MetaCooler, request: Extract<CurationRequest, { kind: 'curationFocus' }>): CurationFocusResult {
  const { evidence } = evidenceOf(mc)
  const contigs = Int32Array.from(request.contigs)
  const slot = new Map<number, number>()
  contigs.forEach((c, k) => {
    if (!slot.has(c)) slot.set(c, k)
  })
  // Each pair once, from the side of its lower slot, then sorted by slot so a
  // readout finds a pair by binary search whatever order the contigs came in.
  const found: Array<[number, number, number]> = []
  contigs.forEach((c, k) => {
    if (slot.get(c) !== k) return
    for (let n = evidence.offsets[c]; n < evidence.offsets[c + 1]; n++) {
      const other = slot.get(evidence.neighbours[n])
      if (other === undefined || other <= k) continue
      found.push([k, other, evidence.counts[n]])
    }
  })
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const within = Float64Array.from(contigs, (c) => evidence.network.within[c])
  const t = Float64Array.from(contigs, (c) => evidence.visibility[c])
  let total = 0
  for (let c = 0; c < evidence.visibility.length; c++) total += evidence.visibility[c]
  const answer = {
    contigs,
    i: Int32Array.from(found, (f) => f[0]),
    j: Int32Array.from(found, (f) => f[1]),
    contacts: Float64Array.from(found, (f) => f[2]),
    within,
    visibility: t,
    total,
    background: evidence.background.rho,
  }
  return { ...answer, picture: focusPicture(contigs.length, answer, evidence.background.rho) }
}
