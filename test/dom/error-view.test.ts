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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewerError } from '@/errors'
import { ErrorView } from '@/ui/ErrorView'
import { setTokenClientFactory, signIn, signOut } from '@/auth/google'
import { bearerFor } from '@/s3/credentials'
import { all, buttonLabels, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'
import { resetDevFeatures } from '@/state/devFeatures'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

let teardown: DomTeardown

beforeEach(() => {
  site.googleClientId = null
  teardown = setUpDom()
  window.localStorage.clear()
  setTokenClientFactory(null)
  signOut()
  // The refusals below are written for a page that reads the multi-genome
  // format; the ones a page with it switched off gives are the last block.
  resetDevFeatures(true)
})

afterEach(() => {
  teardown()
  setTokenClientFactory(null)
  signOut()
  window.localStorage.clear()
  resetDevFeatures()
})

interface Built {
  view: ErrorView
  pickers: number
  retries: number
  signedIn: number
  asStored: number
  entries: string[]
}

function build(
  error: unknown,
  options: { onRetry?: boolean; onOpenEntry?: boolean; onSignedIn?: boolean; onReadAsStored?: boolean } = {},
): Built {
  let pickers = 0
  let retries = 0
  let signedIn = 0
  let asStored = 0
  const entries: string[] = []
  const view = new ErrorView({
    error,
    onOpenFilePicker: () => {
      pickers++
    },
    ...(options.onReadAsStored === true
      ? {
          onReadAsStored: (): void => {
            asStored++
          },
        }
      : {}),
    ...(options.onRetry === true
      ? {
          onRetry: (): void => {
            retries++
          },
        }
      : {}),
    ...(options.onSignedIn === true
      ? {
          onSignedIn: (): void => {
            signedIn++
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
    get signedIn() {
      return signedIn
    },
    get asStored() {
      return asStored
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

  it('says a ladder dropped again opens on its landing rung, not its finest (§9)', () => {
    const { view } = build(new ViewerError('mcool-root', 'No cooler at root', { entries: ['1000', '5000'] }))
    const advice = textsOf(view.el, '.advice li').join(' ')
    expect(advice).toContain('a third of the way up from the finest')
    expect(advice).not.toContain('the finest one opens')
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

describe('a total the contacts box asked for that a map cannot be drawn to', () => {
  // `unsupported` by code, like the operations the browser deliberately never
  // runs — but the CLI refuses this one in the same words, so its advice would
  // send a reader to the same refusal (§6.5).
  const boost = (): ViewerError =>
    new ViewerError(
      'unsupported',
      'NC_000913.3 is 4,642 bins at this resolution, and Boost-HiC — which oversamples it — walks every path between them: at most 3,000. Open a coarser resolution to oversample this map.',
      { sequence: 'NC_000913.3', bins: 4642, limit: 3000, resample: true },
    )

  it('names the box as the way out, not a terminal', () => {
    const { view } = build(boost())
    expect(title(view)).toBe('Not drawn to that total')
    expect(message(view)).toContain('at most 3,000')
    const advice = textsOf(view.el, '.advice li').join(' ')
    expect(advice).toContain('Empty the box')
    expect(advice).not.toContain('metacooler CLI but not here')
  })

  it('offers the files as stored, where the caller can put them back', () => {
    expect(buttonLabels(build(boost()).view.el)).toEqual(['open another file'])
    const built = build(boost(), { onReadAsStored: true })
    expect(buttonLabels(built.view.el)).toEqual(['read as stored', 'open another file'])
    buttonNamed(built.view.el, 'read as stored')?.click()
    expect(built.asStored).toBe(1)
  })

  it('leaves every other unsupported operation’s advice as it was', () => {
    const built = build(new ViewerError('unsupported', 'no such read here'), { onReadAsStored: true })
    expect(title(built.view)).toBe('Not available in the viewer')
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

/**
 * The one refusal whose answer is not in the table (SPECS §24.7).
 *
 * A `401` or `403` from a Google host on a private file is not a CORS problem
 * and not a missing bucket key, and the advice for those two is actively
 * misleading here: the object is fine, the reader is simply not signed in. What
 * is asserted is the boundary in both directions — the offer appears for those
 * hosts and those statuses, and **every other refusal reads exactly as it did**,
 * which is the half a change like this breaks silently.
 */
describe('a Google host saying “not you”', () => {
  const CLIENT_ID = '123-abc.apps.googleusercontent.com'
  const DRIVE = 'https://www.googleapis.com/drive/v3/files/1Ab?alt=media'

  /** The refusal `RemoteRangeSource.open` raises for a `HEAD` that was refused. */
  const refusedHead = (host: string, status = 403): ViewerError =>
    new ViewerError('bad-uri', `${host} answered ${status}`, {
      url: `https://${host}/drive/v3/files/1Ab?alt=media`,
      host,
      status,
      signed: false,
    })

  /** A token client that hands back `token` the moment it is asked. */
  function stub(token: string): void {
    setTokenClientFactory((config) => ({
      requestAccessToken: () =>
        config.callback({ access_token: token, expires_in: 3599 }),
    }))
  }

  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('offers the sign-in, and says what a sign-in is for', () => {
    site.googleClientId = CLIENT_ID
    const { view } = build(refusedHead('www.googleapis.com'))
    expect(buttonLabels(view.el)).toEqual(['sign in', 'open another file'])
    const advice = textsOf(view.el, '.advice li').join(' ')
    expect(advice).toMatch(/not being signed in/i)
    expect(advice).toMatch(/held in memory and never stored/i)
  })

  it('leaves another host’s 403 exactly as it was', () => {
    // The guard on the change: a private bucket answering 403 must still be told
    // the bucket-key story, with no button suggesting Google has anything to do
    // with it.
    site.googleClientId = CLIENT_ID
    const { view } = build(refusedHead('rsglab-data.s3.eu-west-3.amazonaws.com'))
    expect(buttonLabels(view.el)).toEqual(['open another file'])
    expect(textsOf(view.el, '.advice li')).toEqual([
      'Expected file, or file::group — for example file.mmetacool::entries/rep1.',
    ])
  })

  it('ignores a status that is not about authorisation', () => {
    site.googleClientId = CLIENT_ID
    const { view } = build(refusedHead('www.googleapis.com', 404))
    expect(buttonLabels(view.el)).toEqual(['open another file'])
  })

  it('catches a token that ran out mid-file, where only the URL is carried', () => {
    // A ranged read refuses with `remote-no-ranges` and a detail that names the
    // URL and not the host — which is exactly where an expiring token surfaces,
    // an hour into reading one map.
    site.googleClientId = CLIENT_ID
    const { view } = build(
      new ViewerError('remote-no-ranges', 'storage.googleapis.com returned 401', {
        url: 'https://storage.googleapis.com/storage/v1/b/lab/o/rep1.mcool?alt=media',
        status: 401,
        from: 4096,
        to: 8191,
      }),
    )
    expect(buttonLabels(view.el)).toContain('sign in')
  })

  it('does not answer “your key is wrong” with “sign in”', () => {
    // A signed request that was refused is a bucket-key problem and the refusal
    // already says so. GCS's XML host would take a bearer token as readily as a
    // signature, so this is about what the *reader* has to fix, not about what
    // the host accepts.
    site.googleClientId = CLIENT_ID
    const { view } = build(
      new ViewerError('bad-uri', 'storage.googleapis.com refused a signed request', {
        url: 'https://storage.googleapis.com/lab/rep1.mcool',
        host: 'storage.googleapis.com',
        status: 403,
        signed: true,
      }),
    )
    expect(buttonLabels(view.el)).toEqual(['open another file'])
  })

  it('explains rather than offers where the site was built without a client id', () => {
    site.googleClientId = null
    const { view } = build(refusedHead('www.googleapis.com'))
    expect(buttonLabels(view.el)).toEqual(['open another file'])
    expect(textsOf(view.el, '.advice li').join(' ')).toMatch(/GOOGLE_CLIENT_ID/)
  })

  it('says “sign in again” once a token has expired', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-11T10:00:00Z'))
      site.googleClientId = CLIENT_ID
      stub('ya29.OLD')
      await signIn()
      vi.setSystemTime(new Date('2026-09-11T11:30:00Z'))

      const { view } = build(refusedHead('www.googleapis.com', 401))
      expect(buttonLabels(view.el)).toEqual(['sign in again', 'open another file'])
      expect(textsOf(view.el, '.advice li').join(' ')).toMatch(/expired/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops offering once signed in, because the token is not what is missing', async () => {
    site.googleClientId = CLIENT_ID
    stub('ya29.GOOD')
    await signIn()

    const { view } = build(refusedHead('www.googleapis.com'))
    expect(buttonLabels(view.el)).toEqual(['open another file'])
    expect(textsOf(view.el, '.advice li').join(' ')).toMatch(/has not been shared with it/i)
  })

  it('signs in and hands the open back to the caller', async () => {
    site.googleClientId = CLIENT_ID
    stub('ya29.NEW')
    const built = build(refusedHead('www.googleapis.com'), { onSignedIn: true })

    buttonNamed(built.view.el, 'sign in')?.click()
    await settled()

    // The whole point of the offer: the token is held, and the file the reader
    // was refused is opened again without them having to find it.
    expect(bearerFor(DRIVE)).toBe('ya29.NEW')
    expect(built.signedIn).toBe(1)
  })

  it('shows what a refused sign-in said, in place of the offer working', async () => {
    site.googleClientId = CLIENT_ID
    setTokenClientFactory((config) => ({
      requestAccessToken: () => config.callback({ error: 'access_denied' }),
    }))
    const built = build(refusedHead('www.googleapis.com'), { onSignedIn: true })

    buttonNamed(built.view.el, 'sign in')?.click()
    await settled()

    expect(built.view.el.querySelector('.inline-error')?.textContent).toContain('access_denied')
    expect(built.signedIn).toBe(0)
  })
})

describe('with the multi-genome format switched off (§29)', () => {
  beforeEach(() => resetDevFeatures(false))

  /** Everything the view says, bar the reader's own sentence, which names the file. */
  const said = (view: ErrorView): string =>
    [title(view), ...textsOf(view.el, '.advice li')].join(' ')

  it.each([
    ['not-hdf5', 'This is not an HDF5 file'],
    ['not-a-table', 'Text, but not a table this viewer reads'],
    ['not-a-cooler', 'HDF5, but not a contact map'],
    ['variable-bins', 'Variable-bin file'],
    ['unknown-label', 'Unknown sequence'],
    ['unsupported', 'Not available in the viewer'],
    ['bigwig-no-overlap', 'This bigWig names different sequences'],
    ['remote-too-large', 'Too much to download for this operation'],
    ['bad-uri', 'That URI does not parse'],
    ['format', 'This file does not match the format'],
  ] as const)('%s names neither the format nor its genomes', (code, heading) => {
    const { view } = build(new ViewerError(code, 'the reader’s sentence'))
    expect(title(view)).toBe(heading)
    expect(said(view)).not.toMatch(/\.?m?metacool|metacooler|genome|MAG/i)
  })

  it('still names the fix a plain file has', () => {
    const { view } = build(new ViewerError('variable-bins', 'the reader’s sentence'))
    expect(textsOf(view.el, '.advice li').join(' ')).toContain('cooler cload pairs')
  })
})
