// @vitest-environment jsdom
/**
 * Refusals, rendered.
 *
 * §10's rule is that every refusal names the file's actual state and the
 * concrete fix, and the division of labour behind it is what these assert: the
 * *reader* writes the sentence, because it knows the actual value, and this view
 * supplies the heading, the advice and — where one exists — the action that
 * resolves it. Switching on `code` rather than pattern-matching the prose is what
 * makes each refusal read specifically instead of all of them reading like "could
 * not open file", and a heading that fell back to a generic one would be
 * invisible: the message underneath would still look right.
 *
 * The `entry-not-found` case is the one with a way out in it, and the way out is
 * a row of buttons built from names the *error* carried.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ViewerError } from '@/errors'
import { ErrorView } from '@/ui/ErrorView'
import { all, buttonLabels, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

interface Built {
  view: ErrorView
  pickers: number
  retries: number
  entries: string[]
}

function build(
  error: unknown,
  options: { onRetry?: boolean; onOpenEntry?: boolean } = {},
): Built {
  let pickers = 0
  let retries = 0
  const entries: string[] = []
  const view = new ErrorView({
    error,
    onOpenFilePicker: () => {
      pickers++
    },
    ...(options.onRetry === true
      ? {
          onRetry: (): void => {
            retries++
          },
        }
      : {}),
    ...(options.onOpenEntry === true
      ? { onOpenEntry: (entry: string): void => void entries.push(entry) }
      : {}),
  })
  document.body.appendChild(view.el)
  return {
    view,
    entries,
    get pickers() {
      return pickers
    },
    get retries() {
      return retries
    },
  }
}

const title = (view: ErrorView): string =>
  view.el.querySelector('.error-title')?.textContent ?? ''
const message = (view: ErrorView): string =>
  view.el.querySelector('.error-message')?.textContent ?? ''

describe('a named refusal', () => {
  it('takes its heading from the code and its sentence from the reader', () => {
    const { view } = build(
      new ViewerError('variable-bins', 'bin-type is "variable"; this viewer reads fixed bins.', {
        binType: 'variable',
      }),
    )
    expect(title(view)).toBe('Variable-bin file')
    expect(message(view)).toBe('bin-type is "variable"; this viewer reads fixed bins.')
    expect(textsOf(view.el, '.advice li').join(' ')).toContain('metacooler binnify')
  })

  it('gives __unbinned__ its own answer rather than “unknown label”', () => {
    const { view } = build(
      new ViewerError('unbinned-not-displayable', '__unbinned__ cannot be displayed', {
        label: '__unbinned__',
      }),
    )
    // A reader who typed a name they read in the file should learn what that
    // name *is*, not be left doubting whether they mistyped it.
    expect(title(view)).toBe('Unassigned contigs are not a genome')
    expect(title(view)).not.toBe('Unknown genome or contig')
  })

  it('prints what the file actually says, foldable and machine-readable', () => {
    const { view } = build(
      new ViewerError('bad-ordering', 'contig-ordering is "cool"', { ordering: 'cool' }),
    )
    const details = view.el.querySelector('details.meta')
    expect(details?.querySelector('summary')?.textContent).toBe('What the file actually says')
    expect(JSON.parse(details?.querySelector('pre')?.textContent ?? '{}')).toEqual({
      ordering: 'cool',
    })
  })

  it('omits the detail block where the refusal carries none', () => {
    const { view } = build(new ViewerError('bad-uri', 'Expected file or file::group'))
    expect(all(view.el, 'details.meta')).toHaveLength(0)
  })
})

describe('what it offers to do about it', () => {
  it('always offers the picker', () => {
    const built = build(new ViewerError('not-hdf5', 'no HDF5 signature'))
    expect(buttonLabels(built.view.el)).toEqual(['open another file'])
    buttonNamed(built.view.el, 'open another file')?.click()
    expect(built.pickers).toBe(1)
  })

  it('offers a retry only where the caller says the action can be retried', () => {
    expect(buttonLabels(build(new ViewerError('remote-cors', 'blocked')).view.el)).not.toContain(
      'try again',
    )
    const built = build(new ViewerError('remote-cors', 'blocked'), { onRetry: true })
    buttonNamed(built.view.el, 'try again')?.click()
    expect(built.retries).toBe(1)
  })

  it('turns the entries an error names into the way out of it', () => {
    const built = build(
      new ViewerError('entry-not-found', 'No entry "rep3" in this collection', {
        entries: ['rep1', 'rep2'],
      }),
      { onOpenEntry: true },
    )
    expect(buttonLabels(built.view.el)).toEqual(['rep1', 'rep2', 'open another file'])
    buttonNamed(built.view.el, 'rep2')?.click()
    expect(built.entries).toEqual(['rep2'])
  })

  it('offers no entry buttons where the caller cannot open one', () => {
    const built = build(
      new ViewerError('entry-not-found', 'no such entry', { entries: ['rep1'] }),
    )
    expect(all(built.view.el, '.entry-list')).toHaveLength(0)
  })

  it('ignores a detail that is not a list of names', () => {
    const built = build(
      new ViewerError('entry-not-found', 'no such entry', { entries: 'rep1' }),
      { onOpenEntry: true },
    )
    expect(buttonLabels(built.view.el)).toEqual(['open another file'])
  })
})

describe('a failure that is not one of the format refusals', () => {
  it('says so, and still shows the underlying message', () => {
    const { view } = build(new TypeError('x.slice is not a function'))
    expect(title(view)).toBe('Something went wrong')
    expect(message(view)).toBe('x.slice is not a function')
    expect(textsOf(view.el, '.advice li').join(' ')).toContain('not one of the format refusals')
  })

  it('renders a thrown non-error rather than printing [object Object]', () => {
    const { view } = build('the worker went away')
    expect(message(view)).toBe('the worker went away')
  })
})
