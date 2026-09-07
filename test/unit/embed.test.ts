/**
 * The two strings an embed is configured with, and the one it is driven by.
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
import type { ViewState } from '@/types'

const AT = 'https://viewer.example/app/'

describe('reading a mount', () => {
  it('is a plain window when nothing is asked for', () => {
    expect(readMounting('', AT)).toEqual({ embed: false, config: null })
    expect(readMounting('?other=1', AT)).toEqual({ embed: false, config: null })
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
    expect(readMounting('?config=figure.metacooler.json', AT).config).toBe(
      'https://viewer.example/app/figure.metacooler.json',
    )
  })

  it('keeps an absolute config as it was written', () => {
    const url = 'https://data.example/demo/yeast/Yeast_tracks.metacooler.json'
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

  it('reads both keys off one query string', () => {
    expect(readMounting('?embed=1&config=s.json&edges=e.tsv', AT)).toEqual({
      embed: true,
      config: 'https://viewer.example/app/s.json',
    })
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

  it('carries a boolean through as the hash spells it', () => {
    expect(mergeState(AT_VIEW, { balance: true })?.balance).toBe(true)
    expect(mergeState(AT_VIEW, { balance: false })?.balance).toBe(false)
  })
})
