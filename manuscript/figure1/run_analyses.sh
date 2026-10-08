#!/usr/bin/env bash
# The analyses behind Fig. 1, run with the app's own command line, on mouse.
#
# The data are 4DN open data for F123 mouse embryonic stem cells (CASTx129):
# in situ Hi-C (Kubo et al. 2021, 4DNFI5QJNFAT, 1.07 billion contacts, 13
# resolutions from 1 kb to 10 Mb) and ChIP-seq for CTCF, H3K27ac and H3K4me3 in
# the same parental line (Huang et al. 2021). Every computed track,
# set, pile-up and model the figure draws comes from these commands: the same
# tasks, with the same parameters, that the Analysis column runs.
#
#   npm run build:cli
#   bash manuscript/figure1/run_analyses.sh
#
# The inputs (about 8.9 GB) are fetched into build/mouse/ once; the command
# line reads local files only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/results"
DATA="${DATA:-$HERE/build/mouse}"
RUN=(node "$ROOT/dist-cli/metacooler-run.mjs")
FOURDN=https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput
IGENOMES=https://ngi-igenomes.s3.amazonaws.com/igenomes/Mus_musculus/UCSC/mm10
mkdir -p "$OUT" "$DATA"

fetch() { # url -> $DATA/<name>, resumed, retried
  local name; name="$(basename "$1")"
  [ -s "$DATA/$name" ] && return 0
  for i in 1 2 3 4; do curl -sS --fail -C - -o "$DATA/$name" "$1" && return 0; sleep $((2 ** i)); done
  return 1
}
fetch "$FOURDN/ef0eba47-ada0-42bc-9329-5145b57ff33a/4DNFI5QJNFAT.mcool"   # Hi-C, WT
fetch "$FOURDN/6dd5c984-eccf-4d2d-8118-38ea2a4d30fb/4DNFIFFXFV82.bw"      # CTCF
fetch "$FOURDN/8ee59614-5b5f-4c8b-a29e-86d0c8047c30/4DNFIXE23VC7.bw"      # H3K27ac
fetch "$FOURDN/f1ae271a-971a-4611-a6d0-fd971f1e693f/4DNFIQYJLKKH.bw"      # H3K4me3
fetch "$IGENOMES/Annotation/Genes/genes.gtf"
fetch "$IGENOMES/Sequence/WholeGenomeFasta/genome.fa.fai"
# the gene track of the UI session (session/mouse_sox2.metacooler.json): chromosome 3 of the GTF
[ -s "$DATA/genes_chr3.gtf" ] || awk -F '\t' '$1 == "chr3"' "$DATA/genes.gtf" > "$DATA/genes_chr3.gtf"

MAP="$DATA/4DNFI5QJNFAT.mcool"
CTCF="$DATA/4DNFIFFXFV82.bw"
K27AC="$DATA/4DNFIXE23VC7.bw"
SEQS=chr1,chr2,chr3,chr4,chr5,chr6,chr7,chr8,chr9,chr10,chr11,chr12,chr13,chr14,chr15,chr16,chr17,chr18,chr19,chrX

# 2D -> 1D: diamond insulation at 10 kb over the autosomes and X, its borders and the domains between them.
"${RUN[@]}" insulation "$MAP::/resolutions/10000" --window 10 --sequences "$SEQS" --out "$OUT/insulation" --quiet
BORDERS="$(ls "$OUT"/insulation/*boundaries.bed)"
DOMAINS="$(ls "$OUT"/insulation/*domains.bed)"

# 1D x 1D: CTCF piled up on the borders, the borders ranked by their strength into quartiles.
"${RUN[@]}" metaplot --tracks "$CTCF" --features "$BORDERS" --at centre --flank 100000 --step 2000 \
  --stranded false --rankBy score --subset groups --groups 4 --out "$OUT/metaplot" --quiet

# 1D -> 2D: every domain between two borders, rescaled and piled up on the map.
"${RUN[@]}" apa "$MAP::/resolutions/10000" --anchors features --features "$DOMAINS" --mode scaled \
  --out "$OUT/domains" --quiet

# 2D -> 1D: compartments of chromosome 3 at 250 kb, signed by H3K27ac.
"${RUN[@]}" compartments "$MAP::/resolutions/250000" --sequences chr3 --phaseTrack "$K27AC" \
  --out "$OUT/compartments" --quiet

# 2D -> 2D features: loops around Sox2, by the Chromosight port, at 5 kb.
"${RUN[@]}" chromosight "$MAP::/resolutions/5000" --pattern loops --sequences chr3 --out "$OUT/loops" --quiet

# 2D -> 3D: pastis-NB at every scale the figure browses, at that scale's resolution — the genome
# at 2.5 Mb, chromosome 3 at 250 kb, chr3:27–37 Mb at 10 kb, chr3:34–35 Mb at 5 kb, and the
# 250 kb around Sox2 and its control region at 2 kb.
"${RUN[@]}" reconstruct3d "$MAP::/resolutions/2500000" --method nb --region "$SEQS" --out "$OUT/model-genome" --quiet
"${RUN[@]}" reconstruct3d "$MAP::/resolutions/250000" --method nb --region chr3 --out "$OUT/model-chr3" --quiet
"${RUN[@]}" reconstruct3d "$MAP::/resolutions/10000" --method nb --region chr3:27,000,001-37,000,000 \
  --out "$OUT/model-region" --quiet
"${RUN[@]}" reconstruct3d "$MAP::/resolutions/5000" --method nb --region chr3:34,000,001-35,000,000 \
  --out "$OUT/model-locus" --quiet
"${RUN[@]}" reconstruct3d "$MAP::/resolutions/2000" --method nb --region chr3:34,550,001-34,800,000 \
  --out "$OUT/model-gene" --quiet

# 3D -> 2D: chromosome 3's model against the map it came from; 3D -> 1D: its radial position.
MODEL="$(ls "$OUT"/model-chr3/*.bed3d)"
"${RUN[@]}" structuremap "$MAP::/resolutions/250000" --features "$MODEL" --structure "$(basename "$MODEL")" \
  --region chr3 --out "$OUT/model-vs-map" --quiet
"${RUN[@]}" spatialtracks "$MAP::/resolutions/250000" --features "$MODEL" --structure "$(basename "$MODEL")" \
  --out "$OUT/spatial" --quiet

# What the figure does not read: the tables beside the tracks, the per-feature heatmap,
# the model's distance matrix and the compaction track.
rm -f "$OUT"/model-vs-map/*distance--1.tsv "$OUT"/insulation/*.tsv "$OUT"/insulation/*.bedGraph \
  "$OUT"/loops/*patterns.tsv "$OUT"/metaplot/*heatmap.tsv "$OUT"/spatial/*compaction* "$OUT"/spatial/*.tsv \
  "$OUT"/compartments/*.bedGraph
echo "results in $OUT"
