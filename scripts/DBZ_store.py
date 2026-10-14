#!/usr/bin/env python3
"""Index the DNA Bacterial Zoo — the viewer's `dbz` store — in the folder it was written to.

    scripts/dbz-store.sh                     the analyses, into store/, and then this
    python3 scripts/DBZ_store.py index ~/Downloads/metacooler/data/dbz/store
    python3 scripts/DBZ_store.py serve ~/Downloads/metacooler/data/dbz/store
    aws s3 sync ~/Downloads/metacooler/data/dbz/store/ s3://rsglab-data/dbz/ --delete \\
        --exclude '*.tsv' --exclude '*.log'

The viewer ships a tile for it (``DBZ_STORE`` in ``src/ui/stores/registry.ts``)
that reads ``https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.chromosomix.json``, so
publishing it is the sync above: the folder goes up as it is, names and all.

``scripts/dbz-store.sh`` writes every step of every sample straight into the
store's folder for it, and ``index`` reads that folder as it stands::

    store/
      store.chromosomix.json                       the store (SPECS §24.1): written here
      <sample>/<sample>.mcool                      the map every result came from
      <sample>/<species>.fa                        its reference
      <sample>/<sample>.chromosomix.json           its session: written here
      <sample>/framing.tsv                         the circles and origins every step ran with
      <sample>/<step>/<sample>_<bp>.<task>.<output>.bw|bed|bedpe|bed3d|tsv

The store asks to be drawn as cards, one per species like IGV's genomes: the
session is the card's button, and the map, its reference and its tracks are
under its fold.

**Every file the viewer opens is a row**: each map, its reference, and every
bigWig, BED, BEDPE and bed3d a step wrote. The TSVs are not — P(s), cis/trans,
the pileups, the component and origin tables: tables this viewer does not open
— and they stay out of the published copy with the logs (the sync's excludes).

**A session opens on three tracks and nothing else**: the map, whole at the
patterns' bin size, and under it its HiC score, its insulation score and E1 over
the decay along both arms — no overlay, no calls, no model; everything else is
on the map's shelf. It declares what the analyses ran with (``framing.tsv``):
the sequences read as circles, and each origin, so the Chromosomes table, the
``ori`` button and any task rerun in the viewer read the arms from where E1's
were read (SPECS §8.15).

Every name in the store and in the sessions is relative, so the folder is
self-contained: served from this machine or copied to a bucket, it opens the
same way (SPECS §24.1, §21.1).

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
import re
import sys
import urllib.parse
from collections import Counter
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_store  # noqa: E402  (a sibling script, not a package)

HERE = Path(__file__).resolve().parent
SPECIES = HERE / "DBZ_species.tsv"
#: The index, beside the `store.json` the build before the rename reads: its kind
#: (`chromosomix.store`) is one that build refuses, and the zoo is published by a sync of
#: the whole folder, so a second name is what lets it go up before the site carries the
#: rename. Each build reads its own; the old file goes once that site is gone.
INDEX = "store.chromosomix.json"

#: The steps whose outputs become rows, in the order they are listed under a
#: species, with the name the Analysis facet gives each.
STEPS = {
    "composition": "Base composition",
    "oriter": "Origin and terminus",
    "coverage": "Coverage",
    "insulation": "Insulation",
    "di": "Directionality index",
    "hicscore": "HiC score",
    "compartments-arms": "Compartments along both arms",
    "compartments": "Compartments",
    "interarm": "Inter-arm alignment",
    "borders": "Borders",
    "loops": "Loops",
    "model3d": "3D model",
}

#: What the viewer opens, by suffix, and what the Format facet calls it.
FORMATS = {".bw": "bigWig", ".bed": "BED", ".bedpe": "BEDPE", ".bed3d": "bed3d"}

#: A reference, by suffix: what ``dbz-store.sh`` places beside the map.
REFERENCES = (".fa", ".fna", ".fasta")

#: The tracks a species' session opens with, top to bottom under the map, by
#: step and output: the HiC score, the insulation score — its boundaries and
#: domains stay on the shelf — and E1 over the decay along both arms, read from
#: the origin the suite called. Every other output of the sample is on the
#: map's shelf and in the store as a row of its own.
SESSION_TRACKS = (
    "hicscore/hicscore.hicscore-d3.bw",
    "insulation/insulation.insulation-w10.bw",
    "compartments-arms/compartments.compartment-e1.bw",
)

#: The bin size a session opens its map at, where dbz-store.sh's RES_PATTERNS
#: is not handed over.
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
# Reading a sample's folder
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
    """The ``# key: value`` lines at the head of a TSV the ``chromosomix`` command wrote."""
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
            elif line.startswith("# chromosomix "):
                held.setdefault("producer", line[len("# "):].strip())
    return held


def called(path: Path) -> int:
    """How many intervals a BED or BEDPE holds, its comment lines aside."""
    with path.open(encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip() and not line.startswith("#"))


def read_framing(path: Path) -> list[dict]:
    """``framing.tsv``: each sequence, its length, whether it was read as a circle, its origin (1-based)."""
    rows: list[dict] = []
    if not path.exists():
        return rows
    header: Optional[list[str]] = None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            cells = line.rstrip("\n").split("\t")
            if header is None:
                header = cells
                continue
            row = dict(zip(header, cells))
            length = row.get("length", "")
            origin = row.get("origin", "")
            rows.append(
                {
                    "sequence": row.get("sequence", ""),
                    "length": int(length) if length.isdigit() else 0,
                    "circular": row.get("circular") == "yes",
                    "origin": int(origin) if origin.isdigit() and int(origin) >= 1 else None,
                }
            )
    return rows


def reference_extent(path: Path) -> tuple[int, int]:
    """How many sequences a FASTA holds, and how many bases between them."""
    sequences = bases = 0
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.startswith(">"):
                sequences += 1
            else:
                bases += len(line.strip())
    return sequences, bases


def bp(value: int) -> str:
    """``500 bp``, ``4 kb``, ``1.2 Mb`` — §26.2's spelling of a length."""
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f} Mb"
    if value >= 1_000:
        return f"{value / 1_000:g} kb"
    return f"{value} bp"


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


# ---------------------------------------------------------------------------
# index
# ---------------------------------------------------------------------------


def index(store_dir: Path, species_table: Path, resolution: int) -> int:
    table = read_species(species_table)
    repeated = {name for name, count in Counter(name for name, _ in table).items() if count > 1}
    created = make_store.now_iso()

    sessions: list[dict] = []
    maps: list[dict] = []
    tracks: list[dict] = []
    skipped: list[str] = []
    thin: list[str] = []
    producers: set[str] = set()
    circular = 0
    origins = 0
    models = 0

    for species, sample in table:
        out = store_dir / sample
        mcool = out / f"{sample}.mcool"
        if not mcool.exists():
            skipped.append(f"{sample}: not in the store yet (no {mcool.name})")
            continue
        # A species run twice (two libraries) is told apart by what follows its name.
        label = species
        if species in repeated:
            label = f"{species} ({sample[len(species) + 1:] if sample.startswith(species + '_') else sample})"

        framing = read_framing(out / "framing.tsv")
        declared = [row["sequence"] for row in framing if row["circular"]]
        called_at = {row["sequence"]: row["origin"] for row in framing if row["origin"] is not None}
        circular += bool(declared)
        origins += bool(called_at)
        size = sum(row["length"] for row in framing)
        # What tells two samples of a species apart: the sample name less the species.
        tail = sample[len(species) + 1:] if sample.startswith(species + "_") else ""
        common = {
            "species": label,
            **({"id": tail} if tail else {}),
            **({"sequences": plural(len(framing), "sequence")} if framing else {}),
        }

        # The shelf: what the map offers once open, the reference first.
        shelf: list[dict] = []
        references = sorted(path for path in out.iterdir() if path.is_file() and path.suffix in REFERENCES)
        for path in references:
            count, bases = reference_extent(path)
            relative = f"{sample}/{path.name}"
            tracks.append(
                {
                    "label": f"{label} · Reference · {path.name}",
                    "uri": relative,
                    "kind": "genome",
                    "size": path.stat().st_size,
                    "note": f"{bp(bases)} over {plural(count, 'sequence')} · the sequence every track "
                    "of this sample was read against",
                    "fields": {"analysis": "Reference", "format": "FASTA", **common},
                }
            )
            shelf.append({"label": f"Reference · {path.name}", "url": relative, "key": "reference"})

        for step, analysis in STEPS.items():
            for path in sorted((out / step).glob("*")):
                fmt = FORMATS.get(path.suffix)
                # The model step's BED is the model's bins without their
                # coordinates, from before the command wrote a bed3d: nothing to draw.
                if fmt is None or (step == "model3d" and fmt != "bed3d"):
                    continue
                count = called(path) if fmt != "bigWig" else None
                if count == 0:
                    skipped.append(f"{sample}/{step}/{path.name}: no calls")
                    continue
                facts = provenance(path.with_suffix(".tsv"))
                producers.add(facts.get("producer", ""))
                title = facts.get("output") or path.stem.split(".", 1)[-1]
                # A track named after a file of this sample — the coverage the
                # origin call fitted its spline to — is named after that file's
                # output instead, which a card's fold has room for.
                title = re.sub(
                    rf"\b{re.escape(sample)}_\d+\.[\w-]+\.([\w-]+)\.(?:bw|bigwig|bedGraph)\b", r"\1", title
                )
                binsize = re.search(r"_(\d+)\.[^.]+\.[^.]+\.[^.]+$", path.name)
                relative = f"{sample}/{step}/{path.name}"
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
                shelf.append(
                    {"label": title, "url": relative, "key": f"{step}/{path.name.split('.', 1)[-1]}"}
                )
                models += fmt == "bed3d"

        # The session: the map and three of its tracks, named relative to the
        # session's own folder, which is where the viewer resolves them (§21.1).
        chosen = [
            {"label": track["label"], "url": track["url"].split("/", 1)[1]}
            for key in SESSION_TRACKS
            for track in shelf
            if track["key"] == key
        ]
        for key in SESSION_TRACKS:
            if not any(track["key"] == key for track in shelf):
                thin.append(f"{sample}: no {key.split('/', 1)[1]} in {key.split('/', 1)[0]}/")
        document = make_store.session_document(name=label, uri=mcool.name, tracks=chosen, created=created)
        tab = document["tabs"][0]
        # The whole matrix rather than the chromosome list make_store opens a
        # map on: a bacterial genome is a few megabases, and its map with the
        # tracks under it is the picture. At the patterns' bin size, which a
        # sample has wherever a step ran at it; the finest rung whole would be a
        # dense read the size guard refuses (§9).
        if any(f"_{resolution}." in track["url"] for track in shelf):
            tab["state"].update(uri=f"{mcool.name}::resolutions/{resolution}", view="whole")
        # What every step ran with, declared as the viewer keeps it: the circles
        # by name, and each origin 0-based. Declared even when empty, so a first
        # open does not tick by its own test what the analyses read as a line.
        if framing:
            tab["circular"] = declared
            tab["origins"] = {name: at - 1 for name, at in called_at.items()}
        session_path = out / f"{sample}.chromosomix.json"
        session_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

        arms = ", ".join(f"{name}:{at:,}" for name, at in called_at.items())
        sessions.append(
            {
                "label": f"{label} — map with its HiC score, insulation and E1",
                "uri": f"{sample}/{session_path.name}",
                "kind": "workspace",
                "note": ", ".join(track["label"] for track in chosen)
                + (f" · arms from the origin at {arms}" if arms else ""),
                # No format: the row's icon says workspace, and a chip reading
                # *session* beside one reading *Session* says it twice.
                # `tracks` is the count a card's chip says (§24.2), as on IGV's sessions.
                "fields": {"analysis": "Session", "tracks": str(len(chosen)), **common},
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
                        f"{bp(size)} over {plural(len(framing), 'sequence')}" if framing else "",
                        f"circular: {', '.join(declared)}" if declared else "",
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
        print(f"Nothing to index: no sample of {species_table.name} has a map in {store_dir}.", file=sys.stderr)
        return 2
    producer = ", ".join(sorted(p for p in producers if p)) or "chromosomix"
    store = {
        "kind": make_store.STORE_KIND,
        "version": make_store.STORE_VERSION,
        "name": "DNA Bacterial Zoo",
        "description": (
            f"dbz-store.sh over {samples} bacterial Hi-C maps: each map, a session opening it with its "
            "HiC score, insulation and E1 — read along both arms from the replication origin — and "
            "every file on its own: the reference and its base composition, the origin and "
            "terminus, coverage, insulation, directionality index, HiC score, compartments along "
            "both arms and by distance, inter-arm alignment, and chromosight's borders and loops"
            + (f"; a 3D model for {models} of them" if models else "")
            + f". {circular} of {samples} samples have a sequence read as a circle, and {origins} "
            "an origin called from their sequence."
        ),
        "generatedAt": created,
        "source": f"{store_dir.name}/, written in place by dbz-store.sh with {producer}",
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
    written = store_dir / INDEX
    written.write_text(json.dumps(store, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # make_store's checks, less two rules that are its own portals' and not the
    # viewer's: an order by assembly and label, and absolute session names — a
    # session published *beside* its data is resolved against its own URL.
    problems = [
        problem
        for problem in make_store.check_store(written)
        if "sorts before the entry above it" not in problem
    ]
    for session in sorted(store_dir.glob("*/*.chromosomix.json")):
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

    print(f"{written}: {len(sessions)} sessions, {len(maps)} maps, {len(tracks)} tracks")
    for line in skipped:
        print(f"  left out  {line}")
    for line in thin:
        print(f"  session   {line}")
    for name in stale:
        print(f"  stale     {name}/ is no longer in {species_table.name}; remove it by hand")
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
    url = f"http://{host}:{port}/{INDEX}"
    quoted = urllib.parse.quote(url, safe="")
    print(f"Serving {folder} at {url}")
    print(f"  deployed viewer   https://chromosomix.app/?store={quoted}")
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
    one = commands.add_parser("index", help=f"write {INDEX} and the sessions over a store dbz-store.sh wrote")
    one.add_argument("store", type=Path, help="the folder dbz-store.sh wrote: one sub-folder a sample")
    one.add_argument("--species", type=Path, default=SPECIES, help=f"species<TAB>sample table (default: {SPECIES.name})")
    one.add_argument(
        "--resolution",
        type=int,
        default=PATTERNS_BP,
        help=f"the bin size a session opens its map at: dbz-store.sh's RES_PATTERNS (default: {PATTERNS_BP})",
    )
    two = commands.add_parser("serve", help="serve a store folder with byte ranges and CORS")
    two.add_argument("folder", type=Path)
    two.add_argument("--host", default="127.0.0.1")
    two.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if args.command == "index":
        return index(args.store.expanduser().resolve(), args.species, args.resolution)
    return serve(args.folder.expanduser().resolve(), args.host, args.port)


if __name__ == "__main__":
    raise SystemExit(main())
