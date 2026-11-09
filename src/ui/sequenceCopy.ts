/**
 * A sequence lane's residues as text, for the clipboard (§8.8).
 *
 * Two ways in, one reading: *Copy sequence* on a sequence lane's right-click
 * menu takes the stretch the lane is showing, and a drag across the residues or
 * across one reading frame takes the stretch dragged. Both end here, where the
 * bases are asked of the annotations worker — the same `bases` request the lane
 * draws from, in the chunks the worker answers whole — and turned into what is
 * on screen: the complement read backwards where the stretch is drawn reversed
 * (§27.2), and a frame's protein where a frame was dragged.
 *
 * Plain text, no FASTA header: what a primer tool, BLAST's box or a paper's
 * supplement takes pasted. The bases keep the file's case, since a soft-masked
 * repeat is lower-case for a reason.
 */

import { complementByte } from '../annotations/fasta'
import { translateFrame, type ReadingFrame } from '../annotations/codons'
import type { BaseRegion } from '../annotations/types'
import type { AnnotationClient } from '../annotations/worker/client'
import { strandOf, type LocusAxis } from '../render/locus'
import { fmt } from './dom'
import { copyTextToClipboard } from './export'
import { messageToast } from './toast'

/** The most a copy reads: ten megabases, a clipboard's worth and a few seconds of reading. */
export const SEQUENCE_COPY_LIMIT = 10_000_000

/** What one `bases` request answers whole (`annotations.worker.ts`'s `BASES_PER_REQUEST`). */
const CHUNK = 400_000

/** A stretch of one sequence, in the file's coordinates: 0-based, half-open. */
export interface SequenceStretch {
  contig: string
  start: number
  end: number
  /** Drawn the other way round, as a reversed piece of an edit is (§27.2). */
  reversed: boolean
}

/**
 * The stretch of one sequence between two places on an axis, or `null` where
 * they are on two sequences, or off the axis.
 *
 * Clamped to the axis first, so a view panned past a sequence's end still names
 * the part of it that is there.
 */
export function stretchBetween(axis: LocusAxis, from: number, to: number): SequenceStretch | null {
  const low = Math.max(axis.segments[0]?.unitStart ?? 0, Math.min(from, to))
  const high = Math.min(axis.unitEnd, Math.max(from, to))
  if (!(high > low)) return null
  // A hair inside the far end, which is the start of the next base — or of the
  // next sequence, on an axis of several.
  const a = axis.unitToLocus(low)
  const b = axis.unitToLocus(Math.max(low, high - 1e-6))
  if (a === null || b === null || a.contig !== b.contig) return null
  const segment = axis.segmentAt(low)
  return {
    contig: a.contig,
    start: Math.max(0, Math.floor(Math.min(a.bp, b.bp))),
    end: Math.ceil(Math.max(a.bp, b.bp)),
    reversed: segment !== null && strandOf(segment) === -1,
  }
}

/** A stretch's bases, read in the chunks the worker answers, or `null` where it answers nothing. */
export async function readStretch(
  client: AnnotationClient,
  entry: string,
  stretch: Pick<SequenceStretch, 'contig' | 'start' | 'end'>,
): Promise<BaseRegion | null> {
  const parts: Uint8Array[] = []
  let at = stretch.start
  while (at < stretch.end) {
    const end = Math.min(stretch.end, at + CHUNK)
    const got = await client.request<'bases'>({
      kind: 'bases',
      entry,
      regions: [{ contig: stretch.contig, start: at, end }],
    })
    const region = got.regions[0]
    if (region === undefined || region.end <= at) break
    parts.push(region.bases.subarray(at - region.start, Math.min(region.end, end) - region.start))
    // A shorter answer is the sequence's end: nothing past it to ask for.
    if (region.end < end) break
    at = end
  }
  if (parts.length === 0) return null
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const bases = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bases.set(part, offset)
    offset += part.length
  }
  return { contig: stretch.contig, start: stretch.start, end: stretch.start + length, bases }
}

/** The bases as text, read the way they are drawn: backwards and complemented on a reversed stretch. */
export function basesText(region: BaseRegion, reversed: boolean): string {
  if (!reversed) return new TextDecoder().decode(region.bases)
  const out = new Uint8Array(region.bases.length)
  for (let i = 0; i < out.length; i++) out[i] = complementByte(region.bases[region.bases.length - 1 - i])
  return new TextDecoder().decode(out)
}

/**
 * A stretch widened to whole codons of one frame: the first codon it touches to
 * the last. Frames are anchored to the sequence's first base (§8.8), so a
 * codon of frame ±k starts where `(position − (k − 1)) mod 3` is zero.
 */
export function codonStretch<T extends { start: number; end: number }>(stretch: T, frame: ReadingFrame): T {
  const phase = Math.abs(frame) - 1
  const start = stretch.start - ((((stretch.start - phase) % 3) + 3) % 3)
  const end = stretch.end + ((((phase - stretch.end) % 3) + 3) % 3)
  return { ...stretch, start: Math.max(0, start), end }
}

/** One frame's protein over a stretch of bases, as the strand it is read on runs. */
export function proteinText(region: BaseRegion, frame: ReadingFrame, code: number): string {
  return translateFrame(region, frame, code, region.start, region.end)
}

/**
 * Read a stretch and put it on the clipboard, saying so — or why not — in a
 * toast: a copy of ten megabases is a few seconds of reading, and a menu row
 * that closed with nothing said would look like one that did nothing.
 */
export async function copyStretch(
  client: AnnotationClient,
  entry: string,
  stretch: SequenceStretch,
  frame: { frame: ReadingFrame; code: number } | null = null,
): Promise<void> {
  const asked = frame === null ? stretch : codonStretch(stretch, frame.frame)
  try {
    const region = await readStretch(client, entry, asked)
    if (region === null) {
      messageToast('No sequence there to copy.')
      return
    }
    const text = frame === null ? basesText(region, stretch.reversed) : proteinText(region, frame.frame, frame.code)
    await copyTextToClipboard(text)
    messageToast(
      frame === null
        ? `Copied ${fmt.int(text.length)} bp of ${stretch.contig}`
        : `Copied ${fmt.int(text.length)} amino acids, frame ${frame.frame > 0 ? '+' : ''}${frame.frame}`,
    )
  } catch (err) {
    messageToast(`Could not copy the sequence: ${err instanceof Error ? err.message : String(err)}`)
  }
}
