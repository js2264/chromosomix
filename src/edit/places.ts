/**
 * Where a place on screen went when the edit changed under it (SPECS §27.7).
 *
 * A view names a place in the assembly it is drawn in: `IV:1000000-1400000`
 * before an edit, `IV_e1:1000000-1400000` after one turned a stretch of IV,
 * and `IV` again once it is undone. When the stage closes on a different edit
 * the session is redrawn through the new one, and the view has to follow the
 * place rather than keep the words — `IV` may no longer exist, and where it
 * does, its 1.2 Mb may now be somewhere else. So the middle of the window is
 * carried through the file's own coordinates, from the old assembly to the new,
 * and the window is set down around wherever it landed, the same width.
 *
 * `null` for an assembly is the file as it is. `null` back is a place that did
 * not survive — set aside, or in a gap — and the caller goes somewhere that
 * always exists.
 */

import type { EditedAssembly } from '../genome/edit'

/** A region in the machine form a view state carries: `NAME` or `NAME:start-end`, 0-based, half-open. */
function parse(region: string): { name: string; start: number | null; end: number | null } {
  const found = /^(.*):(\d+)-(\d+)$/.exec(region)
  if (found === null) return { name: region, start: null, end: null }
  return { name: found[1], start: Number(found[2]), end: Number(found[3]) }
}

function lengthIn(assembly: EditedAssembly | null, other: EditedAssembly | null, name: string): number | null {
  if (assembly !== null) return assembly.lengthOf(name)
  const original = (other ?? assembly)?.original
  if (original === undefined) return null
  const index = original.names.indexOf(name)
  return index < 0 ? null : original.lengths[index]
}

/** A region of `before`, as the same place in `after`; `null` where it did not survive. */
export function carryRegion(region: string, before: EditedAssembly | null, after: EditedAssembly | null): string | null {
  if (before === after) return region
  const { name, start, end } = parse(region)
  const length = lengthIn(before, after, name)
  if (length === null) return null
  const from = start ?? 0
  const to = Math.min(end ?? length, length)
  if (!(to > from)) return null
  // The middle first, and failing that either end: a window whose middle fell
  // in a gap has not gone anywhere.
  for (const bp of [Math.floor((from + to) / 2), from, to - 1]) {
    const original = before === null ? { sequence: name, bp, strand: 1 as const } : before.toOriginal(name, bp)
    if (original === null) continue
    const landing =
      after === null
        ? { sequence: original.sequence, bp: original.bp, strand: 1 as const }
        : after.toEdited(original.sequence, original.bp)[0]
    if (landing === undefined) continue
    const target = lengthIn(after, before, landing.sequence)
    if (target === null) continue
    // A whole sequence stays a whole sequence: its successor, whole.
    if (start === null) return landing.sequence
    const width = Math.min(to - from, target)
    // Set down around the landing the way round it now reads: where the
    // stretch was turned between the two, what was left of the middle is right
    // of it, a base for a base.
    const turned = original.strand * landing.strand === -1
    const left = turned ? landing.bp - (to - 1 - bp) : landing.bp - (bp - from)
    const at = Math.max(0, Math.min(target - width, Math.round(left)))
    return `${landing.sequence}:${at}-${at + width}`
  }
  return null
}

/**
 * A stretch of an edited sequence, as the stretch of the file it is — how a
 * mark is kept under an edit (§27.7): in the file's coordinates, and drawn
 * wherever they land.
 *
 * A stretch laid across a junction is two places in the file and not one, and
 * the piece the gesture began in — `anchor`, an edited position — says which:
 * the stretch is clamped to that piece, the rule a box laid across a sequence's
 * edge already follows. A name the edit does not have is handed back as it is;
 * `null` where the gesture began in a gap, which is nowhere in the file.
 */
export function stretchInFile(
  assembly: EditedAssembly | null,
  stretch: { contig: string; from: number; to: number },
  anchor: number,
): { contig: string; from: number; to: number } | null {
  if (assembly === null || assembly.sequence(stretch.contig) === null) return stretch
  if (!(stretch.to > stretch.from)) return null
  const at = Math.min(Math.max(anchor, stretch.from), stretch.to - 1)
  for (const { offset, piece } of assembly.piecesIn(stretch.contig, stretch.from, stretch.to)) {
    if (at >= offset && at < offset + (piece.end - piece.start)) {
      return { contig: piece.sequence, from: piece.start, to: piece.end }
    }
  }
  return null
}

/**
 * A window of the edited assembly, as the same view of the file — how a
 * bookmark is kept under an edit (§27.7), in the file's coordinates like a
 * mark, and set down wherever it lands under the edit it is gone back to: the
 * middle carried to where the file has it, and the window set down around it,
 * the same width, as {@link carryRegion} carries a view across a change of
 * edit. The window as it is where the edit left its sequence whole or does not
 * name it; `null` where no base of its middle or its ends is in the file.
 */
export function windowInFile(
  assembly: EditedAssembly | null,
  window: { contig: string; start: number; end: number },
): { contig: string; start: number; end: number } | null {
  if (assembly === null || assembly.sequence(window.contig) === null) return window
  const carried = carryRegion(`${window.contig}:${window.start}-${window.end}`, assembly, null)
  if (carried === null) return null
  const { name, start, end } = parse(carried)
  return start === null || end === null ? null : { contig: name, start, end }
}
