/**
 * Two models on top of each other (§25.5): a model, a copy of it turned,
 * scaled and moved, and the copy asked back.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import { alignTo, displacements, matchBeads, placeStructure, topEigenvector } from '@/structure/align'
import { buildStructure } from '@/structure/scene'

function helixText(n: number, transform: (p: [number, number, number]) => [number, number, number], contig = 'chr1'): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const t = i * 0.4
    const [x, y, z] = transform([Math.cos(t) * 3, Math.sin(t) * 3, i * 0.3])
    lines.push(`${contig}\t${i * 5000}\t${x.toFixed(6)}\t${y.toFixed(6)}\t${z.toFixed(6)}`)
  }
  return lines.join('\n')
}

const identity = (p: [number, number, number]): [number, number, number] => p
/** A rotation of 50° about an axis, a scale of 2.5 and a shift. */
function moved(p: [number, number, number]): [number, number, number] {
  const a = (50 * Math.PI) / 180
  const [x, y, z] = p
  const rx = x
  const ry = y * Math.cos(a) - z * Math.sin(a)
  const rz = y * Math.sin(a) + z * Math.cos(a)
  const b = (20 * Math.PI) / 180
  const sx = rx * Math.cos(b) - ry * Math.sin(b)
  const sy = rx * Math.sin(b) + ry * Math.cos(b)
  return [2.5 * sx + 10, 2.5 * sy - 4, 2.5 * rz + 7]
}

function build(text: string) {
  const structure = buildStructure(parseG3d(text))
  if (structure === null) throw new Error('no model')
  return structure
}

describe('alignment', () => {
  it('finds the top eigenvector of a symmetric matrix', () => {
    const v = topEigenvector([
      [2, 0, 0],
      [0, 5, 0],
      [0, 0, 1],
    ])
    expect(Math.abs(v[1])).toBeCloseTo(1, 9)
    expect(Math.abs(v[0])).toBeLessThan(1e-9)
  })

  it('matches beads by locus and haplotype', () => {
    const a = build(helixText(20, identity))
    const b = build(helixText(20, moved))
    const partner = matchBeads(a, b)
    expect(Array.from(partner)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    const other = build(helixText(20, identity, 'chr2'))
    expect(Array.from(matchBeads(a, other)).every((p) => p === -1)).toBe(true)
  })

  it('puts a turned, scaled and moved copy back on the original', () => {
    const a = build(helixText(30, identity))
    const b = build(helixText(30, moved))
    const fit = alignTo(a, b)
    expect(fit).not.toBeNull()
    if (fit === null) return
    expect(fit.matched).toBe(30)
    expect(fit.rmsd).toBeLessThan(1e-3)
    // The scene normalises each model to its own size, so the fit's scale is
    // near one whatever the copy was scaled by on the way in.
    expect(fit.scale).toBeCloseTo(1, 2)
    const shifts = displacements(a, fit)
    expect(Math.max(...Array.from(shifts))).toBeLessThan(1e-3)
    // The rotation is proper: a determinant of one, never a reflection.
    const r = fit.rotation
    const det =
      r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6])
    expect(det).toBeCloseTo(1, 6)
  })

  it('reports the difference where the copy is not the original', () => {
    const a = build(helixText(30, identity))
    const bent = build(helixText(30, ([x, y, z]) => [x, y, z + (z > 4 ? 2 : 0)]))
    const fit = alignTo(a, bent)
    if (fit === null) throw new Error('no fit')
    expect(fit.rmsd).toBeGreaterThan(0.1)
    const d = displacements(a, fit)
    // The beads on the bent side moved more than the ones on the straight side.
    const near = Array.from(d.slice(0, 10))
    const far = Array.from(d.slice(20, 30))
    expect(Math.max(...near)).toBeLessThan(Math.min(...far) + 1)
  })

  it('refuses fewer than four shared beads', () => {
    const a = build(helixText(3, identity))
    const b = build(helixText(3, moved))
    expect(alignTo(a, b)).toBeNull()
  })
})

describe('placing a model (§25.5)', () => {
  /** The distance between two models bead for bead, after a fit. */
  const apart = (a: ReturnType<typeof build>, b: ReturnType<typeof build>): number => {
    const fit = alignTo(a, b)
    return fit === null ? Number.POSITIVE_INFINITY : fit.rmsd
  }

  it('leaves a model that is not placed exactly as it was', () => {
    const a = build(helixText(20, identity))
    expect(placeStructure(a, { mirrorX: false, mirrorY: false, onto: null })).toBe(a)
  })

  it('mirrors through the screen and up it, and neither moves a bead along the fibre', () => {
    const a = build(helixText(20, identity))
    const x = placeStructure(a, { mirrorX: true, mirrorY: false, onto: null })
    const y = placeStructure(a, { mirrorX: false, mirrorY: true, onto: null })
    for (let i = 0; i < a.set.length; i++) {
      expect(x.x[i]).toBeCloseTo(-a.x[i], 6)
      expect(x.y[i]).toBeCloseTo(a.y[i], 6)
      expect(y.x[i]).toBeCloseTo(a.x[i], 6)
      expect(y.y[i]).toBeCloseTo(-a.y[i], 6)
      // z is untouched by either, and so is where each bead is on the genome.
      expect(x.z[i]).toBeCloseTo(a.z[i], 6)
    }
    expect(Array.from(x.set.start)).toEqual(Array.from(a.set.start))
  })

  it('turns a model into another\u2019s frame without drawing the other', () => {
    // A helix and the same helix turned, scaled and shifted: two solvers'
    // answers to one map, which is the case this is for.
    const a = build(helixText(24, identity))
    const b = build(helixText(24, moved))
    // Already close after a fit — they are the same fold — but in their own
    // coordinates they are not on top of each other at all.
    const before = Math.hypot(a.x[0] - b.x[0], a.y[0] - b.y[0], a.z[0] - b.z[0])
    const placed = placeStructure(b, { mirrorX: false, mirrorY: false, onto: a })
    const after = Math.hypot(a.x[0] - placed.x[0], a.y[0] - placed.y[0], a.z[0] - placed.z[0])
    expect(after).toBeLessThan(before)
    expect(after).toBeCloseTo(0, 3)
    // Every bead, not just the first: the placed model *is* the other's frame.
    expect(apart(a, placed)).toBeCloseTo(0, 6)
  })

  it('needs the reflection first where the two models are in opposite hands', () => {
    // A left-handed copy of the helix: no rotation will ever bring it onto the
    // right-handed one, which is the whole reason the mirrors exist.
    const a = build(helixText(24, identity))
    const flipped = build(helixText(24, ([x, y, z]) => [-x, y, z]))
    const turned = placeStructure(flipped, { mirrorX: false, mirrorY: false, onto: a })
    expect(apart(a, turned)).toBeGreaterThan(0.2)
    const mirrored = placeStructure(flipped, { mirrorX: true, mirrorY: false, onto: a })
    expect(apart(a, mirrored)).toBeCloseTo(0, 6)
  })

  it('leaves the model alone where the two share too few beads to fit', () => {
    const a = build(helixText(3, identity))
    const b = build(helixText(3, moved))
    const placed = placeStructure(b, { mirrorX: false, mirrorY: false, onto: a })
    expect(Array.from(placed.x)).toEqual(Array.from(b.x))
  })
})
