// @vitest-environment jsdom
/**
 * The conversation between an embedded viewer and the page holding it.
 *
 * Six messages, and every one of them is a decision about somebody else's page
 * — so what is asserted here is mostly the refusals. A channel that answered a
 * sibling frame, or pushed the reader's own file URL at whoever framed the
 * window, would work perfectly in the demo it was written for and be wrong in
 * the one case it exists to get right.
 *
 * The window is not framed under jsdom, so the parent and the event source are
 * handed over rather than reached for. That is the same seam the app uses —
 * `embedChannel` is the only thing that looks at a real `window` — and it means
 * the protocol is asserted without a second document.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EMBED_ADD,
  EMBED_ADD_MAX,
  EMBED_NAVIGATE,
  EMBED_PROTOCOL,
  EMBED_READY,
  EMBED_STATE,
  EMBED_WHERE,
  EmbedChannel,
  type MessageSource,
  type MessageTarget,
} from '@/app/EmbedChannel'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const HOST = 'https://lab.example'

interface Posted {
  message: { type: string; state?: ViewState | null; protocol?: number }
  origin: string
}

/** The host page: what it was told, and the object a message can claim to be. */
function hostWindow(): MessageTarget & { seen: Posted[] } {
  const seen: Posted[] = []
  return {
    seen,
    postMessage(message: unknown, targetOrigin: string): void {
      seen.push({ message: message as Posted['message'], origin: targetOrigin })
    },
  }
}

/** A `window` to listen on, with a handle on the listener for dispatching. */
function source(): MessageSource & { deliver: (event: MessageEvent) => void } {
  const listeners = new Set<(event: MessageEvent) => void>()
  return {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    deliver: (event) => listeners.forEach((listener) => listener(event)),
  }
}

/** A message as it arrives: `source` is what the frame checks first. */
function message(data: unknown, options: { origin?: string; from?: unknown } = {}): MessageEvent {
  return new MessageEvent('message', {
    data,
    origin: options.origin ?? HOST,
    // jsdom types `source` as a window-ish; the channel only ever compares it.
    source: options.from as MessageEventSource | null,
  })
}

const A: ViewState = { uri: 'https://data.example/f.mcool', view: 'genomes' }

function channelOn(state: ViewState | null = A): {
  channel: EmbedChannel
  parent: ReturnType<typeof hostWindow>
  events: ReturnType<typeof source>
  at: () => ViewState | null
  went: (ViewState | null)[]
  /** The reader moved the view: the state changes, then the channel is told. */
  move: (next: ViewState | null) => void
} {
  const parent = hostWindow()
  const events = source()
  const went: (ViewState | null)[] = []
  let held = state
  const channel = new EmbedChannel(
    {
      state: () => held,
      navigate: (next) => {
        held = next
        went.push(next)
      },
    },
    parent,
    events,
  )
  return {
    channel,
    parent,
    events,
    at: () => held,
    went,
    move: (next) => {
      held = next
      channel.moved()
    },
  }
}

describe('announcing', () => {
  it('says it is ready, once, and says nothing about the session', () => {
    const { channel, parent } = channelOn()
    channel.start()
    channel.start()
    expect(parent.seen).toHaveLength(1)
    const [first] = parent.seen
    expect(first.message.type).toBe(EMBED_READY)
    expect(first.message.protocol).toBe(EMBED_PROTOCOL)
    // The only message posted to everybody, and the reason it can be: it says
    // which build is in the frame and nothing about what is open in it.
    expect(first.origin).toBe('*')
    expect(first.message.state).toBeUndefined()
  })

  it('has nothing to say when no window framed this one', () => {
    const events = source()
    const channel = new EmbedChannel({ state: () => A, navigate: () => {} }, null, events)
    channel.start()
    // Nothing to assert but the absence of a throw and of a listener: a
    // top-level page has a reader rather than a host.
    events.deliver(message({ type: EMBED_WHERE }))
  })
})

describe('being asked where the view is', () => {
  it('answers the host, at the origin the host spoke from', () => {
    const { channel, parent, events } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_WHERE }, { from: parent }))
    const answer = parent.seen[1]
    expect(answer.message.type).toBe(EMBED_STATE)
    expect(answer.message.state).toEqual(A)
    expect(answer.origin).toBe(HOST)
  })

  it('says nothing at all until it has been spoken to', () => {
    const { channel, parent } = channelOn()
    channel.start()
    channel.moved()
    channel.moved()
    // The `ready` message and nothing else: an embed nobody is driving must not
    // post one message per pan at a page that never asked.
    expect(parent.seen.map((post) => post.message.type)).toEqual([EMBED_READY])
  })

  it('tells the host about a move once it has', () => {
    const { channel, parent, events, move } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_WHERE }, { from: parent }))
    move({ ...A, view: 'genome', genome: 'MAG_2' })
    expect(parent.seen).toHaveLength(3)
    const last = parent.seen[2]
    expect(last.message.type).toBe(EMBED_STATE)
    expect((last.message.state as ViewState).genome).toBe('MAG_2')
    expect(last.origin).toBe(HOST)
  })

  it('does not repeat a state the host already has', () => {
    // A repaint that leaves the view where it was is not news, and neither is
    // asking twice. Both would otherwise be a message the host has to compare
    // against the last one itself.
    const { channel, parent, events, move } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_WHERE }, { from: parent }))
    move({ ...A })
    events.deliver(message({ type: EMBED_WHERE }, { from: parent }))
    expect(parent.seen).toHaveLength(2)
  })
})

describe('being driven', () => {
  it('lays a patch over the view and answers with where it landed', () => {
    const { channel, parent, events, at } = channelOn()
    channel.start()
    events.deliver(
      message({ type: EMBED_NAVIGATE, state: { view: 'genome', genome: 'MAG_1' } }, { from: parent }),
    )
    expect(at()).toEqual({ ...A, view: 'genome', genome: 'MAG_1' })
    const answer = parent.seen[1]
    expect(answer.message.type).toBe(EMBED_STATE)
    expect(answer.message.state).toEqual(at())
  })

  it('answers with where it actually went, not where it was asked to go', () => {
    // A `view` this build does not have falls back to `genomes`, exactly as a
    // hand-edited link does — and the host is told the truth about it rather
    // than its own message echoed back.
    const { channel, parent, events } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_NAVIGATE, state: { view: 'nonsense' } }, { from: parent }))
    expect((parent.seen[1].message.state as ViewState).view).toBe('genomes')
  })

  it('goes back to the picker for an explicit null', () => {
    const { channel, parent, events, at } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_NAVIGATE, state: null }, { from: parent }))
    expect(at()).toBeNull()
    expect(parent.seen[1].message.state).toBeNull()
  })

  it('ignores a navigate carrying something that is not a patch', () => {
    const { channel, parent, events, at, went, move } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_NAVIGATE, state: 'chrII' }, { from: parent }))
    expect(went).toHaveLength(0)
    expect(at()).toEqual(A)
    // And it is not answered either: a typo is not a question.
    expect(parent.seen).toHaveLength(1)
    // Nor does it subscribe whoever sent it — refused before the host is
    // recorded, so the reader's next move is still nobody's business.
    move({ ...A, view: 'contigs' })
    expect(parent.seen).toHaveLength(1)
  })
})

describe('who is allowed to speak', () => {
  it('ignores a window that is not the one holding this frame', () => {
    const { channel, parent, events } = channelOn()
    channel.start()
    const sibling = hostWindow()
    events.deliver(message({ type: EMBED_WHERE }, { from: sibling }))
    events.deliver(message({ type: EMBED_WHERE }, { from: null }))
    expect(parent.seen).toHaveLength(1)
  })

  it('ignores a message that is not one of ours', () => {
    const { channel, parent, events } = channelOn()
    channel.start()
    for (const data of [null, 'chromosomix:where', 42, { type: 'other:where' }, { state: A }]) {
      events.deliver(message(data, { from: parent }))
    }
    expect(parent.seen).toHaveLength(1)
  })

  it('answers a host whose origin cannot be named, at the window itself', () => {
    // A `file://` page, or a sandboxed frame without `allow-same-origin`, both
    // report `"null"` — which `postMessage` will not take as a target. The
    // window that just spoke is the only address left, and it is a narrower one
    // than it looks.
    const { channel, parent, events } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_WHERE }, { from: parent, origin: 'null' }))
    expect(parent.seen[1].message.type).toBe(EMBED_STATE)
    expect(parent.seen[1].origin).toBe('*')
  })

  it('forgets who it was talking to when it stops', () => {
    const { channel, parent, events, move } = channelOn()
    channel.start()
    events.deliver(message({ type: EMBED_WHERE }, { from: parent }))
    channel.stop()
    move({ ...A, view: 'contigs' })
    events.deliver(message({ type: EMBED_WHERE }, { from: parent }))
    expect(parent.seen).toHaveLength(2)
  })
})

describe('being handed files (§21.4)', () => {
  /** A channel whose host records what it was asked to add, and when it finished. */
  function adding(): ReturnType<typeof channelOn> & { added: string[][]; finish: () => void } {
    const parent = hostWindow()
    const events = source()
    const added: string[][] = []
    let finish = (): void => {}
    const channel = new EmbedChannel(
      {
        state: () => A,
        navigate: () => {},
        add: (files) => {
          added.push(files)
          return new Promise<void>((done) => {
            finish = done
          })
        },
      },
      parent,
      events,
    )
    return {
      channel,
      parent,
      events,
      at: () => A,
      went: [],
      move: () => {},
      added,
      finish: () => finish(),
    }
  }

  it('hands the host its addresses, in order, and answers once they are in', async () => {
    const view = adding()
    view.channel.start()
    view.events.deliver(message({ type: EMBED_WHERE }, { from: view.parent }))
    const told = view.parent.seen.length
    view.events.deliver(
      message({ type: EMBED_ADD, files: ['https://data.example/a.bw', 'https://data.example/b.bed'] }, { from: view.parent }),
    )
    expect(view.added).toEqual([['https://data.example/a.bw', 'https://data.example/b.bed']])
    // Nothing until the files are in, and then the state — even unchanged, since
    // the answer is what tells the host they are.
    expect(view.parent.seen.length).toBe(told)
    view.finish()
    await new Promise((settled) => setTimeout(settled, 0))
    expect(view.parent.seen.at(-1)).toEqual({ message: { type: EMBED_STATE, state: A }, origin: HOST })
  })

  it('moves the view only once the files sent before the move are in', async () => {
    const parent = hostWindow()
    const events = source()
    const went: Array<ViewState | null> = []
    let at: ViewState = A
    let finish = (): void => {}
    const channel = new EmbedChannel(
      {
        state: () => at,
        navigate: (state) => {
          went.push(state)
          if (state !== null) at = state
        },
        add: () =>
          new Promise<void>((done) => {
            finish = () => {
              // The add opened a browser of tracks: what the move is laid over.
              at = { uri: 'https://data.example/a.bw', view: 'browser' }
              done()
            }
          }),
      },
      parent,
      events,
    )
    channel.start()
    events.deliver(message({ type: EMBED_ADD, files: ['https://data.example/a.bw'] }, { from: parent }))
    events.deliver(message({ type: EMBED_NAVIGATE, state: { locus: 'II:100-200' } }, { from: parent }))
    expect(went).toEqual([])
    finish()
    await new Promise((settled) => setTimeout(settled, 0))
    expect(went).toHaveLength(1)
    expect(went[0]?.view).toBe('browser')
    expect(went[0]?.locus).toBe('II:100-200')
    // With nothing in flight, a move is carried out at once, as it always was.
    events.deliver(message({ type: EMBED_NAVIGATE, state: { locus: 'II:300-400' } }, { from: parent }))
    expect(went).toHaveLength(2)
  })

  it('takes only strings, and no more than a bounded number of them', () => {
    const view = adding()
    view.channel.start()
    const many = Array.from({ length: EMBED_ADD_MAX + 10 }, (_, i) => `https://data.example/${i}.bw`)
    view.events.deliver(message({ type: EMBED_ADD, files: [42, { url: 'x' }, ...many] }, { from: view.parent }))
    expect(view.added[0]).toHaveLength(EMBED_ADD_MAX)
    expect(view.added[0][0]).toBe('https://data.example/0.bw')
  })

  it('ignores an add with nothing in it, and one from a window that is not its host', () => {
    const view = adding()
    view.channel.start()
    view.events.deliver(message({ type: EMBED_ADD, files: 'https://data.example/a.bw' }, { from: view.parent }))
    view.events.deliver(message({ type: EMBED_ADD, files: [] }, { from: view.parent }))
    view.events.deliver(message({ type: EMBED_ADD, files: ['https://data.example/a.bw'] }, { from: hostWindow() }))
    expect(view.added).toEqual([])
  })

  it('ignores an add where the window cannot take one', () => {
    const view = channelOn()
    view.channel.start()
    view.events.deliver(message({ type: EMBED_ADD, files: ['https://data.example/a.bw'] }, { from: view.parent }))
    expect(view.went).toEqual([])
  })
})
