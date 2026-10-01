/**
 * A feature set's names as categories (§8.16, §25.5): which name each bead is
 * under, which names earn a colour, what colour, and the reader's over it —
 * and the lane coloured by name reading the same mapping.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import { parseBed } from '@/annotations/parse'
import { FIELD_NAME, featureFields, featureStyleOf, defaultFeatureStyle } from '@/annotations/fields'
import { featureColouring, NO_ANSWER } from '@/render/featureInk'
import {
  COMPARTMENT_COLOURS,
  MAX_NAMES,
  NAME_PALETTE,
  OTHER_NAME,
  OTHER_NAME_COLOUR,
  hasNames,
  nameLevels,
  nameOverridesOf,
  namePalette,
} from '@/render/nameColours'
import { buildStructure, type Structure } from '@/structure/scene'
import { beadNames, nameSource } from '@/structure/sources'
import { resolveColours, UNSET_COLOUR } from '@/structure/colour'
import { defaultStructureStyle } from '@/annotations/types'

// Four beads of 10 kb on chrA, two on chrB.
const MODEL = [
  'chrA 0 0 0 0',
  'chrA 10000 1 0 0',
  'chrA 20000 2 0 0',
  'chrA 30000 3 0 0',
  'chrB 0 0 2 0',
  'chrB 10000 1 2 0',
].join('\n')

function model(): Structure {
  const structure = buildStructure(parseG3d(MODEL))
  if (structure === null) throw new Error('no model')
  return structure
}

const bed = (...rows: string[]): ReturnType<typeof parseBed> => parseBed(rows.join('\n') + '\n')

describe('which name a bead is under', () => {
  it('takes the name with the largest overlap, and leaves an uncovered bead unnamed', () => {
    const features = bed(
      'chrA\t0\t13000\tA', // bead 0 whole, bead 1 by 3 kb
      'chrA\t13000\t20000\tB', // bead 1 by 7 kb
      'chrA\t20000\t24000\tA',
      'chrA\t24000\t30000\tB',
      'chrA\t35000\t40000\tA', // bead 3 by 5 kb: the only name over it
    )
    expect(beadNames(model(), features)).toEqual(['A', 'B', 'B', 'A', '', ''])
  })

  it('sums the overlaps of one name, so a compartment cut in two is still one', () => {
    const features = bed('chrA\t0\t3000\tB', 'chrA\t3000\t6000\tB', 'chrA\t6000\t10000\tA')
    expect(beadNames(model(), features)[0]).toBe('B')
  })

  it('gives a tie to the name met first', () => {
    const features = bed('chrA\t0\t5000\tB', 'chrA\t5000\t10000\tA')
    expect(beadNames(model(), features)[0]).toBe('B')
  })

  it('ignores features with no name and features that end before the bead', () => {
    const features = bed('chrA\t0\t40000', 'chrA\t0\t9000\tA', 'chrB\t0\t20000\tB')
    expect(beadNames(model(), features)).toEqual(['A', '', '', '', 'B', 'B'])
  })

  it('names nothing on a sequence the set does not have', () => {
    expect(beadNames(model(), bed('chrZ\t0\t100000\tA'))).toEqual(['', '', '', '', '', ''])
  })
})

describe('the names a set colours by', () => {
  it('ranks names by base pairs covered and says a BED3 has none', () => {
    const features = bed('chrA\t0\t100\tsmall', 'chrA\t100\t5000\tbig', 'chrA\t5000\t5100\tsmall')
    expect(nameLevels(features)).toEqual({ names: ['big', 'small'], folded: 0 })
    expect(hasNames(features)).toBe(true)
    expect(hasNames(bed('chrA\t0\t100'))).toBe(false)
  })

  it('folds the tail past the cap into one bucket, and says how many', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `chrA\t${i * 100}\t${i * 100 + 100 - i}\tn${i}`)
    const levels = nameLevels(bed(...rows))
    expect(levels.names).toHaveLength(MAX_NAMES - 1)
    expect(levels.folded).toBe(30 - (MAX_NAMES - 1))
    const palette = namePalette(levels)
    const other = palette.levels[palette.levels.length - 1]
    expect(other).toEqual({ name: OTHER_NAME, label: 'other (7 more names)', colour: OTHER_NAME_COLOUR })
    expect(palette.colourOf('n29')).toBe(OTHER_NAME_COLOUR)
    expect(palette.colourOf('')).toBeNull()
  })
})

describe('the colour of a name', () => {
  it('draws exactly A and B as the compartments: A red, B blue', () => {
    const palette = namePalette({ names: ['B', 'A'], folded: 0 })
    expect(palette.colourOf('A')).toBe(COMPARTMENT_COLOURS.A)
    expect(palette.colourOf('B')).toBe(COMPARTMENT_COLOURS.B)
    // The key in natural order, whatever the ranking was.
    expect(palette.levels.map((level) => level.label)).toEqual(['A', 'B'])
  })

  it('hands the categorical palette out by rank otherwise, without its grey', () => {
    const palette = namePalette({ names: ['state10', 'state2', 'A'], folded: 0 })
    expect(palette.colourOf('state10')).toBe(NAME_PALETTE[0])
    expect(palette.colourOf('state2')).toBe(NAME_PALETTE[1])
    expect(palette.colourOf('A')).toBe(NAME_PALETTE[2])
    expect(NAME_PALETTE).not.toContain('#7a7a7a')
    expect(new Set(NAME_PALETTE).size).toBe(MAX_NAMES - 1)
    expect(palette.levels.map((level) => level.label)).toEqual(['A', 'state2', 'state10'])
  })

  it('puts the reader’s colour over the default, the bucket’s included', () => {
    const palette = namePalette({ names: ['A', 'B'], folded: 3 }, { A: '#00ff00', [OTHER_NAME]: '#123456' })
    expect(palette.colourOf('A')).toBe('#00ff00')
    // With a bucket the names are not exactly A and B, so B is the palette's.
    expect(palette.colourOf('B')).toBe(NAME_PALETTE[1])
    expect(palette.colourOf('Z')).toBe('#123456')
  })

  it('reads stored colours back as hex only', () => {
    expect(nameOverridesOf({ A: '#aabbcc', B: 'red', C: 3, '': '#000000' })).toEqual({ A: '#aabbcc', '': '#000000' })
    expect(nameOverridesOf(null)).toEqual({})
    const style = featureStyleOf({ colourBy: 'name', nameColours: { A: '#ff0000' } }, 'segments')
    expect(style.nameColours).toEqual({ A: '#ff0000' })
    expect(defaultFeatureStyle('segments').nameColours).toEqual({})
  })
})

describe('a model coloured by names', () => {
  const features = bed('chrA\t0\t20000\tA', 'chrA\t20000\t30000\tB')

  it('colours each bead by its name, leaves the rest neutral, and keys only the names it drew', () => {
    const structure = model()
    const style = { ...defaultStructureStyle(), colourBy: 'names:x' }
    const source = nameSource(structure, features, 'compartments')
    const colours = resolveColours(structure, style, source)
    const { A, B } = COMPARTMENT_COLOURS
    expect(colours.css).toEqual([A, A, B, UNSET_COLOUR, UNSET_COLOUR, UNSET_COLOUR])
    expect(colours.key).toEqual({
      kind: 'levels',
      title: 'compartments',
      levels: [
        { name: 'A', label: 'A', colour: A },
        { name: 'B', label: 'B', colour: B },
      ],
    })
  })

  it('takes the set’s own colours, and leaves a name no bead is under off the key', () => {
    const source = nameSource(model(), bed('chrA\t0\t10000\tA', 'chrZ\t0\t10\tB'), 'c', { A: '#010203' })
    expect(source.colours?.[0]).toBe('#010203')
    expect(source.levels?.map((level) => level.label)).toEqual(['A'])
  })
})

describe('a lane coloured by name', () => {
  it('is offered only where the set has names, and never on a structure', () => {
    const named = bed('chrA\t0\t10\tA')
    expect(featureFields(named, 'segments').some((field) => field.key === FIELD_NAME)).toBe(true)
    expect(featureFields(bed('chrA\t0\t10'), 'segments').some((field) => field.key === FIELD_NAME)).toBe(false)
    expect(featureFields(named, 'structure').some((field) => field.key === FIELD_NAME)).toBe(false)
  })

  it('draws the same colours the model does, the reader’s included', () => {
    const features = bed('chrA\t0\t10\tA', 'chrA\t10\t20\tB', 'chrA\t20\t30')
    const ink = featureColouring(features, 'segments', FIELD_NAME, '#000000', { B: '#00ff00' })
    expect(ink.colourOf?.(0)).toBe(COMPARTMENT_COLOURS.A)
    expect(ink.colourOf?.(1)).toBe('#00ff00')
    expect(ink.colourOf?.(2)).toBe(NO_ANSWER)
    expect(ink.key.levels).toEqual([
      { label: 'A', colour: COMPARTMENT_COLOURS.A, name: 'A' },
      { label: 'B', colour: '#00ff00', name: 'B' },
    ])
  })
})
