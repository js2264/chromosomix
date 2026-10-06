#!/usr/bin/env bash
# The analyses behind Fig. 1, run with the app's own command line.
#
# Every number and every computed track, set, pile-up and model the figure
# draws comes from these commands, on the yeast demo files in demo/yeast/:
# the same tasks, with the same parameters, that the Analysis column runs.
#
#   npm run build:cli
#   bash manuscript/figure1/run_analyses.sh
#
# Needs `cooler` (pip install cooler) for one preparation step: the 3D model is
# solved at 5 kb, and the command line reads a resolution only where the file
# stores it, so the 1 kb demo cooler is zoomified first. Everything at 1 kb
# reads the demo file itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEMO="$ROOT/demo/yeast"
OUT="$HERE/results"
WORK="${WORK:-$HERE/build}"
RUN=(node "$ROOT/dist-cli/metacooler-run.mjs")
COOL="$DEMO/Yeast_microC_G2M_1kb.cool"
MCOOL="$WORK/Yeast_microC_G2M.mcool"
mkdir -p "$OUT" "$WORK"

if [ ! -f "$MCOOL" ]; then
  cooler zoomify -p 4 -r 1000,4000,5000,16000,32000 --balance -o "$MCOOL" "$COOL"
fi

# 2D -> 1D: diamond insulation, its track, its borders and the domains between them.
"${RUN[@]}" insulation "$COOL" --window 10 --out "$OUT/insulation" --quiet
INS="$OUT/insulation/Yeast_microC_G2M_1kb.insulation.insulation-w10.bw"
BORDERS="$OUT/insulation/Yeast_microC_G2M_1kb.insulation.insulation-boundaries.bed"
DOMAINS="$OUT/insulation/Yeast_microC_G2M_1kb.insulation.insulation-domains.bed"

# 2D -> 2D features: loops, by the Chromosight port.
"${RUN[@]}" chromosight "$COOL" --pattern loops --out "$OUT/loops" --quiet

# 1D x 1D: the borders against the ChIP-seq track — Pol II and ATAC piled up on them,
# and the insulation track correlated with each.
"${RUN[@]}" metaplot --tracks "$DEMO/Yeast_ChIP_Pol2-vs-input.bw,$DEMO/Yeast_ATAC.bw" \
  --features "$BORDERS" --at centre --flank 10000 --step 200 --stranded false --out "$OUT/metaplot" --quiet
"${RUN[@]}" trackcorr --tracks "$INS,$DEMO/Yeast_ChIP_Pol2-vs-input.bw,$DEMO/Yeast_ATAC.bw" \
  --over bins --binsize 1000 --out "$OUT/trackcorr" --quiet

# 1D -> 2D: every domain between two borders, rescaled and piled up.
"${RUN[@]}" apa "$COOL" --anchors features --features "$DOMAINS" --mode scaled --out "$OUT/domains" --quiet

# 2D -> 3D: pastis-NB on the whole genome at 5 kb.
"${RUN[@]}" reconstruct3d "$MCOOL::/resolutions/5000" --method nb --out "$OUT/model" --quiet
MODEL="$(ls "$OUT"/model/*.bed3d)"

# 3D -> 2D: the model against the map it came from; 3D -> 1D: its radial position.
"${RUN[@]}" structuremap "$MCOOL::/resolutions/5000" --features "$MODEL" --structure "$(basename "$MODEL")" \
  --region IV --out "$OUT/model-vs-map" --quiet
"${RUN[@]}" spatialtracks "$MCOOL::/resolutions/5000" --features "$MODEL" --structure "$(basename "$MODEL")" \
  --out "$OUT/spatial" --quiet

# What the figure does not read: the tables beside the tracks, the per-feature heatmap,
# the model's distance matrix and the compaction track.
rm -f "$OUT"/model-vs-map/*distance--1.tsv "$OUT"/insulation/*.tsv "$OUT"/insulation/*.bedGraph \
  "$OUT"/loops/*patterns.tsv "$OUT"/metaplot/*heatmap.tsv "$OUT"/spatial/*compaction* "$OUT"/spatial/*.tsv
echo "results in $OUT"
