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
import { CONFIG_KIND, CONFIG_VERSION, type SessionConfig } from '@/state/SessionConfig'

function configOf(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    kind: CONFIG_KIND,
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
    const back = await decodeShare(await encodeShare(config))
    expect(back).not.toBeNull()
    // Field by field rather than deep-equal against the input: `parseConfig`
    // fills in every key an older file might have omitted, so a decoded config
    // is a *superset* of a sparse one. What has to survive is what was set.
    expect(back?.state).toEqual(config.state)
    expect(back?.bookmarks).toEqual(config.bookmarks)
    expect(back?.createdAt).toBe(config.createdAt)
    expect(back?.kind).toBe(CONFIG_KIND)
  })

  it('is stable: decoding what it encoded encodes to the same thing again', async () => {
    // The property deep-equality was reaching for, stated in a way the defaults
    // cannot break. If a round trip lost or invented a field, the second pass
    // would differ from the first.
    const once = await decodeShare(await encodeShare(configOf()))
    const twice = await decodeShare(await encodeShare(once as SessionConfig))
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
    const back = await decodeShare(await encodeShare(config))
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

  it('answers null for a payload that inflates to the wrong kind of JSON', async () => {
    // Guarding the *kind* matters: `parseConfig` is what stops a link built from
    // some other application's JSON being opened as a session.
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'))
    const deflated = new Uint8Array(await new Response(stream).arrayBuffer())
    const payload = btoa(String.fromCharCode(...deflated))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(await decodeShare(payload)).toBeNull()
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
    expect(lengthAdvice(20_000)).toMatch(/Saving the session as a file/)
  })
})
