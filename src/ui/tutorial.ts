/**
 * The guided tutorial's steps (§30): one first session, on real data, from the
 * landing page to a correlation between the reader's own tracks and the ones a
 * consortium published.
 *
 * ## The data, and why these
 *
 * **4DNES4296C5Q**, Hi-C on IMR-90 lung fibroblasts from the 4DN portal: one of
 * the classic human maps, on GRCh38, with **1.07 billion contacts** — enough for
 * domains at 10 kb, not so many that a first session is reading the deepest map
 * on the shelf. Its experiment set carries the three tracks 4DN's own pipeline
 * computed from the same map: the compartment eigenvector at 250 kb, the
 * insulation score at 10 kb and the boundaries called on it. So the last step
 * compares like with like: the reader's E1 at 250 kb and insulation at 10 kb,
 * computed in this page, against the consortium's at the same resolutions.
 *
 * **chr13**, because it shows both halves of the story on one screen: an
 * acrocentric whose short arm is empty — the blank square at its start is what
 * a stretch with no unique sequence looks like — and a long arm with broad,
 * clean compartments. **41–45 Mb** of it is where the tutorial looks at domains:
 * at 10 kb, a run of clear squares along the diagonal, some nested in others,
 * reached from **35–55 Mb** at 250 kb so that each drag is across a square a
 * hand can hit.
 *
 * ## The steps a reader would not think of
 *
 * The map is drawn as a **correlation** before Compartments runs, because the
 * plaid that draws is what the task decomposes — the reader sees the pattern
 * before the number that summarises it — and back as **balanced** before the
 * zoom, because domains are a matter of contact frequency. Compartments is
 * **phased by 4DN's E1**: left to itself the form takes the first set of
 * intervals for a gene model, which on this session is 4DN's boundaries, and a
 * sign decided by those is a coin toss (its saddle says *phasing r 0.01*). 4DN's
 * own E1 is phased already, so following it makes A mean the same in both,
 * which the last step depends on. And the domains are looked at with
 * **O/E** and **adaptive smoothing** on: at 10 kb a pixel holds a handful of
 * contacts, and divided by its distance and pooled where it is thin, the
 * squares stand out from the decay. Neither changes what a task reads — the
 * insulation drawer still says *balanced* — so they stay on.
 *
 * ## How a step is written
 *
 * Against the window, through {@link TutorialHost}: what is open, at what
 * resolution, which drawer, which run. A step's `done` is a *state*, never a
 * click, so the reader may get there by the lit control, a key or the palette
 * (`ui/Tour.ts` says why). Its `target` is found by the classes and labels the
 * reader sees, anywhere in the window — a card can be carried to another column
 * (`ui/cardLayout.ts`) — and read again on every tick, so a card rebuilt under
 * it is found again rather than lit where it used to be.
 */

import { LEAD_MAP } from '../annotations/placement'
import type { AnnotationEntry } from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import { displayOf } from '../analysis/surfaces'
import type { TaskResult } from '../analysis/types'
import type { ViewState } from '../types'
import { isMac } from './commands'
import { BALANCED_SCORE, CORRELATION_SCORE } from './scores'
import type { TourSpot, TourStep, TourText } from './Tour'

/** What the steps read from the window. */
export interface TutorialHost {
  /** The view of the tab in front, or `null` while it holds nothing. */
  view(): ViewState | null
  /** The bin size of the map in front, or `null`. */
  binsize(): number | null
  /**
   * The score its cells are drawn from, by the picker's id, with the file's
   * default applied — a balanced cooler opens balanced and says so nowhere in
   * its view state — or `null`.
   */
  score(): string | null
  /** The address of the file open in the tab in front, or `null` until it has opened. */
  file(): string | null
  /** Its sequences' names, in its own order, or `null` before they are read. */
  sequences(): string[] | null
  /** The store the drawer is open on, or `null` while it is closed. */
  store(): string | null
  /** Whether a column is open. */
  panelOpen(panel: 'analysis' | 'annotations' | 'aesthetics'): boolean
  /** The task the Analysis drawer is open on, or `null`. */
  task(): string | null
  /** Every finished run of a task on the map in front, newest first. */
  runs(task: string): readonly TaskResult[]
  /** Whether a task is running, or waiting to. */
  running(task: string): boolean
  /** The rows of the tab in front's Tracks card, or `null`. */
  tracks(): AnnotationStore | null
  /** Where a stretch of a sequence is drawn on the map in front, as its square on the diagonal. */
  square(stretch: { contig: string; start: number; end: number }): DOMRect | null
  /** Whether the console is open along the bottom of the window. */
  consoleOpen(): boolean
}

/** The experiment set the tutorial opens. */
export const TUTORIAL_SET = '4DNES4296C5Q'
/** The store it is on. */
export const TUTORIAL_STORE = '4dn'
/** The sequence every task is run on. */
export const TUTORIAL_SEQUENCE = 'chr13'
/** Its contact map, by the accession its file is named after. */
const MAP_FILE = '4DNFIJIP5BJF'
/** 4DN's own tracks from the same set: E1 at 250 kb, insulation at 10 kb. */
const FOURDN_E1 = '4DNFIRL31X9M'
const FOURDN_INSULATION = '4DNFIR2STZVV'
/** The square the first drag crosses, at 250 kb, and the one the second crosses, at 10 kb. */
const OVERVIEW = { start: 35_000_000, end: 55_000_000 }
const DOMAINS = { start: 41_000_000, end: 45_000_000 }
/** How narrow a window has to be for the second zoom to count: a few domains, not a chromosome arm. */
const DOMAINS_SPAN = 8_000_000
/**
 * The rows the reader's own runs leave on the Tracks card: a profile by its
 * output (`ui/synthetic.ts`'s `syntheticId`), the insulation score's ending in
 * its window — `analysis:insulation-w10` — and a called set by its task and its
 * output (`analysis/workspace.ts`'s `adoptIntervals`).
 */
const OWN_E1 = 'analysis:compartment-e1'
const OWN_INSULATION = 'analysis:insulation-w'
const OWN_DOMAINS = 'analysis:insulation:insulation-domains'

// ---------------------------------------------------------------------------
// Finding things on screen
// ---------------------------------------------------------------------------

/** Whether a node is laid out at all — not hidden, not in a folded column. */
function laidOut(node: Element | null): node is HTMLElement {
  return node instanceof HTMLElement && node.getClientRects().length > 0
}

/** The first laid-out match. */
function first(selector: string, root: ParentNode = document): HTMLElement | null {
  for (const node of root.querySelectorAll(selector)) if (laidOut(node)) return node
  return null
}

function words(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The Analysis drawer, while it is open. */
function drawer(): HTMLElement | null {
  return first('.analysis-drawer:not(.collapsed)')
}

/** A task's row in the Analysis panel's list. */
function taskRow(title: string): HTMLElement | null {
  for (const row of document.querySelectorAll('.analysis-row')) {
    if (laidOut(row) && words(row.querySelector('.analysis-row-title')) === title) return row
  }
  return null
}

/** A folded column's spine, or the header's button for it. */
function columnDoor(panel: 'analysis' | 'annotations' | 'aesthetics'): HTMLElement | null {
  const title = panel === 'analysis' ? 'Analysis' : panel === 'annotations' ? 'Annotations' : 'Aesthetics'
  return first(`.panel-${panel} .panel-tab`) ?? first(`.head-panels button[aria-label="${title} panel"]`)
}

/** The resolution control: a dropdown on a long ladder, a row of stops on a short one. */
function resolutionControl(): HTMLElement | null {
  return first('select.res-pick, [role="radiogroup"][aria-label="resolution"]')
}

/** The Map card, wherever it has been carried, while it is laid out. */
function mapCard(): HTMLElement | null {
  for (const card of document.querySelectorAll('.controls-card')) {
    if (laidOut(card) && words(card.querySelector('.controls-title')) === 'Map') return card
  }
  return null
}

/** A control of the Map card, by the word beside it. */
function mapField(word: string): HTMLElement | null {
  for (const label of mapCard()?.querySelectorAll('label.field') ?? []) {
    if (words(label.querySelector('.field-label')) === word) return label.querySelector<HTMLElement>('select, input')
  }
  return null
}

/** The Map card's O/E toggle. */
function oeToggle(): HTMLElement | null {
  for (const node of mapCard()?.querySelectorAll<HTMLElement>('button') ?? []) {
    if (words(node) === 'O/E') return node
  }
  return null
}

/** A select of the drawer's form, by the words beside it. */
function formSelect(word: string): HTMLSelectElement | null {
  for (const label of drawer()?.querySelectorAll('label.param-field') ?? []) {
    if (words(label.querySelector('.field-label')) !== word) continue
    const select = label.querySelector('select')
    return select instanceof HTMLSelectElement ? select : null
  }
  return null
}

/** What a select shows, in its own words. */
function shown(select: HTMLSelectElement | null): string {
  return words(select?.selectedOptions[0])
}

/** A figure of the drawer's result, by the start of its heading. */
function figure(heading: string): HTMLElement | null {
  for (const node of drawer()?.querySelectorAll<HTMLElement>('.analysis-figure') ?? []) {
    if (words(node.querySelector('.analysis-figure-head')).startsWith(heading)) return node
  }
  return null
}

/** The experiment set's heading in the store's list. */
function setGroup(): HTMLElement | null {
  for (const group of document.querySelectorAll('.store-drawer .portal-group')) {
    if (laidOut(group) && words(group.querySelector('.portal-group-key')) === TUTORIAL_SET) return group
  }
  return null
}

function searchBox(): HTMLInputElement | null {
  const box = first('.store-drawer .portal-search')
  return box instanceof HTMLInputElement ? box : null
}

/** The sequences ticked in the drawer's form, or `null` where it has no such list. */
function tickedSequences(): string[] | null {
  const list = drawer()?.querySelector('.param-sequences')
  if (list === null || list === undefined) return null
  return [...list.querySelectorAll('label.param-check')]
    .filter((label) => label.querySelector('input')?.checked === true)
    .map((label) => words(label.querySelector('span')))
}

/** One sequence's tick box in the drawer's form. */
function sequenceBox(name: string): HTMLElement | null {
  for (const label of drawer()?.querySelectorAll<HTMLElement>('.param-sequences label.param-check') ?? []) {
    if (words(label.querySelector('span')) === name) return label
  }
  return null
}

/** One track's tick box in the drawer's form, found by the name its row has now. */
function trackBox(entry: AnnotationEntry | undefined): HTMLElement | null {
  if (entry === undefined) return null
  for (const label of drawer()?.querySelectorAll<HTMLElement>('label.param-check') ?? []) {
    if (words(label.querySelector('span')) === entry.label) return label
  }
  return null
}

/** The run button of the drawer's form. */
function runButton(): HTMLElement | null {
  return drawer()?.querySelector<HTMLElement>('.analysis-run > button') ?? null
}

function sameNames(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((name, at) => name === b[at])
}

/** A parameter's value as a list of names, or `null` where it is not one. */
function namesIn(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
}

/** The sequence a view is on, or `null`. */
function sequenceOf(view: ViewState | null): string | null {
  if (view === null || view.view !== 'region' || view.region === undefined) return null
  return view.region.split(':')[0]
}

/** The stretch a view is on, in base pairs, or `null` on a whole sequence or none. */
function stretchOf(view: ViewState | null): { contig: string; start: number; end: number } | null {
  if (view === null || view.view !== 'region' || view.region === undefined) return null
  const match = /^([^:]+):([\d,]+)-([\d,]+)$/.exec(view.region)
  if (match === null) return null
  return { contig: match[1], start: Number(match[2].replace(/,/g, '')), end: Number(match[3].replace(/,/g, '')) }
}

/** The Chromosomes table's name cell for one sequence, which is what a press opens it by. */
function sequenceRow(name: string): HTMLElement | null {
  return first(`.content .tviewport .tr .td[title="${name}"]`)
}

/** The map's locus box, typed into and committed, as a reader who would rather not drag does it. */
function goTo(region: string): void {
  const box = first('.content input.input-region')
  if (!(box instanceof HTMLInputElement)) return
  box.value = region
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

/** Base pairs as the locus box takes them, `41,000,000`. */
function bp(at: number): string {
  return at.toLocaleString('en-US')
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/** Every step of the tutorial, in order. */
export function tutorialSteps(host: TutorialHost): TourStep[] {
  /**
   * The tab in front is on the tutorial's map — opened, or still opening.
   *
   * Read from the view rather than the file because a workspace names its map
   * the moment it is read and opens it a few seconds later; a step that waited
   * for the file would send the reader back to the store while the map they had
   * just asked for was arriving.
   */
  const onMap = (): boolean =>
    host.view()?.uri.includes(MAP_FILE) === true || host.file()?.includes(MAP_FILE) === true
  const onSequence = (): boolean => sequenceOf(host.view()) === TUTORIAL_SEQUENCE
  const ranOn = (task: string): boolean =>
    host.runs(task).some((run) => sameNames(namesIn(run.provenance.params.sequences), [TUTORIAL_SEQUENCE]))
  /** A track loaded from 4DN's set, by the accession in its address. */
  const fourdn = (accession: string): AnnotationEntry | undefined =>
    host.tracks()?.entries.find((entry) => entry.source.kind === 'remote' && entry.source.url.includes(accession))
  const ownE1 = (): AnnotationEntry | undefined => host.tracks()?.byId(OWN_E1)
  const ownInsulation = (): AnnotationEntry | undefined =>
    host.tracks()?.entries.find((entry) => entry.id.startsWith(OWN_INSULATION))
  const domainsRow = (): HTMLElement | null => first(`.ann-row[data-id="${OWN_DOMAINS}"]`)
  const domainsOpen = (): boolean =>
    domainsRow()?.querySelector('.ann-more')?.getAttribute('aria-expanded') === 'true'
  const domainsLane = (): boolean => {
    const entry = host.tracks()?.byId(OWN_DOMAINS)
    return entry !== undefined && displayOf(entry) === 'lane'
  }
  const domainsPlaced = (): { bottom: boolean; left: boolean } | null => {
    const placement = host.tracks()?.laneFor(OWN_DOMAINS, LEAD_MAP)?.placement
    return placement === undefined ? null : { bottom: placement.bottom, left: placement.left }
  }
  const placeToggle = (edge: 'bottom' | 'left'): HTMLElement | null => {
    for (const toggle of domainsRow()?.querySelectorAll<HTMLElement>('.ann-place') ?? []) {
      if (laidOut(toggle) && new RegExp(`\\b${edge} edge\\b`).test(toggle.title)) return toggle
    }
    return null
  }
  const mapPicture = (): HTMLElement | null => first('.content .panel-grid')
  /** A Map card control, or the door to the column it is in while that is folded. */
  const inMapCard = (find: () => HTMLElement | null) => (): HTMLElement | null =>
    find() ?? columnDoor('aesthetics')
  /** The square a stretch of chr13 makes on the map, lit within the map's canvas. */
  const square =
    (stretch: { start: number; end: number }) =>
    (): Element | TourSpot | null => {
      const canvas = first('.content .heatmap-canvas')
      if (canvas === null) return null
      const box = host.square({ contig: TUTORIAL_SEQUENCE, ...stretch })
      return box === null
        ? canvas
        : { within: canvas, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } }
    }
  const keys = isMac() ? '⇧ Shift and ⌥ Option' : 'Shift and Alt'

  // The Chromosomes table draws only the rows in view, so a short window may
  // not have drawn chr13's at all. Scrolled to it once per entry into the step.
  let revealed = false
  const revealRow = (): void => {
    if (revealed || sequenceRow(TUTORIAL_SEQUENCE) !== null) return
    const viewport = first('.content .tviewport')
    const at = host.sequences()?.indexOf(TUTORIAL_SEQUENCE) ?? -1
    if (viewport === null || at < 0) return
    revealed = true
    const height = viewport.querySelector<HTMLElement>('.tr')?.offsetHeight ?? 28
    viewport.scrollTop = Math.max(0, at * height - viewport.clientHeight / 2)
    viewport.dispatchEvent(new Event('scroll'))
  }

  const analysisPanel = (id: string, chapter: string): TourStep => ({
    id,
    chapter,
    title: 'Open the Analysis panel',
    text: 'Analyses run here, in this page, on the map on screen.',
    target: () => columnDoor('analysis'),
    done: () => host.panelOpen('analysis'),
    needs: { holds: onMap, back: 'open-set' },
  })

  /** The map's score, set in the Map card. */
  const scoreStep = (id: string, chapter: string, score: string, title: string, text: TourText): TourStep => ({
    id,
    chapter,
    title,
    text,
    action: 'choose',
    target: inMapCard(() => mapField('score')),
    done: () => host.score() === score,
    needs: { holds: onMap, back: 'open-set' },
  })

  /**
   * A task run on chr13 alone, then its drawer closed: open the panel, choose
   * the task, untick every sequence, tick chr13, set what `between` sets, run —
   * and look at what `after` lights before closing.
   */
  const sequenceTask = (
    chapter: string,
    task: string,
    row: string,
    say: { choose: string; none: string; tick: string; run: string },
    between: (open: () => boolean) => TourStep[] = () => [],
    after: (open: () => boolean) => TourStep[] = () => [],
  ): TourStep[] => {
    const panel = `analysis-${task}`
    const open = (): boolean => host.task() === task
    return [
      analysisPanel(panel, chapter),
      {
        id: task,
        chapter,
        title: `Choose ${row}`,
        text: say.choose,
        target: () => taskRow(row),
        done: open,
        needs: { holds: () => host.panelOpen('analysis'), back: panel },
        missing: 'Not in the list — empty the box over it if a word is typed there.',
      },
      {
        id: `${task}-none`,
        chapter,
        title: 'Untick every sequence',
        text: say.none,
        target: () => drawer()?.querySelector<HTMLElement>('button[title="Untick every sequence"]') ?? null,
        done: () => {
          const now = tickedSequences()
          return now !== null && (now.length === 0 || sameNames(now, [TUTORIAL_SEQUENCE]))
        },
        needs: { holds: open, back: task },
      },
      {
        id: `${task}-sequence`,
        chapter,
        title: `Tick ${TUTORIAL_SEQUENCE}`,
        text: say.tick,
        target: () => sequenceBox(TUTORIAL_SEQUENCE),
        done: () => sameNames(tickedSequences(), [TUTORIAL_SEQUENCE]),
        needs: { holds: open, back: task },
      },
      ...between(open),
      {
        id: `${task}-run`,
        chapter,
        title: 'Run it',
        text: say.run,
        target: runButton,
        done: () => ranOn(task),
        // A run carries on with its drawer closed, and is still a run.
        needs: { holds: () => open() || host.running(task), back: task },
      },
      ...after(open),
      {
        id: `${task}-close`,
        chapter,
        title: 'Back to the map',
        text: 'The result is a track as well as a figure. Close the drawer to see it beside the map.',
        target: () => drawer()?.querySelector<HTMLElement>('.analysis-drawer-head .btn-close') ?? null,
        done: () => host.task() === null,
      },
    ]
  }

  /** One of the four tracks the correlation is run over, ticked in its form. */
  const trackTick = (
    id: string,
    title: string,
    text: TourText,
    entry: () => AnnotationEntry | undefined,
  ): TourStep => ({
    id,
    chapter: 'Track correlation',
    title,
    text,
    target: () => trackBox(entry()),
    done: () => trackBox(entry())?.querySelector('input')?.checked === true,
    needs: { holds: () => host.task() === 'trackcorr', back: 'trackcorr' },
    missing: 'Not in the list — this track did not load, or was closed.',
  })

  return [
    // -- Welcome --------------------------------------------------------------
    {
      id: 'welcome',
      chapter: 'Welcome',
      title: 'A first session, on real data',
      text:
        'Open a Hi-C map from the 4D Nucleome project, find its compartments and domains on chr13, and set ' +
        'them against 4DN’s own — in the real app, one step at a time.',
      hero: true,
      agenda: true,
      next: 'let’s go',
    },

    // -- The store -----------------------------------------------------------
    {
      id: 'store',
      chapter: 'The 4DN store',
      title: 'Open the 4DN store',
      text:
        'Stores are catalogues of published data, read from where they are kept. Open the 4D Nucleome ' +
        'project’s.',
      target: () =>
        (host.store() === null ? null : first(`.store-drawer .store-tile[data-store="${TUTORIAL_STORE}"]`)) ??
        first(`.store-tiles-large .store-tile[data-store="${TUTORIAL_STORE}"]`) ??
        first('.head-files button[aria-label="stores"]'),
      done: () => host.store() === TUTORIAL_STORE,
    },
    {
      id: 'search',
      chapter: 'The 4DN store',
      title: 'Find an experiment',
      text: [
        'Type ',
        { name: TUTORIAL_SET },
        ' in the search box: Hi-C on IMR-90 lung fibroblasts, about a billion contacts.',
      ],
      action: 'type',
      target: searchBox,
      focus: true,
      done: () => searchBox()?.value.toUpperCase().includes(TUTORIAL_SET) === true && setGroup() !== null,
      needs: { holds: () => host.store() === TUTORIAL_STORE, back: 'store' },
      assist: {
        label: 'type it for me',
        title: `Put ${TUTORIAL_SET} in the search box`,
        run: () => {
          const box = searchBox()
          if (box === null) return
          box.value = TUTORIAL_SET
          box.dispatchEvent(new Event('input', { bubbles: true }))
        },
      },
    },
    {
      id: 'open-set',
      chapter: 'The 4DN store',
      title: 'Open it with its tracks',
      text:
        'One press opens the contact map with the tracks 4DN computed from it — compartments, insulation and ' +
        'boundaries — without downloading its 7.8 GB.',
      target: () => setGroup()?.querySelector<HTMLElement>('.portal-session') ?? null,
      done: onMap,
      needs: { holds: () => host.store() === TUTORIAL_STORE || onMap(), back: 'store' },
      missing: `Not on screen — type ${TUTORIAL_SET} in the store’s search box again.`,
    },

    // -- The map -------------------------------------------------------------
    {
      id: 'resolution-250',
      chapter: 'The map',
      title: 'Pick 250 kb',
      text:
        'A map is stored at several resolutions, the size of one bin. 250 kb is coarse enough to show a whole ' +
        'chromosome’s compartments.',
      action: 'choose',
      target: resolutionControl,
      done: () => host.binsize() === 250_000,
      needs: { holds: onMap, back: 'open-set' },
      missing: 'Waiting for the map to open.',
    },
    {
      id: 'chromosome',
      chapter: 'The map',
      title: `Open ${TUTORIAL_SEQUENCE}`,
      text: `Press ${TUTORIAL_SEQUENCE} in the table to open its map.`,
      prepare: () => {
        revealed = false
      },
      target: () => {
        revealRow()
        return sequenceRow(TUTORIAL_SEQUENCE)
      },
      done: onSequence,
      needs: { holds: onMap, back: 'open-set' },
      missing: `Not on screen — scroll the table to ${TUTORIAL_SEQUENCE}.`,
    },
    {
      id: 'look-map',
      chapter: 'The map',
      title: 'The contact map',
      text:
        `Each pixel is how often two stretches of ${TUTORIAL_SEQUENCE} touch. The plaid off the diagonal is ` +
        'its A and B compartments; 4DN’s own tracks are under the map.',
      target: mapPicture,
    },

    // -- Compartments ---------------------------------------------------------
    scoreStep(
      'score-correlation',
      'Compartments',
      CORRELATION_SCORE,
      'Draw it as a correlation',
      'In the Map card, set score to correlation: each pixel becomes how alike two stretches’ contacts are, ' +
        'once distance is divided out.',
    ),
    {
      id: 'look-correlation',
      chapter: 'Compartments',
      title: 'The plaid',
      text:
        'Red where two stretches share a compartment, blue where they do not. Compartments finds this ' +
        'pattern’s main axis: E1.',
      target: mapPicture,
    },
    ...sequenceTask(
      'Compartments',
      'compartments',
      'Compartments',
      {
        choose: 'It splits a chromosome into A and B compartments from the map’s plaid.',
        none: 'It runs on every sequence of the file to begin with. Press none…',
        tick: `…then tick ${TUTORIAL_SEQUENCE}, the chromosome on screen.`,
        run: 'Press run. It takes a few seconds.',
      },
      (open) => [
        {
          id: 'phase-genes',
          chapter: 'Compartments',
          title: 'No gene model',
          text:
            'E1’s sign means nothing until it is phased, and this box took 4DN’s boundaries for genes. ' +
            'Choose Do not use a gene model.',
          action: 'choose',
          target: () => formSelect('phase by gene density'),
          done: () => shown(formSelect('phase by gene density')) === 'Do not use a gene model',
          needs: { holds: open, back: 'compartments' },
        },
        {
          id: 'phase-track',
          chapter: 'Compartments',
          title: 'Phase it by 4DN’s E1',
          text: [
            '4DN’s own E1 is phased already. Choose ',
            { name: FOURDN_E1 },
            ' under phase by a track, so that A means the same in both.',
          ],
          action: 'choose',
          target: () => formSelect('phase by a track'),
          done: () => shown(formSelect('phase by a track')).includes(FOURDN_E1),
          needs: { holds: open, back: 'compartments' },
        },
      ],
      (open) => [
        {
          id: 'look-saddle',
          chapter: 'Compartments',
          title: 'The saddle',
          text:
            'Bins sorted by E1, from B to A: strong opposite corners mean A touches A and B touches B. The ' +
            'numbers under it say how much.',
          target: () => figure('Saddle'),
          needs: { holds: open, back: 'compartments' },
        },
      ],
    ),
    {
      id: 'look-compartments',
      chapter: 'Compartments',
      title: 'Your compartments',
      text:
        'E1 and its A and B calls are drawn left of the map. Compare them with 4DN’s compartment track under ' +
        'it.',
      target: mapPicture,
    },

    // -- Zooming in -----------------------------------------------------------
    scoreStep(
      'score-balanced',
      'Zooming in',
      BALANCED_SCORE,
      'Back to contacts',
      'Domains are about how often stretches touch, not how alike they are: set score back to balanced.',
    ),
    {
      id: 'zoom',
      chapter: 'Zooming in',
      title: 'Zoom along the diagonal',
      text: `Hold ${keys}, then drag across the lit square, from one corner to the other: that stretch opens.`,
      action: 'drag',
      target: square(OVERVIEW),
      done: () => {
        const view = host.view()
        return onSequence() && view?.region?.includes(':') === true && view.region2 === undefined
      },
      needs: { holds: onSequence, back: 'chromosome' },
      assist: {
        label: 'zoom for me',
        title: `Open ${TUTORIAL_SEQUENCE}:${bp(OVERVIEW.start)}-${bp(OVERVIEW.end)}`,
        run: () => goTo(`${TUTORIAL_SEQUENCE}:${bp(OVERVIEW.start)}-${bp(OVERVIEW.end)}`),
      },
    },
    {
      id: 'resolution-10',
      chapter: 'Zooming in',
      title: 'Switch to 10 kb',
      text: 'At 10 kb the domains along the diagonal come into view.',
      action: 'choose',
      target: resolutionControl,
      done: () => host.binsize() === 10_000,
      needs: { holds: onMap, back: 'open-set' },
    },
    {
      id: 'zoom-domains',
      chapter: 'Zooming in',
      title: 'Closer, on a few domains',
      text: `Once more: hold ${keys} and drag across the lit square.`,
      action: 'drag',
      target: square(DOMAINS),
      done: () => {
        const stretch = stretchOf(host.view())
        return (
          stretch !== null &&
          stretch.contig === TUTORIAL_SEQUENCE &&
          stretch.end - stretch.start <= DOMAINS_SPAN &&
          host.binsize() === 10_000
        )
      },
      needs: { holds: () => onSequence() && host.binsize() === 10_000, back: 'resolution-10' },
      missing: 'Not in view — press zoom for me, or go back a step.',
      assist: {
        label: 'zoom for me',
        title: `Open ${TUTORIAL_SEQUENCE}:${bp(DOMAINS.start)}-${bp(DOMAINS.end)}`,
        run: () => goTo(`${TUTORIAL_SEQUENCE}:${bp(DOMAINS.start)}-${bp(DOMAINS.end)}`),
      },
    },
    {
      id: 'look-domains',
      chapter: 'Zooming in',
      title: 'Domains',
      text:
        'Each dark square along the diagonal is a domain, or TAD: a stretch that touches itself more than its ' +
        'neighbours. Some sit inside bigger ones.',
      target: mapPicture,
    },
    {
      id: 'oe-on',
      chapter: 'Zooming in',
      title: 'Turn on O/E',
      text: 'O/E divides each pixel by what its distance predicts, so what is left is structure rather than distance.',
      target: inMapCard(oeToggle),
      done: () => host.view()?.oe === true,
      needs: { holds: onMap, back: 'open-set' },
    },
    {
      id: 'smooth',
      chapter: 'Zooming in',
      title: 'Smooth it',
      text:
        'At 10 kb most pixels hold a handful of contacts. Set smooth to adaptive, which pools neighbours where ' +
        'the counts are thin.',
      action: 'choose',
      target: inMapCard(() => mapField('smooth')),
      done: () => host.view()?.smooth?.startsWith('a') === true,
      needs: { holds: onMap, back: 'open-set' },
    },
    {
      id: 'look-oe',
      chapter: 'Zooming in',
      title: 'Structure, not distance',
      text:
        'Red is more contact than the distance predicts, blue less: the domains are red squares, and the ' +
        'checkerboard behind them is A and B again.',
      target: mapPicture,
    },

    // -- Insulation -----------------------------------------------------------
    ...sequenceTask('Insulation', 'insulation', 'Diamond insulation', {
      choose: 'It scores how much contact crosses each bin; its dips are the boundaries between domains.',
      none: 'Again, press none…',
      tick: `…then tick ${TUTORIAL_SEQUENCE}.`,
      run: 'Press run. At 10 kb it takes ten seconds or so.',
    }),
    {
      id: 'look-insulation',
      chapter: 'Insulation',
      title: 'Your insulation',
      text:
        'The score and its boundaries are drawn left of the map, and the domains between the boundaries are ' +
        'outlined on the map itself.',
      target: mapPicture,
    },

    // -- Tracks ---------------------------------------------------------------
    {
      id: 'annotations',
      chapter: 'Tracks',
      title: 'Open the Annotations panel',
      text: 'Every track has a row here, the ones you computed among them.',
      target: () => columnDoor('annotations'),
      done: () => host.panelOpen('annotations'),
      needs: { holds: onMap, back: 'open-set' },
    },
    {
      id: 'domains',
      chapter: 'Tracks',
      title: 'Unfold the domains’ settings',
      text: 'Press the arrow on the Insulation domains row.',
      target: () => domainsRow()?.querySelector<HTMLElement>('.ann-more') ?? null,
      done: domainsOpen,
      needs: { holds: () => host.panelOpen('annotations'), back: 'annotations' },
      missing: 'No Insulation domains row — run Diamond insulation with its domains on.',
    },
    {
      id: 'domains-display',
      chapter: 'Tracks',
      title: 'Draw them as a 1D track',
      text: 'Domains are outlined on the map. Choose 1D track to draw them as a lane beside it instead.',
      action: 'choose',
      target: () => domainsRow()?.querySelector<HTMLElement>(`select[data-display="${OWN_DOMAINS}"]`) ?? null,
      done: domainsLane,
      needs: { holds: domainsOpen, back: 'domains' },
    },
    {
      id: 'domains-bottom',
      chapter: 'Tracks',
      title: 'Put it under the map',
      text: 'Press the bottom edge to draw the lane under the map…',
      target: () => placeToggle('bottom'),
      done: () => domainsPlaced()?.bottom === true,
      needs: { holds: () => domainsOpen() && domainsLane(), back: 'domains-display' },
    },
    {
      id: 'domains-left',
      chapter: 'Tracks',
      title: 'Take it off the side',
      text: '…and the left edge to take it off the left.',
      target: () => placeToggle('left'),
      done: () => {
        const placed = domainsPlaced()
        return placed !== null && placed.bottom && !placed.left
      },
      needs: { holds: () => domainsOpen() && domainsLane(), back: 'domains-display' },
    },

    // -- Track correlation ----------------------------------------------------
    analysisPanel('analysis-trackcorr', 'Track correlation'),
    {
      id: 'trackcorr',
      chapter: 'Track correlation',
      title: 'Choose Track correlation',
      text: 'It measures how closely every pair of loaded tracks agrees.',
      target: () => taskRow('Track correlation'),
      done: () => host.task() === 'trackcorr',
      needs: { holds: () => host.panelOpen('analysis'), back: 'analysis-trackcorr' },
      missing: 'Not in the list — empty the box over it if a word is typed there.',
    },
    trackTick(
      'tick-4dn-insulation',
      'Tick 4DN’s insulation',
      [{ name: FOURDN_INSULATION }, ', the insulation score 4DN computed at 10 kb.'],
      () => fourdn(FOURDN_INSULATION),
    ),
    trackTick(
      'tick-4dn-e1',
      'Tick 4DN’s compartments',
      [{ name: FOURDN_E1 }, ', the E1 4DN computed at 250 kb.'],
      () => fourdn(FOURDN_E1),
    ),
    trackTick('tick-own-e1', 'Tick your E1', 'The compartment track you computed.', ownE1),
    trackTick('tick-own-insulation', 'Tick your insulation', 'The insulation score you computed.', ownInsulation),
    {
      id: 'trackcorr-run',
      chapter: 'Track correlation',
      title: 'Run it',
      text: `Every pair is compared over the windows all four have values in, which is ${TUTORIAL_SEQUENCE}.`,
      target: runButton,
      done: () => {
        const wanted = [fourdn(FOURDN_INSULATION), fourdn(FOURDN_E1), ownE1(), ownInsulation()]
        if (wanted.some((entry) => entry === undefined)) return false
        return host.runs('trackcorr').some((run) => {
          const chosen = new Set(namesIn(run.provenance.params.tracks) ?? [])
          return wanted.every((entry) => entry !== undefined && chosen.has(entry.id))
        })
      },
      needs: { holds: () => host.task() === 'trackcorr' || host.running('trackcorr'), back: 'trackcorr' },
    },
    {
      id: 'look-trackcorr',
      chapter: 'Track correlation',
      title: 'Yours against 4DN’s',
      text:
        'Each square compares two tracks, dark red where they rise and fall together. Find your E1 against ' +
        '4DN’s, and your insulation against theirs.',
      target: () => figure('Track correlation'),
    },

    // -- The console ----------------------------------------------------------
    {
      id: 'console',
      chapter: 'The console',
      title: 'Every step is a command',
      text:
        'Open the console: each file you opened and each run you made is a line you can paste into a terminal ' +
        'to do it again.',
      target: () => first('.head-actions button[aria-label="console"]') ?? first('button[aria-label="console"]'),
      done: () => host.consoleOpen(),
    },
    {
      id: 'finish',
      chapter: 'Done',
      title: 'That’s the tour',
      text:
        'You opened a billion-contact map from 4DN, called compartments and domains on chr13, and set them ' +
        'against 4DN’s own. The tutorial is in About whenever you want it again.',
      hero: true,
    },
  ]
}
