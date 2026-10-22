// The chromosomix viewer in a notebook cell: the app's embed in an <iframe>,
// and its postMessage channel (SPECS §21.4) between the frame and the kernel.
//
// The kernel names what to show in `src` — a build of the viewer, `?embed=1`,
// the view in the fragment — and the files a fragment has no word for in
// `files`, which go to the frame as `chromosomix:add` once it says it is ready.
// After that the kernel's `navigate` and `add` requests — a numbered list in the
// model, so a view drawn after they were made still makes them — are posted to
// the frame, and the frame's `state` and `rendered` are written back.
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

/** The frame's address, its `uri` and `uri2` made absolute where the kernel gave them relative. */
function frameAddress(src) {
  const url = new URL(src, window.location.href)
  if (url.hash.length > 1) {
    url.hash = url.hash
      .slice(1)
      .split('&')
      .map((part) => {
        const eq = part.indexOf('=')
        const key = eq < 0 ? part : part.slice(0, eq)
        if (key !== 'uri' && key !== 'uri2') return part
        return `${key}=${encodeURIComponent(absolute(decodeURIComponent(part.slice(eq + 1)))).replace(/%2F/g, '/').replace(/%3A/g, ':')}`
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
  const frame = document.createElement('iframe')
  frame.setAttribute('allow', ALLOW)
  frame.style.width = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
  el.appendChild(frame)

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

  const size = () => {
    frame.style.height = `${model.get('height')}px`
    frame.title = model.get('title') || 'chromosomix'
  }
  const post = (message) => frame.contentWindow?.postMessage(message, origin)
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
    if (!ready) return
    for (const request of model.get('requests') || []) {
      if (!(request.seq > posted)) continue
      posted = request.seq
      if (request.type === 'navigate') {
        const state = { ...(request.state || {}) }
        for (const key of ['uri', 'uri2']) if (typeof state[key] === 'string') state[key] = absolute(state[key])
        post({ type: 'chromosomix:navigate', state })
      } else if (request.type === 'add') {
        addFiles((request.files || []).map(absolute))
      }
    }
  }
  const load = () => {
    const src = model.get('src')
    if (!src) return
    const url = frameAddress(src)
    origin = url.origin === 'null' ? '*' : url.origin
    ready = false
    posted = 0
    refused = 0
    notice.hidden = true
    // The files the fragment cannot carry go first once the frame is up: the
    // app waits for the map the fragment names to be drawn before it adds them.
    files = (model.get('files') || []).map(absolute)
    frame.src = url.href
  }

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow) return
    const data = event.data
    if (data === null || typeof data !== 'object' || typeof data.type !== 'string') return
    if (data.type === 'chromosomix:ready') {
      ready = true
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
  model.on('change:src', load)
  model.on('change:height', size)
  model.on('change:title', size)
  size()
  load()

  return () => {
    window.removeEventListener('message', onMessage)
    model.off('change:requests', flush)
    model.off('change:src', load)
    model.off('change:height', size)
    model.off('change:title', size)
  }
}

export default { render }
