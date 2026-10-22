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
// An address the kernel gives may be relative to the page the notebook is on —
// a JupyterHub's `proxy/<port>/` path to the kernel's file server — so every
// one is made absolute here, against this page, before the frame sees it.

const ALLOW = 'clipboard-write; fullscreen; local-network-access; local-network; loopback-network'

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

  const size = () => {
    frame.style.height = `${model.get('height')}px`
    frame.title = model.get('title') || 'chromosomix'
  }
  const post = (message) => frame.contentWindow?.postMessage(message, origin)
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
        post({ type: 'chromosomix:add', files: (request.files || []).map(absolute) })
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
      model.set('version', String(data.version ?? ''))
      model.save_changes()
      // Speaking first is what subscribes this page to the frame's states.
      post({ type: 'chromosomix:where' })
      if (files.length > 0) post({ type: 'chromosomix:add', files })
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
