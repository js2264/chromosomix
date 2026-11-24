#!/usr/bin/env python
"""The truth of the demo's mock community: which organism each contig is.

The mock community MM133 (``demo/metagenomics/mock-community/MM133.metacool``) was sequenced
from strains whose reference genomes are known. Its assembly's contigs are
aligned to them here, and each contig is given the organism and the replicon it
is — the truth the curation stage's method is held to (SPECS §33.11,
``docs/genome-curation.md`` §7). Validation only: nothing of it is in the app.

Run with minimap2's Python binding::

    pip install mappy
    python scripts/make_mock_truth.py ASSEMBLY.fa REFERENCE.fa

The two FASTA files are the lab's (``s3://rsglab-data/meta/mock_ass_tot.fa`` and
``mock_ref.fa``, 174 Mb each). Writes ``test/golden/demo/MM133.truth.tsv.gz``: beside the
demo's other oracles, and not beside the demo, since the app never reads it.

**The rule.** Each contig is aligned with minimap2's ``asm10`` preset; its
aligned bases are the union of its hits' query intervals, per reference
sequence. A contig *is* an organism when at least half of it aligns and nine
tenths of what aligns is that organism's; otherwise its organism is empty —
**unknown**, neither right nor wrong. About 13 Mb of the community's genomes match
nothing in the reference at all: those contigs are unknown.

**Replicons.** A reference sequence named ``<organism>_chr<n>`` is a chromosome
of the organism; ``_plasm…``, ``_Plasm…`` and ``_pOANT…`` a plasmid; the five
phage sequences are their own organisms, hosted by the organism this script
names — *B. subtilis* for SPP1, *P. aeruginosa* for phiKZ, and *V. cholerae*, the
mock's only *Vibrio*, for the two *Vibrio* phages and the 115E34 hitchhiker.

Columns: ``contig``, ``organism`` (the contig's, empty for unknown), ``replicon``
(the reference sequence), ``kind`` (``chromosome``, ``plasmid`` or ``phage``),
``host`` (for a plasmid or a phage, the organism it belongs to), ``aligned`` (the
fraction aligned), ``share`` (the fraction of that which is the organism's).
"""

from __future__ import annotations

import argparse
import gzip
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path("test/golden/demo/MM133.truth.tsv.gz")

#: The phage sequences of the reference: (organism, host).
PHAGES = {
    "Bacteriophage_SPP1": ("phage_SPP1", "B_subtilis"),
    "P_aeruginosa_phiKZ": ("phage_phiKZ", "P_aeruginosa"),
    "Vibrio_phage_115E34": ("phage_115E34", "V_cholerae"),
    "Vibrio_phage_191E37": ("phage_191E37", "V_cholerae"),
    "Vibrio_phage_115E34_hitchhiker": ("satellite_115E34_hitchhiker", "V_cholerae"),
}


def replicon(name: str) -> tuple[str, str, str]:
    """A reference sequence's organism, kind and host (empty for a chromosome)."""
    if name in PHAGES:
        organism, host = PHAGES[name]
        return organism, "phage", host
    chromosome = re.match(r"^(.*?)_(chr\d+)$", name)
    if chromosome:
        return chromosome.group(1), "chromosome", ""
    plasmid = re.match(r"^(.*?)_(plasm\w*|Plasm\w*|pOANT\w*)$", name)
    if plasmid:
        return plasmid.group(1), "plasmid", plasmid.group(1)
    return name, "chromosome", ""


def union(intervals: list[tuple[int, int]]) -> int:
    total, start, end = 0, None, None
    for lo, hi in sorted(intervals):
        if start is None or lo > end:
            if start is not None:
                total += end - start
            start, end = lo, hi
        else:
            end = max(end, hi)
    return total + (end - start if start is not None else 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("assembly")
    parser.add_argument("reference")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    import mappy

    aligner = mappy.Aligner(args.reference, preset="asm10", n_threads=args.threads)
    if not aligner:
        print(f"could not index {args.reference}", file=sys.stderr)
        return 1

    def one(record: tuple[str, str]) -> str:
        name, seq = record
        hits: dict[str, list[tuple[int, int]]] = {}
        for hit in aligner.map(seq, buf=mappy.ThreadBuffer()):
            if hit.mapq < 5 and not hit.is_primary:
                continue
            hits.setdefault(hit.ctg, []).append((hit.q_st, hit.q_en))
        if not hits:
            return f"{name}\t\t\t\t\t0\t0"
        by_ref = {ref: union(iv) for ref, iv in hits.items()}
        by_org: dict[str, int] = {}
        for ref, n in by_ref.items():
            org = replicon(ref)[0]
            by_org[org] = by_org.get(org, 0) + n
        best = max(by_ref, key=by_ref.__getitem__)
        organism, kind, host = replicon(best)
        aligned = union([iv for intervals in hits.values() for iv in intervals]) / len(seq)
        share = by_org[organism] / sum(by_org.values())
        known = aligned >= 0.5 and share >= 0.9
        return "\t".join([name, organism if known else "", best if known else "", kind if known else "", host if known else "", f"{aligned:.3f}", f"{share:.3f}"])

    records = [(name, seq) for name, seq, _ in mappy.fastx_read(args.assembly)]
    with ThreadPoolExecutor(args.threads) as pool:
        rows = list(pool.map(one, records, chunksize=64))
    out = Path(args.out)
    text = "contig\torganism\treplicon\tkind\thost\taligned\tshare\n" + "\n".join(rows) + "\n"
    # No name and no modification time in the gzip header: the same truth is the same bytes.
    with open(out, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as handle:
        handle.write(text.encode("ascii"))
    known = sum(1 for row in rows if row.split("\t")[1])
    print(f"wrote {out}: {len(rows)} contigs, {known} of a known organism")
    return 0


if __name__ == "__main__":
    sys.exit(main())
