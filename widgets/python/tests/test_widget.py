"""What the widget hands its frame: the address, the view in it, and the messages after."""

from pathlib import Path
from urllib.parse import unquote

import pytest

from chromosomix import Chromosomix, address, resolve_viewer
from chromosomix.widget import view_hash


@pytest.fixture(autouse=True)
def no_installed_viewer(monkeypatch, tmp_path):
    monkeypatch.delenv('CHROMOSOMIX_VIEWER', raising=False)
    monkeypatch.delenv('CHROMOSOMIX_PUBLIC_URL', raising=False)
    monkeypatch.delenv('JUPYTERHUB_SERVICE_PREFIX', raising=False)
    monkeypatch.setattr('chromosomix.viewer.CACHE', tmp_path / 'no-cache')


def fragment(widget: Chromosomix) -> dict[str, str]:
    body = widget.src.split('#', 1)[1]
    return {key: unquote(value) for key, value in (part.split('=', 1) for part in body.split('&'))}


def test_frames_the_site_with_the_view_in_its_fragment():
    view = Chromosomix('https://data.example/yeast.cool', region='IV:1000000-1400000', transform='log10', balance=True)
    assert view.src.startswith('https://chromosomix.app/?embed=1#')
    assert fragment(view) == {
        'uri': 'https://data.example/yeast.cool',
        'view': 'region',
        'region': 'IV:1000000-1400000',
        'transform': 'log10',
        'balance': 'true',
    }
    assert view.files == []


def test_writes_the_fragment_in_the_app_s_key_order_and_spelling():
    assert view_hash({'transform': 'log2', 'uri': 'https://d.example/a.mcool::/resolutions/5000', 'vmax': 12.5}) == (
        'uri=https://d.example/a.mcool::/resolutions/5000&transform=log2&vmax=12.5'
    )
    # A comma and a bar stay readable, as the app writes them.
    assert view_hash({'uri': 'a.cool', 'maps': 'b.cool|c.cool', 'locus': 'I:1,000-2,000'}) == (
        'uri=a.cool&maps=b.cool|c.cool&locus=I:1,000-2,000'
    )


def test_puts_tracks_in_files_for_the_frame_to_add_once_the_map_is_up():
    view = Chromosomix('https://d.example/a.cool', tracks=['https://d.example/ATAC.bw', 's3://bucket/genes.gtf'])
    assert view.files == ['https://d.example/ATAC.bw', 's3://bucket/genes.gtf']


def test_opens_on_the_picker_when_there_is_no_map_and_adds_every_file():
    view = Chromosomix(tracks=['https://d.example/ATAC.bw'])
    assert view.src == 'https://chromosomix.app/?embed=1'
    assert view.files == ['https://d.example/ATAC.bw']


def test_serves_a_local_file_from_the_kernel_and_keeps_its_group(tmp_path: Path):
    (tmp_path / 'sample.mcool').write_bytes(b'\x89HDF\r\n\x1a\n')
    served = address(f'{tmp_path / "sample.mcool"}::/resolutions/5000')
    assert served.startswith('http://127.0.0.1:')
    assert served.endswith('/sample.mcool::/resolutions/5000')


def test_names_a_release_by_its_permanent_address():
    assert resolve_viewer('0.16.0') == 'https://chromosomix.app/v/v0.16.0/'
    assert resolve_viewer('v0.16.0') == 'https://chromosomix.app/v/v0.16.0/'
    assert resolve_viewer('https://lab.example/viewer') == 'https://lab.example/viewer/'


def test_serves_a_local_build_beside_the_data(tmp_path: Path):
    (tmp_path / 'index.html').write_text('<!doctype html>')
    served = resolve_viewer(tmp_path)
    assert served.startswith('http://127.0.0.1:') and served.endswith('/')
    with pytest.raises(FileNotFoundError):
        resolve_viewer(tmp_path / 'nothing-here')


def test_asks_for_a_patch_and_moves_by_the_key_the_view_uses():
    view = Chromosomix('https://d.example/a.cool')
    view.goto(('II', 100_000, 200_000))
    view.navigate(transform='log2', oe=True, vmax=None)
    view.state = {'uri': 'https://d.example/a.bw', 'view': 'browser'}
    view.goto('I:1,000-2,000')
    view.add('https://d.example/b.bw')
    assert view.requests == [
        {'type': 'navigate', 'state': {'view': 'region', 'region': 'II:100000-200000'}, 'seq': 1},
        {'type': 'navigate', 'state': {'transform': 'log2', 'oe': 'true', 'vmax': None}, 'seq': 2},
        {'type': 'navigate', 'state': {'locus': 'I:1,000-2,000'}, 'seq': 3},
        {'type': 'add', 'files': ['https://d.example/b.bw'], 'seq': 4},
    ]


def test_keeps_the_newest_requests_for_a_view_drawn_late_and_forgets_them_with_the_frame():
    view = Chromosomix('https://d.example/a.cool')
    for at in range(Chromosomix.KEPT_REQUESTS + 5):
        view.goto(('I', at, at + 1))
    assert len(view.requests) == Chromosomix.KEPT_REQUESTS
    assert view.requests[-1]['seq'] == Chromosomix.KEPT_REQUESTS + 5
    view.load('https://d.example/b.cool')
    assert view.requests == []


def test_loading_again_replaces_the_frame_s_address():
    view = Chromosomix('https://d.example/a.cool')
    view.load('https://d.example/b.cool', tracks=['https://d.example/b.bw'], colormap='Reds')
    assert fragment(view)['uri'] == 'https://d.example/b.cool'
    assert fragment(view)['colormap'] == 'Reds'
    assert view.files == ['https://d.example/b.bw']


def test_moves_a_browser_by_its_locus_before_the_viewer_has_said_anything():
    # "Run all": the cell after the widget asks before its frame is drawn.
    browser = Chromosomix(tracks=['https://d.example/ATAC.bw'])
    browser.goto('IV:400,001-460,000')
    view = Chromosomix('https://d.example/a.cool')
    view.goto('IV:1-100')
    assert browser.requests[-1]['state'] == {'locus': 'IV:400,001-460,000'}
    assert view.requests[-1]['state'] == {'view': 'region', 'region': 'IV:1-100'}
