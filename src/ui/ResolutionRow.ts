/**
 * The resolution row at the far end of the crumb bar (§3.4, §2): *Refine on
 * zoom*, a slider over the file's rungs, a box naming the resolution, and the
 * `+` that adds one.
 *
 * **Two modes, one row.** With *Refine on zoom* ticked — the default — the zoom
 * picks the resolution: the screen's, down to the finest rung the file stores.
 * The slider and the box are greyed, and follow the map as it sharpens, so the
 * row says which resolution is actually drawn rather than one nobody asked for.
 * Unticked, the reader picks it, by sliding, by a slot, or in the box, and the
 * pick is what the map draws, coarser only where the window is too wide for a
 * block at it (the line under the map says so). Unticking keeps the resolution
 * on screen as the pick, so nothing jumps.
 *
 * **The slider is a row of slots, evenly spaced, coarsest on the left.** A
 * ladder is ordered and has a fixed number of rungs, which is what slots show;
 * a continuous track would suggest there is somewhere between two of them to
 * stop. Only the two ends are labelled, so the row stays a row on a laptop
 * with eleven rungs; a slot says its resolution under the pointer. The thumb
 * stands between two slots while refining a grid no rung stores — 20 kb is two
 * of the 10 kb rung's bins — at the place a log scale would put it.
 *
 * The box is the same choice as a list, for the reader who would rather read
 * it than slide to it, and it has no arrow: it is a number first, and a menu
 * only when asked.
 */

import type { DerivedRung, Rung } from '../metacooler/coarsen'
import { resolutionLabel } from '../units'
import { el } from './dom'
import { icon } from './icons'
import { refineEnabled, setRefineEnabled, subscribeRefine } from './refine'

/** A rung of the row: one the file stores, or one the reader added. */
export type RowRung = Rung & { derived?: DerivedRung }

export interface ResolutionRowProps {
  /** Every rung, finest first — the ladder's own order. */
  rungs: ReadonlyArray<RowRung>
  /** The rung picked, by index into {@link rungs}; -1 for none. */
  at: number
  /** The resolution on screen, in base pairs, where it is known. */
  shown: number | null
  /** What a rung is, in a sentence — the slot's and the option's tooltip. */
  why(rung: RowRung): string
  /** A rung was picked. */
  onPick(rung: RowRung): void
  /** The `+`; absent where the session offers no way to add one. */
  onAdd?: () => void
  /** The × that takes an added rung back off the ladder, for the one picked. */
  dropButton?(rung: RowRung, label: string): HTMLElement
}

/** How wide the slider's track is, whatever the number of rungs. */
const TRACK_PX = 168

export class ResolutionRow {
  readonly el: HTMLElement
  private readonly props: ResolutionRowProps
  private shown: number | null
  private readonly tick: HTMLInputElement
  private readonly track: HTMLElement | null
  private readonly thumb: HTMLElement | null
  private readonly slots: HTMLButtonElement[] = []
  private readonly box: HTMLSelectElement
  /** The box's own option for a resolution no rung stores, shown while refining. */
  private readonly between: HTMLOptionElement
  private readonly add: HTMLButtonElement | null
  /** The × beside the box, while the rung picked is one the reader added. */
  private readonly drop: HTMLElement | null
  /** The floating label a slot shows under the pointer; see {@link showTip}. */
  private tip: HTMLElement | null = null
  /** A drag along the track: the slot it is over. */
  private dragging: number | null = null
  private readonly stopRefine: () => void

  constructor(props: ResolutionRowProps) {
    this.props = props
    this.shown = props.shown
    const { rungs } = props

    this.tick = el('input', {
      type: 'checkbox',
      attrs: { 'aria-label': 'Refine on zoom' },
    }) as HTMLInputElement
    this.tick.addEventListener('change', () => this.toggle(this.tick.checked))
    const refine = el(
      'label',
      {
        class: 'res-refine',
        title:
          'Refine on zoom: the map is read at the resolution of the screen, and finer as you zoom, ' +
          'down to the finest the file stores. Untick to pick a resolution yourself.',
      },
      this.tick,
      el('span', { text: 'refine on zoom' }),
    )

    // The slider, for a ladder of two rungs or more: one rung is not a walk.
    if (rungs.length >= 2) {
      this.track = el('div', {
        class: 'res-track',
        attrs: {
          role: 'slider',
          tabindex: '0',
          'aria-label': 'resolution',
          'aria-valuemin': '0',
          'aria-valuemax': String(rungs.length - 1),
        },
      })
      this.track.style.width = `${TRACK_PX}px`
      this.track.append(el('div', { class: 'res-rail' }))
      for (const [index, rung] of rungs.entries()) {
        const label = labelOf(rung)
        const slot = el('button', {
          class: `res-slot${rung.derived === undefined ? '' : ' is-added'}`,
          type: 'button',
          attrs: { 'aria-label': label, tabindex: '-1' },
        }) as HTMLButtonElement
        slot.style.left = `${this.place(index)}%`
        slot.addEventListener('pointerenter', () => this.showTip(slot, label))
        slot.addEventListener('pointerleave', () => this.hideTip())
        slot.addEventListener('click', (event) => {
          event.stopPropagation()
          if (this.refining()) return
          this.pickAt(index)
        })
        this.slots.push(slot)
        this.track.append(slot)
      }
      this.thumb = el('div', { class: 'res-thumb' })
      this.track.append(this.thumb)
      this.track.addEventListener('pointerdown', (event) => this.dragFrom(event))
      this.track.addEventListener('keydown', (event) => this.key(event))
    } else {
      this.track = null
      this.thumb = null
    }

    // The box: every rung, finest first, as the ladder lists them.
    this.box = el('select', {
      class: 'select res-pick',
      attrs: { 'aria-label': 'resolution' },
    }) as HTMLSelectElement
    for (const [index, rung] of rungs.entries()) {
      this.box.append(
        el('option', { value: String(index), text: labelOf(rung), attrs: { title: props.why(rung) } }),
      )
    }
    this.between = el('option', { value: 'shown', attrs: { hidden: '' } }) as HTMLOptionElement
    this.box.append(this.between)
    this.box.addEventListener('change', () => {
      // Greyed while the zoom picks; a change that reaches it anyway is put back.
      if (this.refining()) return this.paint()
      const index = Number(this.box.value)
      if (Number.isInteger(index)) this.pickAt(index)
    })

    this.add =
      props.onAdd === undefined
        ? null
        : (el(
            'button',
            {
              class: 'btn btn-icon res-add',
              type: 'button',
              attrs: {
                'aria-label': 'Add a resolution',
                title:
                  'Look at this map at a resolution the file does not store — any whole number of ' +
                  'its own bins added up.',
              },
              on: { click: () => props.onAdd?.() },
            },
            icon('plus', { size: 12 }),
          ) as HTMLButtonElement)

    const picked = rungs[props.at]
    this.drop =
      picked?.derived !== undefined && props.dropButton !== undefined
        ? props.dropButton(picked, labelOf(picked))
        : null

    const scale =
      this.track === null
        ? null
        : el(
            'div',
            { class: 'res-scale' },
            el('span', { class: 'res-end res-end-coarse', text: labelOf(rungs[rungs.length - 1]) }),
            this.track,
            el('span', { class: 'res-end res-end-fine', text: labelOf(rungs[0]) }),
          )

    this.el = el(
      'div',
      {
        class: 'crumb-res',
        title:
          'How finely this map is drawn: the resolutions the file stores, coarsest on the left. ' +
          'The place on screen does not change.',
      },
      refine,
      ...(scale === null ? [] : [scale]),
      this.drop === null ? this.box : el('span', { class: 'res-pick-wrap' }, this.box, this.drop),
      ...(this.add === null ? [] : [this.add]),
    )

    this.stopRefine = subscribeRefine(() => this.paint())
    this.paint()
  }

  /** The resolution on screen changed: the row follows it while refining. */
  setShown(binsize: number | null): void {
    this.shown = binsize
    if (this.refining()) this.paint()
  }

  destroy(): void {
    this.stopRefine()
    this.hideTip()
  }

  private refining(): boolean {
    return refineEnabled()
  }

  /** Where rung `index` sits along the track, as a percentage: coarsest at 0. */
  private place(index: number): number {
    const n = this.props.rungs.length
    return n < 2 ? 50 : ((n - 1 - index) / (n - 1)) * 100
  }

  /**
   * Where a resolution sits along the track: on its rung's slot, or between two
   * at the place a log scale puts it; clamped to the ends.
   */
  private placeOf(binsize: number): number {
    const { rungs } = this.props
    if (rungs.length < 2) return 50
    if (binsize >= rungs[rungs.length - 1].binsize) return this.place(rungs.length - 1)
    if (binsize <= rungs[0].binsize) return this.place(0)
    for (let i = 0; i < rungs.length - 1; i++) {
      const fine = rungs[i].binsize
      const coarse = rungs[i + 1].binsize
      if (binsize < fine || binsize > coarse) continue
      const t = Math.log(coarse / binsize) / Math.log(coarse / fine)
      return this.place(i + 1) + t * (this.place(i) - this.place(i + 1))
    }
    return this.place(0)
  }

  /** Repaint every part from the preference, the pick and what is shown. */
  private paint(): void {
    const refining = this.refining()
    const { rungs, at } = this.props
    this.tick.checked = refining
    this.el.classList.toggle('is-refining', refining)
    this.box.disabled = refining
    if (this.add !== null) this.add.disabled = refining
    // The × names the rung picked, and while the zoom picks the box names
    // another: beside it, it would offer to remove what is not on screen.
    if (this.drop !== null) this.drop.hidden = refining
    if (this.track !== null) {
      this.track.setAttribute('aria-disabled', String(refining))
      this.track.tabIndex = refining ? -1 : 0
    }
    // While refining: what is drawn, which may be no rung at all. Off: the pick.
    const shown = this.shown
    let value: number | null = null
    let index = at
    if (refining && shown !== null && shown > 0) {
      value = shown
      index = rungs.findIndex((rung) => Math.abs(rung.binsize - shown) < 1e-6 * shown)
    }
    if (index >= 0) {
      this.box.value = String(index)
    } else if (value !== null) {
      this.between.textContent = resolutionLabel(value)
      this.box.value = 'shown'
    }
    const label = index >= 0 ? labelOf(rungs[index]) : value === null ? '' : resolutionLabel(value)
    if (this.track !== null && this.thumb !== null) {
      const left = index >= 0 ? this.place(index) : value === null ? null : this.placeOf(value)
      this.thumb.hidden = left === null
      if (left !== null) this.thumb.style.left = `${left}%`
      this.track.setAttribute('aria-valuenow', String(Math.max(0, index)))
      this.track.setAttribute('aria-valuetext', label)
      for (const [i, slot] of this.slots.entries()) slot.classList.toggle('is-current', i === index)
    }
  }

  /** The tick: refining, or the pick — which unticking takes from the screen. */
  private toggle(on: boolean): void {
    if (on) {
      setRefineEnabled(true)
      return
    }
    // **Unticking keeps what is on screen.** The rung nearest the resolution
    // drawn, on a log scale, becomes the pick, so the picture does not jump to
    // whichever rung was picked last. Picked first, so the first read the
    // preference asks for is already at it.
    const nearest = this.nearestShown()
    if (nearest >= 0 && nearest !== this.props.at) this.props.onPick(this.props.rungs[nearest])
    setRefineEnabled(false)
  }

  /** The stored rung nearest the resolution on screen, on a log scale; -1 for none. */
  private nearestShown(): number {
    const shown = this.shown
    if (shown === null || !(shown > 0)) return -1
    const { rungs } = this.props
    let nearest = -1
    for (const [i, rung] of rungs.entries()) {
      if (rung.derived !== undefined) continue
      const off = Math.abs(Math.log(rung.binsize / shown))
      if (nearest < 0 || off < Math.abs(Math.log(rungs[nearest].binsize / shown))) nearest = i
    }
    return nearest
  }

  private pickAt(index: number): void {
    const rung = this.props.rungs[index]
    if (rung === undefined || index === this.props.at) return
    this.props.onPick(rung)
  }

  /** The slot nearest a pointer's x along the track. */
  private slotAt(clientX: number): number {
    const track = this.track
    if (track === null) return this.props.at
    const box = track.getBoundingClientRect()
    const pct = box.width > 0 ? ((clientX - box.left) / box.width) * 100 : 0
    let best = 0
    for (let i = 1; i < this.props.rungs.length; i++) {
      if (Math.abs(this.place(i) - pct) < Math.abs(this.place(best) - pct)) best = i
    }
    return best
  }

  /**
   * A drag along the track: the thumb follows from slot to slot and names each,
   * and the rung under it when the button comes up is picked — one pick, not
   * one per slot passed, each of which would be a read.
   */
  private dragFrom(event: PointerEvent): void {
    const track = this.track
    if (track === null || this.refining() || event.button !== 0) return
    if ((event.target as Element | null)?.classList.contains('res-slot')) return
    event.preventDefault()
    track.focus()
    track.setPointerCapture?.(event.pointerId)
    const follow = (clientX: number): void => {
      const index = this.slotAt(clientX)
      this.dragging = index
      if (this.thumb !== null) this.thumb.style.left = `${this.place(index)}%`
      const slot = this.slots[index]
      if (slot !== undefined) this.showTip(slot, labelOf(this.props.rungs[index]))
    }
    follow(event.clientX)
    const move = (next: PointerEvent): void => follow(next.clientX)
    const up = (): void => {
      track.removeEventListener('pointermove', move)
      track.removeEventListener('pointerup', up)
      track.removeEventListener('pointercancel', up)
      this.hideTip()
      const index = this.dragging
      this.dragging = null
      if (index !== null && index !== this.props.at) this.pickAt(index)
      else this.paint()
    }
    track.addEventListener('pointermove', move)
    track.addEventListener('pointerup', up)
    track.addEventListener('pointercancel', up)
  }

  /** The arrow keys walk the rungs: left and down coarser, right and up finer. */
  private key(event: KeyboardEvent): void {
    if (this.refining()) return
    const last = this.props.rungs.length - 1
    const at = Math.max(0, this.props.at)
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? Math.min(last, at + 1)
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home'
            ? last
            : event.key === 'End'
              ? 0
              : null
    if (next === null) return
    event.preventDefault()
    this.pickAt(next)
  }

  /**
   * A slot's label, under it. On the page rather than in the row, because the
   * crumb bar scrolls sideways and anything that leaves it is clipped.
   */
  private showTip(slot: HTMLElement, text: string): void {
    const tip = this.tip ?? el('div', { class: 'res-tip', attrs: { role: 'tooltip' } })
    this.tip = tip
    tip.textContent = text
    if (tip.parentElement === null) document.body.append(tip)
    const box = slot.getBoundingClientRect()
    tip.style.left = `${Math.round(box.left + box.width / 2)}px`
    tip.style.top = `${Math.round(box.bottom + 8)}px`
  }

  private hideTip(): void {
    this.tip?.remove()
    this.tip = null
  }
}

/** A rung's name: its resolution, with the `*` of one the reader added (§3.4). */
function labelOf(rung: RowRung | undefined): string {
  if (rung === undefined) return ''
  return resolutionLabel(rung.binsize) + (rung.derived === undefined ? '' : '*')
}
