"""The HiGlass that timing.qmd times: higlass-python's own tile server, serving one map and one track.

Run in the HiGlass environment (`notebooks/requirements-higlass.txt`), one process a timed run, so
that every run meets a server that has read nothing yet:

    python higlass_server.py MAP TRACK CHROMSIZES [--fuse DIR]

MAP is an `.mcool` rung (`file.mcool::/resolutions/25000` is not needed: higlass-python serves the
whole ladder and the viewer picks a rung) and TRACK a bigWig, each a path or an `https://` URL.
A URL is read through higlass-python's own FUSE mount (`hg.fuse`, simple-httpfs), which is how it
serves a file it does not have on disk; DIR holds the mount and its block cache, and is emptied by
the caller between runs.

CHROMSIZES is a JSON list of `[name, length]`: the map's chromosomes, in the map's order, named as
the *track* names them. A HiGlass track is placed on the map by absolute position, and clodius
lays a bigWig out by its own chromosomes sorted by name unless it is given a list — so a yeast
track (`I, II, … IX, V`) would be drawn in another order than its map (`chrI, chrII, …`), and a
track named otherwise than its map would fetch nothing. The list is clodius' own documented
parameter for this (`clodius.tiles.bigwig.tiles(..., chromsizes=)`), the one higlass-server's
`--coordSystem` fills.

Prints one line of JSON — the server's address and the two tilesets' ids — and serves until it
is killed.
"""
import argparse
import functools
import json
import threading

import higlass as hg
from clodius.tiles import bigwig
from higlass.tilesets import LocalTileset


def readable(location, fuse):
    """A path the tile functions can open: the file itself, or its place in the FUSE mount."""
    if location.startswith(('http://', 'https://')):
        if fuse is None:
            raise SystemExit(f'{location} is a URL: give --fuse a directory to mount it under.')
        return hg.fuse.path(location)
    return location


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('map')
    parser.add_argument('track')
    parser.add_argument('chromsizes')
    parser.add_argument('--fuse', default=None)
    args = parser.parse_args()
    if args.fuse is not None:
        hg.fuse.start(args.fuse)
    with open(args.chromsizes) as handle:
        chromsizes = [[str(name), int(length)] for name, length in json.load(handle)]

    heatmap = hg.cooler(readable(args.map, args.fuse))
    track = readable(args.track, args.fuse)
    signal = hg.server.add(LocalTileset(
        datatype='vector',
        tiles=functools.partial(bigwig.tiles, track, chromsizes=chromsizes),
        info=functools.partial(bigwig.tileset_info, track, chromsizes=chromsizes),
        uid='track',
    ))
    print(json.dumps({'server': heatmap.server, 'map': heatmap.tileset.uid, 'track': signal.tileset.uid}),
          flush=True)
    threading.Event().wait()


if __name__ == '__main__':
    main()
