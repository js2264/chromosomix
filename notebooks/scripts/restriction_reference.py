"""Restriction-fragment statistics of a contact list, from `pairtools restrict`'s columns (validation.qmd § 25).

The fragments are `bioframe.digest`'s, as bioframe_digest.py writes them: between the top strand's
cuts, c, its boundaries moved by SHIFT (-2 by default), and between the bottom strand's, c', L - 2k
past them. `pairtools restrict` was run once on each, over the same contact list, and has put each
end of each pair in a fragment (`rfrag1`, `rfrag2`, 0-based along its sequence) and written that
fragment's ends, 1-based (`rfrag_start`, `rfrag_end`: the fragment's first base, 0 for a sequence's
first fragment, and the first base of the next). A + end is read from the run on the top strand's
fragments and a - end from the run on the bottom strand's: a - read's 5' end is the bottom strand's,
which once the enzyme's overhang is filled in ends at c' - 1. From those columns alone, read in
chunks, this counts what chromosomix's Pairs QC counts, by the definitions it states:

- a pair counts when both ends are mapped (the chromosome not `!`, the strand `+` or `-`), both
  sequences are the reference's and it is not a duplicate (`pair_type` DD); a mapped pair that is
  no duplicate, with an end on a sequence the reference lacks, is `unassigned`;
- `trans` across sequences; within one, the two ends ordered by x = pos - 1 (the file's order on a
  tie), a then b, in fragments fa and fb: `dangling` in one fragment as (+, -), `self-circle` as
  (-, +), `same-strand` as (+, +) or (-, -); `re-ligation` in neighbouring fragments as (+, -);
  `valid` otherwise; each class by the strands of (a, b) too, a trans pair's in the file's order;
- the distance from each end of a counted pair to the cut it reads towards, on its own strand's
  boundaries, B for + and B' for -: B[i+1] - x on +, x - B'[i] + 1 on -, counted on pairtools
  stats' separation bins (eight a decade), a value d in the bin searchsorted(edges, d, 'right') - 1,
  each strand apart;
- the ends of counted pairs in each fragment, the fragments seen (with one end or more) of all the
  reference's, and how many fragments have 0, 1, 2, 3-4, 5-8, 9-16, ... ends.

Writes, beside OUT_PREFIX:
  .summary.tsv      measure, value: records read, counted, unassigned, not counted, cis, trans,
                    fragments, fragments seen, cuts, and the ends whose fragment pairtools placed off
                    the digest's boundaries for their strand (0 when the two were given the same);
                    and, what a read starting where the enzyme cut looks like, the + ends on a cut
                    (x = c) and a base past one (c + 1), and the - ends on a cut (x = c' - 1, the
                    bottom strand's first base) and a base before one (c' - 2);
  .classes.tsv      class, pairs, fraction of the counted, and the pairs it would have had with every
                    end placed by the top strand's cuts (`top_strand_only`), as one run of
                    `pairtools restrict` places them;
  .orientation.tsv  class, orientation, pairs: every class by each of ++ +- -+ --;
  .distance.tsv     strand, start, end, ends: each separation bin [start, end), the last open;
  .fragments.tsv    start, end, label, fragments: fragments with start to end ends, inclusive;
  .ends.tsv         chrom, start, end, ends: every fragment, 0-based and half-open between the top
                    strand's cuts, and its ends.

usage: python restriction_reference.py FASTA ENZYME TOP_PAIRS BOTTOM_PAIRS OUT_PREFIX [SHIFT]
       (TOP_PAIRS and BOTTOM_PAIRS: `pairtools restrict`'s output on each strand's fragments)
"""
import csv
import gzip
import sys

import bioframe
import numpy as np
import pandas as pd
from Bio import Restriction

fasta, enzyme, top_pairs, bottom_pairs, prefix = sys.argv[1:6]
shift = int(sys.argv[6]) if len(sys.argv) > 6 else -2

# The fragments on both strands, as bioframe_digest.py writes them for pairtools restrict.
site = getattr(Restriction, enzyme)
apart = site.size - 2 * site.fst5
genome = bioframe.load_fasta(fasta, engine='pyfaidx')
digest = bioframe.digest(genome, enzyme)
TOP, BOTTOM = {}, {}
for chrom in genome:
    length = len(genome[chrom])
    ends = digest.loc[digest['chrom'] == chrom, 'end'].to_numpy(np.int64)[:-1] + shift
    at = np.unique(ends[(ends > 0) & (ends < length)])
    TOP[chrom], BOTTOM[chrom] = np.r_[0, at, length], np.r_[0, at + apart, length]
CHROMS = list(TOP)
#: Each sequence's first fragment in one numbering of every fragment, sequence after sequence.
OFFSET = np.cumsum([0] + [len(b) - 1 for b in TOP.values()])
TOTAL = int(OFFSET[-1])
#: Each fragment's two ends, by that numbering, on each strand.
STARTS = {'+': np.concatenate([b[:-1] for b in TOP.values()]), '-': np.concatenate([b[:-1] for b in BOTTOM.values()])}
ENDS = {'+': np.concatenate([b[1:] for b in TOP.values()]), '-': np.concatenate([b[1:] for b in BOTTOM.values()])}
#: Whether a fragment starts at a cut, and ends at one, rather than at its sequence's ends.
CUT_BEFORE, CUT_AFTER = np.ones(TOTAL, bool), np.ones(TOTAL, bool)
CUT_BEFORE[OFFSET[:-1]], CUT_AFTER[OFFSET[1:] - 1] = False, False

# pairtools stats' separation bins: 0, then 10 ** (k / 8) rounded, to 10⁹.
EDGES = np.unique(np.r_[0, np.round(10 ** np.arange(0, 9.001, 0.125)).astype(np.int64)])
CLASSES = ['trans', 'dangling', 'self-circle', 'same-strand', 're-ligation', 'valid']
ORIENTATIONS = ['++', '+-', '-+', '--']
FRAGMENT = ['rfrag', 'rfrag_start', 'rfrag_end']


def chunks(path, wanted):
    """`pairtools restrict`'s output, the columns `wanted`, a million records at a time. Nothing in a .pairs
    is quoted, and a quality string may hold a quote."""
    with (gzip.open if path.endswith('.gz') else open)(path, 'rt') as handle:
        header = 0
        for line in handle:
            if not line.startswith('#'):
                break
            header += 1
            if line.startswith('#columns:'):
                columns = line.split()[1:]
    wanted = [c for c in wanted if c in columns]
    types = {c: (np.int64 if c.startswith(('pos', 'rfrag')) else str) for c in wanted}
    return columns, pd.read_csv(path, sep='\t', header=None, names=columns, skiprows=header, quoting=csv.QUOTE_NONE,
                                usecols=wanted, dtype=types, chunksize=1_000_000)


PLACED = [f'{c}{k}' for k in '12' for c in FRAGMENT]
columns, tops = chunks(top_pairs, ['chrom1', 'pos1', 'chrom2', 'pos2', 'strand1', 'strand2', 'pair_type', *PLACED])
TYPED = 'pair_type' in columns
_, bottoms = chunks(bottom_pairs, ['pos1', 'pos2', *PLACED])

read = counted = unassigned = cis = off = 0
#: The ends on a cut, and a base from one, by strand: see the docstring.
at_cut = {'+ ends on a cut': 0, '+ ends a base past a cut': 0, '- ends on a cut': 0, '- ends a base before a cut': 0}
by_class = np.zeros(len(CLASSES) * 4, np.int64)
top_only = np.zeros(len(CLASSES), np.int64)
distance = {'+': np.zeros(len(EDGES), np.int64), '-': np.zeros(len(EDGES), np.int64)}
ends = np.zeros(TOTAL, np.int64)
for chunk, below in zip(tops, bottoms):
    if not (chunk['pos1'].equals(below['pos1']) and chunk['pos2'].equals(below['pos2'])):
        raise ValueError(f'{top_pairs} and {bottom_pairs} do not hold the same records in the same order')
    read += len(chunk)
    c1, c2 = chunk['chrom1'].to_numpy(str), chunk['chrom2'].to_numpy(str)
    s1, s2 = chunk['strand1'].to_numpy(str), chunk['strand2'].to_numpy(str)
    mapped = (c1 != '!') & (c2 != '!') & np.isin(s1, ['+', '-']) & np.isin(s2, ['+', '-'])
    unique = chunk['pair_type'].to_numpy(str) != 'DD' if TYPED else np.ones(len(chunk), bool)
    known = np.isin(c1, CHROMS) & np.isin(c2, CHROMS)
    unassigned += int((mapped & unique & ~known).sum())
    keep = mapped & unique & known
    counted += int(keep.sum())
    c1, c2, s1, s2 = c1[keep], c2[keep], s1[keep], s2[keep]

    def placed(k, chrom, strand):
        """End k's fragment, numbered across sequences, read from the run on its strand's fragments, and
        whether pairtools' ends of it are not the digest's."""
        f = np.where(strand == '+', chunk[f'rfrag{k}'].to_numpy()[keep], below[f'rfrag{k}'].to_numpy()[keep])
        g = OFFSET[pd.Categorical(chrom, categories=CHROMS).codes] + f
        lo = np.maximum(np.where(strand == '+', chunk[f'rfrag_start{k}'].to_numpy()[keep],
                                 below[f'rfrag_start{k}'].to_numpy()[keep]) - 1, 0)
        hi = np.where(strand == '+', chunk[f'rfrag_end{k}'].to_numpy()[keep],
                      below[f'rfrag_end{k}'].to_numpy()[keep]) - 1
        wrong = (lo != np.where(strand == '+', STARTS['+'][g], STARTS['-'][g])) | \
                (hi != np.where(strand == '+', ENDS['+'][g], ENDS['-'][g]))
        return f, g, int(wrong.sum())

    (f1, g1, off1), (f2, g2, off2) = placed(1, c1, s1), placed(2, c2, s2)
    off += off1 + off2
    x1, x2 = chunk['pos1'].to_numpy()[keep] - 1, chunk['pos2'].to_numpy()[keep] - 1

    trans = c1 != c2
    cis += int((~trans).sum())
    swap = x2 < x1
    sa, sb = np.where(swap, s2, s1), np.where(swap, s1, s2)
    # A trans pair's orientation is its ends' strands in the file's order.
    sa, sb = np.where(trans, s1, sa), np.where(trans, s2, sb)
    plus_minus, minus_plus = (sa == '+') & (sb == '-'), (sa == '-') & (sb == '+')

    def classes(f1, f2):
        """Each pair's class, its ends in fragments f1 and f2."""
        fa, fb = np.where(swap, f2, f1), np.where(swap, f1, f2)
        same = fa == fb
        kind = np.full(len(c1), CLASSES.index('valid'))
        kind[~trans & (np.abs(fb - fa) == 1) & plus_minus] = CLASSES.index('re-ligation')
        kind[~trans & same & (sa == sb)] = CLASSES.index('same-strand')
        kind[~trans & same & minus_plus] = CLASSES.index('self-circle')
        kind[~trans & same & plus_minus] = CLASSES.index('dangling')
        kind[trans] = CLASSES.index('trans')
        return kind

    orientation = (sa == '-') * 2 + (sb == '-')
    by_class += np.bincount(classes(f1, f2) * 4 + orientation, minlength=len(by_class))
    # And had every end been placed by the top strand's cuts, as pairtools restrict places any end.
    top_only += np.bincount(classes(chunk['rfrag1'].to_numpy()[keep], chunk['rfrag2'].to_numpy()[keep]),
                            minlength=len(CLASSES))

    for x, g, s in ((x1, g1, s1), (x2, g2, s2)):
        d = np.where(s == '+', ENDS['+'][g] - x, x - STARTS['-'][g] + 1)
        for strand in '+-':
            distance[strand] += np.bincount(np.searchsorted(EDGES, d[s == strand], 'right') - 1,
                                            minlength=len(EDGES))
        ends += np.bincount(g, minlength=TOTAL)
        plus, minus = (s == '+') & CUT_BEFORE[g], (s == '-') & CUT_AFTER[g]
        at_cut['+ ends on a cut'] += int((plus & (x == STARTS['+'][g])).sum())
        at_cut['+ ends a base past a cut'] += int((plus & (x == STARTS['+'][g] + 1)).sum())
        at_cut['- ends on a cut'] += int((minus & (x == ENDS['-'][g] - 1)).sum())
        at_cut['- ends a base before a cut'] += int((minus & (x == ENDS['-'][g] - 2)).sum())

counts = by_class.reshape(len(CLASSES), 4)
seen = int((ends > 0).sum())
pd.DataFrame([('records', read), ('counted', counted), ('unassigned', unassigned),
              ('not counted', read - counted - unassigned), ('cis', cis), ('trans', counted - cis),
              ('fragments', TOTAL), ('fragments seen', seen), ('cuts', TOTAL - len(TOP)),
              ('ends off the digest', off), *at_cut.items()], columns=['measure', 'value']).to_csv(
    f'{prefix}.summary.tsv', sep='\t', index=False)
pd.DataFrame({'class': CLASSES, 'pairs': counts.sum(1), 'fraction': counts.sum(1) / max(counted, 1),
              'top_strand_only': top_only}).to_csv(f'{prefix}.classes.tsv', sep='\t', index=False)
pd.DataFrame([(name, o, counts[k, j]) for k, name in enumerate(CLASSES) for j, o in enumerate(ORIENTATIONS)],
             columns=['class', 'orientation', 'pairs']).to_csv(f'{prefix}.orientation.tsv', sep='\t', index=False)
pd.DataFrame([(strand, EDGES[k], EDGES[k + 1] if k + 1 < len(EDGES) else pd.NA, distance[strand][k])
              for strand in '+-' for k in range(len(EDGES))],
             columns=['strand', 'start', 'end', 'ends']).to_csv(f'{prefix}.distance.tsv', sep='\t', index=False)

# 0, 1, 2, 3-4, 5-8, 9-16, ...: a bin of its own for 0 and for 1, then up to each power of two.
most = int(ends.max()) if TOTAL else 0
powers = max(1, int(np.ceil(np.log2(max(most, 2)))))
spans = [(0, 0), (1, 1)] + [(2 ** (k - 1) + 1, 2 ** k) for k in range(1, powers + 1)]
pd.DataFrame([(lo, hi, f'{lo}' if lo == hi else f'{lo}–{hi}', int(((ends >= lo) & (ends <= hi)).sum()))
              for lo, hi in spans], columns=['start', 'end', 'label', 'fragments']).to_csv(
    f'{prefix}.fragments.tsv', sep='\t', index=False)
pd.DataFrame({'chrom': np.repeat(CHROMS, np.diff(OFFSET)), 'start': STARTS['+'], 'end': ENDS['+'],
              'ends': ends}).to_csv(f'{prefix}.ends.tsv', sep='\t', index=False)
