/**
 * The **Synthetic tracks** card: what an analysis produced, listed as tracks.
 *
 * It exists because of §18.5, which is §8.9's argument made a second time and
 * settled the same way. A result that is one value per bin *is* a track, and a
 * track belongs on the map rather than in the drawer it was computed in. So a
 * per-bin output joins the same {@link AnnotationStore} a dropped bigWig joins,
 * as an ordinary entry with `kind: 'track'` — and from that moment the colour,
 * the rename, the limits, the autoscale group, the four edges, the reorder, the
 * hairline, the tooltip, the 1D browser and the vector figure all work, because
 * they are the one implementation those rows already go through and not a second
 * copy written against a drawer.
 *
 * What is left for a card of its own is therefore very little, and that is the
 * point rather than an oversight: a heading, so a reader can tell the four
 * things they computed from the six they loaded, and an **export row**, which is
 * the one control a loaded track has no use for — you do not export a bigWig you
 * were given. Everything else on a row here is deliberately the same three
 * direct manipulations the Tracks card's head carries, calling the same store
 * methods with the same arguments.
 *
 * Two things a loaded track's row cannot say, and this one must. The **task**
 * that made it and the **framing** it was computed against are written under the
 * name, because a synthetic track whose provenance is invisible is a number
 * nobody can defend — and because the framing is a snapshot (§18.4), so a row
 * that says nothing would let a reader compare a profile of one region against a
 * map of another without ever being told. And a row that came back from a reload
 * is `detached` and offers **Recompute** instead of its exports: the recipe is
 * persisted and the values are not, which is precisely the state a dropped local
 * file returns in and precisely the same reason (§8.6, §18.5).
 */

import { taskById } from '../analysis/registry'
import type { ProfileOutput } from '../analysis/types'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry, ComputedSource, LaneEdge } from '../annotations/types'
import { defaultStyle, placementOn } from '../annotations/types'
import { button, el } from './dom'
import { cardTitle, iconButton } from './icons'

/** The three formats a per-bin result can leave the app as (§18.7). */
export type SyntheticFormat = 'bigwig' | 'bedgraph' | 'bed' | 'tsv'

export interface SyntheticCardOptions {
  store: AnnotationStore
  onExport(entry: AnnotationEntry, format: SyntheticFormat): void
  onRecompute(entry: AnnotationEntry): void
}

export class SyntheticCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  /** A rebuild that arrived while a control on a row was being edited. */
  private pending = false

  constructor(private readonly options: SyntheticCardOptions) {
    this.el = el(
      'section',
      { class: 'card annotation-card' },
      cardTitle('Synthetic tracks', 'chart-spline'),
      this.list,
    )

    // The same deferral `AnnotationCard.holdsFocus` argues for, and for the same
    // control: the colour picker fires `input` on every drag of the cursor, each
    // of which is a store change, and replacing the `<input>` underneath an open
    // picker closes it. Released when the focus leaves the list, on a task —
    // at `focusout` time the new owner of the focus is not set yet.
    this.list.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.pending) this.refresh()
      }, 0)
    })

    this.unsubscribe = this.options.store.subscribe(() => this.refresh())
    this.refresh()
  }

  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Rebuild the list, and take the whole card away when there is nothing in it.
   *
   * Hidden rather than shown empty with a line of explanatory text. The
   * Annotations column already carries Tracks, Map overlays, Groups and Manual
   * annotations; a fifth heading over a sentence about a feature the reader has
   * not used is noise in a column they are scanning for a track they have.
   */
  refresh(): void {
    if (this.holdsFocus()) {
      this.pending = true
      return
    }
    this.pending = false

    // Everything **computed**, not one card's rows. A per-bin result is a
    // synthetic *track* and a called interval set is an overlay, so the two land
    // on different cards in the store — but to a reader they are one thing, "what
    // I just ran", and insulation's boundaries belong beside the insulation
    // profile they were called from rather than three cards away among the
    // dropped files. `source.kind` is what they actually share.
    const rows = this.options.store.entries.filter((entry) => entry.source.kind === 'computed')
    this.el.classList.toggle('hidden', rows.length === 0)
    this.list.replaceChildren(...rows.map((entry) => this.row(entry)))
  }

  /** `true` while a control on a row holds a value the reader has not finished
   * giving — the colour picker mid-drag, a half-typed name. */
  private holdsFocus(): boolean {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return false
    return active instanceof HTMLInputElement || active instanceof HTMLSelectElement
  }

  private row(entry: AnnotationEntry): HTMLElement {
    const row = el('div', {
      class: `ann-row ann-${entry.status}`,
      attrs: { 'data-id': entry.id },
    })
    row.appendChild(
      el(
        'div',
        { class: 'ann-head' },
        this.swatch(entry),
        this.name(entry),
        this.visibility(entry),
        iconButton('x', 'Remove this track', () => this.options.store.remove(entry.id), {
          class: 'btn-close',
          size: 14,
        }),
      ),
    )

    // The provenance, on two lines and in that order: what made it, then what it
    // was made from. The task is a sentence and the framing is a coordinate, so
    // the framing takes the monospaced `ann-origin` treatment the file path
    // takes on a loaded row — it is looked up rather than read.
    const made = madeBy(entry)
    if (made !== null) row.appendChild(el('p', { class: 'ann-note', text: made }))
    const framing = framingOf(entry)
    if (framing !== null) {
      row.appendChild(el('p', { class: 'ann-origin', text: framing, title: framing }))
    }

    row.appendChild(entry.status === 'detached' ? this.recompute(entry) : this.exports(entry))
    return row
  }

  // -------------------------------------------------------------------------
  // The head's own controls
  // -------------------------------------------------------------------------

  /** The colour, as the picker itself — the Tracks card's swatch, same store call. */
  private swatch(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'ann-swatch',
      type: 'color',
      value: entry.style.colour,
      title: `Colour for ${entry.label}`,
    })
    input.addEventListener('input', () =>
      this.options.store.restyle(entry.id, { colour: input.value }),
    )
    return input
  }

  /**
   * What the lane is called, editable in place.
   *
   * A computed label is a description of a calculation — `insulation, 10 kb` —
   * and the reader comparing two files needs to say which file it came from.
   * Renaming is the same gesture, the same control and the same store call it is
   * on a loaded track, so a figure's lane labels are written one way.
   */
  private name(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'input ann-name',
      type: 'text',
      value: entry.label,
      title: `${entry.label} — click to rename`,
    })
    input.addEventListener('change', () => {
      const label = input.value.trim()
      // An empty name leaves a lane with nothing written on it and a row that
      // cannot be told from its neighbour; refused, by restoring what was there.
      if (label === '' || label === entry.label) {
        input.value = entry.label
        return
      }
      this.options.store.update(entry.id, { label })
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        input.value = entry.label
        input.blur()
      }
    })
    return input
  }

  private visibility(entry: AnnotationEntry): HTMLElement {
    const node = iconButton(
      entry.visible ? 'eye' : 'eye-off',
      entry.visible ? 'Hide, keeping the settings' : 'Show again',
      () => this.options.store.update(entry.id, { visible: !entry.visible }),
      { class: `btn btn-icon ann-eye${entry.visible ? '' : ' is-off'}`, size: 14 },
    )
    node.setAttribute('aria-pressed', String(entry.visible))
    return node
  }

  // -------------------------------------------------------------------------
  // Getting the numbers out
  // -------------------------------------------------------------------------

  /**
   * Three formats, and the first of them is off.
   *
   * bigWig is what a reader wants at the end of the day and it is offered
   * *visibly* disabled rather than left out, because a row of two formats says
   * nothing about the third while a greyed one with a reason says when it
   * arrives. The alternative — wiring the button to something that writes a file
   * a genome browser then refuses — is the one outcome worse than not offering
   * it, since the reader finds out somewhere else, later, with the app closed.
   *
   * TSV is last and is the one that matters most (§18.7): it is what makes a
   * number in a figure checkable by the person reading the figure, and it is the
   * only one of the three that carries the provenance comment lines — a bigWig
   * has nowhere to put them, which is a reason to offer the TSV beside it rather
   * than a reason to abuse the header (§18.4).
   */
  private exports(entry: AnnotationEntry): HTMLElement {
    // What a row can be written as depends on what it *is*. A per-bin track has
    // a value everywhere and goes out as the two formats a browser opens; a
    // called interval set has coordinates and goes out as the one bedtools
    // reads. Both offer TSV, because §18.7 has no exception to that.
    const intervals = entry.kind === 'segments' || entry.kind === 'pairs'
    const bed = entry.kind === 'pairs' ? 'BEDPE' : 'BED'
    return el(
      'div',
      { class: 'ann-inline' },
      el('span', { class: 'field-label', text: 'export' }),
      ...(intervals
        ? [
            button(bed, () => this.options.onExport(entry, 'bed'), {
              class: 'btn btn-quiet',
              title: `The called intervals as a ${bed} — what bedtools reads, and what this app reads back.`,
            }),
          ]
        : [
            button('bigWig', () => this.options.onExport(entry, 'bigwig'), {
              class: 'btn btn-quiet',
              title:
                'Written here, byte for byte — no bedGraphToBigWig step. What IGV, deepTools and ' +
                'pyBigWig open.',
            }),
            button('bedGraph', () => this.options.onExport(entry, 'bedgraph'), {
              class: 'btn btn-quiet',
              title:
                'One line per bin that has a value; bins with none are omitted, never written as 0.',
            }),
          ]),
      button('TSV', () => this.options.onExport(entry, 'tsv'), {
        class: 'btn btn-quiet',
        title: 'The values, under the task, its parameters and its framing as ‘#’ comment lines.',
      }),
    )
  }

  /**
   * The way back from a reload.
   *
   * A vector over a metagenome is megabytes and session storage is not for that,
   * so what survived is the recipe — the task, its parameters and the framing it
   * was run against (§18.5). The row therefore keeps the colour, the name, the
   * limits and the edge the reader chose, and asks for the arithmetic again,
   * which is exactly the shape `AnnotationCard.reattachNote` gives a local file
   * whose bytes cannot be re-read without a gesture (§8.6).
   */
  private recompute(entry: AnnotationEntry): HTMLElement {
    const run = button('recompute', () => this.options.onRecompute(entry), {
      class: 'btn btn-quiet',
      title: 'The settings below were kept; only the numbers have to be worked out again.',
    })
    return el(
      'p',
      { class: 'ann-note ann-detached' },
      'the values were not carried across the reload · ',
      run,
    )
  }
}

// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

/**
 * What every synthetic entry's id begins with, and the whole of why it does.
 *
 * `mintAnnotationId` produces `a` followed by a decimal number, and
 * `reserveAnnotationId` reads a restored id back by taking `Number` of
 * everything after the first character — so an id of that shape minted anywhere
 * else can be handed to a loaded track after a reload, and two rows under one id
 * is not two tracks: `update` patches every match and `remove` deletes every
 * match, so the pair moves and dies together. This avoids the shape by a prefix
 * that begins with neither `a` nor a digit run, and the colon means no suffix of
 * an output id can rescue it either.
 */
export const SYNTHETIC_PREFIX = 'analysis:'

/**
 * The entry id one output always has.
 *
 * Derived from the output rather than minted, so that running a task a second
 * time — a **Recompute** on a detached row, or a fresh run at the same framing —
 * lands on the row that is already there instead of stacking a second lane of
 * the same numbers beside it. `AnnotationStore.begin` replaces an id it already
 * holds in place and keeps its slot, which is what makes that work.
 */
export function syntheticId(outputId: string): string {
  return `${SYNTHETIC_PREFIX}${outputId}`
}

/**
 * The edge a computed track opens on.
 *
 * The **left**, which is the one edge a dropped file never takes. A bigWig lands
 * at the bottom, and so does every track a reader has loaded — so a computed
 * track arriving there is a new row in the middle of a stack somebody has
 * already arranged, pushing the rest down. On the left it is beside them and
 * plainly a different provenance, and it is still an ordinary lane: the reader
 * drags it anywhere, and §18.5's claim that a synthetic track is a track is
 * about what it *can* do, not about where it starts.
 *
 * Left rather than top for the reason `render/lane.ts` gives about reading
 * direction: a vertical lane grows towards the matrix, so a left-hand lane and
 * the map's rows share an axis and can be read across.
 */
export const SYNTHETIC_EDGE: LaneEdge = 'left'

/**
 * A finished per-bin output, as a row on this card.
 *
 * `status: 'ready'` at birth, unlike a file's row: there is no fetch to wait for
 * — the numbers exist, and the lane draws the moment the store holds them. The
 * caller puts it in a store with `begin` (handing over this id, label, source,
 * placement and style) and then `update(id, { status: 'ready' })`, which is the
 * one door every row goes through.
 *
 * @param colour Resolved by the caller — `output.colour` where the task
 * suggested one, `store.nextColour()` otherwise — because whether the suggestion
 * is already taken by a lane on the same stack is a question about the store and
 * not about the output.
 */
export function syntheticEntry(
  output: ProfileOutput,
  source: ComputedSource,
  colour: string,
): AnnotationEntry {
  const extent = valueExtent(output.values)
  return {
    id: syntheticId(output.id),
    card: 'synthetic',
    kind: 'track',
    label: output.label,
    source,
    status: 'ready',
    visible: true,
    placement: placementOn(SYNTHETIC_EDGE),
    style: defaultStyle('track', colour),
    // The same seed a bigWig's header gives a loaded row: it is what the limits
    // boxes start at when the reader leaves autoscale, and without it an
    // insulation track running −2 to 2 would offer them 0 and 1.
    ...(extent === null ? {} : { fileExtent: extent }),
  }
}

/**
 * The smallest and largest value in a profile, skipping the gaps.
 *
 * `NaN` means *no value here* throughout this codebase and it is skipped rather
 * than propagated: one filtered bin would otherwise take the whole extent with
 * it and leave the limits boxes showing nothing. `null` where every bin is a
 * gap, which is a real answer — a profile over a region the task could say
 * nothing about — and not a range of zero.
 */
function valueExtent(values: Float32Array): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (Number.isNaN(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return min > max ? null : { min, max }
}

/** The computed source behind a row, where it has one. */
function computedSourceOf(entry: AnnotationEntry): ComputedSource | null {
  return entry.source.kind === 'computed' ? entry.source : null
}

/**
 * `Contact probability P(s)` — what made this track.
 *
 * The task's *title* where this build has the task, and its bare id where it
 * does not. A session outlives the build that wrote it and may name a task that
 * has since been renamed or removed, and an id is a worse sentence than a title
 * but a far better one than `undefined` (`analysis/registry.ts` argues the same
 * fallback at the same door).
 */
function madeBy(entry: AnnotationEntry): string | null {
  const source = computedSourceOf(entry)
  if (source === null) return null
  return taskById(source.task)?.title ?? source.task
}

/** `chrIV:1–1,531,933 at 1 kb, balanced` — the framing it is a reading of. */
function framingOf(entry: AnnotationEntry): string | null {
  const framing = computedSourceOf(entry)?.framing
  return framing === undefined || framing === '' ? null : framing
}
