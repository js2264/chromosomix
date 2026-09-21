/**
 * The camera a structure is looked at through, as arithmetic (§25).
 *
 * An orbit camera is four numbers and a point: an azimuth and an elevation
 * round a target, a distance from it, and which of two projections. That is
 * the whole of the state, and it is held as a plain object the panel owns —
 * the same rule `figures/FigureBlock.ts` states for a figure, *an interactive
 * figure is a plain figure of a derived object*: the three.js adapter applies
 * this camera to its own, the vector painter projects through it, and the
 * export draws whatever object the controls built. There is no camera inside
 * the renderer that the picture on paper could disagree with.
 *
 * The projection here is the standard one and matches three.js's
 * `PerspectiveCamera` (vertical field of view, in degrees, aspect from the
 * box) and `OrthographicCamera` (a frustum whose half-height is
 * `distance · tan(fov/2)`, so zooming with the distance means the same thing
 * in both). Right-handed, y up, the camera looking down its own −z.
 */

/** Everything about where the eye is. All lengths are in the scene's normalised units. */
export interface Camera {
  /** Round the vertical axis, radians, wrapped to `(−π, π]`. */
  azimuth: number
  /**
   * Above the horizontal plane, radians, wrapped to `(−π, π]` — and **not
   * clamped**, so the model turns over the top and keeps going.
   */
  elevation: number
  /** From the target to the eye. */
  distance: number
  target: [number, number, number]
  projection: 'perspective' | 'orthographic'
  /** Vertical field of view, degrees. */
  fov: number
}

/** The camera a model opens on: three-quarter view, a little above, fitted to a unit sphere. */
export function defaultCamera(): Camera {
  return {
    azimuth: Math.PI / 5,
    elevation: Math.PI / 8,
    distance: 4,
    target: [0, 0, 0],
    projection: 'perspective',
    fov: 40,
  }
}

const MIN_DISTANCE = 0.05
const MAX_DISTANCE = 1000

/** An angle in `(−π, π]`, so a long drag cannot walk the number off to infinity. */
function wrap(angle: number): number {
  const turn = 2 * Math.PI
  const at = ((angle + Math.PI) % turn + turn) % turn
  return at - Math.PI
}

/**
 * Turn the eye round the target. **Neither angle stops.**
 *
 * The elevation used to be clamped a hair short of the poles, which is the
 * turntable convention: it keeps the horizon level and the model the right way
 * up, at the price of a wall the reader runs into halfway through a drag. A
 * structure is not a landscape and has no horizon to keep level — what a reader
 * wants of a globule is to keep turning it until the face they want is towards
 * them, and being stopped dead partway is the one thing a model in the hand
 * never does.
 *
 * Nothing in the arithmetic needed the clamp. {@link basis} is orthonormal at
 * every elevation — `right` is perpendicular to `forward` for all of them, and
 * both are unit — so past the pole the frame stays valid and `up` simply tilts
 * through the horizontal and on over, which is the model going overhead and
 * coming down the far side upside down. That is what turning something over
 * looks like. The angles wrap rather than grow, so a minute of dragging leaves
 * the same numbers a second of it would.
 */
export function orbit(camera: Camera, dAzimuth: number, dElevation: number): Camera {
  return {
    ...camera,
    azimuth: wrap(camera.azimuth + dAzimuth),
    elevation: wrap(camera.elevation + dElevation),
  }
}

/** Move the eye towards or away from the target, by a factor. */
export function dolly(camera: Camera, factor: number): Camera {
  const distance = camera.distance * (Number.isFinite(factor) && factor > 0 ? factor : 1)
  return { ...camera, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance)) }
}

/**
 * Slide the target across the view plane.
 *
 * `dx` and `dy` are in the scene's units along the camera's right and up
 * vectors, which is what lets a drag of so many pixels be turned into a pan by
 * one division ({@link unitsPerPixel}).
 */
export function pan(camera: Camera, dx: number, dy: number): Camera {
  const { right, up } = basis(camera)
  return {
    ...camera,
    target: [
      camera.target[0] + right[0] * dx + up[0] * dy,
      camera.target[1] + right[1] * dx + up[1] * dy,
      camera.target[2] + right[2] * dx + up[2] * dy,
    ],
  }
}

/**
 * Put the whole of a sphere in view, keeping the direction the camera looks
 * from.
 *
 * The distance is what puts a sphere of `radius` inside the vertical field of
 * view with a little air round it; the orthographic frustum uses the same
 * number through {@link halfHeight}, so a fit is a fit in either projection.
 */
export function fitCamera(
  camera: Camera,
  sphere: { x: number; y: number; z: number; radius: number },
): Camera {
  const radius = Math.max(sphere.radius, 1e-3)
  const half = (camera.fov / 2) * (Math.PI / 180)
  return {
    ...camera,
    target: [sphere.x, sphere.y, sphere.z],
    distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, (radius * 1.15) / Math.sin(half))),
  }
}

/** Where the eye is, in scene units. */
export function eyeOf(camera: Camera): [number, number, number] {
  const { forward } = basis(camera)
  return [
    camera.target[0] - forward[0] * camera.distance,
    camera.target[1] - forward[1] * camera.distance,
    camera.target[2] - forward[2] * camera.distance,
  ]
}

/**
 * The camera's axes in scene coordinates: `forward` from the eye to the
 * target, `right` and `up` spanning the view plane.
 */
export function basis(camera: Camera): {
  forward: [number, number, number]
  right: [number, number, number]
  up: [number, number, number]
} {
  const ce = Math.cos(camera.elevation)
  const se = Math.sin(camera.elevation)
  const ca = Math.cos(camera.azimuth)
  const sa = Math.sin(camera.azimuth)
  // The eye sits on a sphere round the target; forward points back at it.
  const forward: [number, number, number] = [-ce * sa, -se, -ce * ca]
  // Right is forward × world-up, which is what keeps the horizon level.
  const right: [number, number, number] = [ca, 0, -sa]
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]
  return { forward, right, up }
}

/** Half the height of the view at the target's depth, in scene units. */
export function halfHeight(camera: Camera): number {
  return camera.distance * Math.tan((camera.fov / 2) * (Math.PI / 180))
}

/**
 * Scene units per CSS pixel at the target's depth, for turning a drag into a
 * pan and a wheel into a dolly about the pointer.
 */
export function unitsPerPixel(camera: Camera, box: { width: number; height: number }): number {
  return (2 * halfHeight(camera)) / Math.max(1, box.height)
}

/** A point in view space: `x` right, `y` up, `depth` away from the eye (positive in front). */
export interface Viewed {
  x: number
  y: number
  depth: number
}

/** A point in scene coordinates, in the camera's own frame. */
export function toView(camera: Camera, x: number, y: number, z: number): Viewed {
  const { forward, right, up } = basis(camera)
  const eye = eyeOf(camera)
  const dx = x - eye[0]
  const dy = y - eye[1]
  const dz = z - eye[2]
  return {
    x: dx * right[0] + dy * right[1] + dz * right[2],
    y: dx * up[0] + dy * up[1] + dz * up[2],
    depth: dx * forward[0] + dy * forward[1] + dz * forward[2],
  }
}

/**
 * A point on the page, in CSS pixels from the box's top-left, with its depth.
 *
 * `null` for a point behind the eye in perspective, which has no honest place
 * on the page. The scale a bead should be drawn at is `pixelsPerUnit` — how
 * many pixels one scene unit covers at that point's depth — so a sphere of
 * radius `r` is a disc of radius `r · pixelsPerUnit`.
 */
export function project(
  camera: Camera,
  box: { width: number; height: number },
  x: number,
  y: number,
  z: number,
): { px: number; py: number; depth: number; pixelsPerUnit: number } | null {
  const view = toView(camera, x, y, z)
  const half = halfHeight(camera)
  const pixelsPerUnitAtTarget = box.height / 2 / Math.max(half, 1e-9)
  if (camera.projection === 'orthographic') {
    return {
      px: box.width / 2 + view.x * pixelsPerUnitAtTarget,
      py: box.height / 2 - view.y * pixelsPerUnitAtTarget,
      depth: view.depth,
      pixelsPerUnit: pixelsPerUnitAtTarget,
    }
  }
  if (!(view.depth > 1e-6)) return null
  const pixelsPerUnit = (pixelsPerUnitAtTarget * camera.distance) / view.depth
  return {
    px: box.width / 2 + view.x * pixelsPerUnit,
    py: box.height / 2 - view.y * pixelsPerUnit,
    depth: view.depth,
    pixelsPerUnit,
  }
}

/**
 * Read a camera back from storage, clamping every field.
 *
 * Per-file session memory outlives the build that wrote it, so a camera is
 * untrusted like every other stored shape: a `NaN` azimuth would put the eye
 * nowhere and the model with it.
 */
export function cameraOf(value: unknown): Camera {
  const fallback = defaultCamera()
  if (typeof value !== 'object' || value === null) return fallback
  const row = value as Record<string, unknown>
  const number = (key: string, lo: number, hi: number, or: number): number => {
    const held = row[key]
    return typeof held === 'number' && Number.isFinite(held) ? Math.max(lo, Math.min(hi, held)) : or
  }
  const target = row['target']
  const point =
    Array.isArray(target) &&
    target.length === 3 &&
    target.every((v) => typeof v === 'number' && Number.isFinite(v))
      ? ([target[0], target[1], target[2]] as [number, number, number])
      : fallback.target
  return {
    // Both angles wrap rather than clamp, and a stored one from a version that
    // clamped is a legal angle either way.
    azimuth: wrap(number('azimuth', -1e6, 1e6, fallback.azimuth)),
    elevation: wrap(number('elevation', -1e6, 1e6, fallback.elevation)),
    distance: number('distance', MIN_DISTANCE, MAX_DISTANCE, fallback.distance),
    target: point,
    projection: row['projection'] === 'orthographic' ? 'orthographic' : 'perspective',
    fov: number('fov', 10, 120, fallback.fov),
  }
}
