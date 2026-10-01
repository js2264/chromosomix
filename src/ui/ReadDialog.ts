/**
 * Everything the file says about one alignment, on being asked.
 *
 * {@link openFeatureDialog}'s sibling, and deliberately its twin in shape: a
 * click on a read opens a card that stays open, holds what the record actually
 * carried, and can be selected and copied out of. A read is a worse tooltip
 * subject than a gene and a better card subject — the facts a reader wants are
 * its flags, its CIGAR and where its mate went, and none of the three fits in
 * two lines following a pointer.
 *
 * What it does *not* do is fetch. Every field here is already in the
 * {@link ReadPile} the lane drew, which is the reason a click can answer
 * instantly and the reason the answer cannot disagree with the picture: the
 * card and the rectangle are made of the same numbers.
 *
 * Browser-only, like the pile it comes from (§8.13). There is no read to click
 * beside a heatmap, because there is no read drawn there.
 */

import { formatLocus, formatPosition } from '../genome/assembly'
import { CIGAR_OPS, FLAG } from '../annotations/bam/format'
import type { ReadPile } from '../annotations/types'
import { modLabel } from '../annotations/bam/basemods'
import { Modal } from './Modal'
import { el, fmt } from './dom'
import { icon } from './icons'

export interface ReadDialogProps {
  pile: ReadPile
  index: number
  /** What the lane it came from is called, for the line that says where. */
  source: string
  /** Frame the view on this read, and close. */
  onGoTo?(): void
  onClose?(): void
}

/** One `key: value` line. The value is selectable; that is half the point. */
function row(key: string, value: string): HTMLElement {
  return el(
    'div',
    { class: 'feature-row' },
    el('span', { class: 'feature-key', text: key }),
    el('span', { class: 'feature-val', text: value }),
  )
}

/**
 * The SAM flag in words.
 *
 * Every bit that is set, named the way the specification names it, plus the raw
 * number in brackets — because the number is what a reader will paste into
 * `samtools view -f`, and a card that hid it would be a card they had to work
 * around. Bits nobody set are simply absent: listing twelve rows of "no" to
 * carry two of "yes" is how a card stops being read.
 */
const FLAG_WORDS: Array<[number, string]> = [
  [FLAG.PAIRED, 'paired'],
  [FLAG.PROPER_PAIR, 'proper pair'],
  [FLAG.UNMAPPED, 'unmapped'],
  [FLAG.MATE_UNMAPPED, 'mate unmapped'],
  [FLAG.REVERSE, 'reverse'],
  [FLAG.MATE_REVERSE, 'mate reverse'],
  [FLAG.FIRST_IN_PAIR, 'first in pair'],
  [FLAG.SECOND_IN_PAIR, 'second in pair'],
  [FLAG.SECONDARY, 'secondary'],
  [FLAG.QC_FAIL, 'QC fail'],
  [FLAG.DUPLICATE, 'duplicate'],
  [FLAG.SUPPLEMENTARY, 'supplementary'],
]

function flagText(flags: number): string {
  const set = FLAG_WORDS.filter(([bit]) => (flags & bit) !== 0).map(([, word]) => word)
  return set.length === 0 ? `none (${flags})` : `${set.join(', ')} (${flags})`
}

/**
 * The CIGAR, rebuilt from the ops the pile is holding.
 *
 * Long ones are cut, because a spliced long read can carry hundreds of
 * operations and a card is not a place to scroll through them. What is kept is
 * the head, which is where the clipping and the first blocks are — the part
 * anyone reads a CIGAR for.
 */
const CIGAR_LIMIT = 24

function cigarText(pile: ReadPile, at: number): string {
  const from = pile.opAt[at]
  const to = pile.opAt[at + 1]
  const n = to - from
  if (n <= 0) return '—'
  const shown = Math.min(n, CIGAR_LIMIT)
  let out = ''
  for (let i = from; i < from + shown; i++) {
    out += `${pile.opLen[i]}${CIGAR_OPS[pile.opCode[i]] ?? '?'}`
  }
  return shown < n ? `${out}… (${n} operations)` : out
}

/**
 * Where the mate is, in one line.
 *
 * Three genuinely different answers and they are worth distinguishing: on the
 * same sequence (the ordinary case, and then the insert size means something),
 * on another one (a translocation, a scaffolding artefact, or a viral
 * integration — the reason anyone colours by mate at all), and nowhere.
 */
function mateText(pile: ReadPile, at: number): string {
  if ((pile.flags[at] & FLAG.PAIRED) === 0) return 'unpaired'
  if ((pile.flags[at] & FLAG.MATE_UNMAPPED) !== 0) return 'unmapped'
  const contig = pile.mateContig[at]
  const position = pile.matePos[at]
  if (contig < 0 || position < 0) return 'not recorded'
  const name = pile.contigs[contig] ?? '?'
  const where = formatPosition(name, position)
  const strand = (pile.flags[at] & FLAG.MATE_REVERSE) !== 0 ? 'reverse' : 'forward'
  return name === pile.contig ? `${where} (${strand})` : `${where} (${strand}, other sequence)`
}

/** How many bases of this read disagree with the reference, where any do. */
function diffCount(pile: ReadPile, at: number): number {
  return pile.diffAt[at + 1] - pile.diffAt[at]
}

/** `5mC (m) 41 calls, 30 modified · 5hmC (h) 41 calls, 2 modified`, or `''`. */
function modSummary(pile: ReadPile, at: number): string {
  const mods = pile.mods
  if (mods === undefined) return ''
  const calls = new Map<number, [number, number]>()
  for (let k = mods.at[at]; k < mods.at[at + 1]; k++) {
    const held = calls.get(mods.code[k]) ?? [0, 0]
    held[0]++
    if (mods.prob[k] >= 128) held[1]++
    calls.set(mods.code[k], held)
  }
  if (calls.size === 0) return 'none in its MM/ML tags'
  return [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, [n, modified]]) => `${modLabel(mods.codes[code] ?? '')} ${fmt.int(n)} calls, ${fmt.int(modified)} modified`)
    .join(' · ')
}

/** Open the card. Returns the modal so the caller can hold and dismiss it. */
export function openReadDialog(props: ReadDialogProps): Modal {
  const { pile, index: at } = props
  const name = pile.names[at] ?? ''
  const start = pile.refStart[at]
  const end = pile.refEnd[at]
  const flags = pile.flags[at]

  return new Modal({
    // The name, when the pile kept one. It only does at the zoom where reads are
    // wide enough for a reader to have been aiming at a particular one, which is
    // also the only zoom at which one can be clicked — so in practice this is
    // always the name, and the fallback is a guard rather than a case.
    title: name === '' ? 'Read' : name,
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => {
      const rows: HTMLElement[] = [
        // The name again, under the title, and this is not a duplicate for its
        // own sake: the heading is uppercased by the house style and a read name
        // is a case-sensitive identifier somebody is going to paste into
        // `samtools view | grep`. Here it is selectable and exactly as the file
        // wrote it. `FeatureDialog` repeats a gene's name for the same reason.
        ...(name === '' ? [] : [row('name', name)]),
        row('position', formatLocus({ contig: pile.contig, start, end })),
        // The *aligned* span, and the label says so: a spliced read covers ten
        // kilobases and is a hundred bases long, and "length" alone would be the
        // card asserting the wrong one of those.
        row('aligned span', fmt.bp(end - start)),
        row('strand', (flags & FLAG.REVERSE) !== 0 ? 'reverse (−)' : 'forward (+)'),
        row('mapping quality', pile.mapq[at] === 255 ? 'not available (255)' : String(pile.mapq[at])),
        row('flags', flagText(flags)),
        row('CIGAR', cigarText(pile, at)),
      ]

      const clipped = pile.clipStart[at] + pile.clipEnd[at]
      if (clipped > 0) {
        rows.push(row('soft clipped', `${pile.clipStart[at]} before, ${pile.clipEnd[at]} after`))
      }

      rows.push(row('mate', mateText(pile, at)))
      // Only where the file wrote one. `0` is what an unpaired or
      // single-ended record carries, and printing "insert size: 0" would be
      // reporting a measurement nobody made.
      if (pile.tlen[at] !== 0) {
        rows.push(row('insert size', `${fmt.int(Math.abs(pile.tlen[at]))} bp`))
      }

      const diffs = diffCount(pile, at)
      if (diffs > 0) rows.push(row('mismatches', String(diffs)))

      // The read's modification calls, by code, where the pile carries them
      // (§8.13): how many bases each was called on and how many of those
      // cleared one half — the threshold-free count, since the card is about
      // the record and the lane's threshold is a reading of it.
      const mods = modSummary(pile, at)
      if (mods !== '') rows.push(row('modifications', mods))

      // Which category this read was coloured as. Worth a row: the colouring is
      // a control the reader set, and a card that showed the read without
      // saying which bucket it landed in leaves the legend to be read backwards
      // off the picture.
      const group = pile.groups[pile.group[at]]
      if (group !== undefined && pile.groups.length > 1) rows.push(row('group', group))

      rows.push(row('track', props.source))

      const foot = el('div', { class: 'feature-foot' })
      if (props.onGoTo !== undefined) {
        const go = props.onGoTo
        const button = el('button', {
          class: 'btn btn-keyed',
          type: 'button',
          title: 'Frame the view on this read, with a little room either side',
        })
        button.append(icon('zoom-in', { size: 14 }), el('span', { text: 'zoom to it' }))
        button.addEventListener('click', () => {
          close()
          go()
        })
        foot.append(button)
      }

      return el('div', { class: 'feature-body' }, el('div', { class: 'feature-rows' }, ...rows), foot)
    },
  })
}
