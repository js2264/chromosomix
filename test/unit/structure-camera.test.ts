/**
 * The camera's arithmetic, against numbers worked out by hand (§25).
 *
 * The projection is the standard perspective one and has to agree with the
 * three.js camera the adapter builds from the same object — so the cases here
 * are ones with an answer that can be checked on paper: a point at the target
 * lands in the middle of the box, a point one unit right of it at the target's
 * depth lands `pixelsPerUnit` to the right, and doubling the distance halves
 * that.
 */

import { describe, expect, it } from 'vitest'

import {
  basis,
  cameraOf,
  defaultCamera,
  dolly,
  eyeOf,
  fitCamera,
  halfHeight,
  orbit,
  pan,
  project,
  toView,
  unitsPerPixel,
} from '@/structure/camera'

const BOX = { width: 400, height: 300 }

describe('the eye and its axes', () => {
  it('looks from +z at the target with no azimuth and no elevation', () => {
    const camera = { ...defaultCamera(), azimuth: 0, elevation: 0, distance: 5 }
    expect(eyeOf(camera).map((v) => +v.toFixed(10))).toEqual([0, 0, 5])
    const { forward, right, up } = basis(camera)
    expect(forward.map((v) => +v.toFixed(10))).toEqual([0, 0, -1])
    expect(right.map((v) => +v.toFixed(10))).toEqual([1, 0, 0])
    expect(up.map((v) => +v.toFixed(10))).toEqual([0, 1, 0])
  })

  it('keeps the horizon level when orbited', () => {
    const camera = orbit({ ...defaultCamera(), azimuth: 0, elevation: 0 }, Math.PI / 2, 0.3)
    const { right, up } = basis(camera)
    // Right stays in the horizontal plane whatever the elevation.
    expect(right[1]).toBeCloseTo(0, 10)
    expect(right[0] ** 2 + right[1] ** 2 + right[2] ** 2).toBeCloseTo(1, 10)
    expect(up[0] ** 2 + up[1] ** 2 + up[2] ** 2).toBeCloseTo(1, 10)
    expect(up[1]).toBeGreaterThan(0)
  })

  it('stops short of the poles', () => {
    const camera = orbit(defaultCamera(), 0, 10)
    expect(camera.elevation).toBeLessThan(Math.PI / 2)
    expect(orbit(defaultCamera(), 0, -10).elevation).toBeGreaterThan(-Math.PI / 2)
  })
})

describe('projection', () => {
  it('puts the target in the middle of the box', () => {
    const camera = defaultCamera()
    const at = project(camera, BOX, ...camera.target)
    if (at === null) throw new Error('behind the eye')
    expect(at.px).toBeCloseTo(200, 10)
    expect(at.py).toBeCloseTo(150, 10)
    expect(at.depth).toBeCloseTo(camera.distance, 10)
  })

  it('maps one unit to the right at the target’s depth to pixelsPerUnit', () => {
    const camera = { ...defaultCamera(), azimuth: 0, elevation: 0, distance: 5, fov: 60 }
    // Half-height at the target is 5·tan(30°); the box is 300 tall, so one
    // unit is 150 / (5·tan 30°) pixels.
    const expected = 150 / (5 * Math.tan(Math.PI / 6))
    expect(halfHeight(camera)).toBeCloseTo(5 * Math.tan(Math.PI / 6), 10)
    const at = project(camera, BOX, 1, 0, 0)
    if (at === null) throw new Error('behind the eye')
    expect(at.px - 200).toBeCloseTo(expected, 8)
    expect(at.pixelsPerUnit).toBeCloseTo(expected, 8)
    // Up on the page is down in `py`.
    const above = project(camera, BOX, 0, 1, 0)
    if (above === null) throw new Error('behind the eye')
    expect(150 - above.py).toBeCloseTo(expected, 8)
  })

  it('shrinks with depth in perspective and not in orthographic', () => {
    const camera = { ...defaultCamera(), azimuth: 0, elevation: 0, distance: 5 }
    const near = project(camera, BOX, 1, 0, 2.5)
    const far = project(camera, BOX, 1, 0, -5)
    if (near === null || far === null) throw new Error('behind the eye')
    expect(near.pixelsPerUnit).toBeGreaterThan(far.pixelsPerUnit)
    expect(near.pixelsPerUnit / far.pixelsPerUnit).toBeCloseTo(10 / 2.5, 8)
    const ortho = { ...camera, projection: 'orthographic' as const }
    const a = project(ortho, BOX, 1, 0, 2.5)
    const b = project(ortho, BOX, 1, 0, -5)
    if (a === null || b === null) throw new Error('behind the eye')
    expect(a.px).toBeCloseTo(b.px, 10)
  })

  it('refuses a point behind the eye in perspective', () => {
    const camera = { ...defaultCamera(), azimuth: 0, elevation: 0, distance: 5 }
    expect(project(camera, BOX, 0, 0, 6)).toBeNull()
    expect(toView(camera, 0, 0, 6).depth).toBeLessThan(0)
  })
})

describe('the gestures', () => {
  it('dollies by a factor within bounds', () => {
    expect(dolly(defaultCamera(), 2).distance).toBeCloseTo(8, 10)
    expect(dolly(defaultCamera(), 1e-9).distance).toBeGreaterThan(0)
    expect(dolly(defaultCamera(), Number.NaN).distance).toBe(defaultCamera().distance)
  })

  it('pans along the view plane by scene units', () => {
    const camera = { ...defaultCamera(), azimuth: 0, elevation: 0 }
    const moved = pan(camera, 1, 2)
    expect(moved.target.map((v) => +v.toFixed(10))).toEqual([1, 2, 0])
    expect(unitsPerPixel(camera, BOX) * 150).toBeCloseTo(halfHeight(camera), 10)
  })

  it('fits a sphere into the field of view with a little air', () => {
    const fitted = fitCamera(defaultCamera(), { x: 1, y: 2, z: 3, radius: 2 })
    expect(fitted.target).toEqual([1, 2, 3])
    // The sphere's edge, at the target's depth, lands inside the half-height.
    expect(halfHeight(fitted)).toBeGreaterThan(2)
    expect(halfHeight(fitted)).toBeLessThan(3)
  })

  it('reads a stored camera back clamped, and the default from junk', () => {
    expect(cameraOf(null)).toEqual(defaultCamera())
    const read = cameraOf({
      azimuth: 1,
      elevation: 9,
      distance: 1e9,
      target: [1, 'x', 3],
      projection: 'orthographic',
      fov: 5,
    })
    expect(read.azimuth).toBe(1)
    expect(read.elevation).toBeLessThan(Math.PI / 2)
    expect(read.distance).toBe(1000)
    expect(read.target).toEqual(defaultCamera().target)
    expect(read.projection).toBe('orthographic')
    expect(read.fov).toBe(10)
  })
})
