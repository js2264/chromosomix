/**
 * A dialog that is a picture with its settings beside it.
 *
 * The 3D viewer invented this shape and it turned out not to be about 3D at
 * all: a figure large enough to read, a column of every control it has, a grip
 * to decide how the width is split, and a way to put the column away when the
 * picture is what matters. Anything with more settings than fit under it wants
 * the same dialog, so the shell lives here and the 3D model and the analysis
 * figures are two callers of it rather than two implementations of it.
 *
 * What the caller supplies is two elements. Neither is built here and neither
 * is copied: the model's dialog *moves* the cell's canvas and its Aesthetics
 * card in and moves them back, so the camera the reader left it at and the
 * colours they chose are what the cell shows afterwards. A shell that took a
 * description and built its own would have made that impossible.
 *
 * The remembered width is per file and per scope, beside everything else a
 * reader sets once for their screen (`state/UiMemory.ts`).
 */

import { el } from './dom'
import { icon, iconButton } from './icons'
import { Modal, type ModalProps } from './Modal'
import { recall, remember } from '../state/UiMemory'

/** Narrower than this the controls wrap; wider and the picture is the loser. */
export const STAGE_SIDE_MIN = 240
export const STAGE_SIDE_MAX = 760

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

export interface StageDialogProps {
  title: string
  /** The big area: a canvas, a chart, a table. */
  stage: HTMLElement
  /** The column of controls. */
  side: HTMLElement
  /** An extra class on the panel, for the dialog's own size. */
  variant?: string
  /** Extra classes on the stage and the sidebar, for a caller's own rules. */
  stageClass?: string
  sideClass?: string
  /**
   * Controls in the dialog's head, beside its title (`ModalProps.head`). With
   * an `end`, the side's toggle is docked at its end, last before the ✕,
   * rather than floated over the side's foot, where it sat on whatever card
   * was scrolled under it.
   */
  head?: ModalProps['head']
  /** What the side is called on its toggle and its grip: `settings` unless said. */
  sideName?: string
  /**
   * The narrowest the stage may be beside the side, in pixels, asked on every
   * resize. Narrower, the side folds by itself, and its toggle opens it over
   * the stage — a drawer — rather than beside it; wide enough again, it comes
   * back beside the stage, unless the reader folded it. Without it the side
   * stays where the reader put it, whatever the width.
   */
  stageMin?: () => number
  /** Where the sidebar's width is remembered: the file's key and a scope. */
  memoryKey: () => string
  scope: string
  /** The stage's box changed — drag, toggle, keyboard nudge. */
  onResize?: () => void
  /** What Escape does instead of closing — see `ModalProps.onEscape`. */
  onEscape?: () => void
  onClose?: () => void
}

/** The dialog, and what its caller asks of its side. */
export interface StageModal extends Modal {
  /**
   * Fold the side where it no longer fits beside the stage, or put it back
   * where it fits again — for a change the shell cannot see, such as a column
   * of the stage dragged wider. Nothing without `stageMin`.
   */
  fitSide(): void
  /** Fold the side where it is open over the stage, as a drawer: `true` where it was — Escape's, in the caller's order. */
  foldDrawer(): boolean
}

/** Open the dialog. The caller keeps the {@link StageModal} so it can close it. */
export function stageDialog(props: StageDialogProps): StageModal {
  const resize = (): void => props.onResize?.()
  const name = props.sideName ?? 'settings'
  let fitSide = (): void => undefined
  let foldDrawer = (): boolean => false
  let stopWatching = (): void => undefined

  const modal = new Modal({
    title: props.title,
    // Always a name: a figure's own title or the structure row's label.
    titleIsName: true,
    ...(props.head === undefined ? {} : { head: props.head }),
    variant: `modal-stage${props.variant === undefined ? '' : ` ${props.variant}`}`,
    body: () => {
      const stage = el(
        'div',
        { class: `stage-body${props.stageClass === undefined ? '' : ` ${props.stageClass}`}` },
        props.stage,
      )
      const side = el(
        'aside',
        { class: `stage-side${props.sideClass === undefined ? '' : ` ${props.sideClass}`}` },
        props.side,
      )

      // The width the reader last dragged it to: a column of controls is a
      // thing somebody sets once for their screen, not once per dialog.
      const stored = recall<unknown>(props.memoryKey(), props.scope)
      if (typeof stored === 'number' && Number.isFinite(stored)) {
        side.style.flexBasis = `${Math.round(clamp(stored, STAGE_SIDE_MIN, STAGE_SIDE_MAX))}px`
      }

      // The same gesture the panel columns have, for the same reason: how a
      // picture and two dozen fields share a width is not a split anybody else
      // can choose for the reader.
      const grip = el('div', {
        class: 'stage-side-grip',
        attrs: {
          role: 'separator',
          'aria-orientation': 'vertical',
          tabindex: '0',
          ...(props.sideName === undefined ? {} : { 'aria-label': `Resize the ${name}` }),
        },
        title: `Drag to make the ${name} wider or narrower`,
      })
      const widthAt = (clientX: number, modal: HTMLElement): number =>
        clamp(
          modal.getBoundingClientRect().right - clientX,
          STAGE_SIDE_MIN,
          Math.min(STAGE_SIDE_MAX, modal.clientWidth * 0.8),
        )
      grip.addEventListener('pointerdown', (event) => {
        const modal = grip.parentElement
        if (modal === null) return
        grip.setPointerCapture(event.pointerId)
        grip.classList.add('is-dragging')
        event.preventDefault()
        const move = (moved: PointerEvent): void => {
          side.style.flexBasis = `${Math.round(widthAt(moved.clientX, modal))}px`
          resize()
        }
        const up = (ended: PointerEvent): void => {
          grip.removeEventListener('pointermove', move)
          grip.removeEventListener('pointerup', up)
          grip.classList.remove('is-dragging')
          if (grip.hasPointerCapture(ended.pointerId)) grip.releasePointerCapture(ended.pointerId)
          remember(props.memoryKey(), props.scope, widthAt(ended.clientX, modal))
        }
        grip.addEventListener('pointermove', move)
        grip.addEventListener('pointerup', up)
      })
      // …and by the keyboard, for a reader who does not drag.
      grip.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0
        if (step === 0) return
        event.preventDefault()
        const next = clamp(
          side.getBoundingClientRect().width + step,
          STAGE_SIDE_MIN,
          STAGE_SIDE_MAX,
        )
        side.style.flexBasis = `${Math.round(next)}px`
        remember(props.memoryKey(), props.scope, next)
        resize()
      })

      // The sidebar out of the way for a look at the picture, and back. Who
      // folded it decides whether a wider window brings it back: the width
      // does, the reader's choice it does not.
      let foldedBy: 'reader' | 'width' | null = null
      // Whether the side fits beside the stage; a side opened where it does
      // not is a drawer over the stage, which squeezes nothing.
      let fits = true
      // The side's own width, folded or not: what it takes beside the stage,
      // and what it keeps as a drawer, out of the row its basis sizes it in.
      const basis = (): number => parseFloat(getComputedStyle(side).flexBasis) || side.getBoundingClientRect().width
      const show = (shown: boolean, by: 'reader' | 'width'): void => {
        const drawer = shown && !fits
        side.style.width = drawer ? `${Math.round(basis())}px` : ''
        side.classList.toggle('hidden', !shown)
        side.classList.toggle('is-drawer', drawer)
        grip.classList.toggle('hidden', drawer)
        foldedBy = shown ? null : by
        toggle.replaceChildren(icon(shown ? 'panel-right-close' : 'panel-right-open', { size: 14 }))
        toggle.title = `${shown ? 'Hide' : 'Show'} the ${name}`
        toggle.setAttribute('aria-label', toggle.title)
        toggle.setAttribute('aria-expanded', String(shown))
        requestAnimationFrame(resize)
      }
      const toggle = iconButton(
        'panel-right-close',
        `Hide the ${name}`,
        () => show(side.classList.contains('hidden'), 'reader'),
        { class: 'btn btn-icon stage-side-toggle', size: 14 },
      )
      toggle.setAttribute('aria-expanded', 'true')
      const end = props.head?.end
      if (end !== undefined) end.appendChild(toggle)

      foldDrawer = () => {
        if (!side.classList.contains('is-drawer') || side.classList.contains('hidden')) return false
        show(false, 'width')
        return true
      }
      const shell = el('div', { class: 'stage-modal' }, stage, grip, side, ...(end === undefined ? [toggle] : []))
      const stageMin = props.stageMin
      if (stageMin !== undefined) {
        fitSide = () => {
          if (shell.clientWidth === 0) return
          const now = shell.clientWidth - basis() >= stageMin()
          if (now === fits) return
          fits = now
          const open = !side.classList.contains('hidden')
          if (!fits && open) show(false, 'width')
          else if (fits && foldedBy === 'width') show(true, 'width')
          // A drawer the reader opened goes back beside the stage.
          else if (fits && open) show(true, 'reader')
        }
        if (typeof ResizeObserver !== 'undefined') {
          // Its first answer comes once the shell is laid out in the page.
          const observer = new ResizeObserver(() => fitSide())
          observer.observe(shell)
          stopWatching = () => observer.disconnect()
        }
      }
      return shell
    },
    ...(props.onEscape === undefined ? {} : { onEscape: props.onEscape }),
    onClose: () => {
      stopWatching()
      props.onClose?.()
    },
  })
  return Object.assign(modal, { fitSide: () => fitSide(), foldDrawer: () => foldDrawer() })
}
