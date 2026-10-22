"""The kernel's file server: ranges as the viewer asks for them, sidecars beside a file, nothing else."""

import http.client
import os
from pathlib import Path

import pytest

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
    response, _ = request(server, 'GET', server.path_of(data / 'map.cool'), {'Range': 'bytes=5000-5010'})
    assert response.status == 416
    assert response.getheader('Content-Range') == 'bytes */4096'


def test_answers_a_head_with_the_size_a_range_reader_probes_for(served):
    server, data = served
    response, body = request(server, 'HEAD', server.path_of(data / 'map.cool'))
    assert response.status == 200
    assert body == b''
    assert response.getheader('Content-Length') == '4096'
    assert response.getheader('Accept-Ranges') == 'bytes'


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
    for path in (f'/{token}/../secret.txt', f'/{token}/%2E%2E/secret.txt', '/not-a-token/map.cool', '/'):
        response, _ = request(server, 'GET', path)
        assert response.status == 404, path


def test_gives_one_directory_one_token(served):
    server, data = served
    assert server.path_of(data / 'map.cool').split('/')[1] == server.path_of(data / 'map.cool.fai').split('/')[1]


def test_refuses_to_serve_what_is_not_a_file(served, tmp_path):
    server, _ = served
    with pytest.raises(FileNotFoundError):
        server.path_of(tmp_path / 'absent.cool')


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
