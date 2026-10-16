/**
 * The scaffolding a jsdom test needs, in one place.
 *
 * Most of this suite runs under `node`, and that is right: the arithmetic — a
 * range query, an axis, a bin conversion, the shape of a view state — is where
 * the mistakes that matter live, and a DOM under it would be a second of startup
 * per file bought for nothing. What node cannot reach is the other half of this
 * application, which is cards, panels and dialogs: whether the Sequences card
 * builds a tick per sequence, whether a drawer offers bigWig where there is no
 * card to offer it from, whether a feature dialog leads with the gene's name.
 * Those were until now asserted by reading the source.
 *
 * So a test opts *in*, per file, with the docblock Vitest reads:
 *
 * ```ts
 * // @vitest-environment jsdom
 * ```
 *
 * and then calls {@link setUpDom} in a `beforeEach`. Per file rather than
 * globally, because the ninety files that do not need a DOM should not pay for
 * one.
 *
 * ## Canvas
 *
 * jsdom has no 2D context and this module does not fake one. `getContext`
 * returns `null` quietly — quietly being the point, since jsdom's own answer is
 * a "not implemented" error thrown at the virtual console once per canvas — and
 * every figure in this app already handles that, because a context can be
 * refused in a real browser too.
 *
 * A test that wants to know what was actually *drawn* takes the same road the
 * PDF export takes: {@link drawingOf} runs the figure's own `draw` into a
 * {@link VectorPage}, which is a real implementation of the drawing subset these
 * renderers use rather than a mock of one. So "does this figure paint without
 * throwing, and does it put marks on the page" is a question a test can ask, and
 * the answer is about the code that runs in the browser rather than about a stub.
 *
 * There is one exception, and it is opt-in: `setUpDom({ canvas: 'stub' })` hands
 * back a context that accepts every call and draws nothing. It exists for the
 * objects that *refuse to be built* without one — `HeatmapView` throws in its
 * constructor, so `MatrixPanel` cannot be constructed at all, so nothing about
 * the largest class in the application could be tested. What such a test may ask
 * is about arrangement rather than about pixels: which element got which size,
 * what a resize rewrote, what a turn put on the grid. For pixels, use
 * {@link drawingOf}, which is a real context rather than a silent one.
 */

import { VectorPage } from '@/ui/vector'

/** Undo whatever {@link setUpDom} installed. */
export type DomTeardown = () => void

/**
 * Put the document back to a known state and make a canvas answer `null`.
 *
 * Returns the teardown, which a test may ignore: `beforeEach` calling this again
 * clears the body anyway, and a jsdom environment is per file.
 *
 * `canvas: 'stub'` answers with a silent context instead of `null`, for the one
 * case that needs it; see the header, and {@link silentContext} for what is in it.
 */
export function setUpDom(options: { canvas?: 'null' | 'stub' } = {}): DomTeardown {
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-theme')

  const prototype = window.HTMLCanvasElement.prototype as unknown as {
    getContext: unknown
  }
  const original = prototype.getContext
  // Assigned rather than `vi.spyOn`, so this works in a file that has not asked
  // for the mocking API and cannot be left half-restored by a failing assertion.
  prototype.getContext =
    options.canvas === 'stub'
      ? function (this: HTMLCanvasElement) {
          return silentContext(this)
        }
      : () => null

  // The rasteriser puts its pixels through both of these, and jsdom has neither.
  // Installed with the stub and only with it, so the ninety files that answer
  // `null` keep the environment they were written against.
  const globals = globalThis as Record<string, unknown>
  const hadImageData = globals['ImageData']
  const hadOffscreen = globals['OffscreenCanvas']
  if (options.canvas === 'stub') {
    // Overwritten rather than filled in: jsdom *has* an `OffscreenCanvas`, and
    // its `getContext` answers `null` — which the rasteriser is right to treat as
    // fatal, and which made a half-installed stub fail deeper and later than no
    // stub at all. Both are put back by the teardown.
    globals['ImageData'] = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    globals['OffscreenCanvas'] = class {
      width: number
      height: number
      constructor(width = 0, height = 0) {
        this.width = width
        this.height = height
      }
      getContext(): unknown {
        return silentContext(this as unknown as HTMLCanvasElement)
      }
    }
  }

  return () => {
    prototype.getContext = original
    globals['ImageData'] = hadImageData
    globals['OffscreenCanvas'] = hadOffscreen
    document.body.replaceChildren()
  }
}

/**
 * A 2D context that answers every call these renderers make and draws nothing.
 *
 * Deliberately not a spy and deliberately not asserted on: it exists so that an
 * object which *refuses to exist* without a context can be built and then asked
 * about its arrangement. `measureText` returns a width, because a gutter measured
 * as zero is a layout no browser would produce; everything else is a no-op.
 */
export function silentContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const noop = (): void => {}
  const ctx: Record<string, unknown> = {
    canvas,
    measureText: (text: string) => ({ width: text.length * 7 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(Math.max(0, width * height * 4)),
      width,
      height,
    }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(Math.max(0, width * height * 4)),
      width,
      height,
    }),
    createLinearGradient: () => ({ addColorStop: noop }),
  }
  for (const name of [
    'arc',
    'arcTo',
    'beginPath',
    'bezierCurveTo',
    'clearRect',
    'clip',
    'closePath',
    'drawImage',
    'ellipse',
    'fill',
    'fillRect',
    'fillText',
    'lineTo',
    'moveTo',
    'putImageData',
    'quadraticCurveTo',
    'rect',
    'resetTransform',
    'restore',
    'rotate',
    'roundRect',
    'save',
    'scale',
    'setLineDash',
    'setTransform',
    'stroke',
    'strokeRect',
    'strokeText',
    'transform',
    'translate',
  ]) {
    ctx[name] = noop
  }
  return ctx as unknown as CanvasRenderingContext2D
}

/**
 * Mount an element, run the body, and take it away again.
 *
 * A card that is not in the document is not a card: `ResizeObserver`,
 * `getBoundingClientRect`, `:empty` and — in this codebase specifically — the
 * `isConnected` check a Sequences card unsubscribes itself on all depend on
 * being attached. Tests that assert on structure alone can skip this.
 */
export function mounted<T>(node: Node, body: () => T): T {
  document.body.appendChild(node)
  try {
    return body()
  } finally {
    node.parentNode?.removeChild(node)
  }
}

/** Every element matching `selector` inside `root`, as an array. */
export function all<E extends Element = HTMLElement>(root: ParentNode, selector: string): E[] {
  return [...root.querySelectorAll<E>(selector)]
}

/** The trimmed text of every element matching `selector`. */
export function textsOf(root: ParentNode, selector: string): string[] {
  return all(root, selector).map((node) => (node.textContent ?? '').trim())
}

/**
 * Every button inside `root`, by its label — what a reader would click.
 *
 * Buttons in this app are identified by what they say rather than by a class or
 * a `data-` attribute, because that is what a reader identifies them by and a
 * test asserting on a class would pass over a button relabelled to say the wrong
 * thing.
 */
export function buttonLabels(root: ParentNode): string[] {
  return all<HTMLButtonElement>(root, 'button').map((node) => (node.textContent ?? '').trim())
}

/** The button whose text is exactly `label`, or `null`. */
export function buttonNamed(root: ParentNode, label: string): HTMLButtonElement | null {
  return (
    all<HTMLButtonElement>(root, 'button').find(
      (node) => (node.textContent ?? '').trim() === label,
    ) ?? null
  )
}

/**
 * What a figure paints, through the app's own vector context.
 *
 * The same call the PDF export makes, which is the whole reason it is available
 * to a test at all: these renderers draw through a `CanvasRenderingContext2D`
 * and nothing else, so `VectorPage` is a real one for the subset they use. The
 * returned string is the page's operator stream — long, and worth asserting only
 * coarsely: that it is not empty is the difference between a figure that drew
 * and one that quietly drew nothing.
 */
export async function drawingOf(
  figure: { draw(ctx: CanvasRenderingContext2D, box: { width: number; height: number }): void },
  box = { width: 640, height: 400 },
): Promise<string> {
  const page = new VectorPage(box.width, box.height)
  figure.draw(page.ctx, box)
  const blob = await page.toBlob({ title: 'test', created: new Date(0) })
  return await blob.text()
}

/**
 * Open this page as the installed app (`'app'`) or as a browser tab (`'tab'`):
 * the display mode a browser opens each in, which is what `installedApp` reads
 * and so what decides whether a connected folder is kept (§20.6). jsdom has no
 * `matchMedia` at all — a tab, as far as the app can tell. Returns the undo.
 */
export function openedAs(mode: 'app' | 'tab'): () => void {
  const had = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  window.matchMedia = ((query: string) => ({
    matches: mode === 'app' && query === '(display-mode: standalone)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    if (had === undefined) delete (window as { matchMedia?: unknown }).matchMedia
    else Object.defineProperty(window, 'matchMedia', had)
  }
}
