/**
 * The right-click menu on a lane, wherever a lane is drawn: in the stacks
 * beside a map, and in the 1D browser.
 *
 * One builder for both surfaces, because they draw the same tracks from the same
 * store, and a menu that offered a colour or an edge in one of them and not the
 * other would be two answers to one question. What differs between the two is
 * passed in rather than branched on here: the stack the menu was opened from and
 * the map it belongs to, the feature under the pointer and what opening or
 * framing it means on that surface, and whether the surface can copy one lane on
 * its own.
 *
 * It lived at the foot of `ui/MatrixPanel.ts`, which had the 1D browser import
 * the map panel to open a menu on a track. Nothing in it is about a map.
 */

import { FEATURE_DISPLAYS, featuresOf } from '../annotations/fields'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import type { AnnotationStore } from '../annotations/store'
import {
  LANE_EDGES,
  drawsAProfile,
  hasAMovableAxis,
  hasFeatureRows,
  placementOn,
  type AnnotationEntry,
  type FeatureSet,
  type LaneEdge,
} from '../annotations/types'
import { formatLocus } from '../genome/assembly'
import { laneGrowsInward } from '../render/lane'
import { CEILING_LABEL, colourInput } from './LaneControls'
import { copyTextToClipboard } from './export'
import { FEATURE_DISPLAY_WORDS, patchFeatures } from './laneSettings'
import { openMenu, type MenuItem } from './Menu'

/**
 * A feature a lane's menu was opened on, and what may be done with it from there.
 *
 * Built by the surface that owns the pointer, because it is the one that knows
 * what *opening* and *framing* a feature mean on it: the 1D browser frames one
 * on its single axis, and a map has no such gesture — its view is a region on
 * two axes, and framing the gene on one would leave the other wherever it was.
 */
export interface LaneMenuFeature {
  /** What the feature is called, or its accession where it has no name. */
  name: string
  /** Where it is, as the locus box writes a window, so it can be pasted into one. */
  locus: string
  /** Open its card — what a click on it does. */
  open: () => void
  /** Frame it, on a surface with one axis to frame it on. */
  zoom?: () => void
}

/**
 * What a lane's menu says about the feature at an index of a set.
 *
 * The name a reader searches for — the symbol, else the accession, else the
 * place itself — and the window `formatLocus` writes, which is what the locus
 * box accepts back.
 */
export function laneMenuFeature(
  set: FeatureSet,
  index: number,
  actions: { open: () => void; zoom?: () => void },
): LaneMenuFeature {
  const locus = formatLocus({
    contig: set.contigs[set.contig[index]] ?? '',
    start: set.start[index],
    end: set.end[index],
  })
  const name = set.name[index] !== '' ? set.name[index] : set.id[index] !== '' ? set.id[index] : locus
  return { name, locus, ...actions }
}

/** The first letter up, for a menu row built from a word the card writes lower-case. */
function capitalised(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)
}

/**
 * Put text on the clipboard, or — where the browser will not allow it, as in an
 * insecure context — hand it to the reader to copy by hand: a menu row that
 * silently did nothing would be a row that lied.
 */
function copyOrShow(text: string): void {
  void copyTextToClipboard(text).catch(() => {
    window.prompt('This browser would not copy it. Here it is to copy by hand:', text)
  })
}

/** What each edge is called, wherever one has to be named to a reader. */
export const EDGE_WORDS: Record<LaneEdge, string> = {
  top: 'above the map',
  right: 'beside the map',
  bottom: 'below the map',
  left: 'left of the map',
}

/**
 * The right-click menu on a lane: its colour, its axis, and where it is drawn.
 *
 * The things the side panel offers for a track that a reader beside the map
 * actually reaches for, brought to where the track is. Colour opens the
 * browser's own picker — the same control the card uses, so the two cannot drift
 * — and the range is offered as the choices worth having rather than as two
 * boxes: auto, and the round steps around what is on screen. A number box in a
 * context menu is a form in a menu.
 *
 * The location block and the flip are here because a lane is where a reader is
 * looking when they want them: which edge a track is drawn on and which way its
 * signal grows are both decisions about the *picture*, and sending someone to a
 * list in the sidebar to make one is sending them away from the thing they are
 * deciding about.
 */
export function openLaneMenu(
  x: number,
  y: number,
  entry: AnnotationEntry,
  store: AnnotationStore,
  /**
   * The stack the menu was opened from — what "towards the map" is measured
   * against, and what the location block moves the lane *off*.
   *
   * `null` on a surface with no map to have edges: the 1D browser draws every
   * lane the same way up and its placement means nothing until the reader goes
   * back to a map, so offering four edges there would be offering a control
   * with no visible effect.
   */
  edge: LaneEdge | null,
  /**
   * Which map the stack belongs to, so the location block moves *that* map's
   * lane. The lead when nothing says otherwise, which is every surface with no
   * deck behind it — see `annotations/store.ts`'s `placeAt`.
   */
  map: MapId = LEAD_MAP,
  /** The feature under the pointer, where there is one (§8.16). */
  feature: LaneMenuFeature | null = null,
  /**
   * *Copy this* (§7.2): this lane's track alone onto the clipboard, as the
   * surface it was opened on draws it. Absent where the surface cannot draw
   * one lane by itself.
   */
  copy: (() => void) | null = null,
  /**
   * The *Marks* group (`ui/marksMenu.ts`): the reader's marks drawn across
   * this lane, under the pointer and all of them. Last, after the track's own
   * rows, since the menu was opened on a track — and there, rather than
   * nowhere, since a mark's rule runs through every lane it crosses.
   */
  marks: readonly MenuItem[] = [],
): void {
  const limits = entry.style.limits
  const items: MenuItem[] = []
  // The thing under the pointer first, and the track it is on after it: a menu
  // opened on a gene is most often about the gene.
  if (feature !== null) {
    items.push(
      { label: feature.name },
      { label: 'About it…', run: feature.open },
      ...(feature.zoom === undefined
        ? []
        : [{ label: 'Zoom to it', hint: feature.locus, run: feature.zoom }]),
      { label: 'Copy its name', hint: feature.name, run: () => copyOrShow(feature.name) },
      { label: 'Copy its position', hint: feature.locus, run: () => copyOrShow(feature.locus) },
    )
  }
  items.push(
    { label: entry.label },
    ...(copy === null
      ? []
      : [
          {
            label: 'Copy this',
            hint: 'PNG',
            title:
              'The track as it is drawn here — the track alone, with no name, range, handle or ' +
              'pointer — onto the clipboard as a PNG, at the screen’s resolution',
            run: copy,
          },
        ]),
    {
      label: 'Colour…',
      hint: entry.style.colour,
      // The same control the lane's own chip is and the side panel's swatch is,
      // through one builder, so the three cannot come to disagree about what a
      // colour is. Built here rather than up front because a menu that is opened
      // and dismissed should leave nothing behind, and taken away again on the
      // commit *or* on the window coming back, which is what a cancelled picker
      // looks like from this side.
      run: () => {
        const swatch = colourInput(entry, store, { class: 'hidden-input' })
        const done = (): void => swatch.remove()
        swatch.addEventListener('change', done, { once: true })
        window.addEventListener('focus', done, { once: true })
        document.body.appendChild(swatch)
        swatch.click()
      },
    },
  )

  // How the rows are spent, and whether a feature points the way it runs
  // (§8.16) — the two things a reader changes about a gene track while looking
  // at it, and both as a tick on the one in force rather than as a toggle that
  // names the state it would leave.
  if (hasFeatureRows(entry.kind)) {
    const features = featuresOf(entry.style, entry.kind)
    items.push(
      { label: 'Rows' },
      ...FEATURE_DISPLAYS.map((display) => ({
        label: capitalised(FEATURE_DISPLAY_WORDS[display].label),
        title: FEATURE_DISPLAY_WORDS[display].hint,
        checked: features.display === display,
        run: () => patchFeatures(store, entry, { display }),
      })),
    )
    // On every lane that has rows, a call set's included, as the card offers it
    // (`laneSettings.arrowsToggle`): the switch changes nothing on a feature
    // the file gives no strand, and the menu leaving it off one kind of lane
    // the card kept it on was two answers to one question.
    items.push({
      label: 'Point the way each runs',
      checked: features.arrows,
      run: () => patchFeatures(store, entry, { arrows: !features.arrows }),
    })
  }

  if (hasAMovableAxis(entry.kind)) {
    items.push(
      { label: 'Range' },
      {
        label: 'Auto',
        hint: 'this view',
        disabled: limits.auto,
        run: () => store.restyle(entry.id, { limits: { ...limits, auto: true } }),
      },
      // Not a step, and not a control: the two ways the range is moved *on the
      // lane itself*, said once where a reader who opened this menu looking for
      // them will find them. Both are gestures with nothing on screen to
      // announce them, which is exactly what a menu is for.
      { label: `${CEILING_LABEL} on the lane moves the ceiling; click a limit to type one` },
      ...[1, 5, 10, 50, 100].map((max) => ({
        label: `0 – ${max}`,
        disabled: !limits.auto && limits.min === 0 && limits.max === max,
        run: () => store.restyle(entry.id, { limits: { auto: false, min: 0, max } }),
      })),
    )
  }

  // Where the lane goes, as words. The same field the row's `location` control
  // writes and the same call the drag onto a rectangle makes, so a lane moved
  // three different ways is moved once — including the axis turning to keep
  // facing the map, which is `place`'s and not any caller's.
  if (edge !== null) {
    items.push(
      { label: 'Draw it' },
      ...LANE_EDGES.map((side) => ({
        label: EDGE_WORDS[side],
        disabled:
          entry.placement[side] && LANE_EDGES.filter((each) => entry.placement[each]).length === 1,
        run: () => store.placeAt(entry.id, map, placementOn(side)),
      })),
    )
  }

  if (drawsAProfile(entry.kind)) {
    // Which way the signal currently grows, which is the edge's own reading
    // turned round by the flip — not the flip on its own. A lane above the map
    // and one below it with the same `flip` grow in opposite directions
    // relative to the picture, and "flip" is not a word about a picture.
    const towards = laneGrowsInward(edge ?? 'bottom') !== entry.style.flip
    items.push({
      label: towards ? 'Grow away from the map' : 'Grow towards the map',
      hint: towards ? 'now towards' : 'now away',
      run: () => store.restyle(entry.id, { flip: !entry.style.flip }),
    })
  }

  items.push(
    { label: 'This track' },
    {
      label: entry.visible ? 'Hide' : 'Show',
      run: () => store.update(entry.id, { visible: !entry.visible }),
    },
    { label: 'Remove', run: (): void => store.remove(entry.id) },
    ...marks,
  )
  openMenu(x, y, items)
}
