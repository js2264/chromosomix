---
title: "Embedding in a web page"
description: "Put a live chromosomix view in any web page as an iframe, and move it or follow the reader from the page around it with postMessage."
---

The viewer goes into any HTML page as an `<iframe>`: nothing to install, no script to load, nothing to add to the page's headers. A lab's site, a course page or a paper's supplementary material then holds the map itself — the reader pans, zooms and changes the colours — read from where the data are published.

## An iframe

```html
<iframe
  src="https://chromosomix.app/?embed=1#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true"
  width="100%" height="640" loading="lazy" style="border: 0"
  title="Micro-C of yeast chromosome IV"></iframe>
```

The `src` is a link to a view, with `?embed=1` before the `#`. The easiest way to write one is to open the view in the app, copy the address from the browser's bar, and put `?embed=1` in front of its `#`. Every key the part after the `#` can hold is on [Link keys](/reference/links/).

- A link from the app's share dialog works the same way, and so does `?embed=1&config=<address>`, which opens a published workspace with its tracks, colours and marks.
- With nothing after `?embed=1`, the frame is the landing page with **Load files** alone, where a reader opens a file of their own.
- The files must be at addresses the reader's browser can reach, on a server that allows the viewer to read them: see [Hosting your data](/advanced/hosting/). The frame's requests come from the viewer's own origin, so a bucket that admits the viewer admits every page that embeds it, and the page around the frame needs no particular headers.
- A file on your own disk cannot be embedded for others, as it cannot be linked to.

### Pin a release

`https://chromosomix.app/` is the newest build, and changes with it. Every release is also kept for good at its own address, which takes the same query and fragment:

```text
https://chromosomix.app/v/v0.19.0/?embed=1#uri=…
```

A figure in a paper, or any page that must draw the same picture in five years, should name one. A copy of the viewer on your own server is framed the same way: see [Running your own copy](/advanced/self-hosting/).

## What an embed keeps and drops

An embed is the view alone, seeded by its `src`.

- **It keeps** the view and its gestures, the keyboard shortcuts, and the **Annotations** and **Aesthetics** panels, which control the picture: which lanes are drawn, and how they are coloured and scaled. Both start folded, as named strips on either edge, so the map has the room. A reader can still drop a file of their own on the frame; it is read where it is, and nothing is uploaded.
- **It drops** the window around the view: the header, the tab strip, the card that offers to restore the reader's last workspace, the status bar, the store catalogue and the console, and the **Files**, **General** and **Analysis** panels. Its landing page offers **Load files** alone, without the store tiles.
- **It remembers nothing.** An embed writes nothing to the reader's browser storage and adds nothing to their back button, so it shows what its `src` says every time the page loads. It installs nothing for offline use, and shows no notice of a newer build.

## Its one bar

Above the view, one bar holds what a figure in somebody else's page owes its reader:

- on the left, the chromosomix mark and name: a link that opens this same view in the full app, in a new tab. It follows the reader, so it opens where they are;
- next to it, the breadcrumb: the file, and where the reader is in it;
- on the right, the buttons that open the **Annotations** and **Aesthetics** panels — each hidden while its panel has nothing to show — and **About this viewer**, which says what the viewer is, that nothing is uploaded, which build is in the frame, and where its source is.

Notes about the file, and refusals, appear under the bar as they do in the app.

<!-- screenshot: a page with an embedded yeast Micro-C map, the embed's one bar above it, both side panels folded -->

## Driving it from the page

The page around the frame can move the view, put tracks beside it, and be told where the reader has taken it, by `postMessage`. There are six messages, each an object with a `type`, listed with their fields on [Embedding messages](/reference/embedding/). A few rules shape every host page:

- **The page speaks first.** The frame sends `chromosomix:ready` once, when it is listening, and nothing else until the page has sent it something. Put your listener in place before the frame loads: the script before the `<iframe>`, or the `src` set from the script.
- **Only the page that framed it is answered**, at the origin it spoke from. A reader may open their own file in the frame, and no other page learns which. This also works from a page opened from disk.
- **Messages are carried out in order.** A `chromosomix:navigate` sent after a `chromosomix:add` waits for the files to open.
- **A navigate is a patch.** Its `state` holds only the keys to change, as a link writes them; a key given `null` is removed. Each move is answered with `chromosomix:state`, which says where the view actually went: a key the frame cannot read is dropped, so read the answer.
- **Adding files needs 0.17.0 or later.** `chromosomix:add` takes `http(s)` addresses, at most 64. The `accepts` list in `chromosomix:ready` says whether the build in the frame takes it.
- **`chromosomix:rendered` marks a finished picture**: its `report.status` is `drawn`, `gated` (waiting for the reader to agree to a large read) or `error`. It is the moment to take a screenshot.

### A worked example

A map with buttons beside it that move it, a track a link cannot carry, and a caption that follows the reader:

```html
<iframe id="figure" width="100%" height="640" style="border: 0"
        title="Micro-C of yeast chromosome IV"></iframe>
<p>Showing <code id="where">…</code></p>
<p>
  <button data-region="IV:1000000-1400000">IV, 1.0–1.4 Mb</button>
  <button data-region="IV:1150000-1250000">IV, 1.15–1.25 Mb</button>
</p>

<script>
  const VIEWER = "https://chromosomix.app/"
  const DATA = "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/"
  const frame = document.getElementById("figure")
  const origin = new URL(VIEWER).origin
  const send = (message) => frame.contentWindow.postMessage(message, origin)

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return
    const message = event.data
    if (message?.type === "chromosomix:ready") {
      if (message.accepts?.includes("chromosomix:add")) {
        send({ type: "chromosomix:add", files: [DATA + "Yeast_ATAC.bw"] })
      } else {
        send({ type: "chromosomix:where" })
      }
    }
    if (message?.type === "chromosomix:state") {
      const state = message.state
      document.getElementById("where").textContent =
        state === null ? "the landing page" : state.region ?? state.locus ?? state.view
    }
  })

  for (const button of document.querySelectorAll("button[data-region]")) {
    button.addEventListener("click", () => {
      send({
        type: "chromosomix:navigate",
        state: { view: "region", region: button.dataset.region, region2: null, focus: null },
      })
    })
  }

  frame.src = VIEWER + "?embed=1#uri=" + DATA + "Yeast_microC_G2M_1kb.cool" +
    "&view=region&region=IV:1000000-1400000&transform=log10&balance=true"
</script>
```

- The `src` is set last, once the listener is in place, so the frame's `ready` cannot be missed.
- On `ready`, the page adds the ATAC-seq track where the build takes files, and otherwise asks where the view is. Either way the frame answers with a `chromosomix:state`, and from then on it sends one on every move the reader makes, which keeps the caption current.
- Each button sends a patch: the region to show, written as a link writes it, with `region2` and `focus` given `null` so that an off-diagonal block or a zoom the reader left is removed and the map is the square asked for.

## In a notebook

The Jupyter widget and the R htmlwidget are this same frame, driven from Python and from R: see [Jupyter notebooks](/embed/jupyter/) and [R, Quarto and Shiny](/embed/r/).
