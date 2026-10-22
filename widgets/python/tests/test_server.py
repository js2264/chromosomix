"""The kernel's file server: ranges as the viewer asks for them, sidecars beside a file, nothing else."""

import base64
import gzip
import hashlib
import http.client
import io
import json
import tarfile
from pathlib import Path

import pytest

from chromosomix import viewer
from chromosomix.server import FileServer, public_base


@pytest.fixture()
def served(tmp_path: Path):
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'map.cool').write_bytes(bytes(range(256)) * 16)
    (data / 'map.cool.fai').write_text('chrI\t4096\n')
    (tmp_path / 'secret.txt').write_text('not yours')
    server = FileServer()
    yield server, data
    server.close()


def request(server: FileServer, method: str, path: str, headers: dict[str, str] | None = None):
    connection = http.client.HTTPConnection(server.host, server.port, timeout=5)
    connection.request(method, path, headers=headers or {})
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response, body


def test_answers_a_range_with_its_bytes_and_says_which(served):
    server, data = served
    path = server.path_of(data / 'map.cool')
    response, body = request(server, 'GET', path, {'Range': 'bytes=10-19'})
    assert response.status == 206
    assert body == bytes(range(10, 20))
    assert response.getheader('Content-Range') == 'bytes 10-19/4096'
    assert response.getheader('Content-Length') == '10'


def test_answers_an_open_and_a_suffix_range(served):
    server, data = served
    path = server.path_of(data / 'map.cool')
    _, tail = request(server, 'GET', path, {'Range': 'bytes=4090-'})
    assert tail == (bytes(range(256)) * 16)[4090:]
    _, last = request(server, 'GET', path, {'Range': 'bytes=-6'})
    assert last == tail


def test_refuses_a_range_past_the_end(served):
    server, data = served
    for ranged in ('bytes=5000-5010', 'bytes=4096-', 'bytes=-0'):
        response, _ = request(server, 'GET', server.path_of(data / 'map.cool'), {'Range': ranged})
        assert response.status == 416, ranged
        assert response.getheader('Content-Range') == 'bytes */4096'


def test_answers_the_whole_file_to_a_range_it_cannot_honour_as_written(served):
    # RFC 9110 §14.2: a Range that is not understood, or not valid, is ignored.
    server, data = served
    path = server.path_of(data / 'map.cool')
    for ranged in ('bytes=0-1,5-6', 'bytes=10-5', 'bytes= 0-1', 'items=0-1', 'bytes=-', 'bytes=0-' + '9' * 21):
        response, body = request(server, 'GET', path, {'Range': ranged})
        assert response.status == 200, ranged
        assert body == bytes(range(256)) * 16
        assert response.getheader('Content-Range') is None
    # Twenty digits is a number, past the end of any file, and the range stops at the file's.
    response, body = request(server, 'GET', path, {'Range': 'bytes=4095-' + '9' * 20})
    assert (response.status, body, response.getheader('Content-Range')) == (206, b'\xff', 'bytes 4095-4095/4096')


def test_answers_a_head_with_its_size_but_sends_a_range_reader_to_ask_for_a_byte(served):
    # jupyter-server-proxy answers a HEAD with `Content-Length: 0`; a HEAD that
    # said `Accept-Ranges` would have the viewer believe it.
    server, data = served
    path = server.path_of(data / 'map.cool')
    response, body = request(server, 'HEAD', path)
    assert response.status == 200
    assert body == b''
    assert response.getheader('Content-Length') == '4096'
    assert response.getheader('Accept-Ranges') is None
    ranged, _ = request(server, 'HEAD', path, {'Range': 'bytes=0-'})
    assert ranged.status == 206
    assert ranged.getheader('Content-Range') == 'bytes 0-4095/4096'
    assert ranged.getheader('Accept-Ranges') == 'bytes'
    whole, _ = request(server, 'GET', path)
    assert whole.getheader('Accept-Ranges') == 'bytes'


def test_lets_any_origin_read_and_says_so_to_a_preflight(served):
    server, data = served
    path = server.path_of(data / 'map.cool')
    response, _ = request(server, 'GET', path, {'Range': 'bytes=0-0', 'Origin': 'https://chromosomix.app'})
    assert response.getheader('Access-Control-Allow-Origin') == '*'
    assert 'Content-Range' in response.getheader('Access-Control-Expose-Headers')
    preflight, _ = request(server, 'OPTIONS', path, {
        'Origin': 'https://chromosomix.app',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
        'Access-Control-Request-Private-Network': 'true',
    })
    assert preflight.status == 204
    assert preflight.getheader('Access-Control-Allow-Private-Network') == 'true'
    assert 'Range' in preflight.getheader('Access-Control-Allow-Headers')


def test_serves_a_sidecar_beside_its_file(served):
    server, data = served
    path = server.path_of(data / 'map.cool')
    response, body = request(server, 'GET', f'{path}.fai')
    assert response.status == 200
    assert body == b'chrI\t4096\n'


def test_serves_nothing_outside_a_registered_directory(served):
    server, data = served
    token = server.path_of(data / 'map.cool').split('/')[1]
    for path in (
        f'/{token}/../secret.txt',
        f'/{token}/%2E%2E/secret.txt',
        f'/{token}/./map.cool',
        f'/{token}//etc/passwd',
        f'/{token}/%2Fetc%2Fpasswd',
        f'/{token}/map.cool%00.fai',
        '/not-a-token/map.cool',
        '/',
    ):
        response, _ = request(server, 'GET', path)
        assert response.status == 404, path


def test_serves_nothing_hidden(served):
    # A dotfile or a dot-directory beside the data — a `.git`, a `.ssh`, an
    # `.env` — is never the viewer's to read.
    server, data = served
    (data / '.env').write_text('TOKEN=1')
    (data / '.ssh').mkdir()
    (data / '.ssh' / 'id_ed25519').write_text('PRIVATE KEY')
    token = server.path_of(data / 'map.cool').split('/')[1]
    for path in (f'/{token}/.env', f'/{token}/.ssh/id_ed25519', f'/{token}/%2Essh/id_ed25519'):
        response, _ = request(server, 'GET', path)
        assert response.status == 404, path
    with pytest.raises(ValueError, match="starts with '.'"):
        server.path_of(data / '.env')


def test_follows_a_link_in_the_directory_and_finds_a_sidecar_beside_the_link(served, tmp_path):
    # A DataLad or git-annex dataset: each file a link into the annex's object
    # store, under a name of its own there. The `.bai` is beside the link.
    server, _ = served
    store = tmp_path / 'annex' / 'objects'
    (store / 'ab').mkdir(parents=True)
    (store / 'cd').mkdir(parents=True)
    (store / 'ab' / 'MD5E-s4--aaa.bam').write_bytes(b'BAM\1')
    (store / 'cd' / 'MD5E-s4--bbb.bam.bai').write_bytes(b'BAI\1')
    dataset = tmp_path / 'dataset'
    dataset.mkdir()
    (dataset / 'sample.bam').symlink_to(store / 'ab' / 'MD5E-s4--aaa.bam')
    (dataset / 'sample.bam.bai').symlink_to(store / 'cd' / 'MD5E-s4--bbb.bam.bai')
    (dataset / 'secret.txt').symlink_to(tmp_path / 'secret.txt')
    path = server.path_of(dataset / 'sample.bam')
    assert path.endswith('/sample.bam')
    assert request(server, 'GET', path)[1] == b'BAM\1'
    assert request(server, 'GET', f'{path}.bai')[1] == b'BAI\1'
    # Any link in it is followed, out of the directory too: its owner made it.
    response, body = request(server, 'GET', path.replace('sample.bam', 'secret.txt'))
    assert (response.status, body) == (200, b'not yours')


def test_gives_one_directory_one_token(served):
    server, data = served
    assert server.path_of(data / 'map.cool').split('/')[1] == server.path_of(data / 'map.cool.fai').split('/')[1]


def test_refuses_to_serve_what_is_not_a_file(served, tmp_path):
    server, _ = served
    with pytest.raises(FileNotFoundError):
        server.path_of(tmp_path / 'absent.cool')


def test_says_nothing_of_a_reader_that_hangs_up(served, capsys):
    # The viewer drops a read it has moved on from; printed, that would be a
    # traceback in whichever cell of the notebook ran last.
    server, _ = served
    for gone in (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
        try:
            raise gone()
        except OSError:
            server._server.handle_error(None, ('127.0.0.1', 1))
    assert capsys.readouterr().err == ''
    try:
        raise RuntimeError('a fault of the server')
    except RuntimeError:
        server._server.handle_error(None, ('127.0.0.1', 1))
    assert 'a fault of the server' in capsys.readouterr().err


def test_never_names_a_compressed_body_as_encoded(served, tmp_path):
    server, data = served
    (data / 'contacts.pairs.gz').write_bytes(b'\x1f\x8b' + b'\0' * 30)
    response, _ = request(server, 'GET', server.path_of(data / 'contacts.pairs.gz'), {'Range': 'bytes=0-1'})
    assert response.getheader('Content-Encoding') is None


def test_is_reached_where_the_environment_says(monkeypatch):
    monkeypatch.delenv('CHROMOSOMIX_PUBLIC_URL', raising=False)
    monkeypatch.delenv('JUPYTERHUB_SERVICE_PREFIX', raising=False)
    assert public_base(8765) == 'http://127.0.0.1:8765'
    monkeypatch.setenv('JUPYTERHUB_SERVICE_PREFIX', '/user/ada/')
    assert public_base(8765) == '/user/ada/proxy/8765'
    monkeypatch.setenv('CHROMOSOMIX_PUBLIC_URL', 'https://lab.example/files-{port}/')
    assert public_base(8765) == 'https://lab.example/files-8765'


def _registry(monkeypatch, tmp_path: Path, integrity: str | None) -> bytes:
    # npm's registry, with one package whose tarball holds a built viewer.
    # The same bytes on every call: gzip would otherwise write the time into them.
    packed = io.BytesIO()
    with gzip.GzipFile(fileobj=packed, mode='wb', mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w') as archive:
        for name, text in (('package/dist/index.html', b'<!doctype html>'), ('package/dist/assets/app.js', b'1')):
            member = tarfile.TarInfo(name)
            member.size = len(text)
            archive.addfile(member, io.BytesIO(text))
    tarball = packed.getvalue()
    meta = {'version': '0.17.0', 'dist': {'tarball': 'https://registry.example/chromosomix-0.17.0.tgz'}}
    if integrity is not None:
        meta['dist']['integrity'] = integrity
    answers = {
        'https://registry.npmjs.org/chromosomix/latest': json.dumps(meta).encode(),
        meta['dist']['tarball']: tarball,
    }
    monkeypatch.setattr(viewer, 'CACHE', tmp_path / 'cache')
    monkeypatch.setattr(viewer.urllib.request, 'urlopen', lambda url: io.BytesIO(answers[url]))
    return tarball


def test_installs_a_viewer_whole_and_only_as_npm_describes_it(monkeypatch, tmp_path):
    tarball = _registry(monkeypatch, tmp_path, None)
    digest = base64.b64encode(hashlib.sha512(tarball).digest()).decode()
    _registry(monkeypatch, tmp_path, f'sha512-{digest}')
    installed = viewer.install_viewer()
    assert installed == tmp_path / 'cache' / '0.17.0'
    assert (installed / 'assets' / 'app.js').read_bytes() == b'1'
    assert viewer.installed_viewers() == [installed]
    assert [p.name for p in (tmp_path / 'cache').iterdir()] == ['0.17.0']


def test_installs_nothing_that_is_not_the_package_npm_describes(monkeypatch, tmp_path):
    _registry(monkeypatch, tmp_path, 'sha512-' + base64.b64encode(b'\0' * 64).decode())
    with pytest.raises(RuntimeError, match='does not match'):
        viewer.install_viewer()
    assert not (tmp_path / 'cache' / '0.17.0').exists()
    assert viewer.installed_viewers() == []


def test_never_takes_an_install_cut_short_for_a_build(monkeypatch, tmp_path):
    _registry(monkeypatch, tmp_path, None)
    # What an interrupted install leaves: its unpacked directory, never moved into place.
    cut = tmp_path / 'cache' / '.0.18.0-x1y2'
    cut.mkdir(parents=True)
    (cut / 'index.html').write_text('<!doctype html>')
    assert viewer.installed_viewers() == []
    # And a half-built directory from before installs were whole is replaced.
    (tmp_path / 'cache' / '0.17.0' / 'assets').mkdir(parents=True)
    installed = viewer.install_viewer()
    assert (installed / 'index.html').is_file()
    assert viewer.installed_viewers() == [installed]
