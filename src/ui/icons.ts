/**
 * The icon set: inline SVG, built in code, no glyphs and no font.
 *
 * Three reasons it is drawn rather than typed. A character like `⇤` or `ⓘ` is
 * rendered by whatever font the OS picks, so it is a different shape, weight
 * and baseline on every machine — and on some it is a box. An icon font is a
 * network request the CSP on a published artifact would block. And a glyph
 * cannot be given a stroke width that matches the rest of the interface.
 *
 * The shapes come from the upstream packages through `npm run icons`, so they
 * are Lucide's and Simple Icons' own geometry rather than an imitation of it:
 * one weight, round caps and joins, `currentColor`. The brand marks are filled
 * instead of stroked, because that is what a logo is.
 */

import { GENERATED_ICONS } from './icons.generated'

const SVG_NS = 'http://www.w3.org/2000/svg'

interface IconSpec {
  shapes: Array<[tag: string, attrs: Record<string, string>]>
  /** Filled rather than stroked, for the marks that are logos. */
  filled?: boolean
}

/**
 * The set, copied verbatim from upstream by `npm run icons`.
 *
 * Nothing is drawn here by hand any more. A sketched brand mark is wrong in a
 * way anyone can see, and a sketched interface icon drifts from the set it is
 * imitating — different corner radii, different optical weight, a chevron at a
 * slightly different angle. Lucide (ISC) supplies the interface icons and
 * Simple Icons (CC0) the GitHub mark; both are devDependencies of the
 * generator, not of the app.
 */
const ICONS: Record<string, IconSpec> = GENERATED_ICONS

export type IconName = keyof typeof GENERATED_ICONS

/**
 * Build one icon.
 *
 * `aria-hidden` because every caller is a control that already carries its own
 * label — an icon announced twice is worse than one not announced at all.
 */
export function icon(name: IconName, options: { size?: number; class?: string } = {}): SVGElement {
  const spec: IconSpec = ICONS[name]
  const size = options.size ?? 16
  const svg = document.createElementNS(SVG_NS, 'svg')
  // Both sources draw on a 24-unit grid, which is why one viewBox serves all.
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', options.class === undefined ? 'icon' : `icon ${options.class}`)
  if (spec.filled === true) {
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('stroke', 'none')
  } else {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  }
  for (const [tag, attrs] of spec.shapes) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    svg.appendChild(node)
  }
  return svg
}

/**
 * A card's heading: one mark, then the word.
 *
 * Every card in the three panels carries one, and that is the point of it — a
 * column of five headings set in the same small uppercase grey is read
 * top-to-bottom every time you look for one of them, while five distinct marks
 * are recognised at a glance and then used as the index. It is the same reason
 * the tab strip has a favicon on it.
 *
 * 13 px, against a 12 px cap height: the mark is a label for the word, not a
 * second thing beside it, and anything larger starts competing.
 *
 * **The heading is also the card's fold**, and that is why this is the only
 * place it had to be written. The Genome minimap had the behaviour first, as a
 * `<details>` with its heading for a summary, and its own note said there was no
 * per-card collapse idiom in this codebase to follow. There is now, and it is
 * this: every card in every panel gets a chevron on the right-hand end of its
 * heading, and a press anywhere along that line folds the card away to the line
 * itself. Generalising it here rather than card by card is what keeps twenty
 * cards from each growing their own wrapper, their own marker and their own
 * opinion about where the control sits — the gesture is one gesture because it
 * is one implementation.
 *
 * A heading that is not a card's — the empty-metadata box uses one — keeps the
 * type and loses the control; see {@link foldCard}.
 *
 * @param extra Classes the heading needs *as well* — `controls-title` for the
 * cards in the Aesthetics column, which are folded into the panel header in the
 * inline layout and hide their titles there. That layout takes the heading away
 * altogether, so a card sitting in a panel header does not fold: the stylesheet
 * leaves it alone rather than letting a fold made in the column hide controls
 * with nothing left on screen to bring them back.
 */
export function cardTitle(text: string, name: IconName, extra?: string): HTMLElement {
  const node = document.createElement('h3')
  node.className = extra === undefined ? 'card-head' : `card-head ${extra}`
  node.appendChild(icon(name, { size: 13 }))
  const label = document.createElement('span')
  label.textContent = text
  node.appendChild(label)
  node.appendChild(foldChevron(text))
  // On the heading and not on the chevron, which is what makes the whole strip
  // the control: a press on the button bubbles to here, so one listener serves
  // the pointer, the Enter key and the space bar without the two of them ever
  // being able to disagree about which way the card is going.
  node.addEventListener('click', () => foldCard(node))
  return node
}

/**
 * The mark on the right-hand end of a card's heading, and the state it carries.
 *
 * One chevron that **turns** rather than two that are swapped. A swap is two
 * shapes to keep in step and a hard cut between them; a rotation is one node,
 * one transition, and a direction of travel the eye follows into the fold —
 * which is the whole of why the card reads as opening rather than as being
 * replaced. `chevron-down` is the open state, so the resting card points at what
 * is under it and a folded one points along the row it has become.
 *
 * A real `<button>`, though the heading beside it is what is usually pressed:
 * the fold has to be reachable by keyboard and has to say which way it will go,
 * and `aria-expanded` on a focusable control is how that is said. It carries no
 * listener of its own — {@link cardTitle} explains why.
 */
function foldChevron(text: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'card-fold'
  node.setAttribute('aria-expanded', 'true')
  // The card's own name in the label, because a column of five of these read
  // aloud as "collapse" five times over says nothing about which one is which.
  node.setAttribute('aria-label', `Collapse ${text}`)
  node.title = 'Collapse'
  node.appendChild(icon('chevron-down', { size: 14 }))
  return node
}

/**
 * Fold or unfold the card a heading belongs to.
 *
 * The class goes on the **card**, not on the heading, because what folds is
 * everything the card holds *except* the heading — a rule the stylesheet can
 * state once for every card in the application rather than each card hiding its
 * own parts. Which is also why this walks up exactly one level and checks what
 * it found: a heading used somewhere that is not a card — the empty-metadata
 * box is the one — has nothing to fold, and quietly doing nothing is better than
 * hiding half of a box that was never built to lose it.
 *
 * The choice is **not remembered**, following the Genome minimap this was
 * generalised from: the house mechanisms for a per-reader preference are modules
 * over `localStorage` (`ui/textScale.ts`, `ui/mapSize.ts`), and a new storage
 * scheme for a disclosure triangle would be a scheme to migrate, key and forget
 * about. A card that survives a repaint keeps its fold because the element does.
 */
function foldCard(head: HTMLElement): void {
  const card = head.parentElement
  if (card === null) return
  if (!card.classList.contains('card') && !card.classList.contains('controls-card')) return
  const folded = card.classList.toggle('is-folded')
  const chevron = head.querySelector('.card-fold')
  if (chevron === null) return
  chevron.setAttribute('aria-expanded', String(!folded))
  const label = chevron.getAttribute('aria-label') ?? ''
  const name = label.replace(/^(Collapse|Expand) /, '')
  chevron.setAttribute('aria-label', `${folded ? 'Expand' : 'Collapse'} ${name}`)
  if (chevron instanceof HTMLElement) chevron.title = folded ? 'Expand' : 'Collapse'
}

/** A button whose whole content is one icon. The title is the accessible name. */
export function iconButton(
  name: IconName,
  title: string,
  onClick: () => void,
  options: { class?: string; size?: number } = {},
): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = options.class ?? 'btn btn-icon'
  node.title = title
  node.setAttribute('aria-label', title)
  node.appendChild(icon(name, options.size === undefined ? {} : { size: options.size }))
  node.addEventListener('click', onClick)
  return node
}
