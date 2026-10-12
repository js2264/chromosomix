#!/usr/bin/env bash
#
# The DNA Bacterial Zoo: the main Hi-C operations over every map of the lab's
# bacteria, run by the chromosomix command and written straight into the store
# the viewer's "DNA Bacterial Zoo" tile reads — there is no results/ to gather
# it from.
#
#   scripts/dbz-store.sh                         every sample of scripts/DBZ_species.tsv
#   scripts/dbz-store.sh PAK_MM142 PAO1_v3_MM38  two of them
#   STEPS="oriter compartments-arms" scripts/dbz-store.sh
#                                                two steps again, everywhere; the rest is kept
#
# The maps (<sample>.mcool) and the references (<species>.fa, .fna or .fasta,
# gzipped or not) are found wherever they are under $DATA, and the store is
#
#   $STORE/store.chromosomix.json              every file of every species (SPECS §24.1)
#   $STORE/<sample>/<sample>.mcool             the map: a hard link to the one in $DATA
#   $STORE/<sample>/<species>.fa               its reference, likewise
#   $STORE/<sample>/<sample>.chromosomix.json  the session: the map, and under it its HiC
#                                              score, insulation and E1 — nothing else
#   $STORE/<sample>/framing.tsv                what every step ran with: which sequences
#                                              are circles, and where each origin is
#   $STORE/<sample>/<step>/<sample>_<bp>.<task>.<output>.bw|bed|bedpe|bed3d|tsv
#
# One sub-directory per analysis — because output names carry the task and not
# its parameters, so two runs of one task into one directory write over each
# other (loops and borders, and the two compartment runs, below):
#
#   coverage/          coverage-total|cis|trans|fraction.bw                   @ 500 bp
#   circular/          circular.tsv: the junction test, per sequence          @ 4 kb
#   composition/       composition-gc|gcskew|atskew|cumulative.bw             @ 4 kb
#   oriter/            oriter-loci|pars|mats.bed, -coverage-fit.bw, -table    @ 4 kb
#   cistrans/          cistrans.tsv (the table), cistrans-fractions.tsv       @ 500 bp
#   ps/                ps.tsv, ps-slope.tsv                                   @ 500 bp
#   insulation/        insulation-w10.bw, -boundaries.bed, -domains.bed       @ 1 kb
#   di/                di-w10.bw, di-borders.bed, di-domains.bed              @ 1 kb
#   hicscore/          hicscore-d3.bw                                         @ 4 kb
#   compartments/      compartment-e1|e2|e3.bw, compartment-ab.bed            @ 4 kb
#   compartments-arms/ the same, over the decay along both arms               @ 4 kb
#   interarm/          interarm-enrichment.bw, interarm-table.tsv             @ 4 kb
#   loops/             chromosight-patterns.bedpe, -table.tsv, -pileup.tsv    @ 4 kb
#   borders/           chromosight-patterns.bed, -table.tsv, -pileup.tsv      @ 4 kb
#   apa-loops/         apa-chromosight.tsv (the pileup), -anchors.tsv         @ 4 kb
#   apa-borders/       apa-chromosight.tsv (the pileup), -anchors.tsv         @ 4 kb
#   model3d/           reconstructed-model.bed3d, reconstructed-fit.tsv       @ 2 kb
#
# Every step writes a TSV with its provenance at the head. A profile also leaves
# as .bw — the .bedGraph the command writes beside it is removed, the bigWig and
# the TSV saying what it says — a called set as .bed or .bedpe, a model as .bed3d.
#
# A per-sample run.log holds each command with its notes and its exit status,
# and the run ends with a list of every step that failed or wrote nothing. Then
# scripts/DBZ_store.py indexes the folder as it is: store.chromosomix.json lists every file
# the viewer opens, species by species, and each session opens on three tracks.
#
# Look at it, then publish it. The TSVs and the logs are the lab's and stay here:
#
#   python3 scripts/DBZ_store.py serve "$STORE"
#   aws s3 sync "$STORE"/ s3://rsglab-data/dbz/ --delete --exclude '*.tsv' --exclude '*.log'
#
# Keep store.json and the <sample>.metacooler.json sessions in the folder until the site built
# before the rename is gone: that build reads them, and --delete would take them off the bucket.

set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(dirname "$HERE")

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

# The maps and the references, at any depth; the store is written inside it
# unless it is put elsewhere, and is never searched for either.
DATA=${DATA:-$HOME/Downloads/metacooler/data/dbz}
STORE=${STORE:-$DATA/store}
# species<TAB>sample, one row a map, in the order the store lists them. A third
# column, where a row has one, names the sample's reference.
SPECIES=${SPECIES:-$HERE/DBZ_species.tsv}

# This checkout's own build, which has every task the steps below name — `npm
# run build:cli` makes it; or `npm i -g chromosomix`'s on the PATH:
# CLI=chromosomix
if [ -n "${CLI:-}" ]; then
  cli () { $CLI "$@"; }
elif [ -f "$REPO/dist-cli/chromosomix.mjs" ]; then
  CLI="node $REPO/dist-cli/chromosomix.mjs"
  cli () { node "$REPO/dist-cli/chromosomix.mjs" "$@"; }
else
  CLI=chromosomix
  cli () { chromosomix "$@"; }
fi

# One place for the resolutions. A file that does not carry one has the steps
# that need it skipped by name, rather than failing once per file with a line
# about a missing HDF5 group.
RES_COVERAGE=${RES_COVERAGE:-500}
RES_CISTRANS=${RES_CISTRANS:-500}
RES_PS=${RES_PS:-500}
RES_DOMAINS=${RES_DOMAINS:-1000}   # insulation and the directionality index
RES_PATTERNS=${RES_PATTERNS:-4000} # the junction test, the origin, HiC score,
                                   # compartments, chromosight and APA — and the
                                   # bin size a session opens its map at
RES_COMPOSITION=${RES_COMPOSITION:-$RES_PATTERNS} # the sequence tracks, on E1's bins
RES_MODEL=${RES_MODEL:-2000}       # the 3D reconstruction

# A bacterial chromosome and a plasmid join their own ends, and no contact map
# has a field that says so — the reader declares it. `auto` asks each map: the
# junction test the viewer runs when it first opens one (`chromosomix
# circular`, SPECS §8.15) declares the sequences whose two ends are neighbours,
# so the zoo's linear chromosomes (Borrelia, Streptomyces) stay lines. `all`
# declares every sequence of every file circular, `none` none. It changes the
# numbers: on a circle the last bin's contacts with the first are the most local
# contacts there are, so P(s) runs past half the genome, no window near the
# origin is dropped for want of a whole one — and an origin at the first base,
# where most assemblies start, has its two arms running both ways from it.
CIRCULAR=${CIRCULAR:-auto}

# How far along the arms each cell's expectation reaches in compartments-arms,
# in bins at RES_PATTERNS; 0 is the whole chromosome.
ARM_WINDOW=${ARM_WINDOW:-50}

# What both compartment runs take their eigenvectors of: observed/expected
# itself as cooltools' eigs_cis prepares it, the app's default, or the
# correlation of its rows, as Lieberman-Aiden et al. (2009) did (SPECS §18.8).
COMPARTMENTS_METHOD=${COMPARTMENTS_METHOD:-cooltools}

# Only these steps, where given: the others keep what an earlier run wrote, and
# the index lists it. The framing (the junction test, the reference) is always
# made, since every step reads it — so after changing CIRCULAR, run them all:
# the steps kept were framed the old way.
STEPS=${STEPS:-}

# ---------------------------------------------------------------------------

usage () {
  cat <<'TEXT'
usage: scripts/dbz-store.sh [<sample> ...]

  Every sample of the species table, or the ones named.

  DATA=<dir>         the maps and references, at any depth
                     (default: ~/Downloads/metacooler/data/dbz)
  STORE=<dir>        the store to write (default: $DATA/store)
  SPECIES=<tsv>      species<TAB>sample[<TAB>reference] (default: scripts/DBZ_species.tsv)
  STEPS="<step> ..." only these steps; the others keep what is there
  CIRCULAR=auto|all|none  which sequences are circles (default: auto, the junction test)
  ARM_WINDOW=<bins>  compartments-arms' reach along the arms (default: 50)
  COMPARTMENTS_METHOD=cooltools|correlation
                     what the eigenvectors are taken of (default: cooltools;
                     correlation is Lieberman-Aiden 2009's)
  CLI=<command>      the chromosomix command (default: this checkout's dist-cli build)
  RES_COVERAGE, RES_CISTRANS, RES_PS, RES_DOMAINS, RES_PATTERNS, RES_COMPOSITION, RES_MODEL
TEXT
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac

# Before any map is read, rather than as a failed step in every sample's log.
case "$COMPARTMENTS_METHOD" in
  cooltools|correlation) ;;
  *) printf 'COMPARTMENTS_METHOD is cooltools or correlation, not %s\n' "$COMPARTMENTS_METHOD" >&2; exit 2 ;;
esac
[ -d "$DATA" ] || { printf '%s: no such folder. Set DATA to where the maps are.\n' "$DATA" >&2; exit 2; }
[ -f "$SPECIES" ] || { printf '%s: no such table. Set SPECIES.\n' "$SPECIES" >&2; exit 2; }
command -v "${CLI%% *}" > /dev/null 2>&1 || {
  printf '%s is not on the PATH. Install it, or set CLI to a build of it.\n' "${CLI%% *}" >&2
  exit 2
}
# The junction test is newer than some builds of the command, and a store built
# without it would declare nothing circular without saying why.
case "$(cli circular < /dev/null 2>&1)" in
  *'needs at least one file'*) ;;
  *)
    printf '%s has no `circular` command. Build this checkout'"'"'s with `npm run build:cli`, or set CLI.\n' "$CLI" >&2
    exit 2
    ;;
esac
command -v python3 > /dev/null 2>&1 || { printf 'python3 is not on the PATH; the index needs it.\n' >&2; exit 2; }

mkdir -p "$STORE"
# Spelled one way, so the search below can leave the store out.
DATA=$(cd "$DATA" && pwd -P)
STORE=$(cd "$STORE" && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dbz-store.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

failures=0
summary=()
sample=''
log=/dev/null
held=''

# Whether a step runs this time: every one, or those STEPS names.
want () {
  [ -z "$STEPS" ] && return 0
  case " $STEPS " in *" $1 "*) return 0 ;; esac
  return 1
}

# One step: run it, keep the command and its notes in the sample's log, and
# count a run that failed or wrote nothing. A task handed something that does
# not suit it says so in a note and still exits 0 — over eighty files that is
# the failure nobody sees, so an empty output directory is counted here too.
run_step () {
  local name=$1 out=$2; shift 2
  want "$name" || return 0
  mkdir -p "$out"
  # A step owns its directory, so a re-run replaces its own outputs rather than
  # leaving last week's beside this week's under one name.
  rm -f "$out"/*
  printf '\n$ %s %s --out %s\n' "$CLI" "$*" "$out" >> "$log"
  local status=0
  cli "$@" --out "$out" --quiet < /dev/null >> "$log" 2>&1 || status=$?
  # The bigWig beside it says the same, indexed, and the TSV says it with its
  # provenance: the store keeps those two.
  rm -f "$out"/*.bedGraph
  local wrote
  wrote=$(find "$out" -type f | wc -l | tr -d ' ')
  if [ "$status" -ne 0 ]; then
    printf '  %-17s failed (exit %d) — see %s\n' "$name" "$status" "$log"
    summary+=("$sample/$name: exit $status")
    failures=$((failures + 1))
    return 1
  fi
  if [ "$wrote" -eq 0 ]; then
    printf '  %-17s wrote nothing — see %s\n' "$name" "$log"
    summary+=("$sample/$name: no output")
    failures=$((failures + 1))
    return 1
  fi
  printf '  %-17s %s file(s)\n' "$name" "$wrote"
  return 0
}

# Every resolution an .mcool carries, one per line — read out of the container's
# own refusal for a run with no `::` group, which costs one open and no
# arithmetic. A single cooler has no ladder to list, and `have` then says yes to
# whatever is asked: the file has one resolution and it is the only one there is.
rungs () {
  case "$1" in
    *.mcool) ;;
    *) return 0 ;;
  esac
  cli coverage "$1" --quiet < /dev/null 2>&1 |
    sed -n 's/.*Resolutions found: \[\([^]]*\)\].*/\1/p' |
    tr -d " '" | tr ',' '\n' | sed 's#^/*resolutions/##'
}

have () { [ -z "$held" ] || printf '%s\n' "$held" | grep -qx "$1"; }

skip () {
  want "$1" || return 0
  printf '  %-17s skipped: no %s bp bin size (this file has %s)\n' \
    "$1" "$2" "$(printf '%s' "$held" | tr '\n' ' ')" | tee -a "$log"
  summary+=("$sample/$1: no $2 bp resolution")
}

# A file of $DATA in the store: a hard link, which costs no space and which
# `aws s3 sync` uploads as the file itself; a copy where a link cannot be made
# (another volume); and a gzipped reference decompressed, since the viewer reads
# a bacterial genome whole.
place () {
  local from=$1 target=$2
  [ "$from" -ef "$target" ] && return 0
  case "$from" in
    *.gz)
      [ "$target" -nt "$from" ] && return 0
      gzip -cd "$from" > "$target"
      ;;
    *)
      # A copy made by an earlier run, on another volume, is kept while it is
      # the same size and no older.
      if [ -f "$target" ] && [ ! "$from" -nt "$target" ] &&
        [ "$(wc -c < "$from")" -eq "$(wc -c < "$target")" ]; then
        return 0
      fi
      rm -f "$target"
      ln "$from" "$target" 2> /dev/null || cp -p "$from" "$target"
      ;;
  esac
}

# Every reference under $DATA, found once, one path a line.
find "$DATA" -path "$STORE" -prune -o -type f \( \
  -name '*.fa' -o -name '*.fna' -o -name '*.fasta' -o \
  -name '*.fa.gz' -o -name '*.fna.gz' -o -name '*.fasta.gz' \) -print > "$WORK/references"

# ...and the names of the sequences in each, `<path>\t<name>` a line — read only
# once some sample's reference is not named after it.
reference_names () {
  [ -f "$WORK/names" ] && return 0
  while IFS= read -r path; do
    case "$path" in *.gz) gzip -cd "$path" ;; *) cat "$path" ;; esac 2> /dev/null |
      awk -v path="$path" '/^>/ { name = substr($0, 2); sub(/[ \t].*/, "", name); print path "\t" name }'
  done < "$WORK/references" > "$WORK/names"
}

# The reference a sample's analyses read: the one its row of the species table
# names; else one named after the species — PAK.fa for PAK_MM142 — or after the
# sample; else the one holding the map's longest sequence, by name.
reference_for () {
  local species=$1 sample=$2 named=$3 longest=$4 stem found
  if [ -n "$named" ]; then
    [ -f "$named" ] && { printf '%s' "$named"; return 0; }
    [ -f "$DATA/$named" ] && { printf '%s' "$DATA/$named"; return 0; }
    awk -v want="$named" '{ n = $0; sub(/.*\//, "", n); if (n == want) { print; exit } }' "$WORK/references"
    return 0
  fi
  for stem in "$species" "$sample"; do
    found=$(awk -v want="$stem" '{
      n = $0; sub(/.*\//, "", n); sub(/\.gz$/, "", n); sub(/\.(fa|fna|fasta)$/, "", n)
      if (n == want) { print; exit }
    }' "$WORK/references")
    [ -n "$found" ] && { printf '%s' "$found"; return 0; }
  done
  [ -n "$longest" ] || return 0
  reference_names
  awk -F'\t' -v want="$longest" '$2 == want { print $1; exit }' "$WORK/names"
}

# The origins an Origin and terminus table called, `name:position` 1-based and
# comma-separated, as `--origin` takes them.
origins_of () {
  [ -f "$1" ] || return 0
  awk -F'\t' '
    /^#/ { next }
    !head { for (i = 1; i <= NF; i++) col[$i] = i; head = 1; next }
    $(col["ori"]) ~ /^[0-9]+$/ { printf "%s%s:%s", (n++ ? "," : ""), $(col["sequence"]), $(col["ori"]) }
  ' "$1"
}

# framing.tsv: each sequence of the map, whether every step read it as a circle,
# and the origin its arms were read from — what the index declares in the
# session, so the viewer opens the map framed as its tracks were computed.
write_framing () {
  local junctions=$1 out=$2
  {
    printf '# The framing every step of %s ran with (SPECS §8.15): the sequences read as\n' "$sample"
    printf '# circles (CIRCULAR=%s), and each origin, 1-based, as Origin and terminus called it.\n' "$CIRCULAR"
    printf 'sequence\tlength\tcircular\torigin\n'
    awk -F'\t' -v circular=",$circular," -v origins="$origins" '
      BEGIN {
        n = split(origins, list, ",")
        for (i = 1; i <= n; i++) {
          if (match(list[i], /:[0-9]+$/)) at[substr(list[i], 1, RSTART - 1)] = substr(list[i], RSTART + 1)
        }
      }
      /^#/ { next }
      !head { for (i = 1; i <= NF; i++) col[$i] = i; head = 1; next }
      {
        name = $(col["sequence"])
        printf "%s\t%s\t%s\t%s\n", name, $(col["length"]),
          (index(circular, "," name ",") ? "yes" : "no"), ((name in at) ? at[name] : "")
      }
    ' "$junctions"
  } > "$out"
}

# ---------------------------------------------------------------------------
# One sample at a time
# ---------------------------------------------------------------------------

# The table's rows, the ones named on the command line where some are.
awk -F'\t' 'NF >= 2 && $1 !~ /^#/ && $2 != "" { print }' "$SPECIES" |
  if [ "$#" -gt 0 ]; then
    awk -F'\t' -v wanted=" $* " 'index(wanted, " " $2 " ")'
  else
    cat
  fi > "$WORK/samples"
[ -s "$WORK/samples" ] || { printf 'No sample of %s to run.\n' "$SPECIES" >&2; exit 2; }

while IFS=$'\t' read -r species sample named _ <&3 || [ -n "${sample:-}" ]; do
  species=$(printf '%s' "$species" | tr -d '\r'); sample=$(printf '%s' "$sample" | tr -d '\r')
  named=$(printf '%s' "${named:-}" | tr -d '\r')
  map=$(find "$DATA" -path "$STORE" -prune -o -type f -name "$sample.mcool" -print | head -1)
  if [ -z "$map" ]; then
    printf '\n=== %s: no %s.mcool under %s\n' "$sample" "$sample" "$DATA"
    summary+=("$sample: no map"); failures=$((failures + 1)); sample=''; continue
  fi

  dir=$STORE/$sample
  mkdir -p "$dir"
  log=$dir/run.log
  if [ -z "$STEPS" ]; then : > "$log"; else printf '\n=== STEPS=%s\n' "$STEPS" >> "$log"; fi
  printf '\n=== %s -> %s\n' "$map" "$dir"
  file=$dir/$sample.mcool
  place "$map" "$file"
  held=$(rungs "$file")

  # -------------------------------------------------------------------------
  # Coverage, cis and trans, at 500 bp. Unbalanced, so a cis fraction is a
  # fraction of counted contacts rather than of balanced weight — and the one
  # step no framing changes, marginals being neither windowed nor distance-aware.
  # -------------------------------------------------------------------------
  if have "$RES_COVERAGE"; then
    run_step coverage "$dir/coverage" \
      coverage "$file::/resolutions/$RES_COVERAGE" \
      --no-balance --total --fraction --cis --trans
  else
    skip coverage "$RES_COVERAGE"
  fi

  # -------------------------------------------------------------------------
  # The framing every other step of this sample shares: which sequences are
  # circles. The junction test also lists every sequence with its length, which
  # is where the names come from.
  # -------------------------------------------------------------------------
  junctions=$dir/circular/${sample}_${RES_PATTERNS}.circular.tsv
  names=''; tested=''
  if have "$RES_PATTERNS"; then
    mkdir -p "$dir/circular"
    printf '\n$ %s circular %s\n' "$CLI" "$file::/resolutions/$RES_PATTERNS" >> "$log"
    if cli circular "$file::/resolutions/$RES_PATTERNS" --quiet < /dev/null > "$junctions" 2>> "$log"; then
      names=$(awk -F'\t' '!/^#/ && $1 != "sequence" { print $1 }' "$junctions" | paste -sd, -)
      tested=$(awk -F'\t' '!/^#/ && $4 == "yes" { print $1 }' "$junctions" | paste -sd, -)
    else
      printf '  %-17s failed — see %s\n' circular "$log"
      summary+=("$sample/circular: the junction test failed"); failures=$((failures + 1))
      rm -f "$junctions"
    fi
  else
    printf '  %-17s skipped: no %s bp bin size to test at\n' circular "$RES_PATTERNS" | tee -a "$log"
    summary+=("$sample/circular: no $RES_PATTERNS bp resolution")
  fi
  case "$CIRCULAR" in
    auto) circular=$tested ;;
    all) circular=$names ;;
    *) circular='' ;;
  esac
  frame=()
  [ -n "$circular" ] && frame=(--circular "$circular")
  printf '  %-17s %s\n' circular "${circular:-none}" | tee -a "$log"

  # -------------------------------------------------------------------------
  # The reference, beside the map. It phases the compartment eigenvectors by
  # GC content — without one, E1's sign is arbitrary per sample and the tracks
  # cannot be compared across species — and it is what the sequence tracks and
  # the origin are read from.
  # -------------------------------------------------------------------------
  longest=$( [ -f "$junctions" ] &&
    awk -F'\t' '!/^#/ && $2 ~ /^[0-9]+$/ && $2 + 0 > most { most = $2 + 0; name = $1 } END { print name }' "$junctions")
  found=$(reference_for "$species" "$sample" "$named" "$longest")
  reference=''
  if [ -n "$found" ]; then
    reference=$(basename "$found"); reference=$dir/${reference%.gz}
    for other in "$dir"/*.fa "$dir"/*.fna "$dir"/*.fasta; do
      [ -e "$other" ] && [ "$other" != "$reference" ] && rm -f "$other"
    done
    place "$found" "$reference"
    printf '  %-17s %s\n' reference "${found#"$DATA"/}" | tee -a "$log"
  else
    printf '  %-17s none under %s: no sequence tracks, no origin call\n' reference "$DATA" | tee -a "$log"
    summary+=("$sample: no reference; E1's arms read from the first base")
  fi

  # -------------------------------------------------------------------------
  # The sequence tracks: GC content, GC and AT skews and the cumulative GC skew,
  # on the bins the compartments are on.
  # -------------------------------------------------------------------------
  if [ -n "$reference" ]; then
    if have "$RES_COMPOSITION"; then
      run_step composition "$dir/composition" \
        composition "$file::/resolutions/$RES_COMPOSITION" \
        --sequence "$reference" ${frame[@]+"${frame[@]}"}
    else
      skip composition "$RES_COMPOSITION"
    fi
  fi

  # -------------------------------------------------------------------------
  # The origin and terminus of replication: the turning points of the
  # cumulative GC skew, told apart by the parS and matS sites and, failing
  # both, by the coverage just written. The origins it calls are what every
  # step reading a chromosome's two arms reads them from.
  # -------------------------------------------------------------------------
  if [ -n "$reference" ]; then
    if have "$RES_PATTERNS"; then
      coverage=()
      total=$(find "$dir/coverage" -name '*.coverage-total.bw' 2> /dev/null | head -1)
      [ -n "$total" ] && coverage=(--coverage "$total")
      run_step oriter "$dir/oriter" \
        oriter "$file::/resolutions/$RES_PATTERNS" \
        --sequence "$reference" ${coverage[@]+"${coverage[@]}"} ${frame[@]+"${frame[@]}"}
    else
      skip oriter "$RES_PATTERNS"
    fi
  fi
  origins=''
  [ -n "$reference" ] && origins=$(origins_of "$(find "$dir/oriter" -name '*.oriter.oriter-table.tsv' 2> /dev/null | head -1)")
  arms=()
  [ -n "$origins" ] && arms=(--origin "$origins")
  printf '  %-17s %s\n' origin "${origins:-the first base of each sequence}" | tee -a "$log"
  rm -f "$dir/framing.tsv"
  [ -f "$junctions" ] && write_framing "$junctions" "$dir/framing.tsv"

  # -------------------------------------------------------------------------
  # The cis/trans table per sequence. `--matrix` would add the
  # sequence-by-sequence contact table beside it, which is worth having on a
  # genome of several replicons; it is off here, as in the original.
  # -------------------------------------------------------------------------
  if have "$RES_CISTRANS"; then
    run_step cistrans "$dir/cistrans" \
      cistrans "$file::/resolutions/$RES_CISTRANS" \
      ${frame[@]+"${frame[@]}"} --bars both --normalise enrichment \
      --minContacts 10 --maxEdges 500 --matrix=false
  else
    skip cistrans "$RES_CISTRANS"
  fi

  # -------------------------------------------------------------------------
  # P(s) per sequence, with its log-log slope beside it.
  # -------------------------------------------------------------------------
  if have "$RES_PS"; then
    run_step ps "$dir/ps" \
      expected "$file::/resolutions/$RES_PS" \
      ${frame[@]+"${frame[@]}"} --scope contig --quantity density \
      --factor 1.1 --minSeparation 0 --derivative --stranded=false
  else
    skip ps "$RES_PS"
  fi

  # -------------------------------------------------------------------------
  # Diamond insulation and the directionality index, each with its calls and
  # the domains between them. The prominences are in each score's own units.
  # -------------------------------------------------------------------------
  if have "$RES_DOMAINS"; then
    run_step insulation "$dir/insulation" \
      insulation "$file::/resolutions/$RES_DOMAINS" \
      ${frame[@]+"${frame[@]}"} --window 10 --scales 1 \
      --ignoreDiags 2 --minValid 0.5 --call --prominence 0.2 --spacing 0 --domains

    run_step di "$dir/di" \
      di "$file::/resolutions/$RES_DOMAINS" \
      ${frame[@]+"${frame[@]}"} --window 10 \
      --ignoreDiags 0 --minValid 0.5 --call --prominence 10 --spacing 0 --domains
  else
    skip insulation "$RES_DOMAINS"
    skip di "$RES_DOMAINS"
  fi

  if ! have "$RES_PATTERNS"; then
    for step in hicscore compartments compartments-arms interarm loops borders apa-loops apa-borders; do
      skip "$step" "$RES_PATTERNS"
    done
  else
    # -----------------------------------------------------------------------
    # HiC score and compartments, over the whole file rather than one window:
    # a locus from one session is a locus one genome of eighty has.
    # -----------------------------------------------------------------------
    run_step hicscore "$dir/hicscore" \
      hicscore "$file::/resolutions/$RES_PATTERNS" \
      ${frame[@]+"${frame[@]}"} --diagonals 3 --ignoreDiags 0 --minValid 0.5

    # GC content signs each component and chooses none of them: E1 is the
    # largest eigenvalue's, so comparing GC content between the compartments it
    # calls is not comparing GC content with itself.
    # Cis contacts are the task's default and are left to it: on the command line
    # `--contacts` is the number of contacts a map is drawn to (§6.5), which
    # refuses `cis`, and both compartment steps failed on it.
    phase=()
    [ -n "$reference" ] && phase=(--sequence "$reference" --phaseSequence "$reference")
    run_step compartments "$dir/compartments" \
      compartments "$file::/resolutions/$RES_PATTERNS" \
      ${frame[@]+"${frame[@]}"} ${phase[@]+"${phase[@]}"} \
      --ignoreDiags 2 --components 3 --minR 0.1 --saddle=false \
      --method "$COMPARTMENTS_METHOD"

    # -----------------------------------------------------------------------
    # The same, over the decay along both arms. A chromosome whose arms are
    # held together from the origin has a second diagonal through it, which
    # the distance decay leaves in the ratio as an X that the eigenvectors
    # then follow: the arms, and not the compartments. This expectation
    # removes both diagonals, reading the arms from the origins called above;
    # its E1 is the eigenvector the session opens with.
    # -----------------------------------------------------------------------
    run_step compartments-arms "$dir/compartments-arms" \
      compartments "$file::/resolutions/$RES_PATTERNS" \
      ${frame[@]+"${frame[@]}"} ${arms[@]+"${arms[@]}"} ${phase[@]+"${phase[@]}"} \
      --ignoreDiags 2 --components 3 --minR 0.1 --saddle=false \
      --expected arms --armWindow "$ARM_WINDOW" --method "$COMPARTMENTS_METHOD"

    # -----------------------------------------------------------------------
    # How strongly the two arms are aligned, and how far from the origin: the
    # secondary diagonal, measured over each sequence's own distance decay.
    # -----------------------------------------------------------------------
    run_step interarm "$dir/interarm" \
      interarm "$file::/resolutions/$RES_PATTERNS" \
      ${frame[@]+"${frame[@]}"} ${arms[@]+"${arms[@]}"}

    # -----------------------------------------------------------------------
    # Loops and borders: two runs of one task, so two directories.
    # -----------------------------------------------------------------------
    run_step loops "$dir/loops" \
      chromosight "$file::/resolutions/$RES_PATTERNS" \
      ${frame[@]+"${frame[@]}"} --pattern loops --thresholds preset --pearson 0.3 \
      --minDist 10 --maxDist 1000 --minSeparation 3 --iterations 1 \
      --maxPercUndetected 50 --maxPercZero 10 --nMads 5 --maxQvalue 1

    run_step borders "$dir/borders" \
      chromosight "$file::/resolutions/$RES_PATTERNS" \
      ${frame[@]+"${frame[@]}"} --pattern borders --thresholds preset --pearson 0.3 \
      --minDist 10 --maxDist 1000 --minSeparation 3 --iterations 1 \
      --maxPercUndetected 50 --maxPercZero 10 --nMads 5 --maxQvalue 1

    # -----------------------------------------------------------------------
    # The pileup at each of those sets. The calls are handed over as files:
    # nothing carries a result from one run into the next, and an APA with no
    # set piles up nothing, says so in a note, and exits 0.
    #
    # Under `--norm chromosight` the window is the template's own size and the
    # control is the map's own distance law, so the window, grid, flank, mode,
    # shifted-control, seed and ranking flags are never read. They are left out
    # here rather than written and ignored.
    # -----------------------------------------------------------------------
    if want apa-loops; then
      calls=$(find "$dir/loops" -name '*.chromosight-patterns.bedpe' 2> /dev/null | head -1)
      if [ -n "$calls" ] && [ "$(grep -vc '^#' "$calls")" -gt 0 ]; then
        run_step apa-loops "$dir/apa-loops" \
          apa "$file::/resolutions/$RES_PATTERNS" \
          ${frame[@]+"${frame[@]}"} --pairs "$calls" --anchors pairs \
          --norm chromosight --csPattern loops
      else
        printf '  %-17s skipped: no loop was called\n' apa-loops | tee -a "$log"
      fi
    fi

    if want apa-borders; then
      calls=$(find "$dir/borders" -name '*.chromosight-patterns.bed' 2> /dev/null | head -1)
      if [ -n "$calls" ] && [ "$(grep -vc '^#' "$calls")" -gt 0 ]; then
        run_step apa-borders "$dir/apa-borders" \
          apa "$file::/resolutions/$RES_PATTERNS" \
          ${frame[@]+"${frame[@]}"} --features "$calls" --anchors features --at centre \
          --norm chromosight --csPattern borders
      else
        printf '  %-17s skipped: no border was called\n' apa-borders | tee -a "$log"
      fi
    fi
  fi

  # -------------------------------------------------------------------------
  # The 3D model, which leaves as a bed3d: chrom start end x y z.
  # -------------------------------------------------------------------------
  if have "$RES_MODEL"; then
    run_step model3d "$dir/model3d" \
      reconstruct3d "$file::/resolutions/$RES_MODEL" \
      ${frame[@]+"${frame[@]}"} --method nb --alpha 3 --iterations 150
  else
    skip model3d "$RES_MODEL"
  fi
  sample=''
done 3< "$WORK/samples"

# ---------------------------------------------------------------------------
# The index: every file of every species the store holds, and the sessions.
# ---------------------------------------------------------------------------

printf '\n=== index\n'
python3 "$HERE/DBZ_store.py" index "$STORE" --species "$SPECIES" --resolution "$RES_PATTERNS" ||
  { summary+=("store.chromosomix.json: the index reported a problem"); failures=$((failures + 1)); }

printf '\n=== %d step(s) to look at, %d of them a failure\n' \
  "${#summary[@]}" "$failures"
for line in ${summary[@]+"${summary[@]}"}; do printf '  %s\n' "$line"; done
[ "$failures" -eq 0 ]
