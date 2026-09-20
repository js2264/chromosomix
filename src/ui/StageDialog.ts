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
import { Modal } from './Modal'
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
  /** Where the sidebar's width is remembered: the file's key and a scope. */
  memoryKey: () => string
  scope: string
  /** The stage's box changed — drag, toggle, keyboard nudge. */
  onResize?: () => void
  onClose?: () => void
}

/** Open the dialog. The caller keeps the {@link Modal} so it can close it. */
export function stageDialog(props: StageDialogProps): Modal {
  const resize = (): void => props.onResize?.()

  return new Modal({
    title: props.title,
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
        attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: '0' },
        title: 'Drag to make the settings wider or narrower',
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

      // The sidebar out of the way for a look at the picture, and back.
      const toggle = iconButton(
        'panel-right-close',
        'Hide the settings',
        () => {
          const hidden = side.classList.toggle('hidden')
          toggle.replaceChildren(icon(hidden ? 'panel-right-open' : 'panel-right-close', { size: 14 }))
          toggle.title = hidden ? 'Show the settings' : 'Hide the settings'
          toggle.setAttribute('aria-label', toggle.title)
          requestAnimationFrame(resize)
        },
        { class: 'btn btn-icon stage-side-toggle', size: 14 },
      )

      return el('div', { class: 'stage-modal' }, stage, grip, side, toggle)
    },
    onClose: props.onClose,
  })
}
