"""Files on this machine, served to the viewer by byte range.

The viewer reads a file by range, a megabyte at a time, from wherever it is
addressed (SPECS §11): it never downloads a map whole, and it reads a sidecar —
a `.bai`, a `.fai`, a `.px2`, a `.tbi` — from beside the file it belongs to. A
file on the kernel's disk has no address, so this gives it one: a small HTTP
server on 127.0.0.1, in a thread of the kernel, that answers `GET` and `HEAD`
with the `Range` the viewer asks for, and nothing else.

Three decisions:

- **A directory, not a file.** What is registered is the directory a file is in,
  under a random token, so the file's sidecars are where the viewer looks for
  them — beside it — without being named one by one. Nothing outside a
  registered directory is served, and a path that climbs out of one is refused.
- **Tokens, not paths.** A registered directory is `/<token>/…`, the token 128
  random bits drawn for this kernel. The server is on the loopback interface, so
  only this machine can reach it; the token is what keeps another page in this
  machine's browser, which can reach it too, from reading the disk by guessing.
- **Answered for any origin.** Every answer allows a cross-origin read, exposes
  `Content-Length` and `Content-Range`, and says `Access-Control-Allow-Private-Network`
  to a preflight, because the viewer may be the public site at
  https://chromosomix.app/ reading a file on 127.0.0.1. The token, not the
  origin, is the access control.

The viewer itself can be served the same way (`register_viewer`), which puts the
app and the data on one origin: nothing is cross-origin, nothing is fetched from
the network, and the notebook works on a machine that is offline.
"""

from __future__ import annotations

import mimetypes
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
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

_RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')


def _type_of(path: Path) -> str:
    # A `.gz` is its own bytes, never a body to be inflated in transit — the
    # viewer reads a bgzipped file by range, and `Content-Encoding: gzip` would
    # turn every range into a slice of a compressed stream.
    return TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'


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

            def _cors(self) -> None:
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
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
                parts = unquote(self.path.split('?', 1)[0]).lstrip('/').split('/', 1)
                if len(parts) != 2:
                    return None
                with lock:
                    root = roots.get(parts[0])
                if root is None:
                    return None
                target = (root / parts[1]).resolve()
                # Nothing outside the directory registered under the token.
                if target != root and root not in target.parents:
                    return None
                if target.is_dir():
                    target = target / 'index.html'
                return target if target.is_file() else None

            def _refuse(self, status: int) -> None:
                self.send_response(status)
                self._cors()
                self.send_header('Content-Length', '0')
                self.end_headers()

            def _answer(self, body: bool) -> None:
                path = self._resolve()
                if path is None:
                    self._refuse(404)
                    return
                size = path.stat().st_size
                start, end = 0, size - 1
                ranged = self.headers.get('Range')
                if ranged is not None:
                    found = _RANGE.match(ranged.strip())
                    if found is None or (found.group(1) == '' and found.group(2) == ''):
                        self._refuse(416)
                        return
                    if found.group(1) == '':
                        start = max(0, size - int(found.group(2)))
                    else:
                        start = int(found.group(1))
                        end = min(size - 1, int(found.group(2))) if found.group(2) else size - 1
                    if start >= size or start > end:
                        self.send_response(416)
                        self._cors()
                        self.send_header('Content-Range', f'bytes */{size}')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                length = end - start + 1
                self.send_response(206 if ranged is not None else 200)
                self._cors()
                self.send_header('Content-Type', _type_of(path))
                self.send_header('Content-Length', str(length))
                if ranged is not None:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                if not body:
                    return
                with open(path, 'rb') as handle:
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

        self._server = ThreadingHTTPServer((host, port), Handler)
        self._server.daemon_threads = True
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
        """The server path a local file is read at, its directory registered — its sidecars with it."""
        target = Path(file).expanduser().resolve()
        if not target.is_file():
            raise FileNotFoundError(f'{target} is not a file on this machine.')
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
    prefix = os.environ.get('JUPYTERHUB_SERVICE_PREFIX')
    if prefix:
        return f"{prefix.rstrip('/')}/proxy/{port}"
    return f'http://127.0.0.1:{port}'


def serve(file: str | os.PathLike[str]) -> str:
    """The address the viewer reads a local file at: the kernel's server, its directory beside it."""
    server = shared_server()
    return public_base(server.port) + server.path_of(file)
