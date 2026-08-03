/**
 * The two file-driven cards: **Linear annotations** and **Map overlays**
 * (spec §8.1).
 *
 * One class for both, because they differ in three things — their drop areas,
 * their per-row controls, and where their contents get drawn — and in nothing
 * else. Two classes would have been two copies of the loading, the error
 * reporting, the overlap warning, the colour picker and the remove button, kept
 * in step by hand.
 *
 * The rows are rebuilt from the store on every change rather than patched. The
 * list is a handful of items and the alternative — reconciling a DOM against a
 * list — is the one part of this app that would genuinely want a framework.
 */

import type { AnnotationLoader, DropZone } from '../annotations/loader'
import type { AnnotationStore } from '../annotations/store'
import type {
  AnnotationCard as CardKind,
  AnnotationEntry,
  ContigOverlap,
} from '../annotations/types'
import { button, el, fmt } from './dom'
import { iconButton } from './icons'

interface ZoneSpec {
  zone: DropZone
  label: string
  hint: string
  accept: string
}

const LINEAR_ZONES: ZoneSpec[] = [
  {
    zone: 'gtf',
    label: 'Annotation',
    hint: 'One GTF or GFF gene model. Drawn as exons on a spine.',
    accept: '.gtf,.gff,.gff3,.gtf.gz,.gff.gz,.gff3.gz',
  },
  {
    zone: 'track',
    label: 'Tracks',
    hint: 'bigWig, any number. Drawn as lines, areas or bars.',
    accept: '.bw,.bigwig,.bigWig',
  },
  {
    zone: 'segments',
    label: 'Segments',
    hint: 'BED, narrowPeak, broadPeak. Drawn as boxes.',
    accept: '.bed,.narrowPeak,.broadPeak,.gappedPeak,.txt,.tsv',
  },
]

const OVERLAY_ZONES: ZoneSpec[] = [
  {
    zone: 'segments',
    label: 'On the diagonal',
    hint: 'BED-like. Borders as a mark across the diagonal, elements as a box on it.',
    accept: '.bed,.narrowPeak,.broadPeak,.txt,.tsv',
  },
  {
    zone: 'pairs',
    label: 'Off the diagonal',
    hint: 'BEDPE, or a table with chrom1/start1/end1/chrom2/start2/end2. Drawn as circles.',
    accept: '.bedpe,.tsv,.txt',
  },
]

export interface AnnotationCardProps {
  card: CardKind
  store: AnnotationStore
  loader: AnnotationLoader
}

export class AnnotationCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  /** Rows the reader has opened, so a repaint does not fold them shut. */
  private readonly open = new Set<string>()

  constructor(private readonly props: AnnotationCardProps) {
    const linear = props.card === 'linear'
    const zones = linear ? LINEAR_ZONES : OVERLAY_ZONES

    this.el = el(
      'section',
      { class: 'card annotation-card' },
      el('h3', { text: linear ? 'Linear annotations' : 'Map overlays' }),
      el('p', {
        class: 'hint',
        text: linear
          ? 'Drawn beside the map, on the bottom edge, the right edge or both. Everything stays ' +
            'locked to what the map shows.'
          : 'Drawn on the map itself. Nothing here fills the pixel it marks.',
      }),
      el('div', { class: 'drop-row' }, ...zones.map((spec) => this.dropzone(spec))),
      this.urlRow(zones),
      this.list,
    )

    this.unsubscribe = props.store.subscribe(() => this.render())
    this.render()
  }

  destroy(): void {
    this.unsubscribe()
  }

  // -------------------------------------------------------------------------
  // Getting files in
  // -------------------------------------------------------------------------

  /**
   * One drop area.
   *
   * Clickable as well as droppable, because "drag a file here" is not a gesture
   * everyone has, and because a file manager is not always on screen beside the
   * browser. `multiple` on every zone but the gene model, which takes one.
   */
  private dropzone(spec: ZoneSpec): HTMLElement {
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.accept = spec.accept
    input.multiple = spec.zone !== 'gtf'
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      if (files.length > 0) this.props.loader.addFiles(this.props.card, spec.zone, files)
      // Cleared so choosing the same file twice fires `change` the second time.
      input.value = ''
    })

    const zone = el(
      'div',
      { class: 'ann-drop', title: spec.hint, attrs: { tabindex: '0', role: 'button' } },
      el('span', { class: 'ann-drop-label', text: spec.label }),
      el('span', { class: 'ann-drop-hint', text: spec.hint }),
      input,
    )
    zone.addEventListener('click', () => input.click())
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        input.click()
      }
    })
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) this.props.loader.addFiles(this.props.card, spec.zone, files)
    })
    return zone
  }

  /**
   * A URL box, folded away until it is wanted.
   *
   * Published tracks live on buckets beside published maps, and a reader
   * following a link to one should not have to download it first. The zone
   * picker is only offered when the card has more than one, and it decides
   * nothing that the file's own bytes will not overrule (§8.3).
   */
  private urlRow(zones: ZoneSpec[]): HTMLElement {
    const input = el('input', {
      class: 'input',
      type: 'url',
      placeholder: 'https://bucket.example.org/ATAC.bw',
    })
    const select = el('select', { class: 'select' })
    for (const spec of zones) select.appendChild(el('option', { value: spec.zone, text: spec.label }))

    const submit = (): void => {
      const url = input.value.trim()
      if (url === '') return
      this.props.loader.addUrl(this.props.card, select.value as DropZone, url)
      input.value = ''
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit()
    })

    return el(
      'details',
      { class: 'ann-url' },
      el('summary', { text: 'or open one by URL' }),
      el('div', { class: 'ann-url-row' }, select, input, button('add', submit, { class: 'btn' })),
    )
  }

  // -------------------------------------------------------------------------
  // The rows
  // -------------------------------------------------------------------------

  private render(): void {
    const entries = this.props.store.forCard(this.props.card)
    if (entries.length === 0) {
      this.list.replaceChildren()
      return
    }
    this.list.replaceChildren(...entries.map((entry) => this.row(entry)))
  }

  private row(entry: AnnotationEntry): HTMLElement {
    const body = el('div', { class: 'ann-body' })
    const isOpen = this.open.has(entry.id)
    body.classList.toggle('hidden', !isOpen)
    if (isOpen) body.replaceChildren(...this.settings(entry))

    const swatch = el('span', { class: 'ann-swatch' })
    swatch.style.background = entry.style.colour

    const name = el('button', {
      class: 'ann-name',
      type: 'button',
      text: entry.label,
      title: 'Show or hide this annotation’s settings',
    })
    name.addEventListener('click', () => {
      if (this.open.has(entry.id)) this.open.delete(entry.id)
      else this.open.add(entry.id)
      this.render()
    })

    const head = el(
      'div',
      { class: 'ann-head' },
      swatch,
      name,
      ...(entry.card === 'linear' ? [this.placement(entry)] : []),
      this.visibility(entry),
      iconButton('x', 'Remove this annotation', () => this.props.store.remove(entry.id), {
        class: 'btn-close',
        size: 14,
      }),
    )

    const row = el('div', { class: `ann-row ann-${entry.status}` }, head)
    if (entry.status === 'loading') {
      row.appendChild(el('p', { class: 'ann-note', text: 'reading…' }))
    } else if (entry.status === 'error') {
      row.appendChild(el('p', { class: 'inline-error ann-note', text: entry.error ?? 'failed' }))
    } else if (entry.status === 'detached') {
      row.appendChild(this.reattachNote(entry))
    } else {
      if (entry.summary !== undefined) {
        row.appendChild(el('p', { class: 'ann-note', text: entry.summary }))
      }
      const warning = overlapWarning(entry.overlap)
      if (warning !== null) row.appendChild(el('p', { class: 'ann-warn', text: warning }))
    }
    row.appendChild(body)
    return row
  }

  /**
   * The way back from a reload.
   *
   * A dropped file cannot be re-read without a gesture, which is a privacy
   * property rather than a limitation (§11) — so the row keeps everything the
   * reader chose and asks for the file again, rather than vanishing and taking
   * the settings with it.
   */
  private reattachNote(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file !== undefined) this.props.loader.reattach(entry.id, file)
    })
    const pick = button('re-open this file', () => input.click(), {
      class: 'btn btn-quiet',
      title: 'The settings below were kept; only the data has to be read again.',
    })
    return el('p', { class: 'ann-note ann-detached' }, `${entry.source.name} · `, pick, input)
  }

  /** The bottom/right tick boxes — §8.1's "bottom, right, or both". */
  private placement(entry: AnnotationEntry): HTMLElement {
    const box = (edge: 'bottom' | 'right', label: string): HTMLElement => {
      const input = el('input', { class: 'checkbox', type: 'checkbox' })
      input.checked = entry.placement[edge]
      input.addEventListener('change', () =>
        this.props.store.update(entry.id, {
          placement: { ...entry.placement, [edge]: input.checked },
        }),
      )
      return el(
        'label',
        { class: 'ann-edge', title: `Draw this on the ${edge} edge of the map` },
        input,
        el('span', { text: label }),
      )
    }
    return el('div', { class: 'ann-edges' }, box('bottom', 'B'), box('right', 'R'))
  }

  private visibility(entry: AnnotationEntry): HTMLElement {
    const node = el('button', {
      class: 'btn btn-toggle ann-eye',
      type: 'button',
      text: entry.visible ? '◉' : '○',
      title: entry.visible ? 'Hide, keeping the settings' : 'Show again',
    })
    node.setAttribute('aria-pressed', String(entry.visible))
    node.addEventListener('click', () =>
      this.props.store.update(entry.id, { visible: !entry.visible }),
    )
    return node
  }

  // -------------------------------------------------------------------------
  // Per-annotation settings
  // -------------------------------------------------------------------------

  private settings(entry: AnnotationEntry): HTMLElement[] {
    const out: HTMLElement[] = [this.name(entry), this.colour(entry), this.size(entry)]
    if (entry.kind === 'track') {
      out.push(this.mode(entry), this.scaling(entry), this.limits(entry), this.group(entry))
    }
    if (entry.card === 'overlay') {
      if (entry.kind === 'segments') out.push(this.shape(entry))
      if (entry.kind === 'pairs') out.push(this.radius(entry))
      out.push(this.opacity(entry))
    }
    return out
  }

  /**
   * What the lane is called, on screen and in an exported figure.
   *
   * Editable because the file name is a starting point rather than an answer:
   * `Yeast_ATAC.bw` and `Yeast_ATAC.narrowPeak` are two different annotations
   * with one name, and the lane label is what tells them apart on the plot.
   */
  private name(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'input', type: 'text', value: entry.label })
    input.addEventListener('change', () => {
      const label = input.value.trim()
      if (label !== '') this.props.store.update(entry.id, { label })
    })
    return this.field('name', input, 'The label drawn on the lane and in an exported figure.')
  }

  private colour(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'ann-colour', type: 'color', value: entry.style.colour })
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { colour: input.value }),
    )
    return this.field('colour', input)
  }

  /** Lane thickness, or — on the overlay card — nothing, since there is no lane. */
  private size(entry: AnnotationEntry): HTMLElement {
    if (entry.card === 'overlay') return el('span', { class: 'hidden' })
    const input = el('input', { class: 'ann-range', type: 'range', value: String(entry.style.size) })
    input.min = '12'
    input.max = '140'
    input.step = '2'
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { size: Number(input.value) }),
    )
    return this.field('height', input)
  }

  private mode(entry: AnnotationEntry): HTMLElement {
    const select = el('select', { class: 'select' })
    for (const mode of ['area', 'line', 'bar'] as const) {
      select.appendChild(el('option', { value: mode, text: mode }))
    }
    select.value = entry.style.mode
    select.addEventListener('change', () =>
      this.props.store.restyle(entry.id, { mode: select.value as 'area' | 'line' | 'bar' }),
    )
    return this.field('style', select)
  }

  private scaling(entry: AnnotationEntry): HTMLElement {
    const select = el('select', { class: 'select' })
    select.appendChild(el('option', { value: 'linear', text: 'linear' }))
    select.appendChild(el('option', { value: 'log2', text: 'log2' }))
    select.value = entry.style.scaling
    select.title =
      'log2 is for ratio tracks, where a doubling is the unit. Values at or below zero are drawn ' +
      'on the floor rather than dropped.'
    select.addEventListener('change', () =>
      this.props.store.restyle(entry.id, { scaling: select.value as 'linear' | 'log2' }),
    )
    return this.field('scaling', select)
  }

  /**
   * Auto, or a pair of numbers.
   *
   * Auto means *what is in view*, recomputed as the view moves, which is the
   * behaviour a reader expects from a genome browser. The boxes are seeded from
   * the file's own header range so switching to manual starts somewhere sensible
   * rather than at zero.
   */
  private limits(entry: AnnotationEntry): HTMLElement {
    const { limits } = entry.style
    const auto = el('input', { class: 'checkbox', type: 'checkbox' })
    auto.checked = limits.auto

    const seed = entry.fileExtent ?? { min: 0, max: 1 }
    const min = el('input', {
      class: 'input input-num',
      type: 'number',
      value: String(limits.auto ? seed.min : limits.min),
    })
    const max = el('input', {
      class: 'input input-num',
      type: 'number',
      value: String(limits.auto ? seed.max : limits.max),
    })
    for (const box of [min, max]) {
      box.disabled = limits.auto
      box.step = 'any'
      box.addEventListener('change', () =>
        this.props.store.restyle(entry.id, {
          limits: { auto: false, min: Number(min.value), max: Number(max.value) },
        }),
      )
    }
    auto.addEventListener('change', () =>
      this.props.store.restyle(entry.id, {
        limits: {
          auto: auto.checked,
          min: Number(min.value),
          max: Number(max.value),
        },
      }),
    )

    return el(
      'div',
      {
        class: 'field field-block',
        title:
          'Auto rescales to whatever is on screen, as the view moves. A one-signed track is ' +
          'anchored at zero; a signed one is made symmetric so no change sits in the middle.',
      },
      el('span', { class: 'field-label', text: 'limits' }),
      el(
        'div',
        { class: 'ann-limits' },
        el('label', { class: 'ann-auto' }, auto, el('span', { text: 'auto' })),
        min,
        max,
      ),
    )
  }

  /**
   * The autoscale group.
   *
   * A free-text name rather than a picker: the groups that exist are the ones
   * the reader has typed, and offering a list of them would mean inventing a
   * separate place to create one. Two tracks in `rna` share one range; the empty
   * string is "scale alone".
   */
  private group(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'input',
      type: 'text',
      value: entry.style.group,
      placeholder: 'none',
    })
    input.addEventListener('change', () =>
      this.props.store.restyle(entry.id, { group: input.value.trim() }),
    )
    return this.field(
      'group',
      input,
      'Tracks sharing a name share one range, over everything they show. That is the only way ' +
        'two tracks can be compared by eye.',
    )
  }

  private shape(entry: AnnotationEntry): HTMLElement {
    const select = el('select', { class: 'select' })
    select.appendChild(el('option', { value: 'element', text: 'element (box)' }))
    select.appendChild(el('option', { value: 'border', text: 'border (mark)' }))
    select.value = entry.style.shape
    select.title =
      'An element is an extent — a domain — and is drawn as the box it occupies. A border is a ' +
      'point call and is drawn as a mark across the diagonal, which stays visible at any zoom.'
    select.addEventListener('change', () =>
      this.props.store.restyle(entry.id, { shape: select.value as 'element' | 'border' }),
    )
    return this.field('shape', select)
  }

  private radius(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'ann-range', type: 'range', value: String(entry.style.radius) })
    input.min = '3'
    input.max = '24'
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { radius: Number(input.value) }),
    )
    return this.field('radius', input)
  }

  private opacity(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'ann-range',
      type: 'range',
      value: String(Math.round(entry.style.opacity * 100)),
    })
    input.min = '10'
    input.max = '100'
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { opacity: Number(input.value) / 100 }),
    )
    return this.field('opacity', input)
  }

  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return el(
      'label',
      { class: 'field ann-field', title: hint ?? '' },
      el('span', { class: 'field-label', text: label }),
      control,
    )
  }
}

/**
 * What to say when a file and a map disagree about contig names.
 *
 * §8.2 requires this to be impossible to miss, and it applies to every format
 * rather than only to bigWig. The two failures want different fixes and are
 * therefore worded differently: no overlap at all is a naming convention
 * mismatch, and partial overlap is usually a partial annotation.
 */
export function overlapWarning(overlap: ContigOverlap | undefined): string | null {
  if (overlap === undefined || overlap.total === 0) return null
  if (overlap.matched === 0) {
    const sample = overlap.extra.length > 0 ? ` This file names ${overlap.extra.join(', ')}…` : ''
    return `No contig in this file matches the map (0 of ${fmt.int(overlap.total)}).${sample} ` +
      'Nothing will be drawn until the two use the same names.'
  }
  if (overlap.matched < overlap.total) {
    return `${fmt.int(overlap.matched)} of ${fmt.int(overlap.total)} contigs matched; ` +
      `nothing is drawn on ${overlap.missing.join(', ')}${overlap.missing.length < overlap.total - overlap.matched ? '…' : ''}.`
  }
  return null
}
