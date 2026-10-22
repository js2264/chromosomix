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
  is reopened — still ends where Python last put it. The list is never cut: a
  `navigate` that follows a `navigate` is laid over it, so a cell that moves the
  view a thousand times keeps one request, and every `add` is kept.
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

from .server import serve, through_hub
from .viewer import TAKES_FILES, release_of, resolve_viewer, takes_files

#: The view state's keys, in the order the app writes them (`state/ViewState.ts`).
KEY_ORDER = (
    'uri', 'uri2', 'maps', 'view', 'genome', 'genome2', 'genomes', 'region', 'region2', 'focus',
    'regions', 'cells', 'contacts', 'locus', 'level', 'coarsen', 'transform', 'colormap', 'vmin',
    'vmax', 'balance', 'score', 'oe', 'arms', 'smooth', 'op', 'flip',
)

#: The keys whose value is a file, each served from the kernel when it is a path; `maps` holds several, split by `|`.
FILE_KEYS = ('uri', 'uri2', 'maps')

#: The deck's own words in `maps`, which name a cell rather than a file: an empty seat, a 3D model's, the tracks'
#: (`panels/deck.ts`).
DECK_WORDS = ('~', '3d', 'tracks')

#: The keys whose value is a locus, which a `(sequence, start, end)` tuple is written as.
LOCUS_KEYS = ('locus', 'region')

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


def _local(file: str | os.PathLike[str]) -> bool:
    # A path on the kernel's disk, which the kernel serves, rather than an address.
    return not _SCHEME.match(os.fspath(file))


def _value(value: object) -> str:
    # `true` and `false`, as the hash spells a switch — numpy's `bool_` too,
    # named rather than imported, whose `str` is `True`.
    return ('true' if value else 'false') if type(value).__name__ in ('bool', 'bool_') else str(value)


def _view_value(key: str, value: object) -> str:
    """One key's value as the address bar writes it, a file among them served from the kernel."""
    if key in LOCUS_KEYS and isinstance(value, tuple):
        return locus_text(value)  # type: ignore[arg-type]
    if isinstance(value, (list, tuple, set, frozenset)):
        # Written as `str` it would be `['a', 'b']`, which the viewer reads as
        # one name; and which separator joins a list is the key's to say.
        raise TypeError(
            f'{key}= takes one value, as the address bar writes it — genomes=\'a,b\', maps=\'a.cool|b.cool\' — '
            f'not a {type(value).__name__}.'
        )
    if key in FILE_KEYS and isinstance(value, (str, os.PathLike)):
        if key == 'maps':
            return '|'.join(part if _deck_word(part) else address(part) for part in os.fspath(value).split('|'))
        return address(value)
    return _value(value)


def _deck_word(part: str) -> bool:
    # A seat of the deck that names no file, which the deck reads trimmed and skips when blank.
    return part.strip() in ('', *DECK_WORDS)


def _files_in(view: dict[str, object]) -> list[str]:
    # The files a view state names, as they were given: the map, its comparison, a deck's maps.
    named = [os.fspath(view[key]) for key in FILE_KEYS if isinstance(view.get(key), (str, os.PathLike))]
    return [part for text in named for part in text.split('|') if not _deck_word(part)]


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
    in order. `region` frames the map; `locus` places a 1D browser. With no map
    either is a move made once the files are open: `locus` places the browser,
    and `region` frames the map the first file opens. Every other keyword is a
    key of the view state as the app's address bar carries it, one value each —
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
    #: How many times :meth:`load` has run: each puts a new frame in every view, even at the same `src`.
    loads = traitlets.Int(0).tag(sync=True)

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
        self._warned = False
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

        Every address is resolved before anything is replaced, so a file that
        is not there raises and leaves the cell as it was. Then the frame is
        loaded again, in every view, even at the address it already has: what
        Python asked of the old frame, and what it said, go with it.

        Not `open`, which is the name ipywidgets gives the opening of a widget's
        comm, and which its constructor calls.
        """
        tracks = list(tracks)
        added = [address(track) for track in tracks]
        given = {key: value for key, value in view.items() if value is not None}
        values = {key: _view_value(key, value) for key, value in given.items()}
        state: dict[str, object] = {}
        asked: list[dict[str, object]] = []
        if map is None:
            # No map: the frame opens on its picker and the first file becomes
            # the tab's, as the header's `+` makes it on an empty tab. The
            # fragment has nothing to name, so where the view goes is a
            # `navigate` after the files, which the frame carries out in order.
            patch: dict[str, object] = {}
            if locus is not None:
                patch['locus'] = locus_text(locus)
            elif region is not None:
                # A region frames a map, and only in the view that draws one.
                patch.update(view='region', region=locus_text(region))
            patch.update(values)
            if patch:
                self._sequence += 1
                asked.append({'type': 'navigate', 'state': patch, 'seq': self._sequence})
            src = f'{self._viewer}?embed=1'
            # Tracks alone open in the 1D browser, unless the move names another view.
            opens = patch.get('view', 'browser')
        else:
            state['uri'] = address(map)
            if region is not None:
                state['view'] = 'region'
                state['region'] = locus_text(region)
            if locus is not None:
                state['locus'] = locus_text(locus)
            state.update(values)
            src = f'{self._viewer}?embed=1#{view_hash(state)}'
            opens = state.get('view')
        self._warn_if_refused(len(added))
        self._check_reach([*([] if map is None else [map]), *tracks, *_files_in(given)])
        # What `goto` moves until the new frame has said what it shows: the
        # view the cell opens on.
        self._opens_on_browser = opens == 'browser'
        # One message to the front end, `loads` with the rest, so a view puts
        # the new frame up with everything it is to be given already there.
        with self.hold_sync():
            self.state = None
            self.rendered = {}
            self.notice = ''
            self.requests = asked
            self.files = added
            self.src = src
            self.loads += 1

    def _ask(self, request: dict[str, object]) -> None:
        self._sequence += 1
        last = self.requests[-1] if self.requests else None
        if request['type'] == 'navigate' and last is not None and last['type'] == 'navigate':
            # A patch over a patch is one patch: its keys over the last one's, a
            # `None` kept to take the key away — what a view drawn late, or
            # drawn again, makes. A view that already made the last one makes
            # only the keys asked for now (`fresh`, after `after`), or the
            # earlier keys would be laid again over wherever the reader has
            # since taken the view, and a pan between two calls snapped back.
            merged = {**last['state'], **request['state']}  # type: ignore[dict-item]
            self.requests = [
                *self.requests[:-1],
                {
                    'type': 'navigate',
                    'state': merged,
                    'fresh': request['state'],
                    'after': last['seq'],
                    'seq': self._sequence,
                },
            ]
            return
        self.requests = [*self.requests, {**request, 'seq': self._sequence}]

    def navigate(self, **patch: object) -> None:
        """Lay `patch` over the view on screen (§21.4): a key given `None` is taken away.

        A value is one, as the address bar writes it: `genomes='a,b'`, not a
        list. A file — `uri`, `uri2`, each of `maps` — is served from the kernel
        when it is a path, as :meth:`add` serves one.
        """
        state = {key: (None if value is None else _view_value(key, value)) for key, value in patch.items()}
        self._check_reach(_files_in({key: value for key, value in patch.items() if value is not None}))
        self._ask({'type': 'navigate', 'state': state})

    def goto(self, where: Locus) -> None:
        """Frame `where`: a region of the map, or a locus of the 1D browser when that is what is on screen.

        On a map it is the region on both axes, near the diagonal: a second
        axis's region and a focus inside the block, which the reader may have
        left there, are taken away.
        """
        if self._browsing():
            self.navigate(locus=locus_text(where))
        else:
            self.navigate(view='region', region=locus_text(where), region2=None, focus=None)

    def _browsing(self) -> bool:
        # As the viewer last said; before it has said anything — a later cell's
        # `goto` under "Run all" comes before the frame is drawn — as the cell
        # opened it.
        if self.state is not None and 'view' in self.state:
            return self.state['view'] == 'browser'
        return self._opens_on_browser

    def add(self, *files: str | os.PathLike[str]) -> None:
        """Put more files in this cell, as the header's `+` does: tracks, maps, a workspace."""
        added = [address(file) for file in files]
        self._warn_if_refused(len(files))
        self._check_reach(files)
        self._ask({'type': 'add', 'files': added})

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

    def _check_reach(self, files: Iterable[str | os.PathLike[str]]) -> None:
        # Behind JupyterHub a file on the kernel's disk is reached through the
        # hub's proxy, which answers only a request carrying the reader's login.
        # A frame on another origin — the site, a release on it, any address —
        # sends none and reads nothing; a build the kernel serves is on the
        # hub's origin, and reads every file.
        if self._warned or not through_hub() or not _SCHEME.match(self._viewer):
            return
        if any(_local(file) for file in files):
            self._warned = True
            warnings.warn(
                f"Behind JupyterHub, the viewer at {self._viewer} cannot read files on the kernel's disk: "
                "the hub's proxy answers only requests that carry your login, and a page on another origin "
                'sends none. Run chromosomix.install_viewer() once, or set CHROMOSOMIX_VIEWER to a built '
                "dist/, and the viewer is served by the kernel, on the hub's origin, beside the files.",
                stacklevel=3,
            )
