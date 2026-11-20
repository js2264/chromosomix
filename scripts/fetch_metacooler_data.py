#!/usr/bin/env python
"""Put metacooler's test data where ``make_fixtures.py`` reads it, from PyPI.

``make_fixtures.py`` drives the metacooler CLI over the small synthetic
assemblies in metacooler's ``tests/data/``. metacooler is on PyPI, and its
source distribution carries that directory, but not all of it: 0.2.0's leaves
out the ``contacts_*.pairs.gz`` contact lists, the two of assembly 1 being what
every ``.metacool`` fixture is made from. It does carry the script that wrote
them, ``tests/data/generate-raw-files.py``, which is seeded. So the lists that
are missing are written again with that script, and held to the ``.cool`` files
metacooler built from the originals and ships beside them: binned at 1 kb and
at DpnII fragments with ``cooler cload pairs``, as its ``raw-to-cool.sh`` does,
each regenerated list must give those files pixel for pixel, or nothing is
written. A release whose sdist carries the lists has nothing regenerated.

The sdist is the one of the metacooler installed beside this interpreter, so the
CLI ``make_fixtures.py`` drives and the data it reads are the same release.
Checked against PyPI's SHA-256 before it is opened.

Needs metacooler, cooler and Biopython (the generator's last step digests the
assemblies with ``cooler.util.digest``)::

    pip install metacooler cooler biopython
    python scripts/fetch_metacooler_data.py     # npm run fixtures:metacooler

Writes ``test/fixtures/_metacooler/`` (``--out`` moves it), which
``make_fixtures.py`` reads when neither ``--data`` nor ``$METACOOLER_TEST_DATA``
names a directory and no metacooler checkout sits beside this one. Run again,
it does nothing while the directory holds the installed release's data.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "test" / "fixtures" / "_metacooler"
STAMP = ".metacooler-version"

# What make_fixtures.py reads; the rest of tests/data comes along.
REQUIRED = (
    "contigs_table_1.tsv",
    "mag_table_1.tsv",
    "contacts_1_rep1.pairs.gz",
    "contacts_1_rep2.pairs.gz",
    "assembly_1.chrom.sizes",
    "assembly_1_DpnII-digested.bed",
    "metadata.yaml",
)

# Every contact list the generator writes, and the .cool files metacooler's
# raw-to-cool.sh made from each: (bins, as `cooler cload pairs` takes them; the
# file it wrote).
LISTS = {
    f"contacts_{a}_rep{r}.pairs.gz": (
        (f"assembly_{a}.chrom.sizes:1000", f"assembly_{a}_rep{r}_1kb.cool"),
        (f"assembly_{a}_DpnII-digested.bed", f"assembly_{a}_rep{r}_DpnII.cool"),
    )
    for a in (1, 2)
    for r in (1, 2)
}


def say(message: str) -> None:
    print(f"fetch_metacooler_data: {message}", file=sys.stderr)


def tool(name: str) -> str:
    """A console script of this interpreter's environment, as make_fixtures finds it."""
    beside = Path(sys.executable).with_name(name)
    if beside.exists():
        return str(beside)
    found = shutil.which(name)
    if found:
        return found
    raise SystemExit(f"cannot find the {name!r} executable next to {sys.executable}")


def sdist(release: str) -> bytes:
    """The release's source distribution, checked against PyPI's digest."""
    with urllib.request.urlopen(f"https://pypi.org/pypi/metacooler/{release}/json") as response:
        files = json.load(response)["urls"]
    found = [f for f in files if f["packagetype"] == "sdist"]
    if not found:
        raise SystemExit(f"PyPI lists no source distribution for metacooler {release}")
    entry = found[0]
    say(f"downloading {entry['filename']}")
    with urllib.request.urlopen(entry["url"]) as response:
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != entry["digests"]["sha256"]:
        raise SystemExit(f"{entry['filename']} does not have the SHA-256 PyPI lists for it")
    return payload


def unpack(payload: bytes, into: Path) -> None:
    """Every regular file under ``*/tests/data/``, and nothing else."""
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            parts = PurePosixPath(member.name).parts
            if not member.isfile() or len(parts) < 4 or parts[1:3] != ("tests", "data"):
                continue
            relative = PurePosixPath(*parts[3:])
            if ".." in relative.parts:
                continue
            target = into / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            assert source is not None
            target.write_bytes(source.read())


def same_pixels(made: Path, shipped: Path) -> bool:
    import cooler
    import numpy as np

    a, b = cooler.Cooler(str(made)), cooler.Cooler(str(shipped))
    if a.chromnames != b.chromnames or a.info["nbins"] != b.info["nbins"]:
        return False
    columns = ["bin1_id", "bin2_id", "count"]
    return bool(np.array_equal(a.pixels()[:][columns].to_numpy(), b.pixels()[:][columns].to_numpy()))


def regenerate(data: Path, missing: list[str]) -> None:
    """Write the missing contact lists again, or refuse."""
    script = data / "generate-raw-files.py"
    if not script.is_file():
        raise SystemExit(f"{', '.join(missing)} missing, and no generate-raw-files.py to write them")
    cload = tool("cooler")
    with tempfile.TemporaryDirectory() as scratch:
        work = Path(scratch)
        say(f"{', '.join(missing)} not in the sdist: writing them with generate-raw-files.py")
        subprocess.run([sys.executable, "-I", str(script)], cwd=work, check=True)
        for name in missing:
            for bins, shipped in LISTS[name]:
                if not (data / shipped).is_file():
                    raise SystemExit(f"cannot check {name}: the sdist has no {shipped}")
                spec, _, size = bins.partition(":")
                made = work / f"check-{shipped}"
                subprocess.run(
                    [cload, "cload", "pairs", "-c1", "2", "-p1", "3", "-c2", "4", "-p2", "5",
                     f"{data / spec}{':' + size if size else ''}", str(work / name), str(made)],
                    check=True,
                    capture_output=True,
                )
                if not same_pixels(made, data / shipped):
                    raise SystemExit(f"the regenerated {name} does not give metacooler's {shipped}")
            say(f"{name}: gives metacooler's own {' and '.join(s for _, s in LISTS[name])}")
        for name in missing:
            shutil.copyfile(work / name, data / name)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    out: Path = args.out

    try:
        release = version("metacooler")
    except PackageNotFoundError:
        raise SystemExit(f"metacooler is not installed for {sys.executable}: pip install metacooler") from None

    stamp = out / STAMP
    if stamp.is_file() and stamp.read_text().strip() == release and all((out / n).is_file() for n in REQUIRED):
        say(f"{out} already holds metacooler {release}'s test data")
        return 0

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    unpack(sdist(release), out)

    missing = [name for name in LISTS if not (out / name).is_file()]
    if missing:
        regenerate(out, missing)
    absent = [name for name in REQUIRED if not (out / name).is_file()]
    if absent:
        raise SystemExit(f"metacooler {release}'s test data lacks {', '.join(absent)}")

    stamp.write_text(release + "\n")
    say(f"metacooler {release}'s test data is in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
