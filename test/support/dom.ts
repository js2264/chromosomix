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
 */

import { VectorPage } from '@/ui/vector'

/** Undo whatever {@link setUpDom} installed. */
export type DomTeardown = () => void

/**
 * Put the document back to a known state and make a canvas answer `null`.
 *
 * Returns the teardown, which a test may ignore: `beforeEach` calling this again
 * clears the body anyway, and a jsdom environment is per file.
 */
export function setUpDom(): DomTeardown {
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-theme')

  const prototype = window.HTMLCanvasElement.prototype as unknown as {
    getContext: unknown
  }
  const original = prototype.getContext
  // Assigned rather than `vi.spyOn`, so this works in a file that has not asked
  // for the mocking API and cannot be left half-restored by a failing assertion.
  prototype.getContext = () => null

  return () => {
    prototype.getContext = original
    document.body.replaceChildren()
  }
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
