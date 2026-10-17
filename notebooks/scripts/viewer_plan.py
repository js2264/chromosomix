"""What timing.qmd's first section asks of each viewer, worked out from the files themselves.

Every run is one map and one track, at one resolution, in one viewer. The resolution is the
plan's, never the viewer's: each viewer is asked for it in the one way it offers, and a viewer
that cannot draw it — a rung its format does not store, a whole genome it draws only from a
matrix of its own — is reported as such, not run, rather than shown something else and timed.

- **chromosomix** is handed a workspace naming the map at that rung (`file::/resolutions/N`), the
  view and the track; from disk, the workspace names the files and they are dropped with it.
- **juicebox.js** is handed an explicit state: the chromosome's index in the `.hic`'s own list,
  the resolution's index in its list, the window's first bin, and a pixel size that fits the
  window's bins to the map.
- **HiGlass** is handed the window as a domain on the map's own coordinates and the rung as its
  heatmap's `maxZoom` — its only control over the resolution, which caps the rung it would
  otherwise choose. Its track is laid on the map's chromosomes in the track's own names
  (`higlass_server.py` says why).
"""
import json
import math
import struct
import urllib.request
from pathlib import Path


def _read(location, start, length):
    """Bytes of a local file or of a URL, by range."""
    if str(location).startswith(('http://', 'https://')):
        request = urllib.request.Request(str(location), headers={'Range': f'bytes={start}-{start + length - 1}'})
        with urllib.request.urlopen(request) as response:
            return response.read()
    with open(location, 'rb') as handle:
        handle.seek(start)
        return handle.read(length)


def hic_header(location):
    """A `.hic`'s chromosomes, in its own order and with its whole-genome entry first, and its rungs."""
    data = _read(location, 0, 1 << 20)
    at = 0

    def take(fmt):
        nonlocal at
        value = struct.unpack_from(fmt, data, at)
        at += struct.calcsize(fmt)
        return value[0]

    def string():
        nonlocal at
        end = data.index(b'\0', at)
        value = data[at:end].decode()
        at = end + 1
        return value

    if string() != 'HIC':
        raise ValueError(f'{location} is not a .hic')
    version = take('<i')
    take('<q')
    string()
    if version >= 9:
        take('<q')
        take('<q')
    for _ in range(take('<i')):
        string()
        string()
    chromosomes = []
    for _ in range(take('<i')):
        name = string()
        chromosomes.append((name, take('<q') if version >= 9 else take('<i')))
    resolutions = [take('<i') for _ in range(take('<i'))]
    return {'version': version, 'chromosomes': chromosomes, 'resolutions': resolutions}


def mcool_info(path):
    """An `.mcool`'s chromosomes, in its order, and its rungs, from a copy on disk."""
    import h5py

    with h5py.File(path, 'r') as handle:
        rungs = sorted(int(key) for key in handle['resolutions'])
        chroms = handle[f'resolutions/{rungs[-1]}/chroms']
        names = [name.decode() if isinstance(name, bytes) else str(name) for name in chroms['name'][:]]
        lengths = [int(length) for length in chroms['length'][:]]
    return {'chromosomes': list(zip(names, lengths)), 'resolutions': rungs}


def bigwig_names(location):
    """A bigWig's chromosome names, as its own index lists them."""
    head = _read(location, 0, 64)
    tree = struct.unpack_from('<IHHQ', head, 0)[3]
    data = _read(location, tree, 1 << 20)
    key_size = struct.unpack_from('<IIIIQQ', data, 0)[2]
    names = []

    def node(at):
        leaf, _, count = struct.unpack_from('<BBH', data, at)
        at += 4
        for _ in range(count):
            key = data[at:at + key_size].rstrip(b'\0').decode()
            at += key_size
            if leaf:
                names.append(key)
                at += 8
            else:
                node(struct.unpack_from('<Q', data, at)[0] - tree)
                at += 8

    node(32)
    return names


def bare(name):
    """A chromosome's name without a `chr`: how two files' names for one sequence are matched."""
    return name[3:] if name.lower().startswith('chr') else name


def named_in(name, names):
    """The name `names` gives the sequence `name` is, or `None`."""
    wanted = bare(name).lower()
    return next((one for one in names if bare(one).lower() == wanted), None)


def bins(start, end, resolution):
    return math.ceil((end - start) / resolution)


def higlass_sizes(mcool, track_names, path):
    """The map's chromosomes, in its order and lengths, as the track names them: HiGlass's coordinates for the track."""
    sizes = [[named_in(name, track_names) or name, length] for name, length in mcool['chromosomes']]
    Path(path).write_text(json.dumps(sizes))
    return str(path)


def runs_for(genome, views, files, tools, locations, sizes_dir):
    """Every run of one genome: each view in each viewer, from disk and from the bucket.

    `files` holds, for each of `mcool`, `hic` and `track`, the local path and the URL, and the two
    maps' metadata (`mcool_info`, `hic_header`) with the track's names (`bigwig_names`). Returns
    the runs to make and the cells that cannot be run, each with why.
    """
    mcool, hic = files['mcool']['info'], files['hic']['info']
    track_names = files['track']['names']
    sizes = higlass_sizes(mcool, track_names, Path(sizes_dir) / f'{genome}.json')
    offsets, total = {}, 0
    for name, length in mcool['chromosomes']:
        offsets[name] = total
        total += length
    lengths = dict(mcool['chromosomes'])
    runs, refused = [], []
    for view in views:
        resolution = view['resolution']
        whole = view['view'] == 'genome'
        start, end = (0, total) if whole else (view['start'], view['end'])
        if not whole and not 0 <= start < end <= lengths[view['chrom']]:
            # A window past a chromosome's end is drawn by some viewers and refused by others.
            raise ValueError(f"{genome}'s {view['view']} view, {view['chrom']}:{start}-{end}, is not within "
                             f"{view['chrom']}, which is {lengths[view['chrom']]:,} bp")
        count = bins(start, end, resolution)
        for tool, form in tools:
            info = mcool if form == 'mcool' else hic
            cell = {'genome': genome, 'view': view['view'], 'tool': tool, 'format': form,
                    'resolution': resolution, 'window': view['label'], 'bins': count}
            if resolution not in info['resolutions']:
                refused.append({**cell, 'status': 'not stored',
                                'note': f'the {form} holds {", ".join(str(r) for r in sorted(info["resolutions"]))} bp'})
                continue
            if tool == 'juicebox' and whole:
                refused.append({**cell, 'status': 'not available',
                                'note': "juicebox draws a whole genome only from the .hic's own whole-genome matrix"})
                continue
            for location in locations:
                map_ = files[form]['local' if location == 'local' else 'url']
                track = files['track']['local' if location == 'local' else 'url']
                run = {**cell, 'location': location, 'map': str(map_), 'track': str(track),
                       'picture': f'{genome}-{view["view"]}-{tool}-{form}-{location}'}
                if tool == 'chromosomix':
                    run['chromosomix'] = {'workspace': workspace(form, info, view, map_, track, location, resolution)}
                elif tool == 'juicebox':
                    names = [name for name, _ in hic['chromosomes']]
                    chrom = named_in(view['chrom'], names)
                    run['juicebox'] = {'chr': names.index(chrom), 'zoom': hic['resolutions'].index(resolution),
                                       'x': start // resolution}
                else:
                    rungs = sorted(mcool['resolutions'], reverse=True)
                    origin = 0 if whole else offsets[view['chrom']]
                    run['higlass'] = {'domain': [origin + start, origin + end], 'maxZoom': rungs.index(resolution),
                                      'chromsizes': sizes}
                runs.append(run)
    return runs, refused


def workspace(form, info, view, map_, track, location, resolution):
    """The workspace chromosomix is handed: the map at the rung, the view, and the track beside it."""
    name = Path(str(map_)).name if location == 'local' else str(map_)
    state = {'uri': f'{name}::/resolutions/{resolution}', 'balance': False, 'transform': 'log10'}
    if view['view'] == 'genome':
        state['view'] = 'whole'
    else:
        names = [one for one, _ in info['chromosomes']]
        state['view'] = 'region'
        state['region'] = f"{named_in(view['chrom'], names)}:{view['start']}-{view['end']}"
    tracks = []
    if location == 'cloud':
        tracks.append({
            'id': 'track', 'card': 'linear', 'kind': 'track', 'label': 'track',
            'source': {'kind': 'remote', 'name': Path(str(track)).name, 'url': str(track)},
            'visible': True, 'placement': {'bottom': True, 'right': False},
            'style': {'colour': '#d55e00', 'size': 72, 'mode': 'area', 'limits': {'auto': True, 'min': 0, 'max': 1},
                      'group': '', 'shape': 'element', 'radius': 7, 'opacity': 1, 'flip': False},
        })
    return {'kind': 'chromosomix.workspace', 'version': 1, 'active': 0,
            'tabs': [{'version': 1, 'state': state, 'tracks': tracks}]}


def ordered(runs, rounds):
    """The runs, `rounds` times round robin, the viewers taking turns to go first.

    A file read from disk in one run is in the page cache for the next unless the cache is
    dropped between them, and the bucket answers a second read of an object faster than the
    first; whichever viewer reads a picture's file first would pay for that every time. So each
    round runs every picture in turn, and the viewers' order within a picture is rotated round
    by round.
    """
    out = []
    pictures = {}
    for run in runs:
        pictures.setdefault((run['genome'], run['view'], run['location']), []).append(run)
    for round_ in range(1, rounds + 1):
        for group in pictures.values():
            shift = (round_ - 1) % len(group)
            for run in group[shift:] + group[:shift]:
                out.append({**run, 'run': round_, 'id': f"{run['picture']}"})
    return out
