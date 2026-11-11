"""Which build of the viewer a widget frames.

The widget is the viewer's embed (SPECS §21): `?embed=1` on a build of the app,
in an `<iframe>`. Four places a build can come from, named by `viewer=`:

- **nothing** — `CHROMOSOMIX_VIEWER` where it is set, a build fetched with
  :func:`install_viewer` where there is one, and the site, https://chromosomix.app/,
  where there is neither;
- **a version** — `"0.16.0"` or `"v0.16.0"` — the release the site keeps for ever
  at `/v/<tag>/`, which is what a notebook that must draw the same picture next
  year names;
- **an address** — any `http(s)://` build, a lab's own copy of the npm package's
  `dist/` among them;
- **a directory** — a built `dist/` on this machine, served by the kernel beside
  the data (`chromosomix.server`), so app and files are one origin and nothing
  is fetched from the network.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import urllib.request
import warnings
from pathlib import Path

from .server import public_base, shared_server

#: The site, which serves the newest release.
SITE = 'https://chromosomix.app/'

#: Where :func:`install_viewer` keeps the builds it fetched, one directory a version.
CACHE = Path(os.environ.get('CHROMOSOMIX_CACHE', Path.home() / '.cache' / 'chromosomix')) / 'viewer'

_VERSION = re.compile(r'^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$')

#: The first release whose frame takes files from a notebook (`chromosomix:add`, SPECS §21.4).
#: An older one draws the map the fragment names and nothing the widget adds.
TAKES_FILES = (0, 17, 0)


def release_of(address: str) -> tuple[int, int, int] | None:
    """The release a viewer's address names — the site's `/v/vX.Y.Z/` — or `None` for any other build."""
    found = re.search(r'/v/v(\d+)\.(\d+)\.(\d+)/?$', address)
    return None if found is None else (int(found[1]), int(found[2]), int(found[3]))


def takes_files(release: tuple[int, int, int] | None) -> bool:
    """Whether a release's frame takes files from a notebook; a build that names none is asked at run time."""
    return release is None or release >= TAKES_FILES


def installed_viewers() -> list[Path]:
    """The builds :func:`install_viewer` fetched, newest version last."""
    if not CACHE.is_dir():
        return []

    def key(path: Path) -> tuple[int, ...]:
        return tuple(int(part) for part in re.findall(r'\d+', path.name)[:3])

    # A name starting with `.` is an install still being unpacked, or one cut
    # short: never a build.
    builds = (p for p in CACHE.iterdir() if not p.name.startswith('.') and (p / 'index.html').is_file())
    return sorted(builds, key=key)


def _check_integrity(packed: bytes, integrity: str | None, version: str) -> None:
    # npm's `dist.integrity` is a Subresource Integrity string: `sha512-<base64>`
    # of the tarball, maybe with others beside it. One that names a hash this
    # can compute must match it.
    known = [
        (algorithm, digest)
        for algorithm, _, digest in (part.partition('-') for part in (integrity or '').split())
        if algorithm in ('sha256', 'sha384', 'sha512')
    ]
    if not known:
        return
    matches = (base64.b64encode(hashlib.new(algorithm, packed).digest()).decode() == digest for algorithm, digest in known)
    if not any(matches):
        raise RuntimeError(
            f'chromosomix {version} from npm is not the package npm describes: its tarball does not match '
            f'dist.integrity. Nothing was installed.'
        )


def install_viewer(version: str = 'latest') -> Path:
    """Fetch a build of the viewer from npm, once, and keep it for every widget after.

    The npm package `chromosomix` is the app built with a relative base (SPECS §22),
    so it runs from any path — here, from the kernel's own server, beside the
    files it reads. Returns the build's directory.
    """
    with urllib.request.urlopen(f'https://registry.npmjs.org/chromosomix/{version}') as response:
        meta = json.load(response)
    target = CACHE / meta['version']
    release = tuple(int(part) for part in re.findall(r'\d+', meta['version'])[:3])
    if not takes_files(release):  # type: ignore[arg-type]
        warnings.warn(
            f'chromosomix {meta["version"]} from npm cannot take files from a notebook: a widget with '
            f'tracks needs {".".join(map(str, TAKES_FILES))} or later.',
            stacklevel=2,
        )
    if (target / 'index.html').is_file():
        return target
    with urllib.request.urlopen(meta['dist']['tarball']) as response:
        packed = response.read()
    _check_integrity(packed, meta['dist'].get('integrity'), meta['version'])
    # Unpacked beside the build's place, under a name `installed_viewers` passes
    # over, and moved into it whole: an install cut short leaves no half a build
    # that every widget after would frame.
    CACHE.mkdir(parents=True, exist_ok=True)
    unpacked = Path(tempfile.mkdtemp(prefix=f'.{meta["version"]}-', dir=CACHE))
    try:
        # Readable as a build made with `mkdir` would be, not the temporary directory's owner-only.
        unpacked.chmod(0o755)
        with tarfile.open(fileobj=io.BytesIO(packed), mode='r:gz') as archive:
            for member in archive.getmembers():
                # The built viewer only, and nothing that would land outside it.
                if not member.name.startswith('package/dist/') or not (member.isfile() or member.isdir()):
                    continue
                relative = Path(member.name).relative_to('package/dist')
                if '..' in relative.parts:
                    continue
                out = unpacked / relative
                if member.isdir():
                    out.mkdir(parents=True, exist_ok=True)
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, open(out, 'wb') as sink:  # type: ignore[union-attr]
                    sink.write(source.read())
        if not (unpacked / 'index.html').is_file():
            raise RuntimeError(f'chromosomix {meta["version"]} on npm has no dist/index.html.')
        # What an install from before this one left half done is not a build.
        if target.exists() and not (target / 'index.html').is_file():
            shutil.rmtree(target)
        try:
            os.replace(unpacked, target)
        except OSError:
            # Another kernel put the same build in place first.
            if not (target / 'index.html').is_file():
                raise
    finally:
        shutil.rmtree(unpacked, ignore_errors=True)
    return target


def resolve_viewer(viewer: str | os.PathLike[str] | None = None) -> str:
    """The address of the build a widget frames, ending in `/`."""
    if viewer is None:
        named = os.environ.get('CHROMOSOMIX_VIEWER')
        if named:
            viewer = named
        else:
            installed = installed_viewers()
            if not installed:
                return SITE
            viewer = installed[-1]
    if isinstance(viewer, os.PathLike) or (isinstance(viewer, str) and not re.match(r'^https?://', viewer)):
        text = os.fspath(viewer)
        if isinstance(viewer, str) and _VERSION.match(text) and not Path(text).exists():
            tag = text if text.startswith('v') else f'v{text}'
            return f'{SITE}v/{tag}/'
        directory = Path(text).expanduser().resolve()
        if not (directory / 'index.html').is_file():
            raise FileNotFoundError(
                f'{directory} is not a build of the viewer: it has no index.html. Name a built dist/, '
                'an address, a version such as "0.16.0", or nothing for the site.'
            )
        server = shared_server()
        return public_base(server.port) + server.register_directory(directory)
    return viewer if viewer.endswith('/') else f'{viewer}/'
