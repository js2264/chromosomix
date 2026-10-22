"""The viewer as a Jupyter widget.

A notebook cell that holds the app itself — a contact map with its tracks, a 1D
browser, a 3D model beside a map — driven from Python and reporting back where
the reader has taken it. It is the viewer's embed (SPECS §21): `?embed=1` in an
`<iframe>`, and its `postMessage` channel (§21.4) for the two directions:

- **Python to the viewer.** :meth:`Chromosomix.goto` and
  :meth:`Chromosomix.navigate` send `chromosomix:navigate`, a patch over the view
  on screen; :meth:`Chromosomix.add` sends `chromosomix:add`, the header's `+`
  for an address — a track beside the map, another map beside it.

  Sent as **state rather than as messages**: each is appended, numbered, to
  :attr:`Chromosomix.requests`, and every view of the widget posts the ones past
  the last it posted. A message reaches only the views that exist when it is
  sent, and "Run all" sends a later cell's `goto` before the browser has drawn
  the first cell's frame; a view drawn late — or drawn again, when the notebook
  is reopened — still ends where Python last put it.
- **The viewer to Python.** Every `chromosomix:state` lands in
  :attr:`Chromosomix.state`, a traitlet a cell can `observe`, and every finished
  picture in :attr:`Chromosomix.rendered`.

Files are addresses — any the app opens, `http(s)://`, `s3://`, `gs://`, a Dropbox
or Drive share — or paths on the kernel's disk, which the kernel serves by range
from a loopback server (`chromosomix.server`), with their sidecars beside them.
"""

from __future__ import annotations

import os
import re
import warnings
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import quote

import anywidget
import traitlets

from .server import serve
from .viewer import TAKES_FILES, release_of, resolve_viewer, takes_files

#: The view state's keys, in the order the app writes them (`state/ViewState.ts`).
KEY_ORDER = (
    'uri', 'uri2', 'maps', 'view', 'genome', 'genome2', 'genomes', 'region', 'region2', 'focus',
    'regions', 'cells', 'contacts', 'locus', 'level', 'coarsen', 'transform', 'colormap', 'vmin',
    'vmax', 'balance', 'score', 'oe', 'arms', 'smooth', 'op', 'flip',
)

_SCHEME = re.compile(r'^[a-z][a-z0-9+.-]*://', re.I)

Locus = str | tuple[str, int, int]


def address(file: str | os.PathLike[str]) -> str:
    """What the viewer opens a file by: an address as it is, a local path served from the kernel.

    A `::` after a container's path names a group inside it — an `.mcool`'s
    `::/resolutions/5000` — and is kept on the address the path is served at.
    """
    text = os.fspath(file)
    if _SCHEME.match(text):
        return text
    path, sep, group = text.partition('::')
    return serve(Path(path)) + (sep + group if sep else '')


def locus_text(where: Locus) -> str:
    """A locus as the address bar writes one: a string as given, `(seq, start, end)` as `seq:start-end`."""
    if isinstance(where, tuple):
        sequence, start, end = where
        return f'{sequence}:{int(start)}-{int(end)}'
    return str(where)


def _value(value: object) -> str:
    # `true` and `false`, as the hash spells a switch.
    return ('true' if value else 'false') if isinstance(value, bool) else str(value)


def view_hash(state: dict[str, object]) -> str:
    """A view state as the app writes it into the fragment: its keys in order, its values escaped."""
    keys = [key for key in KEY_ORDER if key in state] + [key for key in state if key not in KEY_ORDER]
    return '&'.join(f'{key}={quote(_value(state[key]), safe="/:,|")}' for key in keys if state[key] is not None)


class Chromosomix(anywidget.AnyWidget):
    """The chromosomix viewer in a notebook cell.

    >>> Chromosomix('sample.mcool::/resolutions/5000', region='chr2:10000000-14000000',
    ...             tracks=['ATAC.bw', 'genes.gtf.gz'], transform='log10')

    `map` is the contact map the view opens on — or `None` for a 1D browser of the
    tracks alone, or a 3D model. `tracks` are added beside it once it is on screen,
    in order. `region` frames the map; `locus` places a 1D browser. Every other
    keyword is a key of the view state as the app's address bar carries it —
    `transform`, `colormap`, `balance`, `vmin`, `vmax`, `oe`, `smooth`, `view`, ….
    `viewer` names the build (`chromosomix.viewer`); `height` is the cell's, in
    pixels.
    """

    _esm = Path(__file__).parent / 'static' / 'widget.js'

    #: The frame's address: a build of the viewer, `?embed=1`, and the view in the fragment.
    src = traitlets.Unicode('').tag(sync=True)
    #: What the frame adds once it is up — the tracks a fragment has no word for.
    files = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)
    height = traitlets.Int(600).tag(sync=True)
    title = traitlets.Unicode('chromosomix').tag(sync=True)
    #: Where the view is, as the viewer last said: the app's view state, or `None` for its picker.
    state = traitlets.Dict(allow_none=True, default_value=None).tag(sync=True)
    #: The last finished picture's report (§12): what is drawn, at what resolution.
    rendered = traitlets.Dict(default_value={}).tag(sync=True)
    #: The viewer's version, once its frame has said it is ready.
    version = traitlets.Unicode('').tag(sync=True)
    #: Said when the frame cannot do what was asked of it — a viewer too old to take files — or ''.
    notice = traitlets.Unicode('').tag(sync=True)
    #: Moves and additions asked of the viewer since the frame was loaded, numbered, the newest last.
    requests = traitlets.List(traitlets.Dict(), default_value=[]).tag(sync=True)

    #: How many requests are kept for a view drawn late to replay.
    KEPT_REQUESTS = 64

    def __init__(
        self,
        map: str | os.PathLike[str] | None = None,  # noqa: A002 - the word a reader would use
        *,
        tracks: Iterable[str | os.PathLike[str]] = (),
        region: Locus | None = None,
        locus: Locus | None = None,
        height: int = 600,
        viewer: str | os.PathLike[str] | None = None,
        **view: object,
    ) -> None:
        super().__init__(height=height)
        self._viewer = resolve_viewer(viewer)
        self._sequence = 0
        self.load(map, tracks=tracks, region=region, locus=locus, **view)

    @property
    def viewer(self) -> str:
        """The build this widget frames."""
        return self._viewer

    def load(
        self,
        map: str | os.PathLike[str] | None = None,  # noqa: A002
        *,
        tracks: Iterable[str | os.PathLike[str]] = (),
        region: Locus | None = None,
        locus: Locus | None = None,
        **view: object,
    ) -> None:
        """Open another map and tracks in this cell, in place of what it holds.

        Not `open`, which is the name ipywidgets gives the opening of a widget's
        comm, and which its constructor calls.
        """
        added = [address(track) for track in tracks]
        self._warn_if_refused(len(added))
        # A new frame starts with nothing asked of it.
        self.requests = []
        # What `goto` moves until the viewer has said what it shows: a cell
        # with no map opens its tracks in the 1D browser.
        self._opens_on_browser = map is None or view.get('view') == 'browser'
        if map is None:
            # No map: the frame opens on its picker and the first file becomes
            # the tab's, as the header's `+` makes it on an empty tab.
            self.files = added
            self.src = f'{self._viewer}?embed=1'
            return
        state: dict[str, object] = {'uri': address(map)}
        if region is not None:
            state['view'] = 'region'
            state['region'] = locus_text(region)
        if locus is not None:
            state['locus'] = locus_text(locus)
        state.update({key: value for key, value in view.items() if value is not None})
        self.files = added
        self.src = f'{self._viewer}?embed=1#{view_hash(state)}'

    def _ask(self, request: dict[str, object]) -> None:
        self._sequence += 1
        self.requests = [*self.requests, {**request, 'seq': self._sequence}][-self.KEPT_REQUESTS :]

    def navigate(self, **patch: object) -> None:
        """Lay `patch` over the view on screen (§21.4): a key given `None` is taken away."""
        self._ask({'type': 'navigate', 'state': {key: (None if value is None else _value(value)) for key, value in patch.items()}})

    def goto(self, where: Locus) -> None:
        """Frame `where`: a region of the map, or a locus of the 1D browser when that is what is on screen."""
        if self._browsing():
            self.navigate(locus=locus_text(where))
        else:
            self.navigate(view='region', region=locus_text(where))

    def _browsing(self) -> bool:
        # As the viewer last said; before it has said anything — a later cell's
        # `goto` under "Run all" comes before the frame is drawn — as the cell
        # opened it.
        if self.state is not None and 'view' in self.state:
            return self.state['view'] == 'browser'
        return self._opens_on_browser

    def add(self, *files: str | os.PathLike[str]) -> None:
        """Put more files in this cell, as the header's `+` does: tracks, maps, a workspace."""
        self._warn_if_refused(len(files))
        self._ask({'type': 'add', 'files': [address(file) for file in files]})

    def _warn_if_refused(self, count: int) -> None:
        # Said here for a release named by its address; any other build says
        # at run time whether it takes files, and the cell shows `notice`.
        release = release_of(self._viewer)
        if count > 0 and not takes_files(release):
            warnings.warn(
                f'The viewer in this frame, chromosomix {".".join(map(str, release or ()))}, cannot take files from '
                f'the notebook, so {count} will not be added: name one from {".".join(map(str, TAKES_FILES))} on.',
                stacklevel=3,
            )
