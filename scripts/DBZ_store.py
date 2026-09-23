#!/usr/bin/env python3
"""Gather hic-suite.sh's results into the DNA Bacterial Zoo, the viewer's `dbz` store.

    python3 scripts/DBZ_store.py build ~/Downloads/Martial_DBZ
    python3 scripts/DBZ_store.py serve ~/Downloads/Martial_DBZ/store
    aws s3 sync ~/Downloads/Martial_DBZ/store/ s3://rsglab-data/dbz/ --delete

The viewer ships a tile for it (``DBZ_STORE`` in ``src/ui/stores/registry.ts``)
that reads ``https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.json``, so
publishing it is the sync above: the folder goes up as it is, names and all.

``build`` reads ``cool/`` and ``results/`` under the folder it is given and
writes ``store/`` beside them::

    store/
      store.json                                   the store (SPECS §24.1)
      <sample>/<sample>.mcool                      the map every result came from
      <sample>/<sample>.metacooler.json            a session: the map with eight tracks placed, and its model
      <sample>/model3d/…reconstructed-model.bed3d  the 3D model, where the step wrote one
      <sample>/<step>/<sample>_<bp>.<task>.<output>.bw|bed|bedpe

The store asks to be drawn as cards, one per species like IGV's genomes: the
session is the card's button and the map and its tracks are under its fold.

Every name in the store and in the sessions is relative, so the folder is
self-contained: served from this machine or copied to a bucket, it opens the
same way (SPECS §24.1, §21.1). Files are **hard links** into ``cool/`` and
``results/`` — no second copy of a gigabyte of maps, and unlike a symlink a
hard link survives ``aws s3 sync`` and ``rsync -a`` as the file itself. Re-run
``build`` after hic-suite.sh has run again: a re-run step writes new files, and
the store keeps the old ones until it is rebuilt.

What goes in is what the viewer opens: each map, every bigWig, BED and BEDPE a
step wrote, and the 3D model where the step wrote one as a bed3d — which
``metacooler-run`` does since it stopped writing models as a BED of their bins
alone (§25.7); a sample whose ``model3d/`` holds only that older BED has no
model here until the step is rerun. Left in ``results/``: the bedGraphs (the
bigWig beside each says the same thing, indexed) and the TSVs (P(s), cis/trans,
pileups — tables this viewer does not open).

``serve`` is for looking at it before it goes anywhere: a static server with
the two things the viewer needs of a host — byte ranges and a cross-origin
``GET`` — which ``python3 -m http.server`` does not give.

Standard library only, and ``make_store.py`` beside this file writes the
sessions, so they are the shape the generated IGV/4DN/ENCODE sessions are.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sys
import urllib.parse
from collections import Counter
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_store  # noqa: E402  (a sibling script, not a package)

HERE = Path(__file__).resolve().parent
SPECIES = HERE / "DBZ_species.tsv"

#: The steps whose outputs become rows, in the order they are listed under a
#: species, with the name the Analysis facet gives each.
STEPS = {
    "coverage": "Coverage",
    "insulation": "Insulation",
    "di": "Directionality index",
    "hicscore": "HiC score",
    "compartments": "Compartments",
    "borders": "Borders",
    "loops": "Loops",
    "model3d": "3D model",
}

#: What the viewer opens, by suffix, and what the Format facet calls it.
FORMATS = {".bw": "bigWig", ".bed": "BED", ".bedpe": "BEDPE", ".bed3d": "bed3d"}

#: The tracks a species' session opens with, top to bottom under the map: the
#: coverage (where the map is thin), the two domain scores with insulation's
#: calls, the HiC score, E1, and chromosight's borders and loops — the loops on
#: the map itself, a BEDPE being a pair of loci. The other nine outputs are on
#: the map's shelf and in the store as rows of their own.
SESSION_TRACKS = (
    "coverage.coverage-total.bw",
    "insulation.insulation-w10.bw",
    "insulation.insulation-boundaries.bed",
    "di.di-w10.bw",
    "hicscore.hicscore-d3.bw",
    "compartments.compartment-e1.bw",
    "chromosight.chromosight-patterns.bed",
    "chromosight.chromosight-patterns.bedpe",
    # …and the model, in a cell beside the map, where the sample has one.
    "reconstruct3d.reconstructed-model.bed3d",
)

#: hic-suite.sh's RES_PATTERNS: the bin size a session opens its map at.
PATTERNS_BP = 4000

COLUMNS = [
    {"key": "analysis", "label": "Analysis"},
    {"key": "format", "label": "Format"},
    {"key": "resolution", "label": "Resolution"},
    {"key": "sequences", "label": "Sequences"},
    {"key": "species", "label": "Species"},
    {"key": "id", "label": "Sample ID"},
]


# ---------------------------------------------------------------------------
# Reading results/
# ---------------------------------------------------------------------------


def read_species(path: Path) -> list[tuple[str, str]]:
    """``(species, sample)`` pairs, in the table's order. The last line may lack its newline."""
    rows = []
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.reader(handle, delimiter="\t"):
            if len(row) >= 2 and row[0].strip() and not row[0].startswith("#"):
                rows.append((row[0].strip(), row[1].strip()))
    return rows


def provenance(path: Path) -> dict[str, str]:
    """The ``# key: value`` lines at the head of a metacooler-run TSV."""
    held: dict[str, str] = {}
    if not path.exists():
        return held
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.startswith("#"):
                break
            match = re.match(r"# ([\w ]+?): (.*)$", line.rstrip("\n"))
            if match:
                held.setdefault(match.group(1), match.group(2))
            elif line.startswith("# metacooler "):
                held.setdefault("producer", line[len("# metacooler "):].strip())
    return held


def called(path: Path) -> int:
    """How many intervals a BED or BEDPE holds, its comment lines aside."""
    with path.open(encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip() and not line.startswith("#"))


def genome_of(sample_dir: Path) -> dict[str, int]:
    """Sequence lengths, from the coverage track's last bin on each — the one place they are written."""
    lengths: dict[str, int] = {}
    for path in sample_dir.glob("coverage/*.coverage-total.bedGraph"):
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(("#", "track")):
                    continue
                cells = line.split("\t")
                if len(cells) >= 3:
                    lengths[cells[0]] = max(lengths.get(cells[0], 0), int(cells[2]))
    return lengths


def bp(value: int) -> str:
    """``500 bp``, ``4 kb``, ``1.2 Mb`` — §26.2's spelling of a length."""
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f} Mb"
    if value >= 1_000:
        return f"{value / 1_000:g} kb"
    return f"{value} bp"


def placed(source: Path, target: Path, copy: bool) -> None:
    """*target* as a hard link to *source*, or a copy where a link cannot be made."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if not copy:
        try:
            os.link(source, target)
            return
        except OSError:
            pass  # another volume, or a filesystem without links
    shutil.copy2(source, target)


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def build(root: Path, species_table: Path, copy: bool) -> int:
    cool, results, store_dir = root / "cool", root / "results", root / "store"
    table = read_species(species_table)
    repeated = {name for name, count in Counter(name for name, _ in table).items() if count > 1}
    created = make_store.now_iso()
    store_dir.mkdir(exist_ok=True)

    sessions: list[dict] = []
    maps: list[dict] = []
    tracks: list[dict] = []
    skipped: list[str] = []
    producers: set[str] = set()
    circular = 0
    models = 0

    for species, sample in table:
        mcool = cool / f"{sample}.mcool"
        sample_dir = results / sample
        if not mcool.exists() or not sample_dir.is_dir():
            skipped.append(f"{sample}: no {'map' if not mcool.exists() else 'results'}")
            continue
        # A species run twice (two libraries) is told apart by what follows its name.
        label = species
        if species in repeated:
            label = f"{species} ({sample[len(species) + 1:] if sample.startswith(species + '_') else sample})"

        out = store_dir / sample
        if out.exists():
            shutil.rmtree(out)  # only links and the session this script wrote
        placed(mcool, out / mcool.name, copy)

        lengths = genome_of(sample_dir)
        run_log = sample_dir / "run.log"
        if run_log.exists() and "  circular: " in run_log.read_text(encoding="utf-8"):
            circular += 1
        # What tells two samples of a species apart: the sample name less the species.
        tail = sample[len(species) + 1:] if sample.startswith(species + "_") else ""
        common = {
            "species": label,
            **({"id": tail} if tail else {}),
            **({"sequences": f"{len(lengths)} sequence{'s' if len(lengths) != 1 else ''}"} if lengths else {}),
        }

        shelf: list[dict] = []
        for step, analysis in STEPS.items():
            for path in sorted((sample_dir / step).glob("*")):
                fmt = FORMATS.get(path.suffix)
                # The model step's BED is the model's bins without their
                # coordinates, from before the shell wrote a bed3d: nothing to draw.
                if fmt is None or (step == "model3d" and fmt != "bed3d"):
                    continue
                count = called(path) if fmt != "bigWig" else None
                if count == 0:
                    skipped.append(f"{sample}/{step}/{path.name}: no calls")
                    continue
                facts = provenance(path.with_suffix(".tsv"))
                producers.add(facts.get("producer", ""))
                title = facts.get("output") or path.stem.split(".", 1)[-1]
                binsize = re.search(r"_(\d+)\.[^.]+\.[^.]+\.[^.]+$", path.name)
                relative = f"{sample}/{step}/{path.name}"
                placed(path, store_dir / relative, copy)
                note = " · ".join(
                    piece
                    for piece in (
                        ""
                        if count is None
                        else f"{count:,} beads"
                        if fmt == "bed3d"
                        else f"{count:,} called",
                        facts.get("task", ""),
                        facts.get("framing", ""),
                    )
                    if piece
                )
                tracks.append(
                    {
                        "label": f"{label} · {title}",
                        "uri": relative,
                        "kind": "genome",
                        "size": path.stat().st_size,
                        "note": note,
                        "fields": {
                            "analysis": analysis,
                            "format": fmt,
                            **({"resolution": bp(int(binsize.group(1)))} if binsize else {}),
                            **common,
                        },
                    }
                )
                shelf.append({"label": title, "url": relative, "key": path.name.split(".", 1)[-1]})

        # The session: the map, eight of its tracks and its model, named relative to the
        # session's own folder, which is where the viewer resolves them (§21.1).
        chosen = [
            {"label": track["label"], "url": track["url"].split("/", 1)[1]}
            for key in SESSION_TRACKS
            for track in shelf
            if track["key"] == key
        ]
        model = any(track["url"].endswith(".bed3d") for track in chosen)
        models += model
        lanes = len(chosen) - (1 if model else 0)
        document = make_store.session_document(
            name=label, uri=mcool.name, tracks=chosen, created=created
        )
        # The whole matrix rather than the chromosome list make_store opens a
        # map on: a bacterial genome is a few megabases, and its map with the
        # tracks under it is the picture. At the patterns' bin size, which
        # every sample with a HiC score has; the finest rung whole would be a
        # dense read the size guard refuses (§9).
        if any(track["key"].startswith("hicscore.") for track in shelf):
            # Updated rather than replaced: `maps` says a model's cell opens.
            document["tabs"][0]["state"].update(
                uri=f"{mcool.name}::resolutions/{PATTERNS_BP}",
                view="whole",
            )
        session_path = out / f"{sample}.metacooler.json"
        session_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

        size = sum(lengths.values())
        sessions.append(
            {
                "label": f"{label} — map with {lanes} tracks{' and its 3D model' if model else ''}",
                "uri": f"{sample}/{session_path.name}",
                "kind": "workspace",
                "note": ", ".join(track["label"] for track in chosen),
                # No format: the row's icon says workspace, and a chip reading
                # *session* beside one reading *Session* says it twice.
                # `tracks` is the count a card's chip says (§24.2), as on IGV's sessions.
                "fields": {"analysis": "Session", "tracks": str(lanes), **common},
            }
        )
        maps.append(
            {
                "label": label,
                "uri": f"{sample}/{mcool.name}",
                "kind": "map",
                "size": mcool.stat().st_size,
                "note": " · ".join(
                    piece
                    for piece in (
                        f"{bp(size)} over {len(lengths)} sequence{'s' if len(lengths) != 1 else ''}"
                        if lengths
                        else "",
                        mcool.name,
                    )
                    if piece
                ),
                "fields": {"analysis": "Contact map", "format": "mcool", **common},
                "tracks": [{"label": track["label"], "url": track["url"]} for track in shelf],
            }
        )

    samples = len(maps)
    if samples == 0:
        print("Nothing to publish: no sample in the table has both a map and results.", file=sys.stderr)
        return 2
    framing = (
        "every sequence declared circular"
        if circular == samples
        else "every sequence read as linear"
        if circular == 0
        else f"{circular} of {samples} samples declared circular"
    )
    producer = ", ".join(sorted(p for p in producers if p)) or "metacooler-run"
    store = {
        "kind": make_store.STORE_KIND,
        "version": make_store.STORE_VERSION,
        "name": "DNA Bacterial Zoo",
        "description": (
            f"hic-suite.sh over {samples} bacterial Hi-C maps: each map, a session opening it with "
            "eight of its tracks, and every track on its own — coverage, insulation, directionality "
            "index, HiC score, compartments, and chromosight's borders and loops"
            + (f"; a 3D model for {models} of them" if models else "")
            + f". Analyses ran with {framing}."
        ),
        "generatedAt": created,
        "source": f"{root.name}/results, written by hic-suite.sh with {producer}",
        # One card per species, as IGV's genomes are: its session the button,
        # its sample ID and replicon count the chips, its files under a fold.
        "layout": "cards",
        "group": "species",
        "headline": ["id", "sequences"],
        "columns": COLUMNS,
        # Sessions first, then maps, then every track: unfiltered, the first
        # screen is one row per species that opens it whole.
        "entries": sessions + maps + tracks,
    }
    out = store_dir / "store.json"
    out.write_text(json.dumps(store, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # make_store's checks, less two rules that are its own portals' and not the
    # viewer's: an order by assembly and label, and absolute session names — a
    # session published *beside* its data is resolved against its own URL.
    problems = [
        problem
        for problem in make_store.check_store(out)
        if "sorts before the entry above it" not in problem
    ]
    for session in sorted(store_dir.glob("*/*.metacooler.json")):
        problems += [
            f"{session.name}: {problem}"
            for problem in make_store.check_session(session)
            if "not absolute" not in problem and "relative url" not in problem
        ]
    stale = sorted(
        path.name
        for path in store_dir.iterdir()
        if path.is_dir() and path.name not in {sample for _, sample in table}
    )

    print(
        f"{out}: {len(sessions)} sessions, {len(maps)} maps, {len(tracks)} tracks "
        f"({'copied' if copy else 'hard-linked'} from cool/ and results/)"
    )
    for line in skipped:
        print(f"  left out  {line}")
    for name in stale:
        print(f"  stale     store/{name}/ is no longer in {species_table.name}; remove it by hand")
    for problem in problems:
        print(f"  PROBLEM   {problem}", file=sys.stderr)
    return 1 if problems else 0


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------


class RangeHandler(SimpleHTTPRequestHandler):
    """Static files with byte ranges and CORS: what the viewer asks of any host (SPECS §11)."""

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, ETag")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        # Chrome asks before a public page (the deployed viewer) reads a local address.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_head(self):  # type: ignore[override]
        wanted = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        if wanted is None or not path.is_file():
            return super().send_head()
        total = path.stat().st_size
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", wanted.strip())
        if match is None or match.groups() == ("", ""):
            return super().send_head()
        first, last = match.groups()
        if first == "":
            start, end = max(0, total - int(last)), total - 1
        else:
            start = int(first)
            end = min(int(last), total - 1) if last else total - 1
        if start >= total or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        handle = path.open("rb")
        handle.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return handle

    def copyfile(self, source, outputfile) -> None:  # type: ignore[override]
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(1 << 20, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        self._remaining = None

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def serve(folder: Path, host: str, port: int) -> int:
    handler = lambda *a, **k: RangeHandler(*a, directory=str(folder), **k)  # noqa: E731
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host}:{port}/store.json"
    quoted = urllib.parse.quote(url, safe="")
    print(f"Serving {folder} at {url}")
    print(f"  deployed viewer   https://js2264.github.io/metacooler.js/?store={quoted}")
    print(f"  npm run dev       http://localhost:5173/?store={quoted}")
    print("  or paste the URL under Add a custom store. Ctrl-C stops.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("build", help="write <root>/store/ from <root>/cool and <root>/results")
    one.add_argument("root", type=Path, help="the folder holding cool/ and results/")
    one.add_argument("--species", type=Path, default=SPECIES, help=f"species<TAB>sample table (default: {SPECIES.name})")
    one.add_argument("--copy", action="store_true", help="copy the files rather than hard-linking them")
    two = commands.add_parser("serve", help="serve a store folder with byte ranges and CORS")
    two.add_argument("folder", type=Path)
    two.add_argument("--host", default="127.0.0.1")
    two.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if args.command == "build":
        return build(args.root.expanduser().resolve(), args.species, args.copy)
    return serve(args.folder.expanduser().resolve(), args.host, args.port)


if __name__ == "__main__":
    raise SystemExit(main())
