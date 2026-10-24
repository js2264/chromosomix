// The chromosomix viewer in a notebook cell: the app's embed in an <iframe>,
// and its postMessage channel (SPECS §21.4) between the frame and the kernel.
//
// The kernel names what to show in `src` — a build of the viewer, `?embed=1`,
// the view in the fragment — and the files a fragment has no word for in
// `files`, which go to the frame as `chromosomix:add` once it says it is ready.
// After that the kernel's `navigate` and `add` requests — a numbered list in the
// model, so a view drawn after they were made still makes them — are posted to
// the frame, and the frame's `state` and `rendered` are written back. Each
// `load()` in Python counts one more in `loads`, and each puts a new <iframe>
// in the place of the last.
//
// A frame that cannot take files — a build from before `chromosomix:add`, whose
// `ready` lists no `accepts` (SPECS §21.4) — draws the map without its tracks,
// so the cell says so above the frame, and `notice` tells Python, rather than
// the tracks going missing without a word.
//
// An address the kernel gives may be relative to the page the notebook is on —
// a JupyterHub's `proxy/<port>/` path to the kernel's file server — so every
// one is made absolute here, against this page, before the frame sees it.

const ALLOW = 'clipboard-write; fullscreen; local-network-access; local-network; loopback-network'
/** What a `ready` without an `accepts` list means: a build from before `add`. */
const BEFORE_ADD = ['chromosomix:where', 'chromosomix:navigate']

function absolute(address) {
  try {
    return new URL(address, window.location.href).href
  } catch {
    return address
  }
}

/** The view state's keys that name files: a map, its comparison, and a deck's maps, split by `|`. */
const FILE_KEYS = ['uri', 'uri2', 'maps']
/** The deck's own words in `maps`, which name a cell rather than a file (`panels/deck.ts`). */
const DECK_WORDS = ['~', '3d', 'tracks']

/** A file key's value with every address in it made absolute, and a deck's own words as they are. */
function absoluteFiles(key, value) {
  if (key !== 'maps') return absolute(value)
  return value
    .split('|')
    .map((part) => (part.trim() === '' || DECK_WORDS.includes(part.trim()) ? part : absolute(part)))
    .join('|')
}

/** The frame's address, the files in its fragment made absolute where the kernel gave them relative. */
function frameAddress(src) {
  const url = new URL(src, window.location.href)
  if (url.hash.length > 1) {
    url.hash = url.hash
      .slice(1)
      .split('&')
      .map((part) => {
        const eq = part.indexOf('=')
        const key = eq < 0 ? part : part.slice(0, eq)
        if (eq < 0 || !FILE_KEYS.includes(key)) return part
        const value = absoluteFiles(key, decodeURIComponent(part.slice(eq + 1)))
        return `${key}=${encodeURIComponent(value).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%7C/g, '|')}`
      })
      .join('&')
  }
  return url
}

function render({ model, el }) {
  const notice = document.createElement('div')
  notice.setAttribute('role', 'status')
  notice.hidden = true
  notice.style.cssText =
    'padding:0.4rem 0.6rem;margin:0 0 0.3rem;border-left:3px solid #c77c02;background:rgba(199,124,2,0.1);' +
    'font:13px/1.4 system-ui,sans-serif'
  el.appendChild(notice)
  /** The frame on screen, a new element for each load. */
  let frame = null

  let origin = '*'
  let ready = false
  /** The files the fragment cannot carry, for the frame once it is ready. */
  let files = []
  /** The number of the last request this view posted to its frame. */
  let posted = 0
  /** The messages the frame said it takes. */
  let accepts = BEFORE_ADD
  /** The viewer's version, as its `ready` said. */
  let version = ''
  /** Files the frame could not take since it loaded. */
  let refused = 0
  /** The `loads` the frame on screen was made for. */
  let loaded = model.get('loads')

  const size = () => {
    if (frame === null) return
    frame.style.height = `${model.get('height')}px`
    frame.title = model.get('title') || 'chromosomix'
  }
  const post = (message) => frame?.contentWindow?.postMessage(message, origin)
  /** Files for the frame: added where it takes them, said on the page where it does not. */
  const addFiles = (files) => {
    if (files.length === 0) return
    if (accepts.includes('chromosomix:add')) {
      post({ type: 'chromosomix:add', files })
      return
    }
    refused += files.length
    const text =
      `The viewer in this frame (chromosomix ${version || 'from an older release'}) cannot take files from ` +
      `the notebook, so ${refused === 1 ? '1 file was' : `${refused} files were`} not added. A viewer from ` +
      '0.17.0 on takes them: chromosomix.install_viewer(), or viewer= a newer build.'
    notice.textContent = text
    notice.hidden = false
    model.set('notice', text)
    model.save_changes()
  }
  /** Every request past the last this view posted, once its frame is ready. */
  const flush = () => {
    // Requests made for a newer load are for the frame about to replace this one.
    if (!ready || model.get('loads') !== loaded) return
    for (const request of model.get('requests') || []) {
      if (!(request.seq > posted)) continue
      const previous = posted
      posted = request.seq
      if (request.type === 'navigate') {
        // A merged patch whose earlier part this view has made already: only
        // what was asked since, so a key the reader changed meanwhile stays.
        const since = request.after !== undefined && request.after <= previous
        const state = { ...((since ? request.fresh : request.state) || {}) }
        for (const key of FILE_KEYS) if (typeof state[key] === 'string') state[key] = absoluteFiles(key, state[key])
        post({ type: 'chromosomix:navigate', state })
      } else if (request.type === 'add') {
        addFiles((request.files || []).map(absolute))
      }
    }
  }
  const load = () => {
    loaded = model.get('loads')
    ready = false
    posted = 0
    refused = 0
    notice.hidden = true
    // A new element rather than a new `src` on the old one. A `src` that
    // differs only in its fragment is a move within the same document, which
    // says no `ready`, and the same `src` again is no load at all; and a
    // message the old document was still sending comes from a window that is
    // no longer this frame's, so it is not taken for the new one's.
    const next = document.createElement('iframe')
    next.setAttribute('allow', ALLOW)
    next.style.width = '100%'
    next.style.border = '0'
    next.style.display = 'block'
    const src = model.get('src')
    if (src) {
      const url = frameAddress(src)
      origin = url.origin === 'null' ? '*' : url.origin
      // The files the fragment cannot carry go first once the frame is up: the
      // app waits for the map the fragment names to be drawn before it adds them.
      files = (model.get('files') || []).map(absolute)
      next.src = url.href
    }
    if (frame === null) el.appendChild(next)
    else frame.replaceWith(next)
    frame = next
    size()
  }

  const onMessage = (event) => {
    if (frame === null || event.source !== frame.contentWindow) return
    const data = event.data
    if (data === null || typeof data !== 'object' || typeof data.type !== 'string') return
    if (data.type === 'chromosomix:ready') {
      ready = true
      // Answered where the frame's document is, which is not always where
      // `src` named: a viewer's address that redirects — http to https, a
      // build that moved — puts it on another origin, and every message aimed
      // at the one named would be dropped without a word. An opaque origin
      // cannot be named, and keeps the target it had.
      if (typeof event.origin === 'string' && event.origin !== '' && event.origin !== 'null') origin = event.origin
      // A frame that says it is ready has just loaded `src`, and nothing asked
      // of the last one is on it: the first time, or again when the notebook
      // detached the output and put it back, which reloads an <iframe>. Every
      // request is made again, in order, so it ends where Python last put it.
      posted = 0
      refused = 0
      accepts = Array.isArray(data.accepts) ? data.accepts : BEFORE_ADD
      version = String(data.version ?? '')
      model.set('version', version)
      model.save_changes()
      // Speaking first is what subscribes this page to the frame's states.
      post({ type: 'chromosomix:where' })
      addFiles(files)
      flush()
    } else if (data.type === 'chromosomix:state') {
      model.set('state', data.state ?? null)
      model.save_changes()
    } else if (data.type === 'chromosomix:rendered') {
      model.set('rendered', data.report ?? {})
      model.save_changes()
    }
  }

  window.addEventListener('message', onMessage)
  model.on('change:requests', flush)
  model.on('change:loads', load)
  model.on('change:height', size)
  model.on('change:title', size)
  load()

  return () => {
    window.removeEventListener('message', onMessage)
    model.off('change:requests', flush)
    model.off('change:loads', load)
    model.off('change:height', size)
    model.off('change:title', size)
  }
}

export default { render }
