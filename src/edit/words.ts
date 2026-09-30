/**
 * A step in words, as the stage's history lists it and the console writes it
 * (SPECS §27.2): what was done, to which stretch, in the display form of
 * §26.1 — 1-based, grouped — and the names the sequences had when it was done,
 * which is what a step is recorded in.
 */

import type { AsideReason, EditStep } from '../genome/edit'
import { formatLocus, formatPosition } from '../genome/assembly'

function span(sequence: string, from: number, to: number): string {
  return formatLocus({ contig: sequence, start: from, end: to })
}

const WHY: Record<AsideReason, string> = {
  debris: 'debris',
  contaminant: 'a contaminant',
  haplotig: 'a haplotig',
  unplaced: 'unplaced',
}

/** One line for a step. */
export function stepText(step: EditStep): string {
  switch (step.op) {
    case 'cut':
      return `cut ${step.sequence} before ${(step.at + 1).toLocaleString('en-US')}`
    case 'invert':
      return `turn ${span(step.sequence, step.from, step.to)}`
    case 'move':
    case 'duplicate': {
      const verb = step.op === 'move' ? 'move' : 'copy'
      // A place between two bases, named by the base before it — or, at the
      // very start, by the one after: never a position past a sequence's end.
      const where = step.at === 0 ? `before ${formatPosition(step.into, 0)}` : `after ${formatPosition(step.into, step.at - 1)}`
      return `${verb} ${span(step.sequence, step.from, step.to)} ${where}${step.strand === -1 ? ', turned' : ''}`
    }
    case 'join':
      return `join ${step.a}’s ${step.aEnd} to ${step.b}’s ${step.bEnd}${step.gap > 0 ? `, ${step.gap.toLocaleString('en-US')} N between` : ''}`
    case 'split':
      return `split ${step.sequence} before ${(step.at + 1).toLocaleString('en-US')}`
    case 'aside':
      // Sent to another genome of the metagenome, it says which (§27.10).
      return step.genome !== undefined && step.genome !== ''
        ? `send ${span(step.sequence, step.from, step.to)} to ${step.genome}`
        : `set aside ${span(step.sequence, step.from, step.to)} as ${WHY[step.why]}`
    case 'bring':
      return `bring in ${step.sequence}`
    case 'rotate':
      return `start ${step.sequence} at ${(step.at + 1).toLocaleString('en-US')}`
    case 'rename':
      return `rename ${step.sequence} to ${step.name}`
    case 'reorder':
      return 'reorder the sequences'
    case 'place': {
      const where = step.before === null ? 'last' : `before ${step.before}`
      const turned = step.strand === -1 ? ', turned' : ''
      return step.whole === true
        ? `put ${step.sequence} ${where}${turned}`
        : `make ${span(step.sequence, step.from, step.to)} a sequence of its own, ${where}${turned}`
    }
    case 'layout': {
      const count = step.sequences.length
      return `lay out as in ${step.from} · ${count.toLocaleString('en-US')} sequence${count === 1 ? '' : 's'}`
    }
  }
}
