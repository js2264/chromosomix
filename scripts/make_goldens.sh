#!/usr/bin/env bash
#
# Golden oracles from the reference tools' own command lines.
#
#   ./scripts/make_goldens.sh
#
# Writes into ./goldens: loop and border calls from chromosight as BEDPE and
# BED, four tracks from cooltools as bigWig, and the two APA pileups from
# cooltools pileup. Every line runs every time; nothing is cached, nothing is
# conditional. Delete goldens/ to start over.
#
# Needs, on PATH:
#   pip install 'pandas<3' cooler cooltools chromosight bioframe
#   conda install -c bioconda ucsc-bedgraphtobigwig
#
# Both pins matter. bioframe still passes `verbose=` to `pandas.read_table`,
# which pandas 3 removed, so cooltools cannot read a BED there; and cooltools'
# `--bigwig` shells out to UCSC's bedGraphToBigWig through bioframe, so without
# that binary each track command writes its table and then dies.
#
# About twenty minutes, most of it the 690 MB chicken map and the expected
# curve over it at 10 kb.

set -euo pipefail

mkdir -p goldens
cd goldens

S3=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo

curl -fSL -o yeast.cool "$S3/yeast/Yeast_microC_G2M_1kb.cool"
curl -fSL -o chicken.mcool "$S3/chicken/G2_4DNFIT479GDR.mcool"

# Views over whole chromosomes, with every region name prefixed.
#
# The prefix is a workaround. `cooltools pileup --expected` unpacks its group
# key with `if len(support) == 2: region1, region2 = support` — a test meant for
# a tuple, applied to a string — so a region named `IV` unpacks into `I` and `V`
# and the run dies with "implemented for cis contacts only" on purely cis loops.
# Yeast's Roman numerals hit it every time. `region_IV` does not.
cooler dump -t chroms yeast.cool | awk 'BEGIN{OFS="\t"}{print $1,0,$2,"region_"$1}' > yeast_view.bed
cooler dump -t chroms chicken.mcool::/resolutions/100000 | awk 'BEGIN{OFS="\t"}{print $1,0,$2,"region_"$1}' > chicken_view.bed

# --- chromosight: the pattern calls ----------------------------------------

chromosight detect --pattern loops --norm auto --no-plotting --threads 4 \
  yeast.cool yeast_loops

chromosight detect --pattern borders --norm auto --no-plotting --threads 4 \
  chicken.mcool::/resolutions/10000 chicken_borders

# chromosight's TSV is chrom1 start1 end1 chrom2 start2 end2 … score at $11.
# Off the diagonal that is a BEDPE; on it, both halves of the row are the same
# interval, so it is a BED.
awk 'BEGIN{OFS="\t"} NR>1 {print $1,$2,$3,$4,$5,$6,"loop_"NR-1,$11}' yeast_loops.tsv > yeast_loops.bedpe
awk 'BEGIN{OFS="\t"} NR>1 {print $1,$2,$3,"border_"NR-1,$11}' chicken_borders.tsv > chicken_borders.bed

# The window dumps beside them are 86 MB of JSON for eleven thousand borders,
# and the pileups below recompute the same thing from the map.
rm -f yeast_loops.json chicken_borders.json

# --- cooltools: four tracks off the chicken map, as bigWig ------------------

# `-o` carries no extension because `--bigwig` appends `.cis.bw`, `.<window>.bw`
# and so on to whatever it says.
cooltools coverage --clr_weight_name weight --bigwig -p 4 \
  -o chicken_coverage chicken.mcool::/resolutions/100000

# No phasing track, so E1's sign is arbitrary per chromosome: this is the
# eigenvector up to a flip. Pass --phasing-track <GC bedGraph> for a signed one.
cooltools eigs-cis --clr-weight-name weight --view chicken_view.bed --n-eigs 3 --bigwig \
  -o chicken_eigs chicken.mcool::/resolutions/100000

cooltools insulation --clr-weight-name weight --bigwig -p 4 \
  -o chicken_insulation chicken.mcool::/resolutions/10000 100000 200000

cooltools virtual4c --clr-weight-name weight --bigwig -p 4 \
  -o chicken_v4c chicken.mcool::/resolutions/10000 chr1:20,000,000-20,100,000

mv -f chicken_coverage chicken_coverage.tsv
mv -f chicken_insulation chicken_insulation.tsv

# --- cooltools: the APA of both call sets ----------------------------------

# Observed over expected, because a pileup mixing 20 kb and 2 Mb separations is
# a picture of the distance decay. The expected table is per view region, so it
# is computed against the same view the pileup uses.
cooltools expected-cis --clr-weight-name weight --view yeast_view.bed -p 4 \
  -o yeast_expected.tsv yeast.cool
cooltools expected-cis --clr-weight-name weight --view chicken_view.bed -p 4 \
  -o chicken_expected.tsv chicken.mcool::/resolutions/10000

# Six and three columns: the name and score columns are valid BED and BEDPE and
# cooltools reads them as part of the feature table, which changes the grouping.
cut -f1-6 yeast_loops.bedpe > loops.6col.bedpe
cut -f1-3 chicken_borders.bed > borders.3col.bed

cooltools pileup --features-format bedpe --view yeast_view.bed \
  --expected yeast_expected.tsv --clr-weight-name weight \
  --flank 10000 --aggregate mean -p 4 \
  -o apa_yeast_loops.npz yeast.cool loops.6col.bedpe

cooltools pileup --features-format bed --view chicken_view.bed \
  --expected chicken_expected.tsv --clr-weight-name weight \
  --flank 100000 --aggregate mean -p 4 \
  -o apa_chicken_borders.npz chicken.mcool::/resolutions/10000 borders.3col.bed

# --- what came out ---------------------------------------------------------

sha256sum *.bed *.bedpe *.bw *.npz *.tsv > MANIFEST.sha256
ls -la
