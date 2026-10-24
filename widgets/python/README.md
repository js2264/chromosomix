# chromosomix for Jupyter

The [chromosomix](https://chromosomix.app/) viewer as a Jupyter widget: a contact map with its tracks,
a 1D genome browser or a 3D model in a notebook cell — the app itself, its side panels and its
gestures — driven from Python, and telling Python where the reader has taken it.

```python
from chromosomix import Chromosomix

view = Chromosomix(
    'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool',
    region='IV:1000000-1400000',
    tracks=['https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_ATAC.bw'],
    transform='log10',
)
view
```

`demo.ipynb`, beside this file, walks through it on the repository's own demo data, and
`demo_marimo.py` does the same in marimo.

## Install

```bash
pip install chromosomix          # or, from a clone: pip install -e widgets/python
```

It works wherever [anywidget](https://anywidget.dev/) does: JupyterLab, Jupyter Notebook 7, VS Code,
Google Colab and marimo — in marimo, as [below](#in-marimo). Nothing else is installed (behind
JupyterHub, jupyter-server-proxy beside the single-user server; see [Files](#files)), and nothing is
uploaded: the viewer reads every file from where it is, by range.

## Files

A file is an **address** — any the app opens: `https://`, `s3://`, `gs://`, a Dropbox or Google Drive
share — or a **path on the kernel's disk**, which the kernel serves to the viewer by byte range from a
small server on `127.0.0.1`. A path's directory is what is served, under a random token, so a file's
sidecars — `.bai`, `.fai`, `.tbi`, `.px2` — are read from beside it as the app expects. Nothing else on
the disk is served, and nothing in it whose name starts with `.` — a dotfile, a `.git`, a `.ssh` — which
is why naming such a file raises at once. A link in the directory is followed wherever it points, and
its sidecars are looked for beside the link: a DataLad or git-annex dataset's `sample.bam` finds its
`sample.bam.bai`. A `::` after a container names a group in it, as in the app:
`sample.mcool::/resolutions/5000`.

Behind JupyterHub, the server is reached through [jupyter-server-proxy](https://jupyter-server-proxy.readthedocs.io/)
at `<hub prefix>/proxy/<port>/`, which must be installed beside the single-user server — in the
environment `jupyter lab` runs from, not only the kernel's. That proxy answers only a request that
carries your login to the hub, and a page on another origin sends none: **behind JupyterHub, files on
the kernel's disk are read only by a viewer the kernel serves** — `install_viewer()`,
`CHROMOSOMIX_VIEWER` or `viewer=` a built `dist/` (see below) — never by the site, and the widget
warns when its frame is the site. The proxy also holds each answer whole in memory and gives up on
one over 100 MB; the viewer reads by range a megabyte at a time, so this only touches a file it
reads whole — an annotation file with no tabix index beside it — over 100 MB: bgzip and index it.
In Colab the server is reached through Colab's own port proxy. `CHROMOSOMIX_PUBLIC_URL` names another
way in, with `{port}` where the port goes.

## Which viewer

`viewer=` names the build in the frame:

| `viewer=` | the build |
|---|---|
| nothing | `CHROMOSOMIX_VIEWER` if set, else a build fetched by `install_viewer()`, else https://chromosomix.app/ |
| `"0.17.0"` | that release, kept for ever at `https://chromosomix.app/v/v0.17.0/` — what a notebook that must draw the same picture next year names |
| an address | any build, a lab's own copy of the npm package's `dist/` among them |
| a directory | a built `dist/` on this machine, served beside the data |

**Tracks need a viewer from 0.17.0 on.** The frame takes the files a widget adds — its `tracks`, and
`add` — through a message the viewer learned in 0.17.0. An older build draws the map the cell names and
nothing it adds, and says so above the frame (and in `view.notice`); naming an older release warns
when the widget is made.

**With files on the kernel's disk, prefer a build served beside them.** `chromosomix.install_viewer()`
fetches the npm package once — checked against npm's integrity hash, and moved into place only once
it is whole — and keeps it in `~/.cache/chromosomix/`; every widget after uses it, so the app and the
data are one origin and the notebook works offline. On a laptop the site in the frame reading
`http://127.0.0.1` works too, but Chrome asks the reader once to let the page reach this machine;
behind JupyterHub it cannot read them at all, and a build served beside them is the only way.

## Driving it

| | |
|---|---|
| `view.goto('II:100000-200000')`, `view.goto(('II', 100_000, 200_000))` | frame a region on the diagonal — or a locus, in the 1D browser |
| `view.navigate(transform='log2', oe=True)` | lay a patch over the view: any key the address bar carries, one value each (`genomes='a,b'`, not a list); `None` removes one |
| `view.add('ATAC.bw', 'genes.gtf.gz')` | the header's `+` for each file: a track, another map beside the map, a workspace |
| `view.load(map, tracks=…, region=…)` | another map in this cell, in a new frame — or none, `tracks=` and `locus=` for a 1D browser |
| `view.state` | where the view is now — the app's view state, a traitlet to `observe` |
| `view.rendered` | the last finished picture: what is drawn, at which resolution |
| `view.notice` | what the frame could not do — a viewer too old to take files — or `''` |

```python
view.observe(lambda change: print(change['new'].get('region')), names='state')
```

A file in `uri`, `uri2` or `maps` — given to the widget or to `navigate` — is served from the kernel
like a track; a deck's own words in `maps` (`3d`, `tracks`, `~`) are left as they are. With no map,
`locus=` places the 1D browser once its files are open, and `region=` frames the map the first file
opens. The moves and additions asked of a frame are kept for a view drawn late to make again:
a move after a move is laid over it, so a cell that moves the view a thousand times keeps one, and
every `add` is kept. `load` raises before it changes anything when a file is not there.

## In marimo

A cell reads `view.state` reactively through `mo.ui.anywidget(view)`, and marimo runs every cell
that names that wrapper again each time the frame reports — on every move and every finished
picture. So name the wrapper only where you read, and drive the widget itself:

```python
view = Chromosomix(MAP, region='IV:1000000-1400000', tracks=[ATAC])
live = mo.ui.anywidget(view)
live
```

```python
view.goto('IV:1150000-1300000')   # names `view`: runs once
```

```python
(live.state or {}).get('region')  # names `live`: runs again wherever the reader goes
```

`live.goto(…)` would pull the view back every time the reader moved it, and `live.add(…)` would add
the file again on every report, without end. The `ipywidgets.HTML` that follows the reader in
`demo.ipynb` is not shown by marimo; a `mo.md` cell that reads `live.state` does its work. In
`marimo edit` a cell's output is cut at 610 px and scrolls; `marimo run` shows the whole `height`.

## How it works

The widget is the viewer's embed (`?embed=1`, SPECS §21 in the repository) in an `<iframe>`. Its
`postMessage` channel carries `chromosomix:navigate`, `chromosomix:where` and `chromosomix:add` from the
notebook and `chromosomix:state` and `chromosomix:rendered` back; the view the cell opens on is in the
frame's fragment, as a link to the app carries it. Each `load` puts a new `<iframe>` in the cell.

## Licence

GPL-3.0-or-later, as chromosomix.
