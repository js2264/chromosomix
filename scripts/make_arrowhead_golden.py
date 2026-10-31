#!/usr/bin/env python
"""Export the golden oracle for the Arrowhead port (SPECS.md §18.8, §18.9).

Run with Java 21 and Juicer Tools 1.22.01, the jar ``JUICER_TOOLS_JAR`` names or
the one this script fetches into ``~/.cache/chromosomix``::

    python scripts/make_arrowhead_golden.py

It writes ``test/golden/analysis/arrowhead.json``: what
``juicer_tools arrowhead`` makes of ``demo/yeast/Yeast_hic.hic`` — every domain
of its ``<resolution>_blocks.bedpe``, with the five scores Juicer writes beside
it, in the order it writes them — so ``test/unit/analysis-arrowhead-golden.test.ts``
can hold ``src/analysis/arrowhead.ts`` to it domain for domain.

Two configurations a resolution, at 2 and 4 kb (the file's rungs double from
1 kb): the raw counts (``-k NONE``), which the app reads bit for bit as Juicer
does, and the normalisation the app reads a ``.hic`` balanced with — the first
of SCALE, KR, INTER_KR, GW_KR, VC_SQRT and VC the file carries,
`src/hic/HicFile.ts`'s order, asked of Juicer itself with ``dump norm``. The
balanced run is over the chromosomes whose vector of that name holds a finite
value: where it holds none the app takes the next normalisation for that
chromosome, and Juicer drops every record of it, so the two would be answering
different questions. The window is ``-m 2000``, Juicer's own, and one thread.

**The JVM matters.** One step of Arrowhead walks a ``HashSet`` of its lenient
blocks, and a ``HashSet`` copied from a list sizes its table one way before
JDK 19 and another since: the port follows a current JDK, and the golden
records which one made it.
"""

import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HIC = os.path.join(ROOT, "demo", "yeast", "Yeast_hic.hic")
OUT = os.path.join(ROOT, "test", "golden", "analysis", "arrowhead.json")
JAR_URL = "https://s3.amazonaws.com/hicfiles.tc4ga.com/public/juicer/juicer_tools_1.22.01.jar"
RESOLUTIONS = (2000, 4000)
#: `src/hic/HicFile.ts`'s NORM_PREFERENCE: the vector the app reads a .hic balanced with.
NORM_PREFERENCE = ("SCALE", "KR", "INTER_KR", "GW_KR", "VC_SQRT", "VC")
COLUMNS = ("score", "uVarScore", "lVarScore", "upSign", "loSign")


def jar():
    """The Juicer Tools jar: named, or fetched once into the user's cache."""
    named = os.environ.get("JUICER_TOOLS_JAR")
    if named:
        return named
    cache = os.path.join(os.path.expanduser("~"), ".cache", "chromosomix")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, os.path.basename(JAR_URL))
    if not os.path.exists(path):
        print(f"fetching {JAR_URL}", file=sys.stderr)
        urllib.request.urlretrieve(JAR_URL, path)
    return path


def java_version():
    run = subprocess.run(["java", "-version"], capture_output=True, text=True)
    found = re.search(r'version "([^"]+)"', run.stderr + run.stdout)
    return found.group(1) if found else "?"


def chromosomes(path):
    """The chromosomes a .hic's header lists, less Juicer's whole-genome `All`."""
    with open(path, "rb") as handle:
        data = handle.read(1 << 20)
    at = 4
    version = struct.unpack_from("<i", data, at)[0]
    at += 4 + 8  # the version, the footer's position

    def string():
        nonlocal at
        end = data.index(b"\0", at)
        text = data[at:end].decode()
        at = end + 1
        return text

    string()  # the genome id
    if version >= 9:
        at += 16  # the normalisation index's position and length
    attributes = struct.unpack_from("<i", data, at)[0]
    at += 4
    for _ in range(attributes):
        string()
        string()
    count = struct.unpack_from("<i", data, at)[0]
    at += 4
    names = []
    for _ in range(count):
        name = string()
        at += 8 if version >= 9 else 4
        if name.lower() != "all":
            names.append(name)
    return names


def norm_vector(path, norm, chrom, resolution):
    """A chromosome's vector of one normalisation at one resolution, as Juicer dumps it; None where it has none."""
    run = subprocess.run(["java", "-jar", jar(), "dump", "norm", norm, path, chrom, "BP", str(resolution)],
                         capture_output=True, text=True)
    values = []
    for line in run.stdout.splitlines():
        try:
            values.append(float(line))
        except ValueError:
            if "not available" in line:
                return None
    return values or None


def balanced_for(path, resolution):
    """The normalisation the app reads this rung balanced with, and the chromosomes it holds a value for."""
    names = chromosomes(path)
    for norm in NORM_PREFERENCE:
        vectors = {chrom: norm_vector(path, norm, chrom, resolution) for chrom in names}
        if all(vector is None for vector in vectors.values()):
            continue
        usable = [chrom for chrom, vector in vectors.items()
                  if vector is not None and any(math.isfinite(v) and v > 0 for v in vector)]
        return norm, usable
    return None, []


def arrowhead(path, resolution, norm, chroms=None):
    """``juicer_tools arrowhead`` at one resolution and normalisation: its blocks, as written."""
    with tempfile.TemporaryDirectory() as out:
        argv = ["java", "-Xmx4g", "-jar", jar(), "arrowhead", "-m", "2000", "-r", str(resolution),
                "-k", norm, "--threads", "1", *(["-c", ",".join(chroms)] if chroms else []), path, out]
        print(" ".join(argv), file=sys.stderr)
        subprocess.run(argv, check=True, stdout=sys.stderr)
        blocks = os.path.join(out, f"{resolution}_blocks.bedpe")
        domains = []
        with open(blocks) as handle:
            for line in handle:
                if line.startswith("#") or not line.strip():
                    continue
                # By position: the header names `score` twice, the feature's and the corner's, and
                # the five ARROWHEAD columns are always the last five of a row.
                fields = line.rstrip("\n").split("\t")
                domains.append({
                    "chrom": fields[0],
                    "x1": int(fields[1]),
                    "x2": int(fields[2]),
                    **{key: float(value) for key, value in zip(COLUMNS, fields[-5:])},
                })
        return domains


def main():
    runs = []
    for resolution in RESOLUTIONS:
        runs.append({"resolution": resolution, "norm": "NONE", "chroms": None,
                     "domains": arrowhead(HIC, resolution, "NONE")})
        norm, chroms = balanced_for(HIC, resolution)
        if norm is not None and chroms:
            runs.append({"resolution": resolution, "norm": norm, "chroms": chroms,
                         "domains": arrowhead(HIC, resolution, norm, chroms)})
    golden = {
        "source": "juicer_tools 1.22.01 arrowhead over demo/yeast/Yeast_hic.hic",
        "jar": os.path.basename(jar()),
        "java": java_version(),
        "matrixSize": 2000,
        "runs": runs,
    }
    with open(OUT, "w") as handle:
        json.dump(golden, handle, indent=1)
    print(f"wrote {OUT}: " + ", ".join(f"{r['resolution']} bp {r['norm']}: {len(r['domains'])} domains" for r in runs),
          file=sys.stderr)


if __name__ == "__main__":
    main()
