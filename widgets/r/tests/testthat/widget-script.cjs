// The widget's script (inst/htmlwidgets/chromosomix.js), run in Node against a
// stand-in for the page — elements, frames that record what they are posted,
// htmlwidgets and Shiny — and asked what it sends the frame. Run by
// test-widget-script.R: `node widget-script.cjs <chromosomix.js>`; it exits
// non-zero, saying which check failed, if one does.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(process.argv[2], 'utf8')

/** A page with the widget's script loaded on it, in Shiny or not. */
function page({ shiny = false } = {}) {
  const listeners = []
  const elements = {}
  const instances = new Map()
  const handlers = {}
  const inputs = {}
  let definition = null

  const node = (tag) => ({
    tagName: tag.toUpperCase(),
    style: {},
    attributes: {},
    hidden: false,
    textContent: '',
    setAttribute(key, value) {
      this.attributes[key] = value
    },
  })
  const document = {
    createElement(tag) {
      const made = node(tag)
      if (tag === 'iframe') {
        made.sent = []
        made.contentWindow = {
          postMessage(message, origin) {
            made.sent.push({ message: JSON.parse(JSON.stringify(message)), origin })
          },
        }
      }
      return made
    },
    getElementById: (id) => elements[id] ?? null,
  }
  const window = {
    location: { href: 'http://host.example/page/index.html' },
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener)
    },
  }
  const Shiny = {
    setInputValue(name, value) {
      inputs[name] = value
    },
    addCustomMessageHandler(type, handler) {
      handlers[type] = handler
    },
  }
  if (shiny) window.Shiny = Shiny
  const HTMLWidgets = {
    shinyMode: shiny,
    widget(def) {
      definition = def
    },
    getInstance: (el) => instances.get(el),
  }
  vm.runInNewContext(source, { window, document, HTMLWidgets, Shiny, URL, console })

  const frameOf = (el) => el.children.find((child) => child.tagName === 'IFRAME')
  const say = (el, data, origin = 'https://chromosomix.app') => {
    const frame = frameOf(el)
    for (const listener of listeners) listener({ source: frame.contentWindow, origin, data })
  }
  return {
    inputs,
    /** An output's element, put on the page, and its widget made — or not yet. */
    element(id, { made = true } = {}) {
      const el = {
        id,
        style: {},
        children: [],
        appendChild(child) {
          this.children.push(child)
          return child
        },
        replaceChild(next, old) {
          const at = this.children.indexOf(old)
          assert.ok(at >= 0, 'replaceChild: not a child')
          this.children[at] = next
          // A frame taken off the page has no window any more.
          old.contentWindow = null
          return old
        },
      }
      elements[id] = el
      if (made) instances.set(el, definition.factory(el, 800, 600))
      return el
    },
    make(el) {
      instances.set(el, definition.factory(el, 800, 600))
    },
    widget: (el) => instances.get(el),
    frameOf,
    ready: (el, origin, accepts = ['chromosomix:where', 'chromosomix:navigate', 'chromosomix:add']) =>
      say(el, { type: 'chromosomix:ready', protocol: 1, version: '0.17.0', accepts }, origin),
    readyWithout: (el) => say(el, { type: 'chromosomix:ready', protocol: 1, version: '0.16.0' }),
    state: (el, state) => say(el, { type: 'chromosomix:state', state }),
    /** A custom message from a proxy, as Shiny hands it over. */
    proxy: (id, request) => handlers['chromosomix-request']({ id, request }),
    /** What a frame was posted since it was last asked, and from where to where. */
    sent(el) {
      const frame = frameOf(el)
      return frame.sent.splice(0)
    },
  }
}

const messages = (sent) => sent.map((each) => each.message)
const x = (more = {}) => ({
  src: 'https://chromosomix.app/?embed=1#uri=https://d.example/a.cool&view=region&region=IV:1-2',
  files: [],
  title: 'chromosomix',
  base: 'https://chromosomix.app/',
  browser: false,
  requests: [],
  ...more,
})

const checks = []
const check = (name, body) => checks.push([name, body])

check('every value is drawn in a new frame, the notice kept above it', () => {
  const p = page()
  const el = p.element('w')
  const notice = el.children[0]
  const first = p.frameOf(el)
  p.widget(el).renderValue(x())
  const drawn = p.frameOf(el)
  assert.notEqual(drawn, first)
  assert.equal(drawn.src, 'https://chromosomix.app/?embed=1#uri=https://d.example/a.cool&view=region&region=IV:1-2')
  assert.equal(drawn.style.flex, '1 1 auto')
  // The same value again — a `src` that a frame given it would not load again.
  p.widget(el).renderValue(x())
  const again = p.frameOf(el)
  assert.notEqual(again, drawn)
  assert.equal(again.src, drawn.src)
  assert.deepEqual(el.children, [notice, again])
  assert.equal(el.style.display, 'flex')
  assert.equal(el.style.flexDirection, 'column')
  p.ready(el)
  assert.deepEqual(messages(p.sent(el)), [{ type: 'chromosomix:where' }])
})

check('the origin is the one the frame says it is ready from, unless that is opaque', () => {
  const p = page()
  const el = p.element('w')
  p.widget(el).renderValue(x())
  p.ready(el, 'https://moved.example')
  assert.deepEqual(p.sent(el).map((each) => each.origin), ['https://moved.example'])
  p.widget(el).renderValue(x())
  p.ready(el, 'null')
  assert.deepEqual(p.sent(el).map((each) => each.origin), ['https://chromosomix.app'])
})

check('a goto is a patch as it is laid on, and patches in a row are one', () => {
  const p = page()
  const el = p.element('w')
  p.widget(el).renderValue(
    x({
      files: ['https://d.example/a.bw'],
      requests: [
        { type: 'goto', where: 'IV:10-20' },
        { type: 'navigate', state: { transform: 'log2', vmax: {}, genomes: ['a', 'b'] } },
        { type: 'add', files: ['https://d.example/b.bw'] },
        { type: 'add', files: ['https://d.example/c.bw'] },
        { type: 'navigate', state: { oe: 'true', transform: null } },
        { type: 'goto', where: 'IV:30-40' },
      ],
    }),
  )
  p.ready(el)
  assert.deepEqual(messages(p.sent(el)), [
    { type: 'chromosomix:where' },
    { type: 'chromosomix:add', files: ['https://d.example/a.bw'] },
    {
      type: 'chromosomix:navigate',
      // `{}` is R's NULL, a key taken away; an array is not.
      state: { view: 'region', region: 'IV:10-20', region2: null, focus: null, transform: 'log2', vmax: null, genomes: ['a', 'b'] },
    },
    // Additions are never merged nor dropped.
    { type: 'chromosomix:add', files: ['https://d.example/b.bw'] },
    { type: 'chromosomix:add', files: ['https://d.example/c.bw'] },
    {
      type: 'chromosomix:navigate',
      state: { oe: 'true', transform: null, view: 'region', region: 'IV:30-40', region2: null, focus: null },
    },
  ])

  // From a proxy, after: its keys alone go now, and the frame, reloaded, is
  // sent the two patches as one.
  p.widget(el).ask({ type: 'navigate', state: { transform: 'log10', uri2: 'files/b.cool' } })
  assert.deepEqual(messages(p.sent(el)), [
    { type: 'chromosomix:navigate', state: { transform: 'log10', uri2: 'http://host.example/page/files/b.cool' } },
  ])
  p.ready(el)
  assert.deepEqual(messages(p.sent(el)).slice(-1), [
    {
      type: 'chromosomix:navigate',
      state: {
        oe: 'true',
        transform: 'log10',
        view: 'region',
        region: 'IV:30-40',
        region2: null,
        focus: null,
        uri2: 'http://host.example/page/files/b.cool',
      },
    },
  ])
  assert.equal(messages(p.sent(el)).length, 0)
})

check('a goto places a 1D browser: as it opened, then as the frame says it is', () => {
  const p = page()
  const el = p.element('w')
  p.widget(el).renderValue(x({ browser: true, requests: [{ type: 'goto', where: 'IV:1-2' }] }))
  p.ready(el)
  assert.deepEqual(messages(p.sent(el)).slice(-1), [{ type: 'chromosomix:navigate', state: { locus: 'IV:1-2' } }])
  p.state(el, { uri: 'https://d.example/a.cool', view: 'region' })
  p.widget(el).ask({ type: 'add', files: ['https://d.example/x.bw'] })
  p.widget(el).ask({ type: 'goto', where: 'IV:3-4' })
  assert.deepEqual(messages(p.sent(el)), [
    { type: 'chromosomix:add', files: ['https://d.example/x.bw'] },
    { type: 'chromosomix:navigate', state: { view: 'region', region: 'IV:3-4', region2: null, focus: null } },
  ])
})

check('a proxy request before its widget is drawn is made after the widget\'s own', () => {
  const p = page({ shiny: true })
  // Before the output is on the page, and once it is but not yet drawn.
  p.proxy('w', { type: 'goto', where: 'IV:5-6' })
  p.proxy('w', { type: 'add', files: ['https://d.example/m.g3d'] })
  const el = p.element('w', { made: false })
  p.proxy('w', { type: 'navigate', state: { oe: 'true' } })
  p.make(el)
  p.proxy('w', { type: 'navigate', state: { vmax: '3' } })
  p.widget(el).renderValue(x({ requests: [{ type: 'navigate', state: { transform: 'log2' } }] }))
  p.ready(el)
  assert.deepEqual(messages(p.sent(el)), [
    { type: 'chromosomix:where' },
    {
      type: 'chromosomix:navigate',
      state: { transform: 'log2', view: 'region', region: 'IV:5-6', region2: null, focus: null },
    },
    { type: 'chromosomix:add', files: ['https://d.example/m.g3d'] },
    { type: 'chromosomix:navigate', state: { oe: 'true', vmax: '3' } },
  ])
  assert.equal(p.inputs.w_version, '0.17.0')
  // Held once: drawn again, the widget has only its new value's.
  p.widget(el).renderValue(x())
  p.ready(el)
  assert.deepEqual(messages(p.sent(el)), [{ type: 'chromosomix:where' }])
})

check('a frame too old to take files says so above the new frame', () => {
  const p = page({ shiny: true })
  const el = p.element('w')
  p.widget(el).renderValue(x({ files: ['https://d.example/a.bw', 'https://d.example/b.bw'] }))
  p.readyWithout(el)
  assert.deepEqual(messages(p.sent(el)), [{ type: 'chromosomix:where' }])
  const notice = el.children[0]
  assert.equal(notice.hidden, false)
  assert.match(notice.textContent, /chromosomix 0\.16\.0\) cannot take files from R, so 2 files were not added/)
  assert.equal(p.inputs.w_notice, notice.textContent)
  p.widget(el).renderValue(x())
  assert.equal(notice.hidden, true)
})

let failed = 0
for (const [name, body] of checks) {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.log(`not ok - ${name}\n${error.stack}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
