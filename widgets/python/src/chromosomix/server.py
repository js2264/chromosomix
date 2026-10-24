"""Files on this machine, served to the viewer by byte range.

The viewer reads a file by range, a megabyte at a time, from wherever it is
addressed (SPECS §11): it never downloads a map whole, and it reads a sidecar —
a `.bai`, a `.fai`, a `.px2`, a `.tbi` — from beside the file it belongs to. A
file on the kernel's disk has no address, so this gives it one: a small HTTP
server on 127.0.0.1, in a thread of the kernel, that answers `GET` and `HEAD`
with the `Range` the viewer asks for, and nothing else. A `Range` it cannot
honour as written — several ranges, another unit, a last byte before the first
— is ignored and the whole file answered, as RFC 9110 has it (§14.2).

Three decisions:

- **A directory, not a file.** What is registered is the directory a file is
  named in, under a random token, so the file's sidecars are where the viewer
  looks for them — beside it — without being named one by one. A path into it
  is read as it is written, never resolved, and one that climbs out with `..`,
  or names anything whose name starts with `.` — a dotfile, a `.git`, a `.ssh` —
  is refused. A link in the directory is followed wherever it points, since
  whoever owns the directory made it: a DataLad or git-annex dataset's
  `sample.bam` is a link into the annex, and its `.bai` is still found beside
  the link, which is where the viewer looks.
- **Tokens, not paths.** A registered directory is `/<token>/…`, the token 128
  random bits drawn for this kernel. The server is on the loopback interface, so
  only this machine can reach it; the token is what keeps another page in this
  machine's browser, which can reach it too, from reading the disk by guessing.
- **Answered for any origin.** Every answer allows a cross-origin read, exposes
  `Content-Length` and `Content-Range`, and says `Access-Control-Allow-Private-Network`
  to a preflight, because the viewer may be the public site at
  https://chromosomix.app/ reading a file on 127.0.0.1. The token, not the
  origin, is the access control — except behind JupyterHub, where the hub's
  proxy in front of this server also asks for the reader's login, which only a
  page on the hub's own origin sends (`through_hub`).

The viewer itself can be served the same way (`register_directory`), which puts the
app and the data on one origin: nothing is cross-origin, nothing is fetched from
the network, and the notebook works on a machine that is offline.
"""

from __future__ import annotations

import mimetypes
import os
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote, unquote

#: How much of a file one read hands back at most; a larger range is answered in this many bytes.
CHUNK = 1 << 20

#: Types a browser needs named rather than guessed: a module script, wasm, a manifest.
TYPES = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
}

#: One range of bytes, as the viewer asks for it; twenty digits is past any file's size.
_RANGE = re.compile(r'^bytes=(\d{1,20})?-(\d{1,20})?$')

#: What writing to a reader that has hung up raises: the viewer drops a read it has moved on from.
_GONE = (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)


def _type_of(path: Path) -> str:
    # A `.gz` is its own bytes, never a body to be inflated in transit — the
    # viewer reads a bgzipped file by range, and `Content-Encoding: gzip` would
    # turn every range into a slice of a compressed stream.
    return TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: object, client_address: object) -> None:
        # A reader that hangs up halfway through an answer is not an error, and
        # printed it would be a traceback in whichever cell of the notebook ran
        # last. Anything else is still said.
        if isinstance(sys.exc_info()[1], _GONE):
            return
        super().handle_error(request, client_address)  # type: ignore[arg-type]


class FileServer:
    """The loopback server, started on first use and kept for the life of the kernel."""

    def __init__(self, host: str = '127.0.0.1', port: int = 0) -> None:
        self._roots: dict[str, Path] = {}
        self._tokens: dict[Path, str] = {}
        self._lock = threading.Lock()
        roots, lock = self._roots, self._lock

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                # A notebook cell is not a server log.
                return

            def _cors(self, ranges: bool = True) -> None:
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
                if ranges:
                    self.send_header('Accept-Ranges', 'bytes')

            def do_OPTIONS(self) -> None:  # noqa: N802
                self.send_response(204)
                self._cors()
                self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
                # Chrome asks before a public page reads a private address.
                self.send_header('Access-Control-Allow-Private-Network', 'true')
                self.send_header('Access-Control-Max-Age', '600')
                self.send_header('Content-Length', '0')
                self.end_headers()

            def _resolve(self) -> Path | None:
                token, slash, rest = unquote(self.path.split('?', 1)[0]).lstrip('/').partition('/')
                if not slash:
                    return None
                with lock:
                    root = roots.get(token)
                if root is None:
                    return None
                names = rest.split('/')
                # The directory's own address, `/<token>/`, is its index.html.
                if names[-1] == '':
                    names.pop()
                # Read as written, never resolved: no empty name, which would
                # start again from the top of the disk, no `..` or `.`, and
                # nothing hidden. What is left is inside the directory, and a
                # link in it is followed, as its owner made it.
                if any(name == '' or name.startswith('.') for name in names):
                    return None
                relative = Path(*names)
                # A name this file system reads as more than one — `a\b`, `C:` on Windows — is refused too.
                if relative.anchor or relative.parts != tuple(names):
                    return None
                try:
                    target = root.joinpath(relative)
                    if target.is_dir():
                        target = target / 'index.html'
                    return target if target.is_file() else None
                except (ValueError, OSError):
                    # A name no file can have — a NUL byte in it — or one the disk will not say.
                    return None

            def _refuse(self, status: int) -> None:
                self.send_response(status)
                self._cors()
                self.send_header('Content-Length', '0')
                self.end_headers()

            def _answer(self, body: bool) -> None:
                path = self._resolve()
                try:
                    handle = None if path is None else open(path, 'rb')
                except OSError:
                    handle = None
                if handle is None:
                    self._refuse(404)
                    return
                with handle:
                    self._send(handle, body)

            def _send(self, handle: BinaryIO, body: bool) -> None:
                size = os.fstat(handle.fileno()).st_size
                start, end = 0, size - 1
                ranged = self.headers.get('Range')
                found = None if ranged is None else _RANGE.match(ranged.strip())
                # A range that is not one range of bytes as written — several, a
                # unit other than bytes, a space, no number at all, a last byte
                # before the first, a number past twenty digits — is ignored,
                # and the whole file answered (RFC 9110 §14.2).
                if found is not None and (
                    (found[1] is None and found[2] is None)
                    or (found[1] is not None and found[2] is not None and int(found[2]) < int(found[1]))
                ):
                    found = None
                if found is not None:
                    if found[1] is None:
                        start = max(0, size - int(found[2]))
                    else:
                        start = int(found[1])
                        end = min(size - 1, int(found[2])) if found[2] is not None else size - 1
                    # One range, well formed, that starts at or past the end.
                    if start >= size:
                        self.send_response(416)
                        self._cors()
                        self.send_header('Content-Range', f'bytes */{size}')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                length = end - start + 1
                self.send_response(206 if found is not None else 200)
                # A `HEAD` that names no range says nothing about ranges. Its
                # `Content-Length` does not survive every way in: behind
                # JupyterHub, jupyter-server-proxy answers a `HEAD` with
                # `Content-Length: 0`, whatever was sent, and a viewer told
                # `Accept-Ranges: bytes` and a length believes both — it read a
                # map as a file of no bytes. Told nothing, it asks for one byte,
                # whose `Content-Range` names the size and passes any proxy.
                self._cors(ranges=body or found is not None)
                self.send_header('Content-Type', _type_of(Path(handle.name)))
                self.send_header('Content-Length', str(length))
                if found is not None:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                if not body:
                    return
                handle.seek(start)
                left = length
                while left > 0:
                    block = handle.read(min(CHUNK, left))
                    if not block:
                        break
                    self.wfile.write(block)
                    left -= len(block)

            def do_GET(self) -> None:  # noqa: N802
                self._answer(True)

            def do_HEAD(self) -> None:  # noqa: N802
                self._answer(False)

        self._server = _Server((host, port), Handler)
        self.host, self.port = self._server.server_address[:2]
        self._thread = threading.Thread(target=self._server.serve_forever, name='chromosomix-files', daemon=True)
        self._thread.start()

    @property
    def origin(self) -> str:
        return f'http://{self.host}:{self.port}'

    def _token_for(self, directory: Path) -> str:
        with self._lock:
            token = self._tokens.get(directory)
            if token is None:
                token = secrets.token_urlsafe(16)
                self._tokens[directory] = token
                self._roots[token] = directory
            return token

    def path_of(self, file: str | os.PathLike[str]) -> str:
        """The server path a local file is read at, its directory registered — its sidecars with it.

        The directory is the one the file is named in, and a link is read by its
        own name, not resolved: a link into an object store — DataLad's,
        git-annex's — has its sidecars beside it, not beside what it points to.
        """
        target = Path(file).expanduser().absolute()
        if not target.is_file():
            raise FileNotFoundError(f'{target} is not a file on this machine.')
        if target.name.startswith('.'):
            # Said here rather than as a refusal the viewer cannot explain.
            raise ValueError(
                f"{target} is not served: the kernel's server reads no name that starts with '.', which is "
                'how a file is hidden. Rename it, or link to it under another name.'
            )
        return f'/{self._token_for(target.parent)}/{quote(target.name)}'

    def register_directory(self, directory: str | os.PathLike[str]) -> str:
        """The server path a whole directory is read under, with a trailing slash."""
        target = Path(directory).expanduser().resolve()
        if not target.is_dir():
            raise NotADirectoryError(f'{target} is not a directory on this machine.')
        return f'/{self._token_for(target)}/'

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


_shared: FileServer | None = None
_shared_lock = threading.Lock()


def shared_server() -> FileServer:
    """The kernel's one server, started on the first file it is asked to serve."""
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = FileServer()
        return _shared


def public_base(port: int) -> str:
    """Where the browser reaches the server on `port`, which is not always where the kernel does.

    On a laptop, 127.0.0.1. In Google Colab, the notebook's own proxy to the
    kernel's port; behind JupyterHub with jupyter-server-proxy, the hub's
    `proxy/<port>/` path, which the widget resolves against the page it is shown
    on. `CHROMOSOMIX_PUBLIC_URL` overrides all three, with `{port}` where the port
    goes.
    """
    named = os.environ.get('CHROMOSOMIX_PUBLIC_URL')
    if named:
        return named.replace('{port}', str(port)).rstrip('/')
    try:
        from google.colab.output import eval_js  # type: ignore[import-not-found]

        return str(eval_js(f'google.colab.kernel.proxyPort({port})')).rstrip('/')
    except ImportError:
        pass
    if through_hub():
        return f"{os.environ['JUPYTERHUB_SERVICE_PREFIX'].rstrip('/')}/proxy/{port}"
    return f'http://127.0.0.1:{port}'


def through_hub() -> bool:
    """Whether the browser reaches this server through JupyterHub's jupyter-server-proxy.

    That proxy answers only a request carrying the reader's login to the hub —
    a cookie a page on the hub's own origin sends and a page on any other origin
    does not — so behind it the files are readable by a viewer the kernel serves,
    and by no other.
    """
    return not os.environ.get('CHROMOSOMIX_PUBLIC_URL') and bool(os.environ.get('JUPYTERHUB_SERVICE_PREFIX'))


def serve(file: str | os.PathLike[str]) -> str:
    """The address the viewer reads a local file at: the kernel's server, its directory beside it."""
    server = shared_server()
    return public_base(server.port) + server.path_of(file)
