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
// - in Shiny, requests through `chromosomixProxy()`, as custom messages.
//
// Every request is made in order, and all of them again when the frame
// reloads — it has loaded `src` again, and nothing asked of the last one is on
// it. What the frame says comes back, in Shiny, as `input$<id>_state`,
// `input$<id>_rendered` and `input$<id>_version`.
//
// A frame that cannot take files — a build from before `chromosomix:add`, whose
// `ready` lists no `accepts` (SPECS §21.4) — draws the map without its tracks,
// so the widget says so above the frame, and in Shiny as `input$<id>_notice`,
// rather than the tracks going missing without a word.
//
// An address R gives may be relative to the page — a proxy's path to the R
// session's file server — so every one is made absolute here, against this
// page, before the frame sees it.

(function () {
  var ALLOW = 'clipboard-write; fullscreen; local-network-access; local-network; loopback-network'
  /** What a `ready` without an `accepts` list means: a build from before `add`. */
  var BEFORE_ADD = ['chromosomix:where', 'chromosomix:navigate']

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
      var frame = document.createElement('iframe')
      frame.setAttribute('allow', ALLOW)
      frame.style.width = '100%'
      frame.style.flex = '1 1 auto'
      frame.style.minHeight = '0'
      frame.style.border = '0'
      frame.style.display = 'block'
      el.appendChild(frame)

      var x = null
      var origin = '*'
      var ready = false
      /** Every request made of this view, in order: `x`'s, then a proxy's. */
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

      function message(request) {
        if (request.type === 'goto') {
          var where = String(request.where)
          return {
            type: 'chromosomix:navigate',
            state: browsing() ? { locus: where } : { view: 'region', region: where },
          }
        }
        if (request.type === 'navigate') {
          var patch = {}
          var given = request.state || {}
          Object.keys(given).forEach(function (key) {
            var value = given[key]
            // An empty object is how a `NULL` can arrive from R's JSON: a key taken away.
            if (value !== null && typeof value === 'object') value = null
            patch[key] = (key === 'uri' || key === 'uri2') && typeof value === 'string' ? absolute(value) : value
          })
          return { type: 'chromosomix:navigate', state: patch }
        }
        if (request.type === 'add') return addFiles([].concat(request.files || []).map(absolute))
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
          x = value
          frame.title = x.title || 'chromosomix'
          requests = [].concat(x.requests || [])
          posted = 0
          ready = false
          state = null
          refused = 0
          notice.hidden = true
          var url = frameAddress(x.src)
          origin = url.origin === 'null' ? '*' : url.origin
          frame.src = url.href
        },

        resize: function () {
          // The frame fills the widget's element, which htmlwidgets sizes.
        },

        /** A request from a Shiny proxy. */
        ask: function (request) {
          requests.push(request)
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
    })
  }
})()
