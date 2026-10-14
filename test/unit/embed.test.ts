/**
 * The three strings an embed is configured with, and the one it is driven by.
 *
 * `readMounting` reads a query string and `mergeState` reads a message from
 * another origin, and both are the same kind of code: a value from outside
 * turned into something the app will act on. The tests below are mostly about
 * what happens when the value is *wrong*, because that is the half a working
 * embed never exercises and the half a hostile or careless one does.
 *
 * The third file in the feature — `app/EmbedChannel.ts`'s conversation — needs a
 * window to have a parent, so it is asserted in `test/dom/embed-channel.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { mergeState } from '@/app/EmbedChannel'
import { readMounting } from '@/embed'
import { EMPTY_VIEW } from '@/state/facets'
import type { ViewState } from '@/types'

const AT = 'https://viewer.example/app/'

describe('reading a mount', () => {
  it('is a plain window when nothing is asked for', () => {
    const plain = { embed: false, config: null, store: null, storeView: EMPTY_VIEW }
    expect(readMounting('', AT)).toEqual(plain)
    expect(readMounting('?other=1', AT)).toEqual(plain)
  })

  it('takes the key being present as the answer', () => {
    for (const search of ['?embed', '?embed=', '?embed=1', '?embed=true', '?embed=yes']) {
      expect(readMounting(search, AT).embed).toBe(true)
    }
  })

  it('lets a hand-edited "no" mean no', () => {
    for (const search of ['?embed=0', '?embed=false', '?embed=off']) {
      expect(readMounting(search, AT).embed).toBe(false)
    }
  })

  it('resolves a relative config against the page it was named on', () => {
    expect(readMounting('?config=figure.chromosomix.json', AT).config).toBe(
      'https://viewer.example/app/figure.chromosomix.json',
    )
  })

  it('keeps an absolute config as it was written', () => {
    const url = 'https://data.example/demo/yeast/Yeast_tracks.chromosomix.json'
    expect(readMounting(`?config=${encodeURIComponent(url)}`, AT).config).toBe(url)
  })

  it('refuses a config that is not something to fetch', () => {
    // The value is about to be handed to `fetch` and read as a workspace. The
    // schemes that are not http(s) are the ones with no server on the other end
    // and a document of their own to offer instead.
    for (const named of ['javascript:alert(1)', 'data:application/json,{}', 'file:///etc/passwd']) {
      expect(readMounting(`?config=${encodeURIComponent(named)}`, AT).config).toBeNull()
    }
    // And one that cannot be resolved at all leaves the picker standing rather
    // than throwing on the boot path. A value that resolves to a URL with
    // nothing behind it is *not* this case and is deliberately kept: the fetch
    // reports what the host answered, which is the honest error.
    expect(readMounting('?config=http%3A%2F%2F', AT).config).toBeNull()
    expect(readMounting('?config=missing.json', AT).config).toBe(
      'https://viewer.example/app/missing.json',
    )
  })

  it('reads every key off one query string', () => {
    const read = readMounting('?embed=1&config=s.json&store=h.json&edges=e.tsv&assay=Hi-C', AT)
    expect(read.embed).toBe(true)
    expect(read.config).toBe('https://viewer.example/app/s.json')
    expect(read.store).toBe('https://viewer.example/app/h.json')
    // The rest of the address is the store's view: the facets, and none of the
    // page's own parameters read as one.
    expect([...read.storeView.facets.keys()]).toEqual(['assay'])
  })

  it('keeps a shipped store’s id as written, and reads no view without a store', () => {
    expect(readMounting('?store=4dn', AT).store).toBe('4dn')
    expect(readMounting('?store=encode&group=GRCh38&view=matrix', AT).storeView.mode).toBe('matrix')
    expect(readMounting('?store=store:2', AT).store).toBe('store:2')
    expect(readMounting('?assay=Hi-C', AT).storeView).toEqual(EMPTY_VIEW)
  })

  /**
   * `?store=` is the third mounting parameter (§24.2), and it is read with the
   * same two rules `config` is: resolved against the page, and kept only when
   * it comes out as something this app can fetch. The rules are shared code
   * rather than written twice, and these assertions are what says so.
   */
  it('resolves a store against the page it was named on', () => {
    expect(readMounting('?store=shelf.json', AT).store).toBe('https://viewer.example/app/shelf.json')
    const url = 'https://raw.githubusercontent.com/js2264/chromosomix/stores/4dn.json'
    expect(readMounting(`?store=${encodeURIComponent(url)}`, AT).store).toBe(url)
  })

  it('reads a gs:// or s3:// store as the https URL it stands for (§24.5)', () => {
    expect(readMounting('?store=gs%3A%2F%2Fbucket%2Fshelf.json', AT).store).toBe(
      'https://storage.googleapis.com/storage/v1/b/bucket/o/shelf.json?alt=media',
    )
    expect(readMounting('?config=s3%3A%2F%2Fbucket%2Fsession.json', AT).config).toBe(
      'https://bucket.s3.amazonaws.com/session.json',
    )
  })

  it('refuses a store that is not something to fetch', () => {
    for (const named of ['javascript:alert(1)', 'data:application/json,{}', 'file:///etc/passwd']) {
      expect(readMounting(`?store=${encodeURIComponent(named)}`, AT).store).toBeNull()
    }
    expect(readMounting('?store=', AT).store).toBeNull()
    expect(readMounting('?store=http%3A%2F%2F', AT).store).toBeNull()
  })
})

const AT_VIEW: ViewState = {
  uri: 'https://data.example/f.mcool',
  view: 'genome',
  genome: 'MAG_1',
  locus: 'chrII:1,000-2,000',
}

describe('a navigate from the host page', () => {
  it('lays the patch over what is on screen', () => {
    const next = mergeState(AT_VIEW, { locus: 'chrIV:400,000-460,000' })
    expect(next).toEqual({ ...AT_VIEW, locus: 'chrIV:400,000-460,000' })
  })

  it('takes a key away when it is sent as null', () => {
    // `undefined` does not survive a structured clone, so `null` is the only
    // vocabulary a host has for "no locus".
    expect(mergeState(AT_VIEW, { locus: null })?.locus).toBeUndefined()
  })

  it('opens another file when the patch names one', () => {
    const next = mergeState(AT_VIEW, { uri: 'https://data.example/g.mcool', view: 'genomes' })
    expect(next?.uri).toBe('https://data.example/g.mcool')
    expect(next?.view).toBe('genomes')
  })

  it('is the picker for an explicit null, and for a patch that names no file', () => {
    expect(mergeState(AT_VIEW, null)).toBeNull()
    expect(mergeState(null, { locus: 'chrII:1-2' })).toBeNull()
  })

  it('drops what is not a view-state value rather than stringifying it', () => {
    // Without the filter these arrive as `[object Object]` and `1,2` — legal
    // strings, in keys that take any string, so nothing downstream would refuse
    // them and the map would go somewhere nobody asked for.
    const next = mergeState(AT_VIEW, { genome: { evil: true }, region: [1, 2] })
    expect(next?.genome).toBe('MAG_1')
    expect(next?.region).toBeUndefined()
  })

  it('ignores a key this build does not carry', () => {
    const next = mergeState(AT_VIEW, { nonsense: 'x', locus: 'chrI:1-9' })
    expect(next).toEqual({ ...AT_VIEW, locus: 'chrI:1-9' })
    expect('nonsense' in (next as object)).toBe(false)
  })

  it('holds every value the parser holds a link to', () => {
    // The point of going through `serialiseViewState` → `parseViewState` rather
    // than believing the object: a `view` this build has never heard of falls
    // back exactly as a hand-edited link does, and a smoothing radius it does not
    // offer is dropped rather than run.
    expect(mergeState(AT_VIEW, { view: 'nonsense' })?.view).toBe('genomes')
    expect(mergeState(AT_VIEW, { smooth: '400' })?.smooth).toBeUndefined()
    expect(mergeState(AT_VIEW, { smooth: 3 })?.smooth).toBe('3')
  })

  it('drops a value the address bar cannot carry, rather than throwing on it', () => {
    // A lone surrogate survives a structured clone and is refused by the URI
    // encoder: it used to throw out of the message handler, unanswered. Read as
    // a link, the locus the host sent is unreadable and goes, as an unreadable
    // `locus=` in a link does; the rest of the patch arrives.
    const { locus: _replaced, ...rest } = AT_VIEW
    expect(mergeState(AT_VIEW, { locus: '\uD800', region: 'IV' })).toEqual({ ...rest, region: 'IV' })
  })

  it('carries a boolean through as the hash spells it', () => {
    expect(mergeState(AT_VIEW, { balance: true })?.balance).toBe(true)
    expect(mergeState(AT_VIEW, { balance: false })?.balance).toBe(false)
  })
})
