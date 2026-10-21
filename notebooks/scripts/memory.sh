#!/usr/bin/env bash
#
# A command, run with the machine's memory written beside its output every ten seconds, or every
# MEMORY_EVERY:
#
#   bash notebooks/scripts/memory.sh quarto render notebooks/validation.qmd
#   MEMORY_EVERY=2 bash notebooks/scripts/memory.sh quarto render notebooks/laptop.qmd
#
# A GitHub runner whose memory runs out is shut down in the middle of a step ("The runner has
# received a shutdown signal"): the command reports no error, no step after it runs, `if: always()`
# or not, and the log streamed until then is all that is left. These lines are in it. Each says how
# much of the memory is in use and how much is available (/proc/meminfo's MemAvailable), the swap in
# use, and the three programs holding the most, each one's processes' resident sets added up — pages
# they share counted once in each, so a pool of forked workers reads as more than it holds.
#
# They go to stdout, and Quarto writes its own lines, its cells' progress among them, to stderr: the
# runner reads the two apart, a line at a time, so a sample never lands inside a cell's
# "Cell 16/84: ''....Done". Where there is no /proc/meminfo, as on a Mac, the command runs alone.
# The command's exit status is this script's.
set -euo pipefail

every="${MEMORY_EVERY:-10}"

if [ ! -r /proc/meminfo ]; then
  exec "$@"
fi

sample() {
  # Stopped, it stops its sleep: one left behind would hold the step's output open until it woke.
  nap=''
  trap '[ -z "$nap" ] || kill "$nap"; exit 0' TERM
  awk -v every="$every" -v cores="$(nproc)" \
    '/^MemTotal:/ { printf "memory: every %s s, of %d MB on %d cores\n", every, $2 / 1024, cores; exit }' /proc/meminfo
  while :; do
    sleep "$every" &
    nap=$!
    wait "$nap" || true
    {
      awk -v now="$(date -u +%H:%M:%S)" \
        '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { available = $2 }
         /^SwapTotal:/ { swap = $2 } /^SwapFree:/ { free = $2 }
         END { printf "memory %s: %d MB used, %d available, %d swapped",
               now, (total - available) / 1024, available / 1024, (swap - free) / 1024 }' /proc/meminfo
      ps -eo rss=,comm= \
        | awk '{ rss = $1; sub(/^ *[0-9]+ +/, ""); held[$0] += rss; count[$0]++ }
               END { for (name in held) printf "%d\t%s\t%d\n", held[name] / 1024, name, count[name] }' \
        | sort -rn | head -n 3 \
        | awk -F '\t' '{ printf("%s %s%s %d MB", (NR == 1 ? ";" : ","), $2, ($3 > 1 ? " x" $3 : ""), $1) }'
      echo
    } || true
  done
}

sample &
sampler=$!
trap 'kill "$sampler" 2> /dev/null || true' EXIT

"$@"
