#!/usr/bin/env python3
"""Write the demo ideograms and splice junctions (SPECS §8.22, §8.23).

    python3 scripts/make_ideogram_junction_demo.py yeast
    python3 scripts/make_ideogram_junction_demo.py hg19 <circos>/data/karyotype/karyotype.human.hg19.txt
    python3 scripts/make_ideogram_junction_demo.py junctions <star-dir> <regtools-dir> <rnasplice-checkout>
    python3 scripts/make_ideogram_junction_demo.py yeast-junctions <SJ.out.tab>

Four parts, because they come from four places and only the first can be
rebuilt from this repository alone.

**yeast** writes `demo/yeast/Yeast_cytobands.txt`: the demo assembly as UCSC's
five columns. Yeast chromosomes are not G-banded, so there are no bands to
invent and none are: each arm is one unstained band (`gneg`), the centromere is
the ~118 bp CEN element found in the demo FASTA by its own architecture — CDEI
(`RTCACRTG`), an AT-rich CDEII, CDEIII's `TCCGAA` — split at its midpoint into
the two `acen` bands every cytoBand file writes, and chromosome XII's rDNA is a
`stalk`, which is what the stalk of a human acrocentric chromosome *is*: its
nucleolar organiser. The rDNA span is the two 35S repeats and the 5S gene after
them in the demo GTF (XII:451,575–468,931). The scan is checked against the
coordinates SGD publishes for R64, and differs from them once, on purpose: this
strain's III is 1,095 bp shorter than R64's, upstream of CEN3, and CEN3 sits
1,095 bp earlier. Deterministic.

**hg19** writes `demo/human/hg19_cytoBand.txt`: UCSC's hg19 cytoBand, the 862
bands of chr1–22, X and Y. UCSC's download server is not reachable from where
this was built, so the bands come from Circos 0.69-9 (bioconda
`circos-0.69.9-hdfd78af_0`), whose karyotype files are UCSC's tables — its hg38
file is identical, band for band, to UCSC's hg38 cytoBandIdeo as IGV serves it
(s3://igv.org.genomes/hg38/annotations/cytoBandIdeo.txt.gz), which is what this
part checks before trusting its hg19 file. Written back in UCSC's five columns,
chromosomes in karyotype order.

**junctions** copies real RNA-seq splice junctions into `demo/human/`:
four Geuvadis lymphoblastoid samples (ERR188383 and ERR188428, GBR; ERR188454
and ERR204916, YRI), as nf-core/test-datasets subsamples them to chromosome X
on its `rnasplice` branch (commit b5db2bc3), aligned here with STAR 2.7.9a
(bioconda `star-2.7.9a-h9ee0642_0`) to that branch's GRCh37 chrX with its
Ensembl GTF, with nf-core/rnasplice's own options but in **one pass**:

    STAR --runMode genomeGenerate --genomeFastaFiles X.fa \\
         --sjdbGTFfile genes_chrX.gtf --sjdbOverhang 74 --genomeSAindexNbases 12
    STAR --runRNGseed 0 --readFilesIn <s>_chrX_1.fastq.gz <s>_chrX_2.fastq.gz \\
         --outSAMtype BAM SortedByCoordinate --outSAMattributes NH HI AS NM MD \\
         --outFilterMultimapNmax 20 --alignSJDBoverhangMin 1 \\
         --outSAMstrandField intronMotif

One pass because `--twopassMode Basic` inserts every junction the first pass
found into the genome the second pass aligns to, and then reports all of them
as annotated: column 6 of a two-pass table is 1 on every row, and the one
column that tells a novel junction from a known one says nothing.

Each sample's `SJ.out.tab` is copied as STAR wrote it, byte for byte: a demo
of a format is worth most as the format's own output. One sample's junctions are
also written as the BED12 `regtools junctions extract -s XS` writes (regtools
1.0.0, bioconda `regtools-1.0.0-hdcf5f25_2`), which is the file leafcutter reads
and the shape TopHat's `junctions.bed` has. The same sample's alignments are
kept, with their index, for the coverage lane under the arcs, and so is the
gene model they were aligned against (the branch's chrX GTF, gzipped).

**yeast-junctions** copies `demo/yeast/Yeast_RNA_junctions.SJ.out.tab`: the
junctions of the yeast reads nf-core/test-datasets keeps on its `rnaseq` branch
(commit cad884e7) for GSE110004's WT_REP1 and WT_REP2 (SRR6357070–72, paired),
aligned with the same STAR to the demo FASTA and GTF, one pass, with a yeast's
intron limits:

    STAR --outFilterMultimapNmax 20 --alignIntronMax 2000 --alignMatesGapMax 2000

That subset was drawn for a test that aligns to chromosome I, so its 25
junctions are nearly all there — EFB1's intron with 659 reads among them — and
it is what puts a junction lane beside a real yeast map rather than a showcase:
most of its rows are one read long, which is what the lane's floor is for.

Nothing in any of the four is generated: every number is one a tool computed
from real reads or a published table.
"""

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
YEAST = ROOT / 'demo' / 'yeast'
HUMAN = ROOT / 'demo' / 'human'
FASTA = YEAST / 'S288c_syn40-XIII.fa'
GTF = YEAST / 'Yeast_annotations.gtf'

#: SGD's CEN coordinates for R64-1-1, 1-based and inclusive, as a check on the
#: scan — never as its answer. XIII is the synthetic chromosome's own.
SGD_CEN = {
    'I': (151465, 151582),
    'II': (238207, 238323),
    'III': (114385, 114501),
    'IV': (449711, 449821),
    'V': (151987, 152104),
    'VI': (148510, 148627),
    'VII': (496920, 497038),
    'VIII': (105586, 105703),
    'IX': (355629, 355745),
    'X': (436307, 436425),
    'XI': (440129, 440246),
    'XII': (150828, 150947),
    'XIII-syn40': (268031, 268149),
    'XIV': (628758, 628875),
    'XV': (326584, 326702),
    'XVI': (555957, 556073),
}

#: This strain's III against R64's: 1,095 bp shorter, and every base of the
#: difference upstream of CEN3 (316,620 against 315,525).
III_SHIFT = 1095

#: The rDNA, 1-based inclusive: from ETS2-1 to RDN5-2, the two 35S repeats and
#: the 5S gene after them, as the demo GTF places them.
RDNA = ('XII', 451575, 468931)

#: CDEI's palindromic core, `CACRTG` or its reverse `CAYGTG` — the eight-base
#: consensus `RTCACRTG` is too strict for CEN2 (`ATCATGTG`) and CEN9
#: (`TTCACGTG`), and what makes a hit a centromere is the CDEII and CDEIII after
#: it rather than these six bases.
CDEI = re.compile(r'(?=(CA[CT][AG][CT]G))')


def read_fasta(path):
    """Every sequence of a FASTA, upper-cased."""
    sequences = {}
    name = None
    parts = []
    with path.open() as handle:
        for line in handle:
            if line.startswith('>'):
                if name is not None:
                    sequences[name] = ''.join(parts)
                name = line[1:].split()[0]
                parts = []
            else:
                parts.append(line.strip().upper())
    if name is not None:
        sequences[name] = ''.join(parts)
    return sequences


def reverse_complement(sequence):
    return sequence[::-1].translate(str.maketrans('ACGT', 'TGCA'))


def centromere(sequence):
    """The one CEN element on a sequence, 1-based inclusive, or an error.

    CDEI, then 75–110 bases of CDEII at least 85 % A or T, then CDEIII's
    `TCCGAA` — on either strand. CDEIII's core is allowed one mismatch in its
    first base (`ACCGAA`), which CEN4's has.
    """
    hits = []
    length = len(sequence)
    for strand, text in (('+', sequence), ('-', reverse_complement(sequence))):
        for match in CDEI.finditer(text):
            at = match.start() - 2
            if at < 0:
                continue
            window = text[at + 8:at + 8 + 130]
            for core in re.finditer(r'[AT]CCGAA', window):
                offset = core.start()
                if offset < 75 or offset > 110:
                    continue
                cdeii = text[at + 8:at + 8 + offset - 12]
                richness = sum(base in 'AT' for base in cdeii) / max(1, len(cdeii))
                if richness < 0.85:
                    continue
                end = at + 8 + offset + 14
                if strand == '+':
                    hits.append((richness, at + 1, end))
                else:
                    hits.append((richness, length - end + 1, length - at))
    if not hits:
        raise SystemExit('no centromere found')
    hits.sort(reverse=True)
    best = hits[0]
    # One element per chromosome, and it has to be unambiguous: a second hit
    # nearly as good as the first is a scan that cannot say which it found.
    if len(hits) > 1 and hits[1][0] > best[0] - 0.02 and abs(hits[1][1] - best[1]) > 200:
        raise SystemExit(f'two centromere candidates: {hits[:2]}')
    return best[1], best[2]


def yeast():
    sequences = read_fasta(FASTA)
    rows = []
    for name, sequence in sequences.items():
        start, end = centromere(sequence)
        expected = SGD_CEN[name]
        shift = III_SHIFT if name == 'III' else 0
        # The scan's span may run a base or two past SGD's either side (its
        # CDEIII is 26 bp and SGD's element ends where CDEIII does); the start is
        # what has to agree.
        if abs(start - (expected[0] - shift)) > 2:
            raise SystemExit(f'{name}: CEN at {start}, SGD says {expected[0] - shift}')
        # 0-based half-open from here on, as a cytoBand file is written.
        cen_from = start - 1
        cen_to = end
        middle = (cen_from + cen_to) // 2
        length = len(sequence)
        bands = [
            (0, cen_from, 'p', 'gneg'),
            (cen_from, middle, 'p11', 'acen'),
            (middle, cen_to, 'q11', 'acen'),
        ]
        if name == RDNA[0]:
            rdna_from, rdna_to = RDNA[1] - 1, RDNA[2]
            bands += [
                (cen_to, rdna_from, 'q1', 'gneg'),
                (rdna_from, rdna_to, 'q2', 'stalk'),
                (rdna_to, length, 'q3', 'gneg'),
            ]
        else:
            bands.append((cen_to, length, 'q', 'gneg'))
        for band in bands:
            rows.append((name, *band))
    out = YEAST / 'Yeast_cytobands.txt'
    with out.open('w') as handle:
        handle.write(
            '# Yeast (S288C, syn XIII-40) as a cytoBand. Not G-banded: each arm is one '
            'unstained band; acen is the CEN element found in the demo FASTA by its '
            'CDEI-CDEII-CDEIII architecture; XII q2 is the rDNA, drawn as a stalk. '
            'scripts/make_ideogram_junction_demo.py\n'
        )
        for name, start, end, band, stain in rows:
            handle.write(f'{name}\t{start}\t{end}\t{band}\t{stain}\n')
    print(f'{out.relative_to(ROOT)}: {len(rows)} bands over {len(sequences)} sequences')


def karyotype(path):
    """Circos's `band` lines, as UCSC's five columns, in karyotype order."""
    order = []
    bands = {}
    with Path(path).open() as handle:
        for line in handle:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == 'chr':
                order.append(parts[2])
                bands[parts[2]] = []
            elif parts[0] == 'band':
                bands[parts[1]].append((int(parts[4]), int(parts[5]), parts[2], parts[6]))
    rows = []
    for key in order:
        name = 'chr' + key[2:]
        for start, end, band, stain in bands[key]:
            rows.append((name, start, end, band, stain))
    return rows


def hg19(path, hg38_check=None):
    if hg38_check is not None:
        import gzip

        circos = karyotype(Path(path).with_name('karyotype.human.hg38.txt'))
        main = {f'chr{n}' for n in [*range(1, 23), 'X', 'Y']}
        with gzip.open(hg38_check, 'rt') as handle:
            ucsc = [tuple(line.rstrip('\n').split('\t')) for line in handle]
        ucsc = {(c, int(s), int(e), b, g) for c, s, e, b, g in ucsc if c in main}
        if set(circos) != ucsc:
            raise SystemExit('Circos hg38 is not UCSC hg38: its hg19 cannot be trusted either')
        print(f'checked: Circos hg38 = UCSC hg38 cytoBandIdeo, {len(ucsc)} bands')
    rows = karyotype(path)
    HUMAN.mkdir(parents=True, exist_ok=True)
    out = HUMAN / 'hg19_cytoBand.txt'
    with out.open('w') as handle:
        for row in rows:
            handle.write('\t'.join(str(part) for part in row) + '\n')
    print(f'{out.relative_to(ROOT)}: {len(rows)} bands')


SAMPLES = {
    'ERR188383': 'GBR',
    'ERR188428': 'GBR',
    'ERR188454': 'YRI',
    'ERR204916': 'YRI',
}

#: The sample whose alignments and regtools junctions ride along.
LEAD = 'ERR188428'


def junctions(star_dir, regtools_dir, rnasplice):
    HUMAN.mkdir(parents=True, exist_ok=True)
    import gzip

    # The gene model the reads were aligned against, so the arcs land on the
    # exons they join: the branch's own chrX GTF, gzipped as it is.
    gtf = Path(rnasplice) / 'reference' / 'genes_chrX.gtf'
    target = HUMAN / 'Homo_sapiens.GRCh37.chrX.gtf.gz'
    with gtf.open('rb') as source, gzip.GzipFile(target, 'wb', compresslevel=9, mtime=0) as sink:
        shutil.copyfileobj(source, sink)
    print(f'{target.relative_to(ROOT)}: {target.stat().st_size:,} bytes')
    for sample, population in SAMPLES.items():
        source = Path(star_dir) / sample / 'SJ.out.tab'
        target = HUMAN / f'Geuvadis_chrX_{population}_{sample}.SJ.out.tab'
        shutil.copyfile(source, target)
        print(f'{target.relative_to(ROOT)}: {sum(1 for _ in target.open())} junctions')
    bed = Path(regtools_dir) / f'{LEAD}.junctions.bed'
    target = HUMAN / f'Geuvadis_chrX_{SAMPLES[LEAD]}_{LEAD}.junctions.bed'
    shutil.copyfile(bed, target)
    print(f'{target.relative_to(ROOT)}: {sum(1 for _ in target.open())} junctions')
    for suffix in ('bam', 'bam.bai'):
        source = Path(star_dir) / LEAD / f'Aligned.sortedByCoord.out.{suffix}'
        target = HUMAN / f'Geuvadis_chrX_{SAMPLES[LEAD]}_{LEAD}.{suffix}'
        shutil.copyfile(source, target)
        print(f'{target.relative_to(ROOT)}: {target.stat().st_size:,} bytes')


def yeast_junctions(path):
    target = YEAST / 'Yeast_RNA_junctions.SJ.out.tab'
    shutil.copyfile(path, target)
    print(f'{target.relative_to(ROOT)}: {sum(1 for _ in target.open())} junctions')


def main(argv):
    if len(argv) >= 1 and argv[0] == 'yeast':
        yeast()
    elif len(argv) == 2 and argv[0] == 'yeast-junctions':
        yeast_junctions(argv[1])
    elif len(argv) >= 2 and argv[0] == 'hg19':
        hg19(argv[1], argv[2] if len(argv) > 2 else None)
    elif len(argv) == 4 and argv[0] == 'junctions':
        junctions(argv[1], argv[2], argv[3])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
