"""What the widget hands its frame: the address, the view in it, and the messages after."""

import warnings
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


def plain(requests: list[dict]) -> list[dict]:
    """The requests as the view replays them whole: without what a merge keeps for a view that made the last one."""
    return [{key: value for key, value in request.items() if key not in ('fresh', 'after')} for request in requests]


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
    assert view.requests == []


def test_places_a_browser_with_no_map_by_a_move_after_its_files():
    # The fragment has nothing to name without a map, so the locus and the view
    # keywords are a `navigate`, which the frame carries out after the files.
    view = Chromosomix(tracks=['https://d.example/ATAC.bw'], locus=('IV', 400_000, 460_000), colormap='Reds', smooth=None)
    assert view.src == 'https://chromosomix.app/?embed=1'
    assert view.files == ['https://d.example/ATAC.bw']
    assert plain(view.requests) == [
        {'type': 'navigate', 'state': {'locus': 'IV:400000-460000', 'colormap': 'Reds'}, 'seq': 1},
    ]
    # A locus given wins over a region.
    both = Chromosomix(tracks=['https://d.example/ATAC.bw'], region='IV:1-100', locus='V:1-100')
    assert both.requests[0]['state'] == {'locus': 'V:1-100'}
    # A move asked before the frame is up is laid over it.
    view.goto('IV:1-2000')
    assert plain(view.requests) == [{'type': 'navigate', 'state': {'locus': 'IV:1-2000', 'colormap': 'Reds'}, 'seq': 2}]


def test_refuses_a_hidden_file_when_it_is_named_not_when_it_is_read(tmp_path: Path):
    # The server reads no name that starts with `.`, so one is refused here,
    # with the cell as it was, rather than given an address that answers 404.
    (tmp_path / '.hidden.cool').write_bytes(b'\x89HDF\r\n\x1a\n')
    with pytest.raises(ValueError, match="starts with '.'"):
        Chromosomix(tmp_path / '.hidden.cool')
    view = Chromosomix('https://d.example/a.cool')
    with pytest.raises(ValueError, match="starts with '.'"):
        view.add(tmp_path / '.hidden.cool')
    assert view.requests == []
    # A directory with a dot in its path is the directory served, and no name inside it is hidden.
    (tmp_path / '.cache').mkdir()
    (tmp_path / '.cache' / 'c.cool').write_bytes(b'\x89HDF\r\n\x1a\n')
    assert address(tmp_path / '.cache' / 'c.cool').endswith('/c.cool')


def test_serves_a_local_file_from_the_kernel_and_keeps_its_group(tmp_path: Path):
    (tmp_path / 'sample.mcool').write_bytes(b'\x89HDF\r\n\x1a\n')
    served = address(f'{tmp_path / "sample.mcool"}::/resolutions/5000')
    assert served.startswith('http://127.0.0.1:')
    assert served.endswith('/sample.mcool::/resolutions/5000')


def test_says_when_a_frame_on_another_origin_cannot_read_the_kernel_s_files_behind_a_hub(monkeypatch, tmp_path: Path):
    # Behind JupyterHub a served file is behind the hub's login, which only a
    # viewer on the hub's own origin sends.
    monkeypatch.setenv('JUPYTERHUB_SERVICE_PREFIX', '/user/ada/')
    (tmp_path / 'a.cool').write_bytes(b'\x89HDF\r\n\x1a\n')
    (tmp_path / 'index.html').write_text('<!doctype html>')
    with pytest.warns(UserWarning, match='install_viewer'):
        Chromosomix(tmp_path / 'a.cool')
    on_the_site = Chromosomix('https://d.example/a.cool')
    with pytest.warns(UserWarning, match='install_viewer'):
        on_the_site.add(tmp_path / 'a.cool')
    with pytest.warns(UserWarning, match='install_viewer'):
        Chromosomix('https://d.example/a.cool').navigate(uri2=tmp_path / 'a.cool')
    with warnings.catch_warnings():
        warnings.simplefilter('error')
        # Said once a widget.
        on_the_site.add(tmp_path / 'a.cool')
        served = Chromosomix(tmp_path / 'a.cool', viewer=tmp_path)
        assert served.viewer.startswith('/user/ada/proxy/')
        Chromosomix('https://d.example/a.cool', tracks=['https://d.example/b.bw'])
        # A deck's own words are not files on the kernel's disk.
        Chromosomix('https://d.example/a.cool').navigate(maps='3d|tracks|~')
        monkeypatch.setenv('CHROMOSOMIX_PUBLIC_URL', 'https://files.example/{port}')
        Chromosomix(tmp_path / 'a.cool')


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
    view.add('https://d.example/b.bw')
    view.navigate(transform='log2', oe=True, vmax=None)
    view.state = {'uri': 'https://d.example/a.bw', 'view': 'browser'}
    view.goto('I:1,000-2,000')
    assert plain(view.requests) == [
        {'type': 'navigate', 'state': {'view': 'region', 'region': 'II:100000-200000', 'region2': None, 'focus': None}, 'seq': 1},
        {'type': 'add', 'files': ['https://d.example/b.bw'], 'seq': 2},
        # Two patches in a row are one, numbered as the second.
        {'type': 'navigate', 'state': {'transform': 'log2', 'oe': 'true', 'vmax': None, 'locus': 'I:1,000-2,000'}, 'seq': 4},
    ]


def test_frames_a_region_with_no_map_in_the_view_that_draws_one():
    # A region frames the map the first file opens, and frames nothing but in
    # the region view; `goto` then moves that view, until the frame says otherwise.
    view = Chromosomix(tracks=['https://d.example/a.cool', 'https://d.example/ATAC.bw'], region=('IV', 1, 100))
    assert view.src == 'https://chromosomix.app/?embed=1'
    assert view.requests == [{'type': 'navigate', 'state': {'view': 'region', 'region': 'IV:1-100'}, 'seq': 1}]
    view.goto('V:1-200')
    assert view.requests[-1]['state'] == {'view': 'region', 'region': 'V:1-200', 'region2': None, 'focus': None}
    # A map opened on the browser is moved by its locus.
    browsing = Chromosomix('https://d.example/a.cool', view='browser')
    browsing.goto('I:1-2')
    assert browsing.requests[-1]['state'] == {'locus': 'I:1-2'}


def test_frames_a_region_on_the_diagonal_whatever_block_the_map_was_on():
    # An off-diagonal block keeps its second axis and its focus unless the
    # patch takes them away, and a `goto` is a region on both axes.
    view = Chromosomix('https://d.example/a.cool')
    view.state = {'uri': 'https://d.example/a.cool', 'view': 'region', 'region': 'I', 'region2': 'V', 'focus': 'I:1-100'}
    view.goto('II:100000-200000')
    assert view.requests[-1]['state'] == {'view': 'region', 'region': 'II:100000-200000', 'region2': None, 'focus': None}


def test_keeps_every_request_a_view_drawn_late_needs_however_many_moves_were_asked():
    view = Chromosomix('https://d.example/a.cool')
    view.add('https://d.example/early.bw')
    for at in range(500):
        view.goto(('I', at, at + 1))
    view.navigate(transform='log2', region2='V')
    view.navigate(region2=None)
    assert plain(view.requests) == [
        {'type': 'add', 'files': ['https://d.example/early.bw'], 'seq': 1},
        {
            'type': 'navigate',
            'state': {'view': 'region', 'region': 'I:499-500', 'region2': None, 'focus': None, 'transform': 'log2'},
            'seq': 503,
        },
    ]
    # An `add` is never laid over, nor a move over one.
    view.add('https://d.example/late.bw')
    view.add('https://d.example/later.bw')
    view.goto('II:1-2')
    assert [request['type'] for request in view.requests] == ['add', 'navigate', 'add', 'add', 'navigate']
    assert view.requests[-1] == {
        'type': 'navigate', 'state': {'view': 'region', 'region': 'II:1-2', 'region2': None, 'focus': None}, 'seq': 506,
    }


def test_loads_a_new_frame_and_forgets_what_the_last_one_was_asked_and_said():
    view = Chromosomix('https://d.example/a.cool')
    assert view.loads == 1
    view.goto('I:1-100')
    view.state = {'uri': 'https://d.example/a.cool', 'view': 'region', 'region': 'I:1-100'}
    view.rendered = {'status': 'complete'}
    view.notice = 'The viewer in this frame cannot take files.'
    src = view.src
    # The same map again is a new frame all the same: `loads` moves when `src` does not.
    view.load('https://d.example/a.cool')
    assert (view.src, view.loads) == (src, 2)
    assert (view.state, view.rendered, view.notice, view.requests, view.files) == (None, {}, '', [], [])
    # `goto` now moves the new frame as it opens — a browser, here — not as the old one last said.
    view.load(None, tracks=['https://d.example/x.bw'])
    view.goto('I:1000-2000')
    assert view.loads == 3
    assert view.requests[-1]['state'] == {'locus': 'I:1000-2000'}


def test_sends_a_load_to_the_front_end_as_one_change(monkeypatch):
    # A view puts the new frame up on `loads`, and finds everything else it is
    # to be given already there.
    view = Chromosomix('https://d.example/a.cool')
    view.goto('I:1-100')
    view.state = {'uri': 'https://d.example/a.cool', 'view': 'region'}
    sent: list[object] = []
    # Copied: ipywidgets empties the set it hands over once it is sent.
    monkeypatch.setattr(view, 'send_state', lambda key=None: sent.append(set(key) if isinstance(key, set) else key))
    view.load('https://d.example/b.cool', tracks=['https://d.example/b.bw'])
    assert len(sent) == 1
    assert {'state', 'requests', 'files', 'src', 'loads'} <= set(sent[0])


def test_leaves_the_cell_as_it_was_when_a_load_cannot_be_made(tmp_path: Path):
    view = Chromosomix('https://d.example/a.cool', tracks=['https://d.example/a.bw'])
    view.goto('I:1-100')
    view.state = {'uri': 'https://d.example/a.cool', 'view': 'region', 'region': 'I:1-100'}
    view.rendered = {'status': 'complete'}
    names = ('src', 'files', 'requests', 'state', 'rendered', 'notice', 'loads')
    before = {name: getattr(view, name) for name in names}
    with pytest.raises(FileNotFoundError):
        view.load(tmp_path / 'absent.cool')
    with pytest.raises(FileNotFoundError):
        view.load('https://d.example/b.cool', tracks=['https://d.example/b.bw', tmp_path / 'absent.bw'])
    with pytest.raises(FileNotFoundError):
        view.load(None, tracks=['https://d.example/b.bw'], uri2=tmp_path / 'absent.cool')
    with pytest.raises(TypeError):
        view.load('https://d.example/b.cool', genomes=['a', 'b'])
    assert {name: getattr(view, name) for name in names} == before


def test_takes_one_value_a_key_as_the_address_bar_writes_it():
    with pytest.raises(TypeError, match=r"genomes= takes one value.*genomes='a,b'"):
        Chromosomix('https://d.example/a.cool', genomes=['a', 'b'])
    view = Chromosomix('https://d.example/a.cool')
    for key, value in (('cells', ('a', 'b')), ('maps', {'https://d.example/b.cool'}), ('regions', ['I', 'II'])):
        with pytest.raises(TypeError, match=f'^{key}= takes one value'):
            view.navigate(**{key: value})
    assert view.requests == []
    # A locus as a tuple is written as the address bar writes one.
    view.navigate(region=('II', 1, 2), locus=('I', 10, 20))
    assert view.requests[-1]['state'] == {'region': 'II:1-2', 'locus': 'I:10-20'}


def test_keeps_the_deck_s_own_words_among_its_maps(tmp_path: Path):
    # `~`, `3d` and `tracks` name a cell, not a file, and are not served.
    (tmp_path / 'b.cool').write_bytes(b'\x89HDF\r\n\x1a\n')
    view = Chromosomix('https://d.example/a.cool', maps=f'3d|{tmp_path / "b.cool"}|tracks|~')
    deck = fragment(view)['maps'].split('|')
    assert deck[0] == '3d' and deck[2:] == ['tracks', '~']
    assert deck[1].startswith('http://127.0.0.1:') and deck[1].endswith('/b.cool')
    view.navigate(maps='tracks|https://d.example/c.cool|3d')
    assert view.requests[-1]['state'] == {'maps': 'tracks|https://d.example/c.cool|3d'}


def test_spells_numpy_s_switches_as_the_hash_does():
    numpy = pytest.importorskip('numpy')
    view = Chromosomix('https://d.example/a.cool', balance=numpy.bool_(True), oe=numpy.bool_(False))
    assert (fragment(view)['balance'], fragment(view)['oe']) == ('true', 'false')
    view.navigate(oe=numpy.bool_(True), vmax=numpy.float64(12.5))
    assert view.requests[-1]['state'] == {'oe': 'true', 'vmax': '12.5'}


def test_serves_the_files_a_view_key_names_from_the_kernel(tmp_path: Path):
    (tmp_path / 'b.cool').write_bytes(b'\x89HDF\r\n\x1a\n')
    (tmp_path / 'c.mcool').write_bytes(b'\x89HDF\r\n\x1a\n')
    view = Chromosomix(
        'https://d.example/a.cool',
        uri2=tmp_path / 'b.cool',
        maps=f'{tmp_path / "c.mcool"}::/resolutions/5000|https://d.example/d.cool',
    )
    said = fragment(view)
    assert said['uri2'].startswith('http://127.0.0.1:') and said['uri2'].endswith('/b.cool')
    deck = said['maps'].split('|')
    assert deck[0].startswith('http://127.0.0.1:') and deck[0].endswith('/c.mcool::/resolutions/5000')
    assert deck[1] == 'https://d.example/d.cool'
    view.navigate(uri=str(tmp_path / 'b.cool'), uri2=None, maps=f'https://d.example/d.cool|{tmp_path / "b.cool"}')
    state = view.requests[-1]['state']
    assert state['uri'].startswith('http://127.0.0.1:') and state['uri'].endswith('/b.cool')
    assert state['uri2'] is None
    assert state['maps'].startswith('https://d.example/d.cool|http://127.0.0.1:')


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
    assert view.requests[-1]['state'] == {'view': 'region', 'region': 'IV:1-100', 'region2': None, 'focus': None}


def test_warns_when_a_release_too_old_to_take_files_is_given_some():
    with pytest.warns(UserWarning, match='cannot take files'):
        Chromosomix('https://d.example/a.cool', tracks=['https://d.example/a.bw'], viewer='0.16.0')
    view = Chromosomix('https://d.example/a.cool', viewer='0.16.0')
    with pytest.warns(UserWarning, match='1 will not be added'):
        view.add('https://d.example/b.bw')
    # A release that takes them, or a build that names no release, says nothing here.
    with warnings.catch_warnings():
        warnings.simplefilter('error')
        Chromosomix('https://d.example/a.cool', tracks=['https://d.example/a.bw'], viewer='0.17.0')
        Chromosomix('https://d.example/a.cool', tracks=['https://d.example/a.bw'], viewer='https://lab.example/viewer/')


def test_tells_a_view_that_made_the_last_move_only_what_was_asked_since():
    view = Chromosomix('https://d.example/a.cool')
    view.goto('II:1-100')
    view.navigate(transform='log2')
    merged = view.requests[-1]
    # The whole patch, for a view drawn late; the new keys, after the request it replaced.
    assert merged['state'] == {'view': 'region', 'region': 'II:1-100', 'region2': None, 'focus': None, 'transform': 'log2'}
    assert merged['fresh'] == {'transform': 'log2'}
    assert merged['after'] < merged['seq']
