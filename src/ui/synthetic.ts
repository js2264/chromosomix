/**
 * **Synthetic tracks** (§18.5): what this app computed, listed with what it loaded.
 *
 * A result that is one value per bin *is* a track, and a track belongs on the
 * map rather than in the drawer it was computed in. So a per-bin output joins
 * the same {@link AnnotationStore} a dropped bigWig joins, as an ordinary entry
 * with `kind: 'track'` — and from that moment the colour, the rename, the
 * limits, the autoscale group, the four edges, the reorder, the hairline, the
 * tooltip, the 1D browser and the vector figure all work, because they are the
 * one implementation those rows already go through.
 *
 * They had a card of their own, *Synthetic tracks*, above the Tracks card —
 * which made them a second kind of row with a second, smaller set of controls:
 * no height, no limits, no group, no flip, no batch. They are rows of the
 * **Tracks card** now (`ui/AnnotationCard.ts`), with every control a loaded
 * track has, and this module holds the few things only a synthetic row carries:
 *
 * - **a mark** — `*` after the name, the one a resolution this file does not
 *   store wears in the breadcrumb (`3 kb*`), for the same fact: this is not in
 *   any file the reader gave the app;
 * - **its provenance** — the task that made it and the framing it was computed
 *   against, because a synthetic track whose provenance is invisible is a
 *   number nobody can defend, and the framing is a snapshot (§18.4);
 * - **its exports** — the one control a loaded track has no use for: you do not
 *   export a bigWig you were given;
 * - **Recompute**, on a row that came back from a reload `detached`: the recipe
 *   is persisted and the values are not, which is the state a dropped local file
 *   returns in and for the same reason (§8.6).
 *
 * And the helpers that make one, which the analysis workspace calls.
 */

import { taskById } from '../analysis/registry'
import { calledPayloadOf } from '../analysis/surfaces'
import { TRACK_OP_LABELS } from '../annotations/derived'
import type { ProfileOutput } from '../analysis/types'
import type { AnnotationEntry, ComputedSource, LaneEdge } from '../annotations/types'
import { defaultStyle, placementOn } from '../annotations/types'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import { laneStartsFlipped } from '../render/lane'
import { button, el } from './dom'

/** The formats a computed row can leave the app as (§18.7). */
/**
 * What a row can be written as. `anchors` is a set of pairs' anchors as a BED —
 * each place once, however many pairs share it (§18.7).
 */
export type SyntheticFormat = 'bigwig' | 'bedgraph' | 'bed' | 'anchors' | 'tsv'

/**
 * Whether a row is one this app made rather than one the reader loaded.
 *
 * `computed` is a task's output and `derived` is a comparison of two loaded
 * tracks (`annotations/derived.ts`): both are numbers the app worked out, both
 * have a recipe rather than a file behind them, and both leave through the
 * exports below. A computed *structure* is one too, but it is a model and a row
 * of the Structures card (§25.6), never of the Tracks card.
 */
export function isSynthetic(entry: AnnotationEntry): boolean {
  return entry.source.kind === 'computed' || entry.source.kind === 'derived'
}

/**
 * The `*` after a synthetic row's name, with its provenance in the tooltip.
 *
 * The resolution picker's mark (§26.6), and for its reason: a derived rung is
 * *not in this file*, and so is a computed track — a reader quoting it has to be
 * able to tell it from the bigWig beside it at a glance. A text glyph rather
 * than the icon star, which on this same row already says which gene model the
 * search reads.
 */
export function syntheticMark(entry: AnnotationEntry): HTMLElement {
  const made = madeBy(entry)
  const framing = framingOf(entry)
  const said = [
    made === null ? 'Computed here' : `Computed here — ${made}`,
    ...(framing === null ? [] : [framing]),
  ].join(', from ')
  return el('span', {
    class: 'ann-synthetic',
    text: '*',
    title: `${said}. Not in any file you loaded: its settings hold its exports.`,
    attrs: { 'aria-label': 'synthetic track' },
  })
}

/**
 * What goes under a synthetic row's head: what made it, and how many.
 *
 * One line where a loaded row has its summary (`16 sequences · 12.11 Mb`), so
 * the two kinds of row are the same shape: `Insulation`, `Detected loops ·
 * 312 loops`, `Two tracks, as their ratio`. The count first appeared on the
 * old card for the reason it is here — a called set is a number of things, and
 * the number is what a reader looks for first.
 */
export function syntheticNote(entry: AnnotationEntry): string | null {
  const made = madeBy(entry)
  const counted = entry.summary !== undefined && entry.summary !== '' ? entry.summary : null
  const said = [made, counted].filter((part): part is string => part !== null)
  return said.length === 0 ? null : said.join(' · ')
}

/**
 * A set of pairs' anchors as a BED: both ends of every pair, each exact place
 * once — the file a reader asking *where are the loop anchors* would write, for
 * a motif scan or an overlap with peaks.
 */
function anchorsButton(
  entry: AnnotationEntry,
  onExport: (entry: AnnotationEntry, format: SyntheticFormat) => void,
): HTMLElement {
  return button('anchors', () => onExport(entry, 'anchors'), {
    class: 'btn btn-quiet',
    title:
      'Both ends of every pair as a BED, each place once however many pairs share it — the ' +
      'anchors, for a motif scan or an overlap with peaks.',
  })
}

/**
 * A loaded set of pairs' one export: its anchors (§8.1). The pairs themselves
 * are the file the reader loaded, and need no writing out.
 */
export function pairExports(
  entry: AnnotationEntry,
  onExport: (entry: AnnotationEntry, format: SyntheticFormat) => void,
): HTMLElement {
  return el(
    'div',
    { class: 'ann-inline ann-exports' },
    el('span', { class: 'field-label', text: 'export' }),
    anchorsButton(entry, onExport),
  )
}

/**
 * Three formats for a track, two for a called set of pairs, one for any other
 * called set, and TSV for all of them.
 *
 * What a row can be written as depends on what it *is*. A per-bin track has a
 * value everywhere and goes out as the two formats a browser opens; a called
 * interval set has coordinates and goes out as the one bedtools reads. Both
 * offer TSV, because §18.7 has no exception to that — it is what makes a number
 * in a figure checkable by the person reading the figure, and the only one that
 * carries the provenance as `#` comment lines.
 */
export function syntheticExports(
  entry: AnnotationEntry,
  onExport: (entry: AnnotationEntry, format: SyntheticFormat) => void,
): HTMLElement {
  const intervals = entry.kind === 'segments' || entry.kind === 'pairs'
  // Read off the set as it was called rather than the row's kind: a loop set
  // drawn as a 1D track is its anchors on screen and leaves as its loops (§18.7).
  const bed = entry.kind === 'pairs' || calledPayloadOf(entry)?.kind === 'pairs' ? 'BEDPE' : 'BED'
  return el(
    'div',
    { class: 'ann-inline ann-exports' },
    el('span', { class: 'field-label', text: 'export' }),
    ...(intervals
      ? [
          button(bed, () => onExport(entry, 'bed'), {
            class: 'btn btn-quiet',
            title: `The called intervals as a ${bed} — what bedtools reads, and what this app reads back.`,
          }),
          ...(bed === 'BEDPE' ? [anchorsButton(entry, onExport)] : []),
        ]
      : [
          button('bigWig', () => onExport(entry, 'bigwig'), {
            class: 'btn btn-quiet',
            title:
              'Written here, byte for byte — no bedGraphToBigWig step. What IGV, deepTools and ' +
              'pyBigWig open.',
          }),
          button('bedGraph', () => onExport(entry, 'bedgraph'), {
            class: 'btn btn-quiet',
            title:
              'One line per bin that has a value; bins with none are omitted, never written as 0.',
          }),
        ]),
    button('TSV', () => onExport(entry, 'tsv'), {
      class: 'btn btn-quiet',
      title: 'The values, under the task, its parameters and its framing as ‘#’ comment lines.',
    }),
  )
}

/**
 * The way back from a reload, for a computed row.
 *
 * A vector over a metagenome is megabytes and session storage is not for that,
 * so what survived is the recipe — the task, its parameters and the framing it
 * was run against (§18.5). The row therefore keeps the colour, the name, the
 * limits and the edge the reader chose, and asks for the arithmetic again,
 * which is exactly the shape a dropped local file's row takes when its bytes
 * cannot be re-read without a gesture (§8.6).
 */
export function recomputeNote(
  entry: AnnotationEntry,
  onRecompute: (entry: AnnotationEntry) => void,
): HTMLElement {
  const run = button('recompute', () => onRecompute(entry), {
    class: 'btn btn-quiet',
    title: 'The settings were kept; only the numbers have to be worked out again.',
  })
  return el(
    'p',
    { class: 'ann-note ann-detached' },
    'values not kept over the reload · ',
    run,
  )
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
 * The entry id one output of one map always has.
 *
 * Derived from the output rather than minted, so that running a task a second
 * time — a **Recompute** on a detached row, or a fresh run at the same framing —
 * lands on the row that is already there instead of stacking a second lane of
 * the same numbers beside it. `AnnotationStore.begin` replaces an id it already
 * holds in place and keeps its slot, which is what makes that work.
 *
 * **And of one map.** That clause was missing, and "run on all maps" is what
 * made it matter: a batch of five produced five coverage tracks under one id, so
 * each `begin` replaced the row before it and each `placeOnTarget` moved the
 * single surviving lane onto the next panel and off the last. What came back
 * from a five-map batch was one track, on the fifth map, and four maps with
 * nothing drawn on them — which reads as the batch having silently failed rather
 * than as five results landing on top of each other.
 *
 * The lead keeps the bare id it has always had. That is not cosmetic: a session
 * restored from a reload, and every `Recompute` on a row written before decks
 * existed, resolves through this function, and prefixing the ordinary case would
 * orphan all of them.
 */
export function syntheticId(outputId: string, map: MapId = LEAD_MAP): string {
  return map === LEAD_MAP
    ? `${SYNTHETIC_PREFIX}${outputId}`
    : `${SYNTHETIC_PREFIX}${map}:${outputId}`
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
 * Left rather than top because a left-hand lane and the map's rows share an
 * axis and can be read across — and it grows away from the matrix, as every
 * lane on that edge starts (`render/lane.ts`'s `laneStartsFlipped`).
 */
export const SYNTHETIC_EDGE: LaneEdge = 'left'

/**
 * A finished per-bin output, as a row of the Tracks card.
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
  /**
   * The map this was measured from, and where its lane goes.
   *
   * Absent is the lead, which is every session that has not opened a deck and
   * every row written before decks existed — see {@link syntheticId}, which is
   * careful to leave that case's id exactly as it was.
   */
  on?: { map: MapId; label: string },
): AnnotationEntry {
  const extent = valueExtent(output.values)
  return {
    id: syntheticId(output.id, on?.map),
    card: 'synthetic',
    kind: 'track',
    // Named by its map when it came from one that is not the lead. A batch over
    // five replicates otherwise produces five rows called `coverage`, in one
    // list, in the order the runner happened to finish them — every one of them
    // true, and no way to tell which is which.
    label:
      on === undefined || on.map === LEAD_MAP ? output.label : `${output.label} · ${on.label}`,
    source,
    status: 'ready',
    visible: true,
    placement: placementOn(SYNTHETIC_EDGE),
    style: {
      ...defaultStyle('track', colour),
      // Turned for the edge it opens on, as `begin` turns a file dropped there:
      // the style is handed in whole, and a handed-in style is not turned again.
      flip: laneStartsFlipped(SYNTHETIC_EDGE) !== defaultStyle('track', colour).flip,
      // The task's display hints, where it gave any (§18.11). Written into the
      // style rather than kept beside it, because from here on they are the
      // reader's: a group they can rename and a style they can change, and not
      // a property of the result that would come back on the next repaint.
      ...(output.group === undefined ? {} : { group: groupNameOn(output.group, on) }),
      ...(output.mode === undefined ? {} : { mode: output.mode }),
      ...(output.scale === undefined ? {} : { scale: output.scale }),
      // A length, so a log axis is ruled and labelled in distances (§18.12).
      ...(output.unit === 'bp' ? { unit: 'bp' as const } : {}),
    },
    // The same seed a bigWig's header gives a loaded row: it is what the limits
    // boxes start at when the reader leaves autoscale, and without it an
    // insulation track running −2 to 2 would offer them 0 and 1.
    ...(extent === null ? {} : { fileExtent: extent }),
  }
}

/**
 * A suggested group name, made specific to the map it was measured from.
 *
 * The same reason the label is (see above): a batch over a deck runs the task
 * once per map, and one group name across all of them would overlay five
 * replicates' worth of lanes into one stack of heatmaps whose rows come from
 * different files.
 */
export function groupNameOn(group: string, on?: { map: MapId; label: string }): string {
  return on === undefined || on.map === LEAD_MAP ? group : `${group} · ${on.label}`
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
export function madeBy(entry: AnnotationEntry): string | null {
  if (entry.source.kind === 'derived') {
    const op = entry.derivedFrom?.op
    return op === undefined ? 'Two tracks compared' : `Two tracks, as their ${TRACK_OP_LABELS[op]}`
  }
  const source = computedSourceOf(entry)
  if (source === null) return null
  return taskById(source.task)?.title ?? source.task
}

/**
 * `chrIV:1–1,531,933 at 1 kb, balanced` — the framing it is a reading of.
 *
 * A derived row has none, and that is not an omission: it holds no values of its
 * own and is recomputed from its two operands every time it is drawn, so what it
 * is a reading of is whatever *they* are — which their own rows say.
 */
export function framingOf(entry: AnnotationEntry): string | null {
  const framing = computedSourceOf(entry)?.framing
  return framing === undefined || framing === '' ? null : framing
}
