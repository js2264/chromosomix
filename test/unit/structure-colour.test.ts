/**
 * The colouring of a model, and the rule that it means the same thing as the
 * lane beside the map (§25).
 *
 * A bead coloured by a field of the file goes through the same `featureInk`
 * resolver the lane of that row uses, so the two cannot disagree; that is the
 * invariant pinned here, alongside the arithmetic of the parser every colour
 * string in this app goes through.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import { defaultStructureStyle } from '@/annotations/types'
import { CATEGORY_PALETTE } from '@/render/meta'
import { featureColouring } from '@/render/featureInk'
import { hexOf, lightness, parseColour, rampCss, rangeOf, resolveColours, rgbOf, TRACK_TINT_RAMP } from '@/structure/colour'
import { buildStructure } from '@/structure/scene'

function rows(lines: string[]): string {
  return lines.map((line) => line.replace(/ +/g, '\t')).join('\n')
}

const MODEL = rows([
  'chrA 0 0 0 0 m',
  'chrA 0 0 1 0 p',
  'chrA 10000 1 0 0 m',
  'chrA 10000 1 1 0 p',
  'chrB 0 5 0 0 m',
  'chrB 0 5 1 0 p',
])

function scene() {
  const structure = buildStructure(parseG3d(MODEL))
  if (structure === null) throw new Error('no model')
  return structure
}

describe('parsing colours', () => {
  it('reads hex in its lengths, rgb() and hsl(), and greys the unknown', () => {
    expect(parseColour('#ff0000')).toEqual([1, 0, 0])
    expect(parseColour('#0f0')).toEqual([0, 1, 0])
    expect(parseColour('#0000ffcc')).toEqual([0, 0, 1])
    expect(parseColour('rgb(255, 128, 0)').map((v) => +v.toFixed(3))).toEqual([1, 0.502, 0])
    expect(parseColour('hsl(120 100% 50%)').map((v) => +v.toFixed(3))).toEqual([0, 1, 0])
    expect(parseColour('hsl(240, 100%, 50%)').map((v) => +v.toFixed(3))).toEqual([0, 0, 1])
    expect(parseColour('nonsense')).toEqual(parseColour('#9a9a9a'))
    expect(hexOf('#0072b2')).toBe(0x0072b2)
  })

  it('packs a list of strings into one rgb buffer', () => {
    const rgb = rgbOf(['#ff0000', '#00ff00'])
    expect([...rgb]).toEqual([1, 0, 0, 0, 1, 0])
  })

  it('moves a colour to another lightness and keeps its hue', () => {
    const dark = lightness('#0072b2', 0)
    const light = lightness('#0072b2', 1)
    expect(dark).not.toBe(light)
    // Both are still blue: red below green below blue.
    for (const colour of [dark, light]) {
      const [r, g, b] = parseColour(colour)
      expect(b).toBeGreaterThan(g)
      expect(g).toBeGreaterThan(r)
    }
    expect(parseColour(light)[2]).toBeGreaterThan(parseColour(dark)[2])
  })

  it('finds the finite extent of a value array', () => {
    expect(rangeOf(new Float32Array([Number.NaN, 2, -1, 5]))).toEqual({ min: -1, max: 5 })
    expect(rangeOf(new Float32Array([Number.NaN]))).toEqual({ min: 0, max: 1 })
  })
})

describe('resolving a colouring', () => {
  it('colours by sequence with one palette colour per contig', () => {
    const s = scene()
    const colours = resolveColours(s, defaultStructureStyle())
    expect(colours.css[0]).toBe(CATEGORY_PALETTE[0])
    expect(colours.css[4]).toBe(CATEGORY_PALETTE[1])
    expect(colours.key).toEqual({
      kind: 'levels',
      title: 'sequence',
      levels: [
        { label: 'chrA', colour: CATEGORY_PALETTE[0] },
        { label: 'chrB', colour: CATEGORY_PALETTE[1] },
      ],
    })
    expect(colours.rgb.length).toBe(18)
  })

  it('colours a phased file’s homologues at two lightnesses of one hue', () => {
    const s = scene()
    const colours = resolveColours(s, { ...defaultStructureStyle(), colourBy: 'haplotype' })
    expect(colours.css[0]).not.toBe(colours.css[1])
    expect(colours.css[0]).toBe(colours.css[2])
    expect(colours.key.kind).toBe('levels')
    if (colours.key.kind === 'levels') expect(colours.key.levels.map((l) => l.label)).toEqual(['maternal', 'paternal'])
  })

  it('colours by position along each chain, first bead to last', () => {
    const s = scene()
    const colours = resolveColours(s, { ...defaultStructureStyle(), colourBy: 'position' })
    // chrA maternal: beads 0 and 2 are the ends of a two-bead chain.
    expect(colours.css[0]).not.toBe(colours.css[2])
    // chrB's chains are one bead each, at the start of the ramp.
    expect(colours.css[4]).toBe(colours.css[0])
    expect(colours.key.kind).toBe('ramp')
  })

  it('colours by a field of the file exactly as the lane does', () => {
    const s = scene()
    const colours = resolveColours(s, { ...defaultStructureStyle(), colourBy: 'haplotype' })
    const lane = featureColouring(s.set, 'structure', 'haplotype', '#000000')
    // Not the same ink — the model's haplotype colouring is per contig — but
    // the resolver a field goes through is the lane's, which this pins on a
    // field the lane offers: `score`.
    expect(lane.colourOf).toBeDefined()
    const byScore = resolveColours(s, { ...defaultStructureStyle(), colourBy: 'score' })
    const laneScore = featureColouring(s.set, 'structure', 'score', '#000000')
    if (laneScore.colourOf === undefined) {
      // A file with no score column: both say the grey for every bead.
      expect(new Set(byScore.css).size).toBe(1)
    } else {
      for (let i = 0; i < s.set.length; i++) expect(byScore.css[i]).toBe(laneScore.colourOf(i))
    }
    expect(colours.css.length).toBe(s.set.length)
  })

  it('takes a value per bead from outside the row, on a ramp fitted to the values', () => {
    const s = scene()
    const values = new Float32Array([0, 1, 2, 3, Number.NaN, 5])
    const colours = resolveColours(
      s,
      { ...defaultStructureStyle(), colourBy: 'track:abc' },
      { label: 'ATAC', values },
    )
    expect(colours.key).toEqual({ kind: 'ramp', title: 'ATAC', colormap: 'viridis', min: 0, max: 5 })
    expect(colours.css[4]).toBe('#9a9a9a')
    expect(colours.css[0]).not.toBe(colours.css[5])
  })

  it('falls back to the sequence when a stored colouring names a row it cannot reach', () => {
    const s = scene()
    const colours = resolveColours(s, { ...defaultStructureStyle(), colourBy: 'track:gone' })
    expect(colours.key.title).toBe('sequence')
  })
})

describe('the colour scale', () => {
  const base = { ...defaultStructureStyle(), colourBy: 'position' }

  it('draws a ramp colouring on the reader’s scale, and says so in the key', () => {
    const s = scene()
    const own = resolveColours(s, base)
    const chosen = resolveColours(s, { ...base, colormap: 'magma' })
    expect(own.key).toMatchObject({ kind: 'ramp', colormap: 'viridis' })
    expect(chosen.key).toMatchObject({ kind: 'ramp', colormap: 'magma' })
    // …and the beads move with the key, which is the point: a legend that
    // named one ramp while the model was drawn on another would be a lie.
    expect(chosen.css).not.toEqual(own.css)
  })

  it('overrides a source’s own scale only where one was chosen', () => {
    const s = scene()
    const values = new Float32Array(s.set.length).fill(0).map((_, i) => i)
    const source = { label: 'a track', values, colormap: 'cividis' }
    const lane = resolveColours(s, { ...base, colourBy: 'track:x' }, source)
    // Left at its own, a track keeps the lane's colormap so the bead and the
    // lane cannot disagree at the same value (§25.5).
    expect(lane.key).toMatchObject({ colormap: 'cividis' })
    const chosen = resolveColours(s, { ...base, colourBy: 'track:x', colormap: 'magma' }, source)
    expect(chosen.key).toMatchObject({ colormap: 'magma' })
  })

  it('leaves a levels colouring alone, which has no ramp to change', () => {
    const s = scene()
    const plain = resolveColours(s, defaultStructureStyle())
    const asked = resolveColours(s, { ...defaultStructureStyle(), colormap: 'magma' })
    expect(asked.key.kind).toBe('levels')
    expect(asked.css).toEqual(plain.css)
  })
})

describe('white to the track’s colour (§25.5)', () => {
  it('runs from white at the bottom to the tint at the top', () => {
    expect(parseColour(rampCss(TRACK_TINT_RAMP, 0, '#d95f02'))).toEqual([1, 1, 1])
    expect(rampCss(TRACK_TINT_RAMP, 1, '#d95f02')).toBe('rgb(217, 95, 2)')
    expect(rampCss(TRACK_TINT_RAMP, 2, '#d95f02')).toBe('rgb(217, 95, 2)')
  })

  it('draws a track’s beads and its key on the lane’s colour', () => {
    const structure = scene()
    const n = structure.set.length
    const values = Float32Array.from({ length: n }, (_, i) => i)
    const style = { ...defaultStructureStyle(), colourBy: 'track:x', colormap: TRACK_TINT_RAMP }
    const colours = resolveColours(structure, style, {
      label: 'H3K27ac',
      values,
      range: { min: 0, max: n - 1 },
      tint: '#d95f02',
    })
    expect(colours.css[0]).toBe('rgb(255, 255, 255)')
    expect(colours.css[n - 1]).toBe('rgb(217, 95, 2)')
    expect(colours.key).toMatchObject({ kind: 'ramp', colormap: TRACK_TINT_RAMP, tint: '#d95f02', min: 0, max: n - 1 })
  })

  it('leaves a colouring with no colour of its own on its own ramp', () => {
    const structure = scene()
    const style = { ...defaultStructureStyle(), colourBy: 'distance', colormap: TRACK_TINT_RAMP }
    const colours = resolveColours(structure, style, {
      label: 'distance',
      values: new Float32Array(structure.set.length).fill(1),
      colormap: 'magma',
    })
    expect(colours.key).toMatchObject({ kind: 'ramp', colormap: 'magma' })
  })
})
