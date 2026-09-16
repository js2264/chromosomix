/**
 * The structure drawn on the GPU, through three.js (§25).
 *
 * The one place in this application a picture is not a `CanvasRenderingContext2D`,
 * and the reason is stated in `package.json`'s comment on the dependency: a lit
 * tube of thousands of beads under an orbiting camera, with sorted transparency
 * and picking, is not the arithmetic the hand-written PDF and charts were the
 * cheaper answer for. It draws the structure cell of a deck and nothing else.
 *
 * ## Thin, on purpose
 *
 * Everything with a number in it lives in `structure/scene.ts`, `camera.ts`
 * and `colour.ts` and is tested in node; this module turns those numbers into
 * buffers and back. It holds no camera state of its own — it is handed a
 * {@link StructureView} and applies its camera to a three.js one on every
 * frame — so the picture it draws and the picture the vector painter draws
 * are projections of the same object, and the export can never show a
 * different angle from the screen.
 *
 * ## What is rebuilt when
 *
 * Geometry is expensive and colours are not, so the two are kept apart. The
 * tube, the bead instances and the stick instances are rebuilt only when the
 * structure, the representation, a radius or the set of *shown* beads changes;
 * a change of colouring, of what is lit, of what is hovered or of the camera
 * touches a colour attribute or a matrix and nothing else. A colouring by a
 * track sampled on every pan would otherwise rebuild a tube per frame.
 *
 * ## Picking
 *
 * Against the bead instances, always — including under a tube, where the
 * beads are not drawn. The pick mesh sits on a layer the camera does not
 * render and the raycaster does, so a pick is always a bead index and never a
 * point on a surface with no locus.
 */

import {
  AmbientLight,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'

import { basis, eyeOf, halfHeight, project } from './camera'
import { hexOf, parseColour } from './colour'
import type { StructureView } from './painter'
import { GHOST_OPACITY } from './painter'

/** What the renderer clears to and writes labels in, read off the page. */
export interface RenderPalette {
  background: string
  ink: string
  halo: string
}

/** The layer the pick mesh lives on: raycast, never drawn. */
const PICK_LAYER = 1

/** Radial segments of a tube and a stick. Eight reads as round at any size a cell draws. */
const RADIAL = 8

/** Tube segments per bead along a run. */
const TUBE_PER_BEAD = 4

export class StructureRenderer {
  readonly el: HTMLCanvasElement
  private renderer: WebGLRenderer | null = null
  private readonly scene = new Scene()
  private perspective = new PerspectiveCamera(40, 1, 0.01, 100)
  private orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  private readonly root = new Object3D()
  private readonly lights = new Object3D()
  private beads: InstancedMesh | null = null
  private picks: InstancedMesh | null = null
  private halos: InstancedMesh | null = null
  private sticks: InstancedMesh | null = null
  private tubes: Mesh[] = []
  private chord: Line | null = null
  /** Loops as chords (§25.5), one segment per pair. */
  private chords: LineSegments | null = null
  private chordsFrom: ReadonlyArray<readonly [number, number]> | null = null
  private readonly raycaster = new Raycaster()
  private width = 1
  private height = 1
  private view: StructureView | null = null
  private palette: RenderPalette
  /** What the geometry was last built for, so a change elsewhere does not rebuild it. */
  private built: string | null = null
  /** Bead index per pick instance, since hidden beads are not instanced. */
  private pickBeads: Int32Array = new Int32Array(0)
  private shown: Uint8Array = new Uint8Array(0)
  /** `true` after the GPU took the context away; the next frame rebuilds. */
  lost = false
  private readonly onLost = (event: Event): void => {
    event.preventDefault()
    this.lost = true
  }
  private readonly onRestored = (): void => {
    this.lost = false
    this.built = null
    this.render()
  }

  constructor(palette: RenderPalette) {
    this.palette = palette
    this.el = document.createElement('canvas')
    this.el.className = 'structure-canvas'
    this.el.addEventListener('webglcontextlost', this.onLost)
    this.el.addEventListener('webglcontextrestored', this.onRestored)
    this.scene.add(this.root)
    this.scene.add(this.lights)
    const ambient = new AmbientLight(0xffffff, 0.9)
    const key = new DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 1.2, 1.5)
    const fill = new DirectionalLight(0xffffff, 0.5)
    fill.position.set(-1, -0.4, -1)
    this.lights.add(ambient, key, fill)
    this.raycaster.layers.set(PICK_LAYER)
  }

  /** Whether this browser gave a WebGL context at all. */
  get available(): boolean {
    return this.contextOrNull() !== null
  }

  private contextOrNull(): WebGLRenderer | null {
    if (this.renderer !== null) return this.renderer
    try {
      this.renderer = new WebGLRenderer({ canvas: this.el, antialias: true, alpha: false })
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
      this.renderer.setSize(this.width, this.height, false)
      return this.renderer
    } catch {
      return null
    }
  }

  setPalette(palette: RenderPalette): void {
    this.palette = palette
    // Ghosted and paled colours are mixed with the background, so they are
    // colours of the page as well as of the model.
    this.recolour()
    this.render()
  }

  /** CSS pixels. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.renderer?.setSize(this.width, this.height, false)
    this.render()
  }

  /** Adopt a view and draw it. */
  setView(view: StructureView): void {
    const previous = this.view
    this.view = view
    const key = buildKey(view)
    if (key !== this.built) {
      this.rebuild(view)
      this.built = key
    } else if (previous === null || previous.colours !== view.colours || previous.lit !== view.lit) {
      this.recolour()
    }
    this.mark()
    this.render()
  }

  /**
   * The bead under a point in the canvas, in CSS pixels from its top-left, or
   * `-1`.
   */
  pick(x: number, y: number): number {
    const view = this.view
    if (view === null || this.picks === null) return -1
    const ndc = new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1)
    const camera = this.applyCamera(view)
    this.raycaster.setFromCamera(ndc, camera)
    const hits = this.raycaster.intersectObject(this.picks, false)
    const first = hits.find((hit) => hit.instanceId !== undefined)
    if (first === undefined || first.instanceId === undefined) return -1
    return this.pickBeads[first.instanceId] ?? -1
  }

  /**
   * The picture at a size, as a 2D canvas: the GL frame plus the labels.
   *
   * Rendered at the requested size rather than screen-grabbed, so a 300 dpi
   * export is a 300 dpi drawing (§7.2's rule, kept for the one raster here).
   */
  snapshot(width: number, height: number): HTMLCanvasElement | null {
    const renderer = this.contextOrNull()
    const view = this.view
    if (renderer === null || view === null) return null
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width))
    out.height = Math.max(1, Math.round(height))
    const ctx = out.getContext('2d')
    if (ctx === null) return null
    const heldWidth = this.width
    const heldHeight = this.height
    const heldRatio = renderer.getPixelRatio()
    try {
      renderer.setPixelRatio(1)
      this.width = out.width
      this.height = out.height
      renderer.setSize(out.width, out.height, false)
      this.render()
      ctx.drawImage(this.el, 0, 0)
    } finally {
      this.width = heldWidth
      this.height = heldHeight
      renderer.setPixelRatio(heldRatio)
      renderer.setSize(heldWidth, heldHeight, false)
      this.render()
    }
    drawLabels(ctx, { width: out.width, height: out.height }, view, this.palette, out.width / heldWidth)
    return out
  }

  render(): void {
    const renderer = this.contextOrNull()
    const view = this.view
    if (renderer === null || view === null || this.lost) return
    const camera = this.applyCamera(view)
    const background = new Color(hexOf(this.palette.background))
    this.scene.background = background
    // The depth cue: the far side of the model fades towards the page. Set from
    // the camera's distance so it reads the same at every zoom.
    const near = view.camera.distance
    this.scene.fog = view.style.lit ? new Fog(background, near * 0.9, near * 2.6) : null
    renderer.render(this.scene, camera)
  }

  destroy(): void {
    this.el.removeEventListener('webglcontextlost', this.onLost)
    this.el.removeEventListener('webglcontextrestored', this.onRestored)
    this.clear()
    this.renderer?.dispose()
    this.renderer = null
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private clear(): void {
    for (const mesh of [this.beads, this.picks, this.halos, this.sticks, ...this.tubes]) {
      if (mesh === null) continue
      this.root.remove(mesh)
      mesh.geometry.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material.dispose()
    }
    if (this.chords !== null) {
      this.root.remove(this.chords)
      this.chords.geometry.dispose()
      ;(this.chords.material as LineBasicMaterial).dispose()
      this.chords = null
      this.chordsFrom = null
    }
    if (this.chord !== null) {
      this.root.remove(this.chord)
      this.chord.geometry.dispose()
      ;(this.chord.material as LineDashedMaterial).dispose()
    }
    this.beads = null
    this.picks = null
    this.halos = null
    this.sticks = null
    this.tubes = []
    this.chord = null
  }

  private rebuild(view: StructureView): void {
    this.clear()
    const { structure, style } = view
    const n = structure.set.length
    const shown = shownBeads(view)
    this.shown = shown
    let count = 0
    for (let i = 0; i < n; i++) count += shown[i]
    const beadRadius = structure.step * style.beadRadius
    const stickRadius = structure.step * style.tubeRadius
    const lit = style.lit

    // The pick instances, always: one sphere per shown bead at the bead radius
    // or, under a tube, at the tube's, so a pick on the tube lands on the bead
    // the surface belongs to.
    const pickRadius = style.representation === 'tube' || style.representation === 'sticks' ? Math.max(stickRadius, beadRadius * 0.6) : beadRadius
    this.pickBeads = new Int32Array(count)
    this.picks = new InstancedMesh(new SphereGeometry(1, 8, 6), new MeshBasicMaterial(), Math.max(1, count))
    this.picks.count = count
    this.picks.layers.set(PICK_LAYER)
    const matrix = new Matrix4()
    let at = 0
    for (let i = 0; i < n; i++) {
      if (shown[i] === 0) continue
      matrix.makeScale(pickRadius, pickRadius, pickRadius)
      matrix.setPosition(structure.x[i], structure.y[i], structure.z[i])
      this.picks.setMatrixAt(at, matrix)
      this.pickBeads[at] = i
      at++
    }
    this.picks.instanceMatrix.needsUpdate = true
    // A raycast against an instanced mesh is gated by its bounding sphere,
    // which three computes once and never again: left as it was, it is the
    // sphere of a mesh that had no instances yet, and every ray misses. The
    // same sphere is what frustum culling reads, which is why every object
    // under the root is added with culling off (`frustumCulled = false`): a
    // halo or a chord placed after its sphere was computed was culled as
    // out of view and never drawn.
    this.picks.computeBoundingSphere()
    this.root.add(this.picks)
    this.picks.frustumCulled = false

    const drawBeads = style.representation === 'beads' || style.representation === 'beads+sticks'
    const drawSticks = style.representation === 'sticks' || style.representation === 'beads+sticks'
    const drawTube = style.representation === 'tube'

    if (drawBeads) {
      this.beads = new InstancedMesh(new SphereGeometry(1, 16, 12), surface(lit), Math.max(1, count))
      this.beads.count = count
      at = 0
      for (let i = 0; i < n; i++) {
        if (shown[i] === 0) continue
        matrix.makeScale(beadRadius, beadRadius, beadRadius)
        matrix.setPosition(structure.x[i], structure.y[i], structure.z[i])
        this.beads.setMatrixAt(at, matrix)
        at++
      }
      this.beads.instanceMatrix.needsUpdate = true
      this.root.add(this.beads)
      this.beads.frustumCulled = false
    }

    if (drawSticks || drawTube) {
      // Sticks between neighbours on a run, and dashed ones across gaps where
      // asked — as instanced cylinders, each turned from the y axis onto its
      // pair. A tube's runs of one bead have no tube and are given a stick's
      // worth of nothing, which is what a lone bead is.
      const pairs = pairsOf(view, shown)
      if (drawSticks && pairs.length > 0) {
        this.sticks = new InstancedMesh(
          new CylinderGeometry(1, 1, 1, RADIAL, 1, true),
          surface(lit),
          pairs.length,
        )
        const q = new Quaternion()
        const up = new Vector3(0, 1, 0)
        const dir = new Vector3()
        for (let p = 0; p < pairs.length; p++) {
          const [a, b] = pairs[p]
          dir.set(structure.x[b] - structure.x[a], structure.y[b] - structure.y[a], structure.z[b] - structure.z[a])
          const length = dir.length()
          q.setFromUnitVectors(up, dir.clone().normalize())
          matrix.compose(
            new Vector3((structure.x[a] + structure.x[b]) / 2, (structure.y[a] + structure.y[b]) / 2, (structure.z[a] + structure.z[b]) / 2),
            q,
            new Vector3(stickRadius, length, stickRadius),
          )
          this.sticks.setMatrixAt(p, matrix)
        }
        this.sticks.instanceMatrix.needsUpdate = true
        this.sticks.userData['pairs'] = pairs
        this.root.add(this.sticks)
        this.sticks.frustumCulled = false
      }
      if (drawTube) {
        for (const chain of structure.chains) {
          if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
          for (let r = 0; r < chain.runs.length; r += 2) {
            const from = chain.runs[r]
            const to = chain.runs[r + 1]
            const run: number[] = []
            for (let k = from; k < to; k++) if (shown[chain.beads[k]] === 1) run.push(chain.beads[k])
            if (run.length < 2) continue
            const points = run.map((i) => new Vector3(structure.x[i], structure.y[i], structure.z[i]))
            const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.5)
            const segments = Math.max(1, (run.length - 1) * TUBE_PER_BEAD)
            const geometry = new TubeGeometry(curve, segments, stickRadius, RADIAL, false)
            // Which bead each ring of vertices belongs to, by arc length along
            // the polyline, so a colouring reads along the fibre.
            const owner = new Int32Array(segments + 1)
            const lengths = cumulative(points)
            const total = lengths[lengths.length - 1]
            for (let s = 0; s <= segments; s++) {
              const along = (s / segments) * total
              let k = 0
              while (k + 1 < lengths.length - 1 && lengths[k + 1] <= along) k++
              const span = lengths[k + 1] - lengths[k]
              const t = span > 0 ? (along - lengths[k]) / span : 0
              owner[s] = run[t < 0.5 ? k : k + 1]
            }
            geometry.setAttribute('color', new BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3))
            const mesh = new Mesh(geometry, surface(lit, true))
            mesh.userData['owner'] = owner
            mesh.userData['radial'] = RADIAL
            this.tubes.push(mesh)
            this.root.add(mesh)
          }
        }
      }
    }

    // The halo behind a hovered or pinned bead: a copy of the sphere, a little
    // larger, drawn back faces only, which reads as an outline round it.
    this.halos = new InstancedMesh(
      new SphereGeometry(1, 16, 12),
      new MeshBasicMaterial({ color: hexOf(this.palette.ink), side: BackSide }),
      8,
    )
    this.halos.count = 0
    this.root.add(this.halos)
    this.halos.frustumCulled = false

    const chordGeometry = new BufferGeometry()
    chordGeometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3))
    this.chord = new Line(
      chordGeometry,
      new LineDashedMaterial({ color: hexOf(this.palette.ink), dashSize: stickRadius * 3, gapSize: stickRadius * 2 }),
    )
    this.chord.visible = false
    this.root.add(this.chord)
    this.chord.frustumCulled = false

    this.chords = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: hexOf(this.palette.ink), transparent: true, opacity: 0.55 }),
    )
    this.chords.visible = false
    this.root.add(this.chords)
    this.chords.frustumCulled = false
    this.chordsFrom = null

    this.recolour()
  }

  /** Write every colour attribute from the view's colours, lit mask and palette. */
  private recolour(): void {
    const view = this.view
    if (view === null) return
    const { structure } = view
    const n = structure.set.length
    const rgb = view.colours.rgb
    const background = parseColour(this.palette.background)
    const colourOf = (i: number, out: Color): void => {
      const ghost = view.lit !== null && view.lit[i] === 0
      const mix = ghost ? 1 - GHOST_OPACITY : 0
      out.setRGB(
        rgb[i * 3] + (background[0] - rgb[i * 3]) * mix,
        rgb[i * 3 + 1] + (background[1] - rgb[i * 3 + 1]) * mix,
        rgb[i * 3 + 2] + (background[2] - rgb[i * 3 + 2]) * mix,
      )
    }
    const colour = new Color()
    if (this.beads !== null) {
      for (let at = 0; at < this.pickBeads.length; at++) {
        colourOf(this.pickBeads[at], colour)
        this.beads.setColorAt(at, colour)
      }
      if (this.beads.instanceColor !== null) this.beads.instanceColor.needsUpdate = true
    }
    if (this.sticks !== null) {
      const pairs = this.sticks.userData['pairs'] as Array<[number, number]>
      const other = new Color()
      for (let p = 0; p < pairs.length; p++) {
        colourOf(pairs[p][0], colour)
        colourOf(pairs[p][1], other)
        colour.lerp(other, 0.5)
        this.sticks.setColorAt(p, colour)
      }
      if (this.sticks.instanceColor !== null) this.sticks.instanceColor.needsUpdate = true
    }
    for (const tube of this.tubes) {
      const owner = tube.userData['owner'] as Int32Array
      const radial = tube.userData['radial'] as number
      const attribute = tube.geometry.getAttribute('color') as BufferAttribute
      const array = attribute.array as Float32Array
      for (let s = 0; s < owner.length; s++) {
        colourOf(owner[s], colour)
        for (let ring = 0; ring <= radial; ring++) {
          const v = s * (radial + 1) + ring
          array[v * 3] = colour.r
          array[v * 3 + 1] = colour.g
          array[v * 3 + 2] = colour.b
        }
      }
      attribute.needsUpdate = true
    }
    if (this.halos !== null) {
      ;(this.halos.material as MeshBasicMaterial).color.setHex(hexOf(this.palette.ink))
    }
    if (this.chord !== null) {
      ;(this.chord.material as LineDashedMaterial).color.setHex(hexOf(this.palette.ink))
    }
    void n
  }

  /** Place the halos and the chord for what is hovered and pinned. */
  private mark(): void {
    const view = this.view
    if (view === null || this.halos === null || this.chord === null) return
    const { structure, style } = view
    const marked = [...new Set([...view.hovered, ...(view.pinned >= 0 ? [view.pinned] : [])])].filter(
      (i) => i >= 0 && i < structure.set.length && this.shown[i] === 1,
    )
    const radius =
      (style.representation === 'tube' || style.representation === 'sticks'
        ? Math.max(structure.step * style.tubeRadius, structure.step * style.beadRadius * 0.6)
        : structure.step * style.beadRadius) * 1.45
    const matrix = new Matrix4()
    const count = Math.min(marked.length, 8)
    for (let at = 0; at < count; at++) {
      const i = marked[at]
      matrix.makeScale(radius, radius, radius)
      matrix.setPosition(structure.x[i], structure.y[i], structure.z[i])
      this.halos.setMatrixAt(at, matrix)
    }
    this.halos.count = count
    this.halos.instanceMatrix.needsUpdate = true

    if (this.chords !== null && this.chordsFrom !== view.chords) {
      // Rebuilt only when the list is a new one: the panel hands the same
      // array back frame after frame while nothing about the loops changed.
      this.chordsFrom = view.chords
      const kept = view.chords.filter(([a, b]) => this.shown[a] === 1 && this.shown[b] === 1)
      const array = new Float32Array(kept.length * 6)
      kept.forEach(([a, b], at) => {
        array[at * 6] = structure.x[a]
        array[at * 6 + 1] = structure.y[a]
        array[at * 6 + 2] = structure.z[a]
        array[at * 6 + 3] = structure.x[b]
        array[at * 6 + 4] = structure.y[b]
        array[at * 6 + 5] = structure.z[b]
      })
      this.chords.geometry.dispose()
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(array, 3))
      this.chords.geometry = geometry
      this.chords.visible = kept.length > 0
    }

    const chord = view.chord
    if (chord !== null && this.shown[chord[0]] === 1 && this.shown[chord[1]] === 1) {
      const position = this.chord.geometry.getAttribute('position') as BufferAttribute
      const array = position.array as Float32Array
      const [a, b] = chord
      array[0] = structure.x[a]
      array[1] = structure.y[a]
      array[2] = structure.z[a]
      array[3] = structure.x[b]
      array[4] = structure.y[b]
      array[5] = structure.z[b]
      position.needsUpdate = true
      this.chord.computeLineDistances()
      this.chord.visible = true
    } else {
      this.chord.visible = false
    }
  }

  /** The three.js camera for a view, positioned from the pure one. */
  private applyCamera(view: StructureView): PerspectiveCamera | OrthographicCamera {
    const camera = view.camera
    const aspect = this.width / this.height
    const eye = eyeOf(camera)
    const { up } = basis(camera)
    const near = Math.max(0.005, camera.distance * 0.02)
    const far = camera.distance * 30 + 10
    if (camera.projection === 'orthographic') {
      const half = halfHeight(camera)
      const cam = this.orthographic
      cam.left = -half * aspect
      cam.right = half * aspect
      cam.top = half
      cam.bottom = -half
      cam.near = near
      cam.far = far
      cam.position.set(eye[0], eye[1], eye[2])
      cam.up.set(up[0], up[1], up[2])
      cam.lookAt(camera.target[0], camera.target[1], camera.target[2])
      cam.updateProjectionMatrix()
      this.lights.position.copy(cam.position)
      this.lights.quaternion.copy(cam.quaternion)
      return cam
    }
    const cam = this.perspective
    cam.fov = camera.fov
    cam.aspect = aspect
    cam.near = near
    cam.far = far
    cam.position.set(eye[0], eye[1], eye[2])
    cam.up.set(up[0], up[1], up[2])
    cam.lookAt(camera.target[0], camera.target[1], camera.target[2])
    cam.updateProjectionMatrix()
    // The lights ride with the eye, so the lit side of the model is the side
    // the reader is looking at whatever the orbit.
    this.lights.position.copy(cam.position)
    this.lights.quaternion.copy(cam.quaternion)
    return cam
  }
}

/** The material a bead, a stick or a tube is drawn in: shaded, or flat. */
function surface(lit: boolean, vertexColors = false): MeshStandardMaterial | MeshBasicMaterial {
  return lit
    ? new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, vertexColors })
    : new MeshBasicMaterial({ vertexColors })
}

/** Which beads are drawn at all under this view. */
function shownBeads(view: StructureView): Uint8Array {
  const { structure, style } = view
  const n = structure.set.length
  const shown = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (structure.present[i] === 0) continue
    if (view.haplotype >= 0 && structure.model.hap[i] !== view.haplotype) continue
    if (view.lit !== null && view.lit[i] === 0 && style.others === 'hide') continue
    shown[i] = 1
  }
  return shown
}

/** The bead pairs a stick joins: neighbours on a run, and gap ends where dashed. */
function pairsOf(view: StructureView, shown: Uint8Array): Array<[number, number]> {
  const { structure, style } = view
  const pairs: Array<[number, number]> = []
  for (const chain of structure.chains) {
    if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
    for (let r = 0; r < chain.runs.length; r += 2) {
      for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
        const a = chain.beads[k - 1]
        const b = chain.beads[k]
        if (shown[a] === 1 && shown[b] === 1) pairs.push([a, b])
      }
    }
    if (style.gaps === 'dashed') {
      for (let r = 2; r < chain.runs.length; r += 2) {
        const a = chain.beads[chain.runs[r - 1] - 1]
        const b = chain.beads[chain.runs[r]]
        if (shown[a] === 1 && shown[b] === 1) pairs.push([a, b])
      }
    }
  }
  return pairs
}

/** Cumulative polyline length at each point, from zero. */
function cumulative(points: Vector3[]): number[] {
  const out = [0]
  for (let k = 1; k < points.length; k++) out.push(out[k - 1] + points[k].distanceTo(points[k - 1]))
  return out
}

/** What the geometry depends on, so a change elsewhere leaves it alone. */
function buildKey(view: StructureView): string {
  const { structure, style } = view
  let litKey = ''
  if (view.lit !== null && style.others === 'hide') {
    // Under `hide` the lit mask changes which beads exist, so it is part of
    // the key; under `ghost` and `show` it is a colour and is not.
    let hash = 0
    for (let i = 0; i < view.lit.length; i++) hash = (hash * 31 + view.lit[i]) | 0
    litKey = String(hash)
  }
  return [
    structure.set.length,
    structure.placed,
    style.representation,
    style.beadRadius,
    style.tubeRadius,
    style.gaps,
    style.lit,
    view.haplotype,
    style.others,
    litKey,
  ].join('|')
}

/**
 * The chain names onto a 2D canvas over the GL frame, for the export.
 *
 * Projected through the pure camera, which is the same projection the GL
 * camera was built from, so a label lands on its chain.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  box: { width: number; height: number },
  view: StructureView,
  palette: RenderPalette,
  scale: number,
): void {
  if (!view.style.labels) return
  const { structure } = view
  ctx.save()
  ctx.font = `${Math.round(11 * scale)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const chain of structure.chains) {
    if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
    const mid = chain.beads[chain.beads.length >> 1]
    if (structure.present[mid] === 0) continue
    const at = project(view.camera, box, structure.x[mid], structure.y[mid], structure.z[mid])
    if (at === null) continue
    const name = structure.contigs[chain.contig]
    const label =
      structure.haplotypes.length > 1 && view.haplotype < 0
        ? `${name} ${structure.haplotypes[chain.hap]}`
        : name
    ctx.fillStyle = palette.halo
    ctx.fillText(label, at.px + scale, at.py + scale)
    ctx.fillStyle = palette.ink
    ctx.fillText(label, at.px, at.py)
  }
  ctx.restore()
}
