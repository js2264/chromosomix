/**
 * The icon set: inline SVG, built in code, no glyphs and no font.
 *
 * Three reasons it is drawn rather than typed. A character like `⇤` or `ⓘ` is
 * rendered by whatever font the OS picks, so it is a different shape, weight
 * and baseline on every machine — and on some it is a box. An icon font is a
 * network request the CSP on a published artifact would block. And a glyph
 * cannot be given a stroke width that matches the rest of the interface.
 *
 * These are stroked 24×24 outlines on a 2px grid, in the Lucide idiom: one
 * weight, round caps and joins, `currentColor` so they take the colour of the
 * button they sit in. The GitHub mark is the exception — it is a filled
 * trademark and has to be its own shape (octicons, MIT).
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

type Shape = [tag: string, attrs: Record<string, string>]

interface IconSpec {
  shapes: Shape[]
  /** Filled rather than stroked, for the one mark that is a logo. */
  filled?: boolean
  viewBox?: string
}

const line = (x1: number, y1: number, x2: number, y2: number): Shape => [
  'line',
  { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2) },
]

const ICONS = {
  'chevron-down': { shapes: [['polyline', { points: '6 9 12 15 18 9' }]] },
  'chevron-up': { shapes: [['polyline', { points: '18 15 12 9 6 15' }]] },
  'chevron-left': { shapes: [['polyline', { points: '15 18 9 12 15 6' }]] },
  'chevron-right': { shapes: [['polyline', { points: '9 18 15 12 9 6' }]] },
  x: { shapes: [line(18, 6, 6, 18), line(6, 6, 18, 18)] },
  check: { shapes: [['polyline', { points: '20 6 9 17 4 12' }]] },
  info: {
    shapes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      line(12, 16, 12, 11),
      line(12, 8, 12.01, 8),
    ],
  },
  keyboard: {
    shapes: [
      ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2' }],
      line(6, 9, 6.01, 9),
      line(10, 9, 10.01, 9),
      line(14, 9, 14.01, 9),
      line(18, 9, 18.01, 9),
      line(6, 13, 6.01, 13),
      line(18, 13, 18.01, 13),
      line(9, 16, 15, 16),
    ],
  },
  'file-plus': {
    shapes: [
      ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }],
      ['polyline', { points: '14 3 14 8 19 8' }],
      line(12, 12, 12, 18),
      line(9, 15, 15, 15),
    ],
  },
  sun: {
    shapes: [
      ['circle', { cx: '12', cy: '12', r: '4' }],
      line(12, 2, 12, 4),
      line(12, 20, 12, 22),
      line(4.9, 4.9, 6.3, 6.3),
      line(17.7, 17.7, 19.1, 19.1),
      line(2, 12, 4, 12),
      line(20, 12, 22, 12),
      line(4.9, 19.1, 6.3, 17.7),
      line(17.7, 6.3, 19.1, 4.9),
    ],
  },
  moon: { shapes: [['path', { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' }]] },
  monitor: {
    shapes: [
      ['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }],
      line(8, 21, 16, 21),
      line(12, 17, 12, 21),
    ],
  },
  'panel-left-close': {
    shapes: [
      ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
      line(9, 3, 9, 21),
      ['polyline', { points: '16 9 13 12 16 15' }],
    ],
  },
  'panel-left-open': {
    shapes: [
      ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
      line(9, 3, 9, 21),
      ['polyline', { points: '13 9 16 12 13 15' }],
    ],
  },
  github: {
    filled: true,
    viewBox: '0 0 16 16',
    shapes: [
      [
        'path',
        {
          d:
            'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 ' +
            '0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 ' +
            '1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 ' +
            '0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 ' +
            '1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 ' +
            '3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z',
        },
      ],
    ],
  },
} satisfies Record<string, IconSpec>

export type IconName = keyof typeof ICONS

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
  svg.setAttribute('viewBox', spec.viewBox ?? '0 0 24 24')
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
    svg.setAttribute('stroke-width', '1.75')
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
