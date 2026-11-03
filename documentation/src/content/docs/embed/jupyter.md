---
title: "Jupyter notebooks"
description: "Put the chromosomix viewer in a notebook cell with the Python package, move it from Python, and read back where the reader has taken it."
---

The `chromosomix` Python package is the viewer as a notebook widget: the app itself in a cell — the map, its tracks, its side panels and its gestures — moved from Python, and telling Python where the reader has taken it. It works wherever [anywidget](https://anywidget.dev/) does: JupyterLab, Jupyter Notebook 7, VS Code, Google Colab and marimo.

## Install

```sh
pip install chromosomix
```

From a clone of the repository, `pip install -e widgets/python`. It needs Python 3.10 or later, and brings anywidget and traitlets with it. Nothing else is needed, except behind JupyterHub ([below](#jupyterhub-colab-and-other-proxies)).

## A map and its tracks

```python
from chromosomix import Chromosomix

yeast = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/'
view = Chromosomix(
    yeast + 'Yeast_microC_G2M_1kb.cool',
    region='IV:1000000-1400000',
    tracks=[yeast + 'Yeast_ATAC.bw', yeast + 'Yeast_annotations.gtf'],
    transform='log10',
)
view
```

<!-- screenshot: the widget in a JupyterLab cell, the yeast Micro-C map of IV:1.0–1.4 Mb with its ATAC-seq and gene tracks -->

`region` frames the map, `tracks` are put beside it once it is drawn, in order, and every other keyword is a key of the view as a link to the app carries it — here, the counts on a log₁₀ scale. The file is read where it is, by range: nothing is copied into the notebook.

| Argument | What it is |
| --- | --- |
| `map` | the contact map, a path or an address. A `::` names a group inside it, as in the app: `'sample.mcool::/resolutions/5000'`. Leave it out for a 1D browser of the tracks alone |
| `tracks` | files put in the view once it is drawn, in order, as the header's **+** puts them: a track beside the map, another map beside it, a 3D model, a workspace |
| `region` | where the map is framed, as a link writes a region: `'IV:1000000-1400000'`, counted from 0 as cooler counts, or `('IV', 1_000_000, 1_400_000)` |
| `locus` | where a 1D browser is placed, as the browser shows a locus: `'IV:400,001-460,000'`, 1-based |
| `height` | the cell's height in pixels; 600 by default |
| `viewer` | which build of the viewer is in the frame ([below](#which-viewer)) |
| any other keyword | a key of the view: `transform`, `colormap`, `balance`, `vmin`, `vmax`, `oe`, `smooth`, `view`… |

Every key and the values it takes are on [Link keys](/reference/links/). A key takes one value, written as a link writes it — `maps='a.cool|b.cool'`, not a list — and a list is refused by name. A file under `uri`, `uri2` or `maps` is served from the kernel like the map, when it is a path.

## Moving it from Python

```python
view.goto('IV:1150000-1300000')                 # a region of the map, or a locus in the 1D browser
view.navigate(transform='log2', oe=True)        # any key a link carries; None removes one
view.add(yeast + 'Yeast_structure.g3d.gz')      # the header's +: a track, a map, a 3D model
```

- `goto` frames a square on the diagonal, and takes away an off-diagonal block or a zoom the reader left — or, when the view is the 1D browser, moves its locus. It takes a string or a `(sequence, start, end)` tuple.
- `navigate` lays a patch over the view on screen: only the keys you give change, and a key given `None` is removed.
- `add` puts more files in the cell, as the header's **+** does. A 3D model opens in a cell of its own beside the map, panned and zoomed with it.
- `load(map, tracks=…, region=…)` opens another map in this cell, in a new frame. It checks every file first, so one that is not there raises and leaves the cell as it was.

What you ask is kept with the widget, not sent once and forgotten. A cell that runs before its frame is drawn — when you run the whole notebook, say — or a notebook opened again, still ends where Python last put the view. Moves in a row are kept as one, so a slider that moves the view a thousand times replays one move; every `add` is kept.

## Where the reader is

| | |
| --- | --- |
| `view.state` | where the view is now: a dict of the keys a link carries (`uri`, `view`, `region`, `locus`…), or `None` on the landing page. It follows the reader's pans and zooms |
| `view.rendered` | the report of the last finished picture: what is drawn, at which resolution |
| `view.version` | the viewer's version, once its frame is up |
| `view.notice` | what the frame could not do — a viewer too old to take files — or `''` |
| `view.viewer` | the address of the build in the frame |

`state` is a traitlet, so a cell can be told when it changes:

```python
view.observe(lambda change: print((change['new'] or {}).get('region')), names='state')
```

## A 1D browser

With no map, the first file becomes the cell's: a bigWig opens a genome browser over the assembly it declares, and the rest are its tracks.

```python
browser = Chromosomix(
    tracks=[yeast + 'Yeast_ATAC.bw', yeast + 'Yeast_ChIP_Pol2-vs-input.bw', yeast + 'Yeast_annotations.gtf'],
    height=540,
)
browser
```

```python
browser.goto('IV:400,001-460,000')
```

Given with no map, `locus=` places the browser once its files are open, and `region=` frames the map the first file opens.

## Files on the kernel's disk

A path is served to the viewer by the kernel, by byte range, from a small server on `127.0.0.1`. Nothing is uploaded, and nothing leaves the machine the kernel runs on.

```python
from pathlib import Path

data = Path('~/data/yeast').expanduser()
Chromosomix(data / 'Yeast_microC_G2M_1kb.cool', region='IV:1000000-1400000', tracks=[data / 'Yeast_ATAC.bw'])
```

- What is served is the folder the file is in, under a random token, so the file's sidecars — `.bai`, `.fai`, `.tbi`, `.px2` — are read from beside it, as the app expects. Nothing outside that folder is served.
- No name that starts with a dot is served — a dotfile, a `.git`, a `.ssh` — and naming such a file raises at once.
- A link in the folder is followed wherever it points, and its sidecars are looked for beside the link, so a DataLad or git-annex file finds its index.
- `chromosomix.serve(path)` returns the address the viewer reads a local file at, and `chromosomix.address(file)` keeps an address as it is and serves a path.

## Which viewer

`viewer=` names the build of the viewer in the frame:

| `viewer=` | The build |
| --- | --- |
| nothing | `CHROMOSOMIX_VIEWER` if it is set, else a build fetched by `install_viewer()`, else https://chromosomix.app/ |
| a version, `'0.17.0'` | that release, kept for good at `https://chromosomix.app/v/v0.17.0/`: what a notebook that must draw the same picture next year names |
| an address | any build, a lab's own copy of the viewer among them |
| a folder | a built `dist/` on this machine, served beside the data |

**Tracks need a viewer from 0.17.0 on.** The frame takes the files a widget adds — its `tracks`, and `add` — through a message the viewer learned in 0.17.0. An older build draws the map and nothing it adds, and says so above the frame and in `view.notice`; naming an older release warns when the widget is made.

**With files on the kernel's disk, prefer a build served beside them.** `chromosomix.install_viewer()` fetches the viewer from the npm package once, checks it against npm's integrity hash, and keeps it in `~/.cache/chromosomix/` (or under `CHROMOSOMIX_CACHE`); every widget after uses it. The app and the data are then one origin, and the notebook works offline. The site in the frame reading `127.0.0.1` works too on a laptop, but Chrome asks the reader once to let the page reach this machine. `install_viewer('0.19.0')` fetches a given release rather than the latest.

## JupyterHub, Colab and other proxies

- **Behind JupyterHub**, the kernel's server is reached through [jupyter-server-proxy](https://jupyter-server-proxy.readthedocs.io/), which must be installed beside the single-user server — in the environment `jupyter lab` runs from, not only the kernel's. That proxy answers only requests that carry your login to the hub, which a page on another origin does not send, so **local files are read only by a viewer the kernel serves**: run `chromosomix.install_viewer()` once, or set `CHROMOSOMIX_VIEWER` or `viewer=` to a built `dist/`. The widget warns when its frame is the site. The proxy also gives up on an answer over 100 MB, which touches only a file the viewer reads whole — an annotation file with no tabix index beside it: bgzip and index it.
- **In Colab**, the server is reached through Colab's own port proxy, with nothing to set.
- **Any other way in**: set `CHROMOSOMIX_PUBLIC_URL` to the address the browser reaches the server at, with `{port}` where the port goes.

## In marimo

marimo runs every cell that names a `mo.ui.anywidget` wrapper again each time the frame reports, which it does on every move and every finished picture. So name the wrapper only where you read where the reader is, and drive the widget itself:

```python
import marimo as mo
from chromosomix import Chromosomix

view = Chromosomix(MAP, region='IV:1000000-1400000', tracks=[ATAC])   # MAP and ATAC: a map and a track
live = mo.ui.anywidget(view)
live
```

```python
view.goto('IV:1150000-1300000')   # names `view`: runs once
```

```python
(live.state or {}).get('region')  # names `live`: runs again wherever the reader goes
```

`live.goto(…)` would pull the view back every time the reader moved it, and `live.add(…)` would add the file again on every report. In `marimo edit` a cell's output is cut at 610 px and scrolls; `marimo run` shows the whole `height`.

## The demo notebooks

[`demo.ipynb`](https://github.com/js2264/chromosomix/blob/main/widgets/python/demo.ipynb) walks through all of this on the repository's yeast demo — a map and its tracks, following the reader, moving the view, a 3D model and a 1D browser — and [`demo_marimo.py`](https://github.com/js2264/chromosomix/blob/main/widgets/python/demo_marimo.py) does the same in marimo. Both open the demo files from a clone, so the kernel serves them.

The widget is the viewer's own embed, in an `<iframe>`, driven over its message channel: [Embedding in a web page](/embed/web-page/) says what an embed keeps and drops. The package's own notes are in [its README](https://github.com/js2264/chromosomix/blob/main/widgets/python/README.md).
