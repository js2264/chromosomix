/**
 * A session in a link, round-tripped.
 *
 * The property that matters is that the *same object* comes back — not an
 * approximation of it, and not a subset. A share link and a saved session file
 * are two encodings of one thing (`state/SessionConfig.ts`), and a link that
 * quietly dropped the bookmarks would look like a working feature to everyone
 * except the person who sent it.
 *
 * The refusals get their own tests for the same reason they do in the tabix
 * suite: a truncated link pasted across two lines by a mail client is the single
 * most likely thing to arrive, and the right answer to it is the picker with a
 * sentence, not a stack trace.
 */

import { describe, expect, it } from 'vitest'

import {
  SHARE_KEY,
  decodeShare,
  encodeShare,
  lengthAdvice,
  readShareHash,
  shareUrl,
  shortenable,
} from '@/state/shareLink'
import { MAPS_SEPARATOR, VACANT } from '@/panels/deck'
import {
  CONFIG_VERSION,
  isRefusal,
  type ConfigRefusal,
  type SessionConfig,
} from '@/state/SessionConfig'
import { WORKSPACE_KIND } from '@/state/workspace'

/**
 * The session a link decoded to, or `null`.
 *
 * `decodeShare` now separates *the link did not survive the journey* (`null`)
 * from *it arrived intact and this build will not read it* (a refusal), because
 * only the first is the link's fault. These tests are about the first road, so
 * they narrow to the session and let a refusal read as a failure.
 */
function decoded(value: SessionConfig | ConfigRefusal | null): SessionConfig | null {
  return value === null || isRefusal(value) ? null : value
}

/**
 * What a payload actually holds, undone by hand.
 *
 * `decodeShare` answers with the one tab, which is the right answer for every
 * caller and the wrong one for a test about the *envelope*: it is the wrapper —
 * the kind, the version, the single tab — that makes a link refusable by the
 * same code a file is, and only this reaches it.
 */
async function inflated(payload: string): Promise<Record<string, any>> {
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()))
}

function configOf(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    version: CONFIG_VERSION,
    createdAt: '2026-08-12T09:00:00.000Z',
    state: {
      uri: 'https://bucket.example.org/Hum53.metacool',
      view: 'genome',
      genome: 'MAG_12',
    },
    tracks: [],
    manual: [],
    bookmarks: [],
    ...overrides,
  } as SessionConfig
}

describe('a session in a fragment', () => {
  it('comes back as the object that went in', async () => {
    const config = configOf({
      bookmarks: [
        { id: 'b1', label: 'the loop', contig: 'chrI', start: 1_200_000, end: 1_260_000, binsize: 1000 },
        { id: 'b2', label: 'boundary', contig: 'chrII', start: 40_000, end: 60_000, binsize: 5000 },
      ],
    })
    const back = decoded(await decodeShare(await encodeShare(config)))
    expect(back).not.toBeNull()
    // Field by field rather than deep-equal against the input: `parseTab` fills
    // in every key an older file might have omitted, so a decoded config is a
    // *superset* of a sparse one. What has to survive is what was set.
    expect(back?.state).toEqual(config.state)
    expect(back?.bookmarks).toEqual(config.bookmarks)
    expect(back?.createdAt).toBe(config.createdAt)
  })

  it('travels as a workspace of one tab, which is the file’s own format', async () => {
    // One parser rather than two. The wrapper costs a few dozen bytes after
    // deflate and buys a link that is refused by the same code a file is —
    // including the version gate, which a link had no way to apply before.
    //
    // One tab and not the window: `lengthAdvice` already warns past about eight
    // thousand characters and a single session with eight tracks is a few
    // thousand, so a link carrying six tabs would open by telling the reader not
    // to use it.
    const file = await inflated(await encodeShare(configOf()))
    expect(file.kind).toBe(WORKSPACE_KIND)
    expect(file.tabs).toHaveLength(1)
    expect(file.active).toBe(0)
  })

  it('is stable: decoding what it encoded encodes to the same thing again', async () => {
    // The property deep-equality was reaching for, stated in a way the defaults
    // cannot break. If a round trip lost or invented a field, the second pass
    // would differ from the first.
    const once = decoded(await decodeShare(await encodeShare(configOf())))
    const twice = decoded(await decodeShare(await encodeShare(once as SessionConfig)))
    expect(twice).toEqual(once)
  })

  it('survives a workspace rather than only a view', async () => {
    // The case the file format exists for, and therefore the case the link has
    // to carry: eight tracks with their colours, limits and placements.
    const tracks = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      card: 'linear',
      kind: 'track',
      label: `signal ${i}`,
      visible: true,
      placement: { top: false, right: i % 2 === 0, bottom: i % 2 === 1, left: false },
      style: { colour: `#${(i * 111111).toString(16).padStart(6, '0')}`, height: 40 + i },
      source: { kind: 'remote', name: `s${i}.bw`, url: `https://x/${i}.bw` },
    }))
    const config = configOf({ tracks: tracks as unknown as SessionConfig['tracks'] })
    const back = decoded(await decodeShare(await encodeShare(config)))
    expect(back?.tracks).toHaveLength(8)
    expect(back?.tracks).toEqual(config.tracks)
  })

  it('is shorter than the JSON it carries, which is the whole reason to deflate', async () => {
    const config = configOf({
      bookmarks: Array.from({ length: 40 }, (_, i) => ({
        id: `b${i}`,
        label: `peak ${i}`,
        contig: 'chrI',
        start: i * 10_000,
        end: i * 10_000 + 5_000,
        binsize: 1000,
      })),
    })
    const payload = await encodeShare(config)
    // Forty bookmarks compress well — they are the same sentence forty times —
    // which is exactly the shape a workspace has.
    expect(payload.length).toBeLessThan(JSON.stringify(config).length / 2)
  })

  it('uses only characters that survive being pasted', async () => {
    // `+` and `/` are legal in a fragment and are routinely percent-encoded by
    // something between the two people. base64url has neither, and no padding.
    const payload = await encodeShare(configOf())
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('reading a link', () => {
  it('finds the payload in a fragment', () => {
    expect(readShareHash('#s=abc')).toBe('abc')
    expect(readShareHash('s=abc')).toBe('abc')
    expect(readShareHash(`#other=1&${SHARE_KEY}=abc`)).toBe('abc')
  })

  it('finds none in an ordinary view state, which shares the fragment', () => {
    // The reason `readHash` asks this first: a view state is `key=value` pairs
    // in the same place, and the two must not be confused in either direction.
    expect(readShareHash('#uri=file.cool&view=contigs')).toBeNull()
    expect(readShareHash('')).toBeNull()
    expect(readShareHash('#')).toBeNull()
  })

  it('builds a link onto a page address, replacing any fragment already there', () => {
    expect(shareUrl('https://js2264.github.io/metacooler.js/', 'PAY')).toBe(
      'https://js2264.github.io/metacooler.js/#s=PAY',
    )
    expect(shareUrl('https://x/y#uri=old', 'PAY')).toBe('https://x/y#s=PAY')
  })

  it('answers null for a link that was cut short in transit', async () => {
    const payload = await encodeShare(configOf())
    expect(await decodeShare(payload.slice(0, Math.floor(payload.length / 2)))).toBeNull()
  })

  it('answers null for something that is not one at all', async () => {
    expect(await decodeShare('not-base64-and-not-deflate')).toBeNull()
    expect(await decodeShare('')).toBeNull()
  })

  it('carries none of the three things a link may not carry', async () => {
    // Each of these is already *claimed* to be absent from a link by a comment
    // somewhere else in the codebase, and none of them was. A local companion
    // and a local compared file are bare filenames from the sender's disk: a
    // recipient who has ever granted their own `rep2.cool` would open *their*
    // file in the sender's slot, because the grant store is keyed on the bare
    // name. `source` is the size and mtime of a private disk.
    const config = configOf({
      compare: 'secret.cool',
      source: { name: 'rep1.cool', size: 4_200_000_000, lastModified: 1_700_000_000_000 },
      deck: { starred: 'p2', columns: 3, locals: [{ index: 1, uri: 'rep2.cool' }] },
      state: { uri: 'lead.cool', view: 'region', maps: `a.cool${MAPS_SEPARATOR}${VACANT}` },
    } as Partial<SessionConfig>)

    const payload = await encodeShare(config)
    // Asserted against the *encoded text* as well as the decoded object: the
    // point is that the name never leaves the machine, not merely that the
    // reader on the other end ignores it.
    const json = JSON.stringify(decoded(await decodeShare(payload)))
    expect(json).not.toContain('secret.cool')
    expect(json).not.toContain('rep2.cool')
    expect(json).not.toContain('rep1.cool')

    const back = decoded(await decodeShare(payload))
    expect(back?.compare).toBeUndefined()
    expect(back?.source).toBeUndefined()
    expect(back?.deck.locals).toBeUndefined()
    // The arrangement is not private and stays.
    expect(back?.deck).toEqual({ starred: 'p2', columns: 3 })
    // …and the slot the dropped companion held is still in the deck, so the
    // recipient gets a drop rectangle rather than a deck one map short.
    expect(back?.state.maps).toBe(`a.cool${MAPS_SEPARATOR}${VACANT}`)
  })

  it('keeps a local track, because dropping one would lose the row', async () => {
    // The rule that decides all four: a private name is stripped only where the
    // structure survives without it.
    const config = configOf({
      tracks: [
        { id: 'a1', card: 'linear', kind: 'track', label: 'dropped', visible: true, placement: {}, style: {}, source: { kind: 'local', name: 'ATAC.bw' } },
      ] as unknown as SessionConfig['tracks'],
    })
    const back = decoded(await decodeShare(await encodeShare(config)))
    expect(back?.tracks).toHaveLength(1)
    expect(back?.tracks[0].source).toEqual({ kind: 'local', name: 'ATAC.bw' })
  })

  /** Deflate and base64url an arbitrary object, as `encodeShare` would. */
  async function payloadOf(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'))
    const deflated = new Uint8Array(await new Response(stream).arrayBuffer())
    return btoa(String.fromCharCode(...deflated))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('refuses a payload that inflates to the wrong kind of JSON, and says which', async () => {
    // Guarding the *kind* matters: it is what stops a link built from some other
    // application's JSON being opened as a session. It answers with a **reason**
    // rather than `null`, because `null` is reserved for the one failure that is
    // the link's own fault — see below.
    expect(await decodeShare(await payloadOf({ hello: 'world' }))).toEqual({
      reason: 'not-a-workspace',
    })
    // A bare tab is not a workspace either. It is the shape a link carried
    // before the two formats were made one, so it is worth pinning that it is
    // refused rather than half-read.
    expect(await decodeShare(await payloadOf({ state: { uri: 'a.cool' } }))).toEqual({
      reason: 'not-a-workspace',
    })
  })

  it('separates a link that did not survive from one this build will not read', async () => {
    // The distinction the reader actually needs. A truncated payload is the
    // link's fault and a fresh copy fixes it. A session from a newer build
    // travelled perfectly, and telling its recipient the link was cut short
    // sends them back to the sender for a copy that will fail identically.
    expect(await decodeShare('not-base64-and-not-deflate')).toBeNull()
    const newer = await decodeShare(
      await payloadOf({
        kind: WORKSPACE_KIND,
        version: CONFIG_VERSION + 1,
        active: 0,
        tabs: [{ state: { uri: 'a.cool' } }],
      }),
    )
    expect(newer).toMatchObject({ reason: 'newer', version: CONFIG_VERSION + 1 })
  })
})

describe('what is offered to a shortener', () => {
  it('offers a remote session, which a recipient can actually open', () => {
    expect(shortenable(configOf())).toBe(true)
    expect(shortenable(configOf({ state: { uri: 's3://bucket/x.mcool' } as SessionConfig['state'] }))).toBe(
      true,
    )
  })

  it('refuses a local one, which would post a filename for nothing', () => {
    // The long link is still worth having — the recipient gets the tracks and
    // the marks and is asked for the file — but there is nothing for a third
    // party to shorten that anybody else could open.
    expect(shortenable(configOf({ state: { uri: 'Hum53.metacool' } as SessionConfig['state'] }))).toBe(
      false,
    )
  })
})

describe('saying how long the link is', () => {
  it('says nothing about one that will paste anywhere', () => {
    expect(lengthAdvice(300)).toBeNull()
    expect(lengthAdvice(2000)).toBeNull()
  })

  it('warns about the range some clients wrap', () => {
    expect(lengthAdvice(4000)).toMatch(/wrap or truncate/)
  })

  it('recommends the file for one that is not going to survive', () => {
    expect(lengthAdvice(20_000)).toMatch(/Saving the workspace as a file/)
  })
})
