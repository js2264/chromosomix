#!/usr/bin/env bash
#
# Golden oracles for the pattern-detection and matrix tasks, from the reference
# tools' own command lines.
#
#   ./scripts/make_goldens.sh                 # everything, into goldens/
#   ./scripts/make_goldens.sh chromosight     # one section
#   OUT=/tmp/g THREADS=8 ./scripts/make_goldens.sh
#
# What it makes
# -------------
#   chromosight   loop calls on a yeast micro-C map      -> BEDPE
#                 border calls on a chicken G2 map       -> BED
#   cooltools     coverage, E1, insulation, virtual 4C   -> bigWig
#                 on the same chicken map
#   pileups       APA of those loops and those borders   -> NPZ (+ PNG)
#
# Why a shell script and not a Python one
# ---------------------------------------
# Every number here comes out of a published tool's *command line*, which is the
# interface those tools promise to keep. A Python script would be reaching past
# it into APIs that move between minor versions — and, more to the point, a
# golden produced by code somebody wrote for the occasion is a golden that can
# be wrong in the same direction as the thing it is checking. `chromosight
# detect` and `cooltools insulation` cannot be.
#
# The one place this rule bends is the APA *picture*: `cooltools pileup` writes
# arrays and has no plotting command, so the PNG comes from `plotpup.py`
# (coolpuppy). It is optional and the NPZ is the golden.
#
# What it needs
# -------------
#   pip install 'pandas<3' cooler cooltools chromosight bioframe pyBigWig
#   pip install coolpuppy tables            # optional, for the APA pictures
#   conda install -c bioconda ucsc-bedgraphtobigwig   # or the UCSC binary
#
# Two of those pins are not decoration:
#
#   * **pandas < 3.** bioframe's table reader still passes `verbose=` to
#     `read_table`, which pandas 3 removed, so every cooltools command that
#     reads a BED dies on import of its own input. Unpatched chromosight is
#     worse on pandas >= 2.2: it *runs*, and silently writes an empty score
#     column, because its score assignment is a chained one that copy-on-write
#     turns into a no-op.
#   * **bedGraphToBigWig on PATH.** cooltools' `--bigwig` is a call out to the
#     UCSC binary through bioframe; without it every command still writes its
#     table and then fails at the last step. Set ALLOW_NO_BIGWIG=1 to accept
#     tables only, which is a degraded run and says so.
#
# Twenty minutes on a laptop from cold: the 690 MB chicken map is the first half
# and `cooltools expected-cis` over it at 10 kb is most of the second. Both are
# cached, so a re-run that changes a threshold or a flank takes seconds. Raise
# THREADS to shorten the expected step; FORCE=1 recomputes it.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — every one of these can be overridden from the environment
# ---------------------------------------------------------------------------

BUCKET="${BUCKET:-https://rsglab-data.s3.eu-west-3.amazonaws.com/demo}"
OUT="${OUT:-goldens}"
DATA="${DATA:-$OUT/data}"
THREADS="${THREADS:-2}"

YEAST_FILE="${YEAST_FILE:-yeast/Yeast_microC_G2M_1kb.cool}"
CHICKEN_FILE="${CHICKEN_FILE:-chicken/G2_4DNFIT479GDR.mcool}"

#: Bin size for the border scan and for insulation and virtual 4C. chromosight's
#: border template was drawn at 5 kb; 10 kb on a 1 Gb genome keeps the whole run
#: to a couple of minutes and the call set to something a human can look at.
FINE_RES="${FINE_RES:-10000}"
#: Coverage and compartments. An eigenvector at 10 kb is mostly noise and takes
#: a hundred times as long to find.
COARSE_RES="${COARSE_RES:-100000}"

INSULATION_WINDOWS="${INSULATION_WINDOWS:-100000 200000}"
V4C_VIEWPOINT="${V4C_VIEWPOINT:-chr1:20,000,000-20,100,000}"

#: APA flanks, chosen so both pileups come out 21x21 at their own bin size.
LOOP_FLANK="${LOOP_FLANK:-10000}"
BORDER_FLANK="${BORDER_FLANK:-100000}"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not on PATH. $2"
}

#: Download once. `--continue-at -` resumes a half-finished 690 MB file rather
#: than starting it again, which is the difference between a flaky connection
#: costing a minute and costing the whole run.
fetch() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then
    note "have $(basename "$dest")"
    return
  fi
  note "fetching $(basename "$dest")"
  mkdir -p "$(dirname "$dest")"
  curl -fSL --retry 3 --continue-at - -o "$dest" "$url"
}

#: chromosight's TSV to BEDPE: drop the header, keep the six interval columns,
#: and carry the correlation into the score field so the set stays sortable and
#: filterable once it has left the tool.
to_bedpe() {
  awk -F'\t' 'BEGIN { OFS = "\t" }
    NR == 1 { next }
    { print $1, $2, $3, $4, $5, $6, "loop_" NR - 1, $11 }' "$1" > "$2"
}

#: The same for a pattern that lives on the diagonal, where bin1 == bin2 and the
#: two halves of the row are the same interval: a BED, not a BEDPE.
to_bed() {
  awk -F'\t' 'BEGIN { OFS = "\t" }
    NR == 1 { next }
    { print $1, $2, $3, "border_" NR - 1, $11 }' "$1" > "$2"
}

#: chromosight writes every matched window beside its calls — 86 MB of JSON for
#: eleven thousand borders. They are an intermediate: the pileup section below
#: recomputes the same average from the map, and the calls themselves are the
#: golden. Kept only on request.
drop_windows() {
  [ "${KEEP_WINDOWS:-0}" = "1" ] && return 0
  rm -f "$1"
}

#: A cooltools view over whole chromosomes, with the region names prefixed.
#:
#: The prefix is a workaround and worth stating. `cooltools pileup --expected`
#: unpacks its group key with `if len(support) == 2: region1, region2 = support`
#: — which is a test on a *tuple*, applied to whatever the key is. A region
#: named `IV` is a two-character string, so it unpacks into `I` and `V`, and the
#: run dies with "ObsExpSnipper is implemented for cis contacts only" on a set of
#: purely cis loops. Yeast's Roman numerals are the common case. Naming every
#: region `region_<chrom>` steps around it without changing any coordinate.
make_view() {
  cooler dump -t chroms "$1" \
    | awk 'BEGIN { OFS = "\t" } { print $1, 0, $2, "region_" $1 }' > "$2"
}

#: Record what was made and what made it. A golden with no provenance is a file
#: nobody can regenerate or argue with.
manifest() {
  local file="$OUT/MANIFEST.txt"
  {
    printf 'generated  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'host       %s\n' "$(uname -sm)"
    printf 'chromosight %s\n' "$(chromosight --version 2>&1 | tail -1)"
    printf 'cooltools  %s\n' "$(cooltools --version 2>&1 | tail -1)"
    printf 'cooler     %s\n' "$(cooler --version 2>&1 | tail -1)"
    printf 'pandas     %s\n' "$(pip show pandas 2>/dev/null | awk '/^Version:/ { print $2; exit }')"
    printf 'sources    %s %s\n' "$BUCKET/$YEAST_FILE" "$BUCKET/$CHICKEN_FILE"
    printf '\n%s\n' 'outputs (sha256, bytes, name):'
    ( cd "$OUT" && find . -type f ! -name 'MANIFEST.txt' ! -path './data/*' | sort \
      | while read -r f; do
          printf '%s  %10d  %s\n' "$(sha256sum "$f" | cut -c1-16)" "$(wc -c < "$f")" "${f#./}"
        done )
  } > "$file"
  say "manifest"
  cat "$file"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

need curl "It fetches the two maps."
need awk "Every format conversion here is one awk line."
need sha256sum "The manifest checksums what was written."
need cooler "pip install cooler"
need cooltools "pip install cooltools"
need chromosight "pip install chromosight"

BIGWIG_FLAG="--bigwig"
if ! command -v bedGraphToBigWig >/dev/null 2>&1; then
  if [ "${ALLOW_NO_BIGWIG:-0}" = "1" ]; then
    BIGWIG_FLAG=""
    printf '\033[33mwarning: bedGraphToBigWig is not on PATH — writing tables only.\033[0m\n'
  else
    die "bedGraphToBigWig is not on PATH, and cooltools --bigwig shells out to it.
       conda install -c bioconda ucsc-bedgraphtobigwig
       or https://hgdownload.soe.ucsc.edu/admin/exe/linux.x86_64/bedGraphToBigWig
       Re-run with ALLOW_NO_BIGWIG=1 to accept the bedGraph/TSV tables instead."
  fi
fi

PLOTS=1
command -v coolpup.py >/dev/null 2>&1 && command -v plotpup.py >/dev/null 2>&1 || PLOTS=0

SECTIONS="${*:-chromosight cooltools pileup}"
mkdir -p "$OUT" "$DATA"

YEAST="$DATA/$(basename "$YEAST_FILE")"
CHICKEN="$DATA/$(basename "$CHICKEN_FILE")"
CHICKEN_FINE="$CHICKEN::/resolutions/$FINE_RES"
CHICKEN_COARSE="$CHICKEN::/resolutions/$COARSE_RES"

say "inputs"
fetch "$BUCKET/$YEAST_FILE" "$YEAST"
fetch "$BUCKET/$CHICKEN_FILE" "$CHICKEN"
make_view "$YEAST" "$OUT/yeast_view.bed"
make_view "$CHICKEN_COARSE" "$OUT/chicken_view.bed"
note "$(wc -l < "$OUT/yeast_view.bed") yeast sequences, $(wc -l < "$OUT/chicken_view.bed") chicken sequences"

# ---------------------------------------------------------------------------
# 1. chromosight: the pattern calls
# ---------------------------------------------------------------------------

if [[ " $SECTIONS " == *" chromosight "* ]]; then
  say "chromosight detect — loops on the yeast micro-C map"
  # `--norm auto` reuses the weights already in the file rather than rebalancing
  # it, which is both faster and the only way two runs agree; `--no-plotting`
  # because the pileup PDF is a picture of the run and not a golden of it.
  chromosight detect \
    --pattern loops \
    --norm auto \
    --no-plotting \
    --threads "$THREADS" \
    "$YEAST" "$OUT/yeast_loops"
  to_bedpe "$OUT/yeast_loops.tsv" "$OUT/yeast_loops.bedpe"
  drop_windows "$OUT/yeast_loops.json"
  note "$(wc -l < "$OUT/yeast_loops.bedpe") loops -> yeast_loops.bedpe"

  say "chromosight detect — borders on the chicken G2 map at ${FINE_RES} bp"
  chromosight detect \
    --pattern borders \
    --norm auto \
    --no-plotting \
    --threads "$THREADS" \
    "$CHICKEN_FINE" "$OUT/chicken_borders"
  to_bed "$OUT/chicken_borders.tsv" "$OUT/chicken_borders.bed"
  drop_windows "$OUT/chicken_borders.json"
  note "$(wc -l < "$OUT/chicken_borders.bed") borders -> chicken_borders.bed"
fi

# ---------------------------------------------------------------------------
# 2. cooltools: four tracks off the chicken map, as bigWig
# ---------------------------------------------------------------------------

if [[ " $SECTIONS " == *" cooltools "* ]]; then
  say "cooltools coverage — ${COARSE_RES} bp"
  # The prefix carries no extension because `--bigwig` appends `.cis.bw` and
  # `.tot.bw` to whatever `-o` says; a `-o …coverage.tsv` would name the tracks
  # `coverage.tsv.cis.bw`. The table is renamed afterwards instead.
  cooltools coverage \
    --clr_weight_name weight \
    $BIGWIG_FLAG \
    -p "$THREADS" \
    -o "$OUT/chicken_coverage" \
    "$CHICKEN_COARSE"
  mv -f "$OUT/chicken_coverage" "$OUT/chicken_coverage.tsv"

  say "cooltools eigs-cis — ${COARSE_RES} bp"
  # No phasing track, so E1's *sign* is arbitrary per chromosome: the golden is
  # the eigenvector up to a flip, and anything comparing against it has to say
  # so. Phase it with `--phasing-track <GC or gene density bedGraph>` if a
  # signed track is what you need.
  cooltools eigs-cis \
    --clr-weight-name weight \
    --view "$OUT/chicken_view.bed" \
    --n-eigs 3 \
    $BIGWIG_FLAG \
    -o "$OUT/chicken_eigs" \
    "$CHICKEN_COARSE"

  say "cooltools insulation — ${FINE_RES} bp, windows ${INSULATION_WINDOWS}"
  # shellcheck disable=SC2086 — the window list is deliberately word-split.
  cooltools insulation \
    --clr-weight-name weight \
    $BIGWIG_FLAG \
    -p "$THREADS" \
    -o "$OUT/chicken_insulation" \
    "$CHICKEN_FINE" $INSULATION_WINDOWS
  mv -f "$OUT/chicken_insulation" "$OUT/chicken_insulation.tsv"

  say "cooltools virtual4c — $V4C_VIEWPOINT at ${FINE_RES} bp"
  cooltools virtual4c \
    --clr-weight-name weight \
    $BIGWIG_FLAG \
    -p "$THREADS" \
    -o "$OUT/chicken_v4c" \
    "$CHICKEN_FINE" "$V4C_VIEWPOINT"

  note "tracks: $(cd "$OUT" && ls chicken_*.bw 2>/dev/null | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 3. cooltools pileup: the APA of both call sets
# ---------------------------------------------------------------------------

if [[ " $SECTIONS " == *" pileup "* ]]; then
  [ -s "$OUT/yeast_loops.bedpe" ] || die "no yeast_loops.bedpe — run the chromosight section first."
  [ -s "$OUT/chicken_borders.bed" ] || die "no chicken_borders.bed — run the chromosight section first."

  # Observed over expected, because a raw pileup at 20 kb separation and one at
  # 2 Mb are not on the same scale and averaging them together is a picture of
  # the distance decay. The expected table is per view region, so it has to be
  # computed against the same view the pileup uses.
  say "cooltools expected-cis — for both pileups"
  # Kept between runs. The chicken curve at 10 kb is the long pole of the whole
  # script — a hundred thousand bins, every diagonal — and re-running the pileup
  # section to change a flank should not pay for it twice. FORCE=1 recomputes.
  if [ -s "$OUT/yeast_expected.tsv" ] && [ "${FORCE:-0}" != "1" ]; then
    note "have yeast_expected.tsv"
  else
    cooltools expected-cis \
      --clr-weight-name weight \
      --view "$OUT/yeast_view.bed" \
      -p "$THREADS" \
      -o "$OUT/yeast_expected.tsv" \
      "$YEAST"
  fi
  if [ -s "$OUT/chicken_expected.tsv" ] && [ "${FORCE:-0}" != "1" ]; then
    note "have chicken_expected.tsv"
  else
    note "the chicken curve at ${FINE_RES} bp takes a few minutes; raise THREADS to shorten it"
    cooltools expected-cis \
      --clr-weight-name weight \
      --view "$OUT/chicken_view.bed" \
      -p "$THREADS" \
      -o "$OUT/chicken_expected.tsv" \
      "$CHICKEN_FINE"
  fi

  say "cooltools pileup — APA of the chromosight loops"
  # Six columns only: the extra name and score columns are a valid BEDPE and
  # cooltools reads them as part of the feature table, which changes how the
  # rows are grouped.
  cut -f1-6 "$OUT/yeast_loops.bedpe" > "$OUT/.loops6.bedpe"
  cooltools pileup \
    --features-format bedpe \
    --view "$OUT/yeast_view.bed" \
    --expected "$OUT/yeast_expected.tsv" \
    --clr-weight-name weight \
    --flank "$LOOP_FLANK" \
    --aggregate mean \
    -p "$THREADS" \
    -o "$OUT/apa_yeast_loops.npz" \
    "$YEAST" "$OUT/.loops6.bedpe"

  say "cooltools pileup — APA of the chromosight borders"
  cut -f1-3 "$OUT/chicken_borders.bed" > "$OUT/.borders3.bed"
  cooltools pileup \
    --features-format bed \
    --view "$OUT/chicken_view.bed" \
    --expected "$OUT/chicken_expected.tsv" \
    --clr-weight-name weight \
    --flank "$BORDER_FLANK" \
    --aggregate mean \
    -p "$THREADS" \
    -o "$OUT/apa_chicken_borders.npz" \
    "$CHICKEN_FINE" "$OUT/.borders3.bed"

  if [ "$PLOTS" = "1" ]; then
    # The one step that is not cooltools, because cooltools' CLI has no plotting
    # command: coolpuppy computes the same pileup and `plotpup.py` draws it. The
    # NPZ above stays the golden; this is the picture to look at.
    say "coolpup.py + plotpup.py — the same two pileups, as pictures"
    coolpup.py "$YEAST" "$OUT/.loops6.bedpe" \
      --features_format bedpe \
      --view "$OUT/yeast_view.bed" \
      --expected "$OUT/yeast_expected.tsv" \
      --flank "$LOOP_FLANK" \
      --outname "$OUT/apa_yeast_loops.clpy"
    plotpup.py --input_pups "$OUT/apa_yeast_loops.clpy" \
      --vmin 0.5 --vmax 2 --output "$OUT/apa_yeast_loops.png"

    coolpup.py "$CHICKEN_FINE" "$OUT/.borders3.bed" \
      --features_format bed \
      --local \
      --view "$OUT/chicken_view.bed" \
      --expected "$OUT/chicken_expected.tsv" \
      --flank "$BORDER_FLANK" \
      --outname "$OUT/apa_chicken_borders.clpy"
    plotpup.py --input_pups "$OUT/apa_chicken_borders.clpy" \
      --vmin 0.5 --vmax 2 --output "$OUT/apa_chicken_borders.png"
  else
    note "coolpup.py / plotpup.py not found — NPZ written, no pictures."
    note "pip install coolpuppy tables"
  fi
  rm -f "$OUT/.loops6.bedpe" "$OUT/.borders3.bed"
fi

manifest
say "done — $OUT"
