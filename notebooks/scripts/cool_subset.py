"""Some sequences of one rung of a remote .mcool, as a local .cool: read by range, cis contacts only.

The GM12878 map of validation.qmd § 24 and of the paper's store (scripts/make_rsg_store.py derive) is
4DN's 4DNFIXP4QG5B, 27 GB at thirteen resolutions; what either reads of it is one rung of a few
sequences, or of every sequence near the diagonal. This reads exactly that, by HTTP range requests
through h5py, and writes it with cooler: the rung's own bins and its own balancing weights, which
are the whole map's (they are copied, not recomputed), and every contact between two bins of one
sequence — within --band of the diagonal, if one is given — each row in order and a pixel the file
stores twice written once, as its sum, which is what cooler and the app both read it as. Every
analysis either side runs on it reads contacts within a sequence, so it reads the same numbers here
as in the whole file.

usage: python cool_subset.py URL RESOLUTION OUT.cool [--sequences chr19,chr20] [--band BP]
"""
import argparse
import io
import sys
import time
from collections import OrderedDict

import cooler
import h5py
import numpy as np
import pandas as pd
import requests


class Ranged(io.RawIOBase):
    """A remote file read by range, in blocks, the latest `keep` of them held."""

    def __init__(self, url, block=16 << 20, keep=32):
        self.url, self.block, self.keep = url, block, keep
        self.session = requests.Session()
        head = self.session.head(url, allow_redirects=True, timeout=60)
        head.raise_for_status()
        self.size = int(head.headers['Content-Length'])
        self.at = 0
        self.blocks = OrderedDict()
        self.fetched = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.at

    def seek(self, offset, whence=io.SEEK_SET):
        self.at = {io.SEEK_SET: offset, io.SEEK_CUR: self.at + offset, io.SEEK_END: self.size + offset}[whence]
        return self.at

    def _get(self, index):
        if index in self.blocks:
            self.blocks.move_to_end(index)
            return self.blocks[index]
        lo = index * self.block
        hi = min(self.size, lo + self.block) - 1
        for attempt in range(5):
            try:
                answer = self.session.get(self.url, headers={'Range': f'bytes={lo}-{hi}'}, timeout=120)
                answer.raise_for_status()
                data = answer.content
                if len(data) == hi - lo + 1:
                    break
            except requests.RequestException:
                pass
            time.sleep(2 ** attempt)
        else:
            raise OSError(f'{self.url}: bytes {lo}-{hi} could not be read')
        self.fetched += len(data)
        self.blocks[index] = data
        if len(self.blocks) > self.keep:
            self.blocks.popitem(last=False)
        return data

    def readinto(self, buffer):
        view = memoryview(buffer).cast('B')
        wanted = min(len(view), max(0, self.size - self.at))
        done = 0
        while done < wanted:
            index, offset = divmod(self.at + done, self.block)
            data = self._get(index)
            n = min(wanted - done, len(data) - offset)
            view[done:done + n] = data[offset:offset + n]
            done += n
        self.at += done
        return done


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('url')
    parser.add_argument('resolution', type=int)
    parser.add_argument('out')
    parser.add_argument('--sequences', help='comma-separated; every sequence of the rung by default')
    parser.add_argument('--band', type=int, help='the furthest from the diagonal a contact is kept, in bp')
    args = parser.parse_args(argv)

    remote = Ranged(args.url)
    started = time.time()
    with h5py.File(remote, 'r') as handle:
        rung = handle['resolutions'][str(args.resolution)]
        names = [n.decode() for n in rung['chroms']['name'][:]]
        lengths = rung['chroms']['length'][:]
        wanted = names if args.sequences is None else args.sequences.split(',')
        unknown = [name for name in wanted if name not in names]
        if unknown:
            raise SystemExit(f'not in the file: {", ".join(unknown)}')
        wanted = [name for name in names if name in wanted]  # the file's order
        chrom_offset = rung['indexes']['chrom_offset'][:]
        bin1_offset = rung['indexes']['bin1_offset'][:]
        weights = rung['bins']['weight']
        band = None if args.band is None else args.band // args.resolution

        bins, spans, first = [], [], 0
        for name in wanted:
            k = names.index(name)
            lo, hi = int(chrom_offset[k]), int(chrom_offset[k + 1])
            starts = np.arange(hi - lo, dtype=np.int64) * args.resolution
            bins.append(pd.DataFrame({'chrom': name, 'start': starts,
                                      'end': np.minimum(starts + args.resolution, int(lengths[k])),
                                      'weight': weights[lo:hi]}))
            spans.append((name, lo, hi, first))
            first += hi - lo
        bins = pd.concat(bins, ignore_index=True)
        bins['chrom'] = pd.Categorical(bins['chrom'], categories=wanted, ordered=True)

        pixels = rung['pixels']
        kept = [0]

        def chunks(step=20_000_000):
            # Whole rows at a time, so that a row is sorted and summed in one piece: 4DN's coarser rungs
            # store a row as one sorted run per finer row aggregated into it (ten at 10 kb), and here and
            # there a pixel twice. cooler and the app add a pixel stored twice into one cell
            # (`scatterDense`), so the sum is what both read; written once, in order, it is a .cool that
            # cooler.create_cooler accepts and every reader reads the same.
            for name, lo, hi, offset in spans:
                rows = bin1_offset[lo:hi + 1].astype(np.int64)
                a = 0
                while a < hi - lo:
                    b = max(a + 1, int(np.searchsorted(rows, rows[a] + step, side='right')) - 1)
                    b = min(b, hi - lo)
                    p0, p1 = int(rows[a]), int(rows[b])
                    a_row, a = a, b
                    if p1 == p0:
                        continue
                    # A pixel's row is the index's to say — rows[a_row:a + 1] delimits rows lo + a_row … lo + a − 1
                    # — so the bin1_id column, a third of what a rung's pixels weigh, is never read.
                    bin1 = np.repeat(np.arange(lo + a_row, lo + a, dtype=np.int64), np.diff(rows[a_row:a + 1]))
                    bin2 = pixels['bin2_id'][p0:p1]
                    count = pixels['count'][p0:p1]
                    keep = bin2 < hi
                    if band is not None:
                        keep &= bin2 - bin1 <= band
                    key = (bin1[keep] - lo).astype(np.int64) * (hi - lo) + (bin2[keep] - lo)
                    cells, where = np.unique(key, return_inverse=True)
                    summed = np.bincount(where, weights=count[keep], minlength=len(cells)).astype(count.dtype)
                    kept[0] += len(cells)
                    yield pd.DataFrame({'bin1_id': cells // (hi - lo) + offset, 'bin2_id': cells % (hi - lo) + offset,
                                        'count': summed})
                print(f'{name}: {kept[0]:,} contacts kept so far, {remote.fetched / 1e9:.2f} GB read, '
                      f'{time.time() - started:.0f} s', file=sys.stderr)

        metadata = {'source': args.url, 'resolution': args.resolution, 'sequences': wanted, 'cis only': True,
                    'band': args.band, 'weights': 'copied from the source rung'}
        cooler.create_cooler(args.out, bins, chunks(), ordered=True, symmetric_upper=True,
                             dtypes={'count': pixels['count'].dtype}, metadata=metadata,
                             assembly=rung.attrs.get('genome-assembly'))
    print(f'{args.out}: {len(bins):,} bins, {kept[0]:,} contacts, {remote.fetched / 1e9:.2f} GB read in '
          f'{time.time() - started:.0f} s', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
