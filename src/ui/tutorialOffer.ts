/**
 * The guided tutorial's offer (§30): the buttons *About* and the landing page
 * both draw, so the two say the same thing about the same place kept.
 *
 * One invited answer at a time, filled: *play* for a reader who has not begun,
 * *resume* for one who has, *play again* for one who finished. Starting over
 * is offered beside a resume, quietly, rather than as a second filled button,
 * since a reader who left half way is far more often coming back than starting
 * again.
 */

import type { TourProgress } from '../state/tour'
import { el } from './dom'
import { icon } from './icons'

/** Where the tutorial is played from. */
export type TutorialStart = 'start' | 'resume'

/** What the filled button says, from what was kept. */
export function tutorialLabel(progress: TourProgress | null): string {
  if (progress !== null && !progress.finished) return `resume at step ${progress.index + 1} of ${progress.total}`
  return progress?.finished === true ? 'play the tutorial again' : 'play the tutorial'
}

/** The filled button, and *start over* beside it while there is a place to resume from. */
export function tutorialButtons(
  progress: TourProgress | null,
  play: (from: TutorialStart) => void,
  options: { class?: string } = {},
): HTMLElement[] {
  const resumable = progress !== null && !progress.finished
  const invited = el(
    'button',
    { class: `btn btn-primary${options.class === undefined ? '' : ` ${options.class}`}`, type: 'button' },
    icon('play', { size: 12 }),
    el('span', { text: tutorialLabel(progress) }),
  )
  invited.addEventListener('click', () => play(resumable ? 'resume' : 'start'))
  if (!resumable) return [invited]
  const over = el('button', {
    class: 'btn btn-quiet',
    type: 'button',
    text: 'start over',
    title: 'Begin again at the first step, in a tab of its own',
  })
  over.addEventListener('click', () => play('start'))
  return [invited, over]
}
