/**
 * Everything a file says about one feature, on being asked.
 *
 * A click on a gene used to zoom to it. That is a reasonable thing for a click
 * to do and it was the wrong one, because it answers a question nobody had: the
 * gene is already on screen — it was clicked — and what a reader wants from it
 * is what it *is*. The tooltip says a little of that, in the two or three lines
 * a box following the pointer can hold, and it goes away the moment the pointer
 * does, which rules out reading a systematic name and typing it somewhere else.
 *
 * So the click opens a panel that stays open, holds everything the parser kept,
 * and can be selected and copied out of. Zooming is still available from inside
 * it, as a button — the old gesture is not lost, it is behind a name.
 *
 * One module for both surfaces. The map's lanes and the 1D browser draw the same
 * `FeatureSet` through the same renderer, and a feature card that said two
 * different things about one gene depending on which picture it was clicked in
 * would be the application disagreeing with itself.
 */

import { DETAIL_SEP, type BarChartBars, type FeatureSet } from '../annotations/types'
import { barColours } from '../render/barchart'
import { Modal } from './Modal'
import { el, fmt } from './dom'
import { icon } from './icons'

export interface FeatureDialogProps {
  /** The set the feature belongs to, and which row of it. */
  set: FeatureSet
  index: number
  /** What the track it came from is called, for the line that says where. */
  source: string
  /**
   * Frame the feature in the view behind the dialog, and close.
   *
   * Optional, and absent is not an oversight: this is the gesture's *old*
   * meaning, offered back where the view has somewhere to take it. A contact
   * map's lanes hang off a view whose navigation is a region on two axes, and a
   * button that silently did half of that would be worse than no button.
   */
  onGoTo?(): void
  onClose?(): void
}

/** `chrI:1,234–5,678`, in the 1-based inclusive form a reader writes. */
function locusOf(set: FeatureSet, at: number): string {
  const contig = set.contigs[set.contig[at]]
  return `${contig}:${fmt.int(set.start[at] + 1)}–${fmt.int(set.end[at])}`
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
 * The attributes the parser kept, one to a line.
 *
 * Split back apart rather than shown as the single joined string the tooltip
 * uses: `YBR020W · biotype protein_coding · source SGD · 1 exons` is four facts,
 * and four facts on four lines is the difference between a card that can be
 * scanned and a card that has to be read. See {@link DETAIL_SEP} for why the
 * separator is imported rather than spelled out.
 *
 * A part that already reads as `key value` — `source SGD`, `score 12` — is split
 * at its first space so it lines up with the rows above it. One that does not
 * gets no key, because inventing one ("attribute: protein_coding") would be
 * labelling a thing this code does not actually know the name of.
 */
function attributeRows(detail: string): HTMLElement[] {
  // The keys the parsers actually write. A VCF's are the second set (§8.14) and
  // they are the reason this list is worth keeping in one place: `REF>ALT` is
  // the answer to the question the click asked and has no key at all, while
  // `QUAL 60` and `filter q10` are two facts that read as one run-on string
  // unless they are split here.
  const KEYED =
    /^(biotype|source|score|signal|summit|-log10 [pq]|type|QUAL|filter|AF|DP|SVTYPE|top|total) (.+)$/
  return detail
    .split(DETAIL_SEP)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const keyed = KEYED.exec(part)
      return keyed === null ? row('', part) : row(keyed[1], keyed[2])
    })
}

/**
 * What the file calls this gene, both ways, at the top of the card.
 *
 * First because it is the answer to the question the click asked. A reader who
 * clicks a glyph labelled `VAR` on a *Plasmodium* map is very often clicking it
 * *because* sixty of them are called that, and the accession is the whole of
 * what distinguishes this one — so it belongs above the coordinates rather than
 * three lines down among the attributes, and labelled rather than sitting in the
 * card as an unexplained string of capitals.
 *
 * Both lines only where there are two facts. `name === id` is how
 * {@link FeatureSet.id} spells a gene the file identifies but never names, and
 * printing that twice under two different labels would invent a symbol the file
 * does not contain. A format with no accession at all — a BED, a peak set —
 * gets neither line and keeps its name in the title, where it always was.
 */
function geneRows(name: string, id: string): HTMLElement[] {
  if (id === '') return []
  return name === '' || name === id
    ? [row('gene ID', id)]
    : [row('gene name', name), row('gene ID', id)]
}

/**
 * The exons, as coordinates rather than as a count.
 *
 * Capped, and the cap is visible in the text rather than silent: a transcript
 * with sixty exons is a real thing to click on, and a card that listed all sixty
 * would push everything under it off the bottom of a dialog that is at most four
 * fifths of the window tall. The count above the list is the whole truth; the
 * list is the part worth reading.
 */
const EXON_LIMIT = 12

function exonRows(set: FeatureSet, at: number): HTMLElement[] {
  const from = set.exonAt[at]
  const to = set.exonAt[at + 1]
  const n = to - from
  if (n <= 0) return []
  const shown = Math.min(n, EXON_LIMIT)
  const parts: string[] = []
  for (let i = from; i < from + shown; i++) {
    parts.push(`${fmt.int(set.exonStart[i] + 1)}–${fmt.int(set.exonEnd[i])}`)
  }
  if (shown < n) parts.push(`… ${n - shown} more`)
  return [row('exons', String(n)), row('', parts.join(', '))]
}

/**
 * How many categories the card lists before it stops.
 *
 * The same reasoning as {@link EXON_LIMIT} and a much larger number, because
 * these are the *answer* rather than a supporting detail: a reader who clicked a
 * barChart clicked it to see the chart, and a card that showed a dozen of
 * fifty-four tissues would have answered a different question. Sixty-four is
 * where the list stops being a chart and starts being a file.
 */
const BAR_LIMIT = 64

/**
 * The whole chart, read out (§8.17).
 *
 * The one thing on this card that is not a line of text, and the reason is that
 * the glyph it came from is at most a few dozen pixels wide: the lane says
 * *roughly which categories are high* and this says *which, and how much*. So
 * it is the same picture at a size that can be read, in **file order** — the
 * order the bars are drawn in — so the card reads left-to-right as the glyph
 * does and can be used as its legend. Sorting by value would answer a question
 * this card is not being asked and would make two features' cards two different
 * orders of the same categories.
 *
 * The colours are `barColours`, the function the renderer itself calls, so a
 * bar named here in a colour it is not drawn in would be a bug in the ink rule
 * rather than a second palette drifting out of step (§8.16).
 */
function barRows(bars: BarChartBars, at: number): HTMLElement[] {
  const width = bars.labels.length
  const from = at * width
  // A row that kept its interval and lost its chart (§8.17). It has nothing to
  // show and must not show zeroes, which would be a measurement.
  if (!Number.isFinite(bars.values[from])) return []
  const colours = barColours(bars)
  const ceiling = bars.max > 0 ? bars.max : 1
  const shown = Math.min(width, BAR_LIMIT)
  const rows: HTMLElement[] = []
  for (let c = 0; c < shown; c++) {
    const value = bars.values[from + c]
    rows.push(
      el(
        'div',
        { class: 'feature-bar' },
        el('span', { class: 'feature-bar-name', text: bars.labels[c] }),
        el(
          'span',
          { class: 'feature-bar-track' },
          el('span', {
            class: 'feature-bar-fill',
            style: {
              // Clamped rather than trusted: `maxLimit` is the file's own
              // ceiling and a row may exceed it, and a bar 140% along its track
              // would run out of the card.
              width: `${Math.max(0, Math.min(1, value / ceiling)) * 100}%`,
              background: colours[c],
            },
          }),
        ),
        el('span', { class: 'feature-bar-value', text: fmt.num(value) }),
      ),
    )
  }
  const what = bars.label === '' ? 'categories' : bars.label.toLowerCase()
  const unit = bars.unit === '' ? '' : ` (${bars.unit})`
  const metric = bars.metric === '' ? '' : `${bars.metric.toLowerCase()} `
  return [
    row(what, `${metric}per category${unit}, to ${fmt.num(bars.max)}`),
    el('div', { class: 'feature-bars' }, ...rows),
    ...(shown < width ? [row('', `… ${width - shown} more`)] : []),
  ]
}

/** Open the card. Returns the modal so the caller can hold and dismiss it. */
export function openFeatureDialog(props: FeatureDialogProps): Modal {
  const { set, index: at } = props
  const name = set.name[at]
  const length = set.end[at] - set.start[at]
  const strand = set.strand[at]

  return new Modal({
    // The name is the title, because it is what the reader clicked on. A feature
    // with none — a peak, an unnamed BED row — says what kind of thing it is
    // instead, rather than leaving the heading blank.
    title: name === '' ? 'Feature' : name,
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => {
      const rows: HTMLElement[] = [
        ...geneRows(name, set.id[at]),
        row('position', locusOf(set, at)),
        row('length', fmt.bp(length)),
      ]
      // Only where the format carries one. A `0` strand means "this file does
      // not say", and writing "strand: ." would be reporting a fact the file
      // does not contain.
      if (strand !== 0) rows.push(row('strand', strand === 1 ? 'forward (+)' : 'reverse (−)'))
      if (Number.isFinite(set.score[at])) rows.push(row('score', fmt.num(set.score[at])))
      rows.push(...attributeRows(set.detail[at]))
      // Before the exons and after the attributes: a barChart has no exons and
      // the attributes are `top` and `total`, which are this chart summarised —
      // so the summary reads first and the chart it summarises is under it.
      if (set.bars !== undefined) rows.push(...barRows(set.bars, at))
      const cdsFrom = set.cdsStart[at]
      const cdsTo = set.cdsEnd[at]
      if (cdsFrom >= 0 && cdsTo > cdsFrom) {
        rows.push(row('coding', `${fmt.int(cdsFrom + 1)}–${fmt.int(cdsTo)}`))
      }
      rows.push(...exonRows(set, at))
      // Last, and in the dimmer style: which file this came from is the question
      // a reader asks after the ones above, and only when two tracks disagree.
      rows.push(row('track', props.source))

      const foot = el('div', { class: 'feature-foot' })
      if (props.onGoTo !== undefined) {
        const go = props.onGoTo
        const button = el('button', {
          class: 'btn btn-keyed',
          type: 'button',
          title: 'Frame the view on this feature, with a little room either side',
        })
        button.append(icon('zoom-in', { size: 14 }), el('span', { text: 'Zoom to it' }))
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
