#!/usr/bin/env python3
"""Write the demo barChart: one chart per yeast gene, over six conditions.

    python3 scripts/make_barchart_demo.py

Reads `demo/yeast/Yeast_annotations.gtf` for the genes and writes
`demo/yeast/Yeast_expression.barChart` beside it, so the lane lands on exactly
the genes the demo's own annotation lane draws and a reader can put the two
side by side.

The coordinates, names and strands are the real ones. **The numbers are not.**
They are drawn from a seeded generator, and the file says so in a comment on
its first line and in the track's own name, because a demo that looks like an
expression atlas and is not would be the one lie this repository's spec (§10)
refuses everywhere else. What they are built to have is the *shape* real data
has, which is what a renderer has to be tried against: a heavy tail, so most
genes are low and a few are very high; one condition usually dominating, so a
lane at chromosome zoom is a map of colour rather than a grey wash; and a
handful of genes flat across every condition, because those are the ones a bar
chart is worst at drawing and best to have in a test file.

Deterministic: the same seed and the same GTF give byte-identical output, so
the committed file can be regenerated and diffed.
"""

import random
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GTF = ROOT / 'demo' / 'yeast' / 'Yeast_annotations.gtf'
OUT = ROOT / 'demo' / 'yeast' / 'Yeast_expression.barChart'

# Space-separated in the `track` line, so a label cannot contain a space —
# which is also what keeps the parser's `top` detail key one word (§8.17).
CONDITIONS = ['YPD', 'heat_shock', 'osmotic_stress', 'diauxic', 'stationary', 'sporulation']

# UCSC's own barChart colours are per-category and named in the track line; a
# demo that ships them exercises the branch a file *with* colours takes, which
# is the one every hub uses.
COLOURS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b']

SEED = 20240917
GENE_ID = re.compile(r'gene_id "([^"]+)"')
GENE_NAME = re.compile(r'gene_name "([^"]+)"')


def genes():
    """One row per gene: the widest span the GTF gives each gene_id."""
    spans = {}
    order = []
    with GTF.open() as handle:
        for line in handle:
            if line.startswith('#'):
                continue
            columns = line.rstrip('\n').split('\t')
            if len(columns) < 9 or columns[2] != 'gene':
                continue
            found = GENE_ID.search(columns[8])
            if found is None:
                continue
            key = found.group(1)
            name = GENE_NAME.search(columns[8])
            start, end = int(columns[3]) - 1, int(columns[4])
            if key in spans:
                held = spans[key]
                held[1] = min(held[1], start)
                held[2] = max(held[2], end)
                continue
            spans[key] = [columns[0], start, end, columns[6], name.group(1) if name else '']
            order.append(key)
    return [(key, *spans[key]) for key in order]


def profile(rng):
    """Six numbers with the shape an expression profile has.

    A log-normal base so the tail is heavy, one condition multiplied up so the
    gene has somewhere it belongs, and one gene in eight left flat — the case a
    bar chart draws worst and therefore the one a demo must contain.
    """
    base = rng.lognormvariate(1.4, 1.1)
    values = [base * rng.lognormvariate(0, 0.45) for _ in CONDITIONS]
    if rng.random() > 0.125:
        values[rng.randrange(len(CONDITIONS))] *= rng.uniform(2.5, 9.0)
    # A few genes are off everywhere, which is what an unexpressed gene is and
    # what makes the lane's empty glyphs real rather than an artefact.
    if rng.random() < 0.08:
        values = [value * 0.02 for value in values]
    return [round(value, 2) for value in values]


def main():
    rng = random.Random(SEED)
    rows = []
    for key, contig, start, end, strand, name in genes():
        values = profile(rng)
        total = sum(values)
        # BED's column 5, in its own 0–1000 range, from the total — which is
        # what UCSC's barChart says that column is derived from.
        score = min(1000, int(total * 4))
        rows.append(
            '\t'.join(
                [
                    contig,
                    str(start),
                    str(end),
                    key,
                    str(score),
                    strand if strand in '+-' else '.',
                    name or key,
                    str(len(CONDITIONS)),
                    ','.join(f'{value:g}' for value in values),
                ]
            )
        )

    # `maxLimit` is a *display* ceiling, not the largest number in the file, and
    # that is what makes it worth setting here: expression is heavy-tailed, so a
    # ceiling at the maximum draws every gene but the top few as a flat line.
    # The 99th percentile keeps the shape of the bulk of the file readable and
    # clips the tail, which the viewer clamps rather than overflows. A reader
    # who wants the tail back has the per-feature scale in the lane's card.
    every = sorted(
        float(part) for row in rows for part in row.split('\t')[8].split(',')
    )
    ceiling = round(every[int(len(every) * 0.99)], 1)
    header = [
        '# Synthetic expression values over real S. cerevisiae gene coordinates.',
        '# Coordinates, names and strands are from Ensembl R64-1-1; the numbers are',
        '# generated by scripts/make_barchart_demo.py and mean nothing biologically.',
        'track type=barChart name="Expression (synthetic)" '
        f'barChartBars="{" ".join(CONDITIONS)}" '
        f'barChartColors="{" ".join(COLOURS)}" '
        'barChartLabel=Conditions barChartMetric=Median barChartUnit=TPM '
        f'maxLimit={ceiling:g}',
    ]
    OUT.write_text('\n'.join(header + rows) + '\n')
    print(f'{OUT.relative_to(ROOT)}: {len(rows)} genes × {len(CONDITIONS)} conditions')


if __name__ == '__main__':
    main()
