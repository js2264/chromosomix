/* global HTMLWidgets, Shiny */
// The chromosomix viewer as an htmlwidget: the app's embed in an <iframe>, and
// its postMessage channel (SPECS §21.4) between the frame and R. The same frame
// and the same conversation as the Jupyter widget's
// (widgets/python/src/chromosomix/static/widget.js), with R's two ways in:
//
// - `x`, from `chromosomix()`: the frame's address — a build of the viewer,
//   `?embed=1`, the view in the fragment — the files a fragment has no word for,
//   which go to the frame as `chromosomix:add` once it says it is ready, and the
//   requests laid on the widget before it was drawn;
// - in Shiny, requests through `chromosomixProxy()`, as custom messages. One
//   that arrives before its widget is drawn — an output not yet bound, or bound
//   and not yet given its value — is kept, and made after the widget's own.
//
// Every request is made in order, and all of them again when the frame
// reloads — it has loaded `src` again, and nothing asked of the last one is on
// it. A `goto` is made a patch as it is laid on: the map's `region`, or the 1D
// browser's `locus`. Patches in a row are one patch, so a reload replays where
// the view was sent rather than every step on the way. What the frame says
// comes back, in Shiny, as `input$<id>_state`, `input$<id>_rendered` and
// `input$<id>_version`.
//
// Every value is drawn in a new <iframe>. An old one given a `src` that differs
// only in its fragment — another region of the same map — or not at all would
// not load again, would never say it is ready, and would take nothing after.
//
// A frame that cannot take files — a build from before `chromosomix:add`, whose
// `ready` lists no `accepts` (SPECS §21.4) — draws the map without its tracks,
// so the widget says so above the frame, and in Shiny as `input$<id>_notice`,
// rather than the tracks going missing without a word.
//
// An address R gives may be relative to the page — a proxy's path to the R
// session's file server — so every one is made absolute here, against this
// page, before the frame sees it.
//
// The reader can change the widget's height with the grip under the frame's
// corner, dragged or stepped by the arrow keys, as the documentation's live
// views resize theirs and the Jupyter widget its own (SPECS §21.5). In Shiny the
// height they leave it at comes back as `input$<id>_height`.

(function () {
  var ALLOW = 'clipboard-write; fullscreen; local-network-access; local-network; loopback-network'
  /** What a `ready` without an `accepts` list means: a build from before `add`. */
  var BEFORE_ADD = ['chromosomix:where', 'chromosomix:navigate']
  /** Requests a proxy made of an output before its widget was drawn, by the output's id. */
  var early = {}

  function hold(id, request) {
    if (!Object.prototype.hasOwnProperty.call(early, id)) early[id] = []
    early[id].push(request)
  }

  function take(id) {
    if (!id || !Object.prototype.hasOwnProperty.call(early, id)) return []
    var held = early[id]
    delete early[id]
    return held
  }

  function absolute(address) {
    try {
      return new URL(address, window.location.href).href
    } catch (error) {
      return address
    }
  }

  /** The frame's address, its `uri` and `uri2` made absolute where R gave them relative. */
  function frameAddress(src) {
    var url = new URL(src, window.location.href)
    if (url.hash.length > 1) {
      url.hash = url.hash
        .slice(1)
        .split('&')
        .map(function (part) {
          var eq = part.indexOf('=')
          var key = eq < 0 ? part : part.slice(0, eq)
          if (key !== 'uri' && key !== 'uri2') return part
          var value = absolute(decodeURIComponent(part.slice(eq + 1)))
          return key + '=' + encodeURIComponent(value).replace(/%2F/g, '/').replace(/%3A/g, ':')
        })
        .join('&')
    }
    return url
  }

  /** `{}`, which is how an R `NULL` can arrive in JSON: a key taken away. */
  function emptyObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
  }

  /** Three strokes in a corner, the mark the documentation's live views put on their grip. */
  var GRIP =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M14 4 4 14M14 8.5 8.5 14M14 13l-1 1" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  /** The shortest widget the grip leaves, in pixels: below it the viewer's own controls overlap. */
  var MIN_HEIGHT = 288
  /** How far one arrow key moves the widget's foot, in pixels. */
  var STEP = 32

  /**
   * A grip that sets a height: dragged, stepped by the arrow keys, and put back
   * to `asked()` by a double click. `show` follows the hand on every move, and
   * `keep` is told the height the reader let go at. While it is dragged the
   * frame lets the pointer through, or the drag would stall the moment it shrank
   * the frame under the hand, which then took the pointer.
   */
  function heightGrip(options) {
    var grip = document.createElement('button')
    grip.type = 'button'
    grip.className = 'chromosomix-grip'
    grip.title = 'Drag to change the viewer\u2019s height, or use the arrow keys; double-click to put it back'
    grip.setAttribute('aria-label', 'Resize the viewer')
    grip.innerHTML = GRIP
    grip.style.cssText =
      'display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;margin:0;padding:0;' +
      'border:1px solid rgba(128,128,128,0.55);border-radius:6px;background:transparent;color:inherit;' +
      'opacity:0.75;cursor:ns-resize;touch-action:none'
    function clamp(height) {
      return Math.round(Math.max(MIN_HEIGHT, height))
    }
    grip.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      event.preventDefault()
      var from = event.clientY
      var start = options.current()
      var height = start
      if (grip.setPointerCapture && event.pointerId !== undefined) grip.setPointerCapture(event.pointerId)
      var held = options.frame()
      held.style.pointerEvents = 'none'
      function move(next) {
        height = clamp(start + next.clientY - from)
        options.show(height)
      }
      function end() {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', end)
        grip.removeEventListener('pointercancel', end)
        held.style.pointerEvents = ''
        options.frame().style.pointerEvents = ''
        if (height !== start) options.keep(height)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', end)
      grip.addEventListener('pointercancel', end)
    })
    grip.addEventListener('keydown', function (event) {
      var by = event.key === 'ArrowUp' ? -STEP : event.key === 'ArrowDown' ? STEP : 0
      if (by === 0) return
      event.preventDefault()
      options.keep(clamp(options.current() + by))
    })
    grip.addEventListener('dblclick', function () {
      options.keep(clamp(options.asked()))
    })
    return grip
  }

  function newFrame() {
    var frame = document.createElement('iframe')
    frame.setAttribute('allow', ALLOW)
    frame.style.width = '100%'
    frame.style.flex = '1 1 auto'
    frame.style.minHeight = '0'
    frame.style.border = '0'
    frame.style.display = 'block'
    return frame
  }

  HTMLWidgets.widget({
    name: 'chromosomix',
    type: 'output',

    factory: function (el) {
      var notice = document.createElement('div')
      notice.setAttribute('role', 'status')
      notice.hidden = true
      notice.style.cssText =
        'flex:0 0 auto;padding:0.4rem 0.6rem;border-left:3px solid #c77c02;background:#fdf3e1;' +
        'color:#3a2a00;font:13px/1.4 system-ui,sans-serif'
      // A column the widget's size is shared out in: the notice, when there is
      // one, above the frame and taken out of its height rather than over it.
      el.style.display = 'flex'
      el.style.flexDirection = 'column'
      el.appendChild(notice)
      var frame = newFrame()
      el.appendChild(frame)

      /** The widget's height as drawn, or as htmlwidgets set it before it is laid out. */
      function height() {
        return el.getBoundingClientRect().height || parseFloat(el.style.height) || 0
      }
      /** The height R gave the widget, which a double click on the grip goes back to. */
      var asked = null
      var foot = document.createElement('div')
      foot.style.cssText = 'flex:0 0 auto;display:flex;justify-content:flex-end;padding-top:0.25rem'
      foot.appendChild(
        heightGrip({
          current: height,
          show: function (h) {
            if (asked === null) asked = height()
            el.style.height = h + 'px'
          },
          keep: function (h) {
            if (asked === null) asked = height()
            el.style.height = h + 'px'
            tell('height', h)
          },
          asked: function () {
            return asked === null ? height() : asked
          },
          frame: function () {
            return frame
          },
        }),
      )
      el.appendChild(foot)

      /** The value R last gave; `null` before the widget is drawn. */
      var x = null
      var origin = '*'
      var ready = false
      /** Every request made of this view, in order, as the frame is sent them: patches and additions. */
      var requests = []
      /** How many of them the frame has been sent since it last loaded. */
      var posted = 0
      /** Where the view is, as the frame last said; `null` before it has. */
      var state = null
      /** The messages the frame said it takes, and its version. */
      var accepts = BEFORE_ADD
      var version = ''
      /** Files the frame could not take since it loaded. */
      var refused = 0

      function post(message) {
        if (frame.contentWindow) frame.contentWindow.postMessage(message, origin)
      }

      /** A value for Shiny, as `input$<id>_<name>`. */
      function tell(name, value) {
        if (HTMLWidgets.shinyMode && el.id && window.Shiny && Shiny.setInputValue) {
          Shiny.setInputValue(el.id + '_' + name, value)
        }
      }

      /** Files for the frame: added where it takes them, said on the page where it does not. */
      function addFiles(files) {
        if (files.length === 0) return null
        if (accepts.indexOf('chromosomix:add') >= 0) return { type: 'chromosomix:add', files: files }
        refused += files.length
        var text =
          'The viewer in this frame (chromosomix ' + (version || 'from an older release') + ') cannot take files ' +
          'from R, so ' + (refused === 1 ? '1 file was' : refused + ' files were') + ' not added. A viewer from ' +
          '0.17.0 on takes them: chromosomix::install_viewer(), or viewer = a newer build.'
        notice.textContent = text
        notice.hidden = false
        tell('notice', text)
        return null
      }

      /** Whether `goto` moves a 1D browser: as the frame last said, or as R opened it. */
      function browsing() {
        if (state !== null && typeof state.view === 'string') return state.view === 'browser'
        return Boolean(x && x.browser)
      }

      /** A request from R as the frame will be sent it — `goto` made a patch — or `null`. */
      function prepare(request) {
        if (request === null || typeof request !== 'object') return null
        if (request.type === 'goto') {
          var where = String(request.where)
          return {
            type: 'navigate',
            state: browsing() ? { locus: where } : { view: 'region', region: where, region2: null, focus: null },
          }
        }
        if (request.type === 'navigate') {
          var patch = {}
          var given = request.state || {}
          Object.keys(given).forEach(function (key) {
            var value = given[key]
            if (emptyObject(value)) value = null
            patch[key] = (key === 'uri' || key === 'uri2') && typeof value === 'string' ? absolute(value) : value
          })
          return { type: 'navigate', state: patch }
        }
        if (request.type === 'add') return { type: 'add', files: [].concat(request.files || []).map(absolute) }
        return null
      }

      /**
       * A request laid on after the others. A patch after a patch is one patch,
       * the later keys over the earlier — a `null` among them kept, since it
       * takes a key away. An addition is never merged nor dropped.
       */
      function append(request) {
        var last = requests.length > 0 ? requests[requests.length - 1] : null
        if (request.type !== 'navigate' || last === null || last.type !== 'navigate') {
          requests.push(request)
          return
        }
        var merged = {}
        Object.keys(last.state).forEach(function (key) {
          merged[key] = last.state[key]
        })
        Object.keys(request.state).forEach(function (key) {
          merged[key] = request.state[key]
        })
        requests[requests.length - 1] = { type: 'navigate', state: merged }
        // The frame has the one before it already: it is sent this one's keys
        // alone, and the two together only when it loads again.
        if (ready && posted === requests.length) post({ type: 'chromosomix:navigate', state: request.state })
      }

      function message(request) {
        if (request.type === 'navigate') return { type: 'chromosomix:navigate', state: request.state }
        if (request.type === 'add') return addFiles(request.files)
        return null
      }

      /** Every request past the last the frame was sent, once it is ready. */
      function flush() {
        if (!ready) return
        while (posted < requests.length) {
          var out = message(requests[posted])
          posted += 1
          if (out !== null) post(out)
        }
      }

      function onMessage(event) {
        if (event.source !== frame.contentWindow) return
        var data = event.data
        if (data === null || typeof data !== 'object' || typeof data.type !== 'string') return
        if (data.type === 'chromosomix:ready') {
          // The frame's own origin from here on: where `src` redirected to,
          // if it did. An opaque one cannot be named, so it is left as it was.
          if (event.origin && event.origin !== 'null') origin = event.origin
          ready = true
          posted = 0
          state = null
          refused = 0
          accepts = Array.isArray(data.accepts) ? data.accepts : BEFORE_ADD
          version = String(data.version || '')
          tell('version', version)
          // Speaking first is what subscribes this page to the frame's states.
          post({ type: 'chromosomix:where' })
          var added = addFiles([].concat((x && x.files) || []).map(absolute))
          if (added !== null) post(added)
          flush()
        } else if (data.type === 'chromosomix:state') {
          state = data.state || null
          tell('state', state)
        } else if (data.type === 'chromosomix:rendered') {
          tell('rendered', data.report || null)
        }
      }
      window.addEventListener('message', onMessage)

      return {
        renderValue: function (value) {
          var first = x === null
          x = value
          ready = false
          posted = 0
          state = null
          refused = 0
          notice.hidden = true
          requests = []
          // `x`'s requests, then any a proxy made before this widget was drawn.
          ;[]
            .concat(x.requests || [], first ? take(el.id) : [])
            .forEach(function (request) {
              var prepared = prepare(request)
              if (prepared !== null) append(prepared)
            })
          var url = frameAddress(x.src)
          origin = url.origin === 'null' ? '*' : url.origin
          var next = newFrame()
          next.title = x.title || 'chromosomix'
          next.src = url.href
          el.replaceChild(next, frame)
          frame = next
        },

        resize: function () {
          // The frame fills the widget's element, which htmlwidgets sizes.
        },

        /** A request from a Shiny proxy. */
        ask: function (request) {
          if (x === null) {
            hold(el.id, request)
            return
          }
          var prepared = prepare(request)
          if (prepared === null) return
          append(prepared)
          flush()
        },
      }
    },
  })

  if (HTMLWidgets.shinyMode && window.Shiny) {
    Shiny.addCustomMessageHandler('chromosomix-request', function (message) {
      var el = document.getElementById(message.id)
      var widget = el ? HTMLWidgets.getInstance(el) : null
      if (widget && widget.ask) widget.ask(message.request)
      else hold(message.id, message.request)
    })
  }
})()
