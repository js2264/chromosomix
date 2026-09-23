/**
 * Generate `src/ui/icons.generated.ts` from the upstream icon packages.
 *
 * The icons are *copied from the official sources*, not redrawn: Lucide for the
 * interface set (ISC) and Simple Icons for the GitHub mark (CC0). A hand-drawn
 * approximation of a brand mark is wrong in a way a user can see, and a
 * hand-drawn interface icon drifts from the set it is trying to match.
 *
 * The generated file is committed, so the app builds with no icon dependency at
 * runtime and the two packages stay devDependencies. Re-run with `npm run icons`
 * after changing NEEDED or bumping either package.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Interface icons, by their Lucide name. */
const LUCIDE = [
  'chevron-down',
  'chevron-up',
  'chevron-left',
  'chevron-right',
  'x',
  'check',
  'info',
  'keyboard',
  'sun',
  'moon',
  'monitor',
  'panel-left-close',
  'panel-left-open',
  'panel-right-close',
  'panel-right-open',
  'layers',
  'grip-vertical',
  'plus',
  // The Files panel. `folder-tree` is what the panel *holds* — a directory read
  // one level at a time — on the same rule its four siblings follow: `layers`
  // for the annotation stack, `beaker` for what can be computed. `plug` is the
  // Connect dialog's own mark, on its tiles and in the palette: what it does is
  // attach a place rather than bring in a file.
  'folder-tree',
  'plug',
  // Which kind of place a connected folder is, on its own row: a disk on this
  // machine, or a bucket somewhere else. The one fact about a folder that
  // changes what its rows cost to open, so it is a mark rather than a word.
  'hard-drive',
  'cloud',
  'search',
  'zoom-in',
  'zoom-out',
  'maximize',
  // Enlarging a cell into a dialog, which is not the same act as re-framing
  // what is in it: the structure cell had `maximize` on the one and `scan` on
  // the other, two corner-bracket glyphs side by side. `maximize` is the refit
  // mark the Map card already uses, so `expand`'s diagonal arrows take the
  // dialog.
  'expand',
  'crosshair',
  'git-compare',
  'dna',
  'trash-2',
  'unfold-horizontal',
  'unfold-vertical',
  'type',
  'chart-area',
  'chart-spline',
  // The Structures card (§25): a model is a thing with a volume.
  'box',
  // The structure cell's mode badge and its corner (§25.3): orbit, pan, the
  // centre of rotation, select-to-mark, and the dialog's sidebar.
  'rotate-3d',
  'move',
  'locate-fixed',
  'mouse-pointer-click',
  'map-pin',
  // The cell's menu as toggles: beads, sticks, a tube; the chords; the fog;
  // the names.
  'circle-dot',
  'minus',
  'spline',
  'link-2',
  'cloud-fog',
  'waypoints',
  'list',
  'align-end-horizontal',
  'chevrons-up-down',
  'flip-vertical',
  // The two mirrors on the structure cell's frame row (§25.5): a model from
  // contacts is fixed only up to reflection, so this is how it is turned over.
  'flip-horizontal',
  // The turn, as two shapes for one button: a map on its diagonal is a triangle
  // standing on a genomic axis and a map that is not is a square, and the toggle
  // shows **the shape it will give you** rather than the shape you have — a
  // triangle while the map is square, a square once it is turned. See
  // `ui/MatrixPanel.ts`.
  'triangle',
  'square',
  'eye',
  'eye-off',
  'align-right',
  'grid-2x2',
  'separator-vertical',
  'tag',
  'ruler',
  'rows-3',
  'link',
  'unlink',
  'stretch-vertical',
  'fold-vertical',
  'a-large-small',
  'chart-line',
  'download',
  'clipboard-copy',
  'message-square-text',
  'star',
  'save',
  // The card headings. One mark per card in the three panels, so a column of
  // five is scanned by shape before it is read: see `ui/icons.ts` -> cardTitle.
  'file',
  // The General panel's own mark: what is in that column is the file and the
  // settings read off it, which is a document with a cog on it rather than the
  // fold arrow it used to carry — an arrow said only *this panel folds*, which
  // is true of all four of them.
  'file-cog',
  'palette',
  'sliders-horizontal',
  'pencil',
  'scan',
  'columns-2',
  'beaker',
  'play',
  'circle-stop',
  'rotate-cw',
  'table',
  // Bookmarks (§8.7): the card's own mark, the *take one* button that sits beside
  // `go` on the title line, and the arrow a saved row is opened by. The arrow is
  // the row's whole affordance — a list of coordinates says nothing about what
  // clicking one does, and `chevron-right` is already the app's "there is more
  // under this" rather than its "take me there".
  'bookmark',
  'bookmark-plus',
  'arrow-right',
  // A link that leaves the app, on the stores drawer's head beside the
  // download (§24.2). The arrow leaving its own corner is the web's settled
  // sign for *this opens elsewhere*, and it is the distinction that matters
  // here: the button beside it hands you a file, this one hands you to
  // somebody else's site, in a tab of its own.
  'arrow-up-right',
  // The console (§23), on the header and on its own heading. A prompt with a
  // caret and a line beside it, because what that panel holds is the commands
  // that would repeat the day — the same thing `metacooler-run` is typed into,
  // which is the association the mark has to make in one glance at 15 px.
  'terminal',
  // The stores (§24): the header's toggle for the drawer, and the matrix mode
  // inside it. A row of books for a shelf of somebody else's data, and a grid
  // for a count at every crossing of two facets.
  'library',
  'grid-3x3',
]

/**
 * Brand marks, by their Simple Icons slug. Filled, not stroked.
 *
 * GitHub for the header's source link; Google Drive and Dropbox for the two
 * providers a place can be connected through (§24.9), on their tiles in the
 * Connect dialog and beside their folders in the Files column.
 */
const BRANDS = ['github', 'googledrive', 'dropbox']

/**
 * The one shape upstream does not have.
 *
 * `icons.ts` says nothing is drawn by hand any more, and the reason it gives is
 * drift: a sketched icon ends up with different corner radii, a different
 * optical weight, a chevron at a slightly different angle from the set it is
 * imitating. None of that can happen to three straight horizontal rules. They
 * sit on Lucide's own 24-unit grid at its own baselines (`y = 6, 12, 18`, the
 * rows `align-left` uses), start at its own left margin, and inherit the same
 * stroke width and round caps from the renderer — so this is Lucide's geometry
 * with three lengths chosen, not an imitation of its style.
 *
 * It is here rather than in `icons.ts` so that the generated file stays the
 * single place icons come from, and so the exception is visible next to the
 * rule it is an exception to.
 *
 * The nearest upstream shape is `chart-bar-decreasing`, and it was tried first:
 * it is these three bars plus an L-shaped axis, and at the 15 px these buttons
 * are drawn at the axis closes the left side and the whole mark reads as a
 * letter E.
 */
const HAND = {
  /** A resolution ladder: coarse at the top, fine at the bottom, one origin. */
  'bars-decreasing': [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M3 12h11' }],
    ['path', { d: 'M3 18h5' }],
  ],
  /**
   * Open in a new session: a window with a `+` where its top-right corner was.
   *
   * The second exception, and made of the same material as the first. The
   * frame is Lucide's own — the open-cornered square of
   * `square-arrow-out-up-right`, copied to the unit — and the `+` in the
   * corner is `plus` at half its size on the same grid, so the two marks a
   * row carries (`plus` beside this) are one glyph and a frame around it. The
   * set has the frame with an *arrow* leaving it, which is *open elsewhere*;
   * what a store row and a folder row offer is *open as a new thing*, and an
   * arrow says the wrong half of that.
   */
  'new-session': [
    ['path', { d: 'M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6' }],
    ['path', { d: 'M18 2v8' }],
    ['path', { d: 'M14 6h8' }],
  ],
  /**
   * The matrix's own diagonal: one stroke, corner to corner.
   *
   * The third exception, and the least of the three — it is Lucide's `slash` on
   * the other diagonal, which is the one that matters here: a matrix is drawn
   * with row zero at the top, so its main diagonal runs from the top-left
   * corner down, and `slash` runs the other way. Same grid, same inset from the
   * corners as `slash` keeps from the edges, same stroke and caps from the
   * renderer.
   *
   * It replaces `move-diagonal-2`, which is this line with an arrowhead on each
   * end. The arrowheads say *drag along here*, and the button does not drag
   * anything: it puts the view back on the line. At 15 px the two heads were
   * also most of the ink, so what the mark chiefly showed was arrows.
   */
  diagonal: [['path', { d: 'm5 5 14 14' }]],
}

/** Pull the drawable children out of an SVG, in document order. */
function shapesOf(svg) {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[\s\S]*?<\/title>/g, '')
  const shapes = []
  const element = /<(path|circle|line|rect|polyline|polygon|ellipse)\b([^>]*?)\/?>/g
  let match
  while ((match = element.exec(body)) !== null) {
    const attrs = {}
    // `[\w-]` after the first character, not `[a-zA-Z-]`: `x1`, `y2` and
    // `stroke-width` are all legal attribute names and two of the three contain
    // a digit. Without it every `<line>` came through with no coordinates and
    // drew nothing, which is how a magnifier icon became a bare circle.
    const attribute = /([a-zA-Z][\w:-]*)="([^"]*)"/g
    let pair
    while ((pair = attribute.exec(match[2])) !== null) attrs[pair[1]] = pair[2]
    shapes.push([match[1], attrs])
  }
  if (shapes.length === 0) throw new Error(`no drawable shapes found in:\n${svg.slice(0, 200)}`)
  return shapes
}

function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

const entries = []
for (const name of LUCIDE) {
  entries.push([name, { shapes: shapesOf(read(`node_modules/lucide-static/icons/${name}.svg`)) }])
}
for (const [name, shapes] of Object.entries(HAND)) {
  entries.push([name, { shapes }])
}
for (const name of BRANDS) {
  entries.push([
    name,
    { shapes: shapesOf(read(`node_modules/simple-icons/icons/${name}.svg`)), filled: true },
  ])
}

const lucideVersion = JSON.parse(read('node_modules/lucide-static/package.json')).version
const simpleVersion = JSON.parse(read('node_modules/simple-icons/package.json')).version

const body = entries
  .map(([name, spec]) => {
    const shapes = spec.shapes
      .map(([tag, attrs]) => `    ['${tag}', ${JSON.stringify(attrs)}],`)
      .join('\n')
    return `  '${name}': {\n${spec.filled ? '    filled: true,\n' : ''}    shapes: [\n${shapes}\n    ],\n  },`
  })
  .join('\n')

writeFileSync(
  join(root, 'src/ui/icons.generated.ts'),
  `/**
 * Generated by \`npm run icons\` — do not edit.
 *
 * Interface icons from lucide-static ${lucideVersion} (ISC); brand marks from
 * simple-icons ${simpleVersion} (icons CC0). Copied verbatim from the upstream
 * SVGs, so the shapes are the published ones rather than an approximation.
 */

export interface GeneratedIcon {
  shapes: Array<[tag: string, attrs: Record<string, string>]>
  /** Filled rather than stroked — the brand marks. */
  filled?: boolean
}

export const GENERATED_ICONS = {
${body}
} satisfies Record<string, GeneratedIcon>
`,
  'utf8',
)

console.log(`wrote src/ui/icons.generated.ts (${entries.length} icons)`)
