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

  it('turns over the top and keeps going, in both directions', () => {
    // No pole to stop at: a drag that would once have hit a wall halfway now
    // carries the model all the way over and round.
    const start = { ...defaultCamera(), azimuth: 0, elevation: 0 }
    let camera = start
    const step = Math.PI / 12
    const seen: number[] = []
    for (let k = 0; k < 24; k++) {
      camera = orbit(camera, 0, step)
      seen.push(camera.elevation)
    }
    // A whole turn of elevation, and back where it began.
    expect(camera.elevation).toBeCloseTo(0, 10)
    // It passed the pole rather than piling up against it.
    expect(seen.some((e) => e > Math.PI / 2 - 1e-9)).toBe(true)
    expect(seen.some((e) => e < -Math.PI / 2 + 1e-9)).toBe(true)
    // …and the other way round too.
    let back = start
    for (let k = 0; k < 24; k++) back = orbit(back, 0, -step)
    expect(back.elevation).toBeCloseTo(0, 10)
  })

  it('stays an orthonormal frame past the pole, which is why the clamp could go', () => {
    // The clamp was a convention, not a safeguard: the basis is well formed at
    // every elevation, so nothing downstream breaks when one goes past π/2.
    for (const elevation of [0, 1, Math.PI / 2, 2, 3, -2.5, Math.PI]) {
      const { forward, right, up } = basis({ ...defaultCamera(), azimuth: 0.7, elevation })
      const dot = (a: readonly number[], b: readonly number[]): number =>
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      expect(dot(forward, forward)).toBeCloseTo(1, 10)
      expect(dot(right, right)).toBeCloseTo(1, 10)
      expect(dot(up, up)).toBeCloseTo(1, 10)
      expect(dot(forward, right)).toBeCloseTo(0, 10)
      expect(dot(forward, up)).toBeCloseTo(0, 10)
      expect(dot(right, up)).toBeCloseTo(0, 10)
    }
  })

  it('keeps both angles in a turn rather than letting a long drag run away', () => {
    let camera = defaultCamera()
    for (let k = 0; k < 500; k++) camera = orbit(camera, 0.3, 0.2)
    expect(Math.abs(camera.azimuth)).toBeLessThanOrEqual(Math.PI)
    expect(Math.abs(camera.elevation)).toBeLessThanOrEqual(Math.PI)
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

  it('reads a stored camera back clamped or wrapped, and the default from junk', () => {
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
    // The angles wrap rather than clamp: 9 radians is 9 − 2π of a turn, which
    // is the same place, and not the pole a clamp would have parked it at.
    expect(read.elevation).toBeCloseTo(9 - 2 * Math.PI, 10)
    expect(read.distance).toBe(1000)
    expect(read.target).toEqual(defaultCamera().target)
    expect(read.projection).toBe('orthographic')
    expect(read.fov).toBe(10)
  })
})
