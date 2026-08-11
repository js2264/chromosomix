#!/usr/bin/env python
"""Export golden oracles for the metacooler-viewer test suite.

Run with the interpreter that has metacooler installed, *after*
``make_fixtures.py``::

    /pasteur/helix/users/jaseriza/repos/metacooler/.venv/bin/python \
        scripts/make_golden.py

One JSON per fixture in ``test/golden/``, plus ``test/golden/_manifest.json``
so the JS suite can iterate without hard-coding the fixture list.

Why this exists
---------------
The JS reader is checked against these files for **exact integer equality**, not
for approximate agreement. The two things most likely to be wrong in a
re-implementation are the upper-triangular symmetry logic and the off-diagonal
transpose (spec §5.3), and both fail by producing a matrix that *looks*
plausible — a blank block, or a block that is the transpose of the right answer.
Nothing short of cell-by-cell equality against Python catches that.

Determinism
-----------
``json.dump(sort_keys=True)`` everywhere, and every value that varies between
runs is stripped rather than recorded. The only such value metacooler writes is
the ``creation-date`` root attribute; the keys removed from ``info`` are listed
under ``info_volatile_keys`` so a JS test knows exactly what to ignore rather
than guessing. ``metadata.commands`` is stripped for the same reason — it
carries the absolute paths of whatever machine ran ``make_fixtures.py``.

Every fixture has a **full** oracle, and that is a property of the fixture set
------------------------------------------------------------------------------
Nothing here has a non-ASCII name, because metacooler will not write one:
``/contigs`` doubles as cooler's ``/chroms`` and cooler decodes it with an ASCII
``.astype("U")``, so ``check_ascii_names`` refuses on the way in and
``schema.validate`` on the way out.  There is therefore no fixture ``cooler`` and
``MetaCooler`` cannot open, no partial golden, and no matrix this script has to
record as unobtainable — a file the reference implementation cannot read is one
the viewer should not be claiming to read either.

``metacooler aggregate`` can still fall back to ``ops.aggregate._aggregate_sparse``
— the same primitive ``show`` uses — and every matrix entry records which method
produced it, because the two are worth telling apart wherever they differ.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
from pathlib import Path
from typing import Any

import h5py
import numpy as np

REPO = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURES = REPO / "test" / "fixtures"
DEFAULT_OUT = REPO / "test" / "golden"

log = logging.getLogger("make_golden")

# Root attributes whose value changes on every regeneration. Stripped from the
# golden and listed under `info_volatile_keys` so the JS side ignores exactly
# these and nothing more.
VOLATILE_INFO_KEYS = ("creation-date",)

# `metacooler.constants.UNBINNED_NAME`. Matched by name, never by index —
# `create --drop-unassigned` omits the row entirely (correction #4).
UNBINNED = "__unbinned__"

# Bins per axis above which a dense golden matrix is not worth committing.
# Well under DENSE_MATRIX_BIN_LIMIT (50_000); this is a repo-size limit, not a
# correctness one.
MAX_GOLDEN_AXIS = 200

# Contigs sampled for `contig_extent`.
CONTIG_SAMPLE = 12

# Facts about how h5wasm surfaces this format in Node, verified empirically
# against these fixtures (h5wasm 0.10.x, Node 24). They live in the manifest
# because each one silently produces a *plausible* wrong answer rather than an
# error, so a reader written from the numpy-side documentation alone is wrong in
# ways no type checker catches.
READER_NOTES = {
    "dtype_strings": {
        "note": (
            "h5wasm's Dataset.dtype is C-struct-style, not numpy-style: int64 is "
            "'<q', int32 '<i', float64 '<d', fixed-length strings 'A<n>', vlen "
            "strings 'S'. The `dtype` fields in these goldens are numpy strings "
            "('<i8', '<i4', '<f8', '|S12') and the `kind` fields are numpy kinds. "
            "Map through `kind_by_h5wasm_letter` before comparing; do not slice "
            "dtype[1] and expect a numpy kind."
        ),
        "kind_by_h5wasm_letter": {
            "b": "i", "h": "i", "i": "i", "l": "i", "q": "i",
            "B": "u", "H": "u", "I": "u", "L": "u", "Q": "u",
            "e": "f", "f": "f", "d": "f",
            "A": "S", "S": "O",
        },
    },
    "attributes": {
        "note": (
            "An int64 attribute arrives as a JS BigInt, an int32 attribute as a "
            "Number, and a variable-bin file's bin-size as the string 'null'. All "
            "three reach the `_int_attr` mirror, so it must accept bigint — "
            "`typeof v === 'number'` is false for 1000n, and `Number('null')` is "
            "NaN while `Boolean('null')` is true. See the `attrs` block of "
            "basic.metacool (int64), floatcount.metacool (int32) and "
            "variable.metacool (string 'null')."
        ),
        "h5_api_gap": (
            "src/h5/api.ts's AttrValue union omits `bigint`; it needs adding, or "
            "attrsAt()/attrs() must narrow BigInt to Number at the boundary."
        ),
    },
    "string_decoding": {
        "note": (
            "h5wasm decodes fixed-length 'A<n>' string datasets as Latin-1, not "
            "UTF-8, so Dataset.value is unusable for any string column — read the "
            "raw bytes and decode with TextDecoder('utf-8'), stripping trailing "
            "NULs (spec §6.2). Names are ASCII by construction (metacooler refuses "
            "anything else, since /contigs is cooler's /chroms), but an extra "
            "/genomes column is not: an accented taxonomy is legal metadata cooler "
            "never sees, and it is what this note is about."
        )
    },
    "non_finite": {
        "note": (
            "Optional /genomes columns carry NaN for any genome absent from the "
            "user's --genomes table (__unbinned__ always is, since /genomes rows "
            "are derived from the contigs table and the table only left-joins). "
            "JSON has no NaN, so these goldens encode it as null; the JS reader "
            "will see a real NaN and must treat the two as equal. "
            "metadata.metacool is the fixture with this shape."
        )
    },
}

# Absolute path prefix stripped from every recorded exception message. Python
# interpolates the store path into the mmetacool root KeyError, which would make
# the golden depend on where the repo happens to be checked out — the one thing
# a "a diff means a real change" oracle cannot afford.
_SCRUB_PREFIX = ""


def scrub(text: str) -> str:
    """Make a recorded string independent of the checkout location."""
    if _SCRUB_PREFIX:
        return text.replace(_SCRUB_PREFIX, "")
    return text


def deep_scrub(value: Any) -> Any:
    """Apply :func:`scrub` to every string inside a nested structure.

    metacooler's provenance is not confined to ``metadata['commands']``:
    ``binnify`` writes ``metadata['binnify'][0]['source']`` as an absolute path,
    and ``zoomify`` copies that forward into every entry. Dropping one key is
    therefore not enough — the whole blob has to be made location-independent.
    """
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, dict):
        return {k: deep_scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [deep_scrub(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# JSON coercion
# ---------------------------------------------------------------------------


def jsonable(value: Any) -> Any:
    """Coerce numpy / pandas / bytes values into JSON primitives.

    Integers stay integers: the whole point of the oracle is exact integer
    equality, so nothing here may route an int through float.
    """
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    return value


def finite(value: Any) -> Any:
    """Replace every non-finite float with ``null``, recursively.

    JSON has no NaN, but Python's ``json`` emits a bare ``NaN`` token that
    ``JSON.parse`` rejects outright — so without this the goldens are not
    loadable from JS at all. And NaN is not hypothetical here: ``/genomes`` rows
    are derived from the contigs table and a user's ``--genomes`` table only
    left-joins onto them, so any genome missing from that table (``__unbinned__``
    always is) carries NaN in every optional numeric column. Real MetaTOR output
    has exactly this shape.
    """
    if isinstance(value, float):
        return None if (value != value or value in (float("inf"), float("-inf"))) else value
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [finite(v) for v in value]
    return value


def dump(obj: Any, path: Path) -> int:
    """Write *obj* as deterministic, strictly-valid JSON; return the byte count."""
    text = (
        json.dumps(finite(obj), indent=1, sort_keys=True, ensure_ascii=False, allow_nan=False)
        + "\n"
    )
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


# ---------------------------------------------------------------------------
# Raw HDF5 blocks — available even when cooler refuses the file
# ---------------------------------------------------------------------------


def attrs_block(node: h5py.Group) -> dict:
    """Every attribute on *node*, with its stored Python type.

    The type matters as much as the value: ``bin-size`` is ``np.int64`` on a
    fixed-bin file, ``np.int32`` on one round-tripped through ``create cool``,
    and the **string** ``'null'`` on a variable-bin file. A JS reader that does
    ``Number(attr)`` gets ``NaN`` for the last one and a truthiness test gets
    ``true``, which is how a variable-bin file gets silently accepted
    (correction #3). Recording the type is what lets a test assert the
    ``_int_attr`` mirror on the real shapes rather than on invented ones.
    """
    out: dict[str, dict] = {}
    for key, raw in node.attrs.items():
        entry: dict[str, Any] = {"value": jsonable(raw)}
        entry["python_type"] = type(raw).__name__
        if isinstance(raw, np.generic):
            entry["numpy_dtype"] = raw.dtype.str
        elif isinstance(raw, np.ndarray):
            entry["numpy_dtype"] = raw.dtype.str
        if key in VOLATILE_INFO_KEYS:
            # Present and typed, but valueless: `creation-date` changes on every
            # regeneration, and leaving it in would make every golden differ
            # after a rebuild that changed nothing.
            entry.pop("value")
            entry["volatile"] = True
        elif key == "metadata" and isinstance(entry["value"], str):
            # The `metadata` attribute is a JSON blob carrying provenance:
            # `commands` is the line metacooler reconstructs from argv, and
            # `binnify`/`zoomify` add their own `source` paths. Drop the first
            # and make the rest location-independent, so the golden does not
            # depend on where the fixtures were generated. The attribute's type
            # is preserved; `mc.metadata` is emitted separately as the decoded
            # oracle, redacted the same way.
            try:
                parsed = json.loads(entry["value"])
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                redacted = [k for k in ("commands",) if k in parsed]
                for k in redacted:
                    parsed.pop(k)
                entry["value"] = json.dumps(deep_scrub(parsed), sort_keys=True)
                if redacted:
                    entry["redacted"] = redacted
        elif isinstance(entry["value"], str):
            entry["value"] = scrub(entry["value"])
        out[key] = entry
    return out


def dataset_kinds(node: h5py.Group, group: str) -> dict:
    """dtype string and kind for every column of a table group.

    ``CORE_COLUMN_KINDS`` permits a *set* of kinds per column (``iu`` for ids,
    ``iuf`` for ``pixels/count``, ``SOU`` for names), so a test must assert the
    kind and never the exact dtype — this block is what makes that assertable.
    """
    if group not in node:
        return {}
    grp = node[group]
    out = {}
    for key in grp:
        ds = grp[key]
        if isinstance(ds, h5py.Dataset):
            out[key] = {
                "dtype": ds.dtype.str,
                "kind": ds.dtype.kind,
                "length": int(ds.shape[0]) if ds.ndim else 0,
            }
    return out


def raw_table(node: h5py.Group, group: str) -> dict:
    """Read a table group straight from HDF5, decoding S columns as UTF-8.

    Deliberately not ``pandas``: this mirrors ``schema.read_table``'s decode,
    which uses an explicit UTF-8 decode precisely because ``astype('U')`` is
    ASCII — and an extra ``/genomes`` column may legally hold an accented value.
    """
    grp = node[group]
    columns = [k for k in grp if isinstance(grp[k], h5py.Dataset)]
    data: dict[str, list] = {}
    for key in columns:
        values = grp[key][:]
        if values.dtype.kind == "S":
            data[key] = [v.decode("utf-8") for v in values]
        elif values.dtype == object:
            data[key] = [v.decode("utf-8") if isinstance(v, bytes) else str(v) for v in values]
        else:
            data[key] = [jsonable(v) for v in values]
    n = len(next(iter(data.values()))) if data else 0
    return {
        "columns": columns,
        "length": n,
        "dtypes": {k: grp[k].dtype.str for k in columns},
        "rows": [{k: data[k][i] for k in columns} for i in range(n)],
    }


def indexes_block(node: h5py.Group) -> dict:
    """The three offset arrays, as plain integers.

    ``chrom_offset`` and ``contigs/length`` together are the *entire* coordinate
    model for a fixed-bin file (spec §3.3), so these are the arrays the JS
    arithmetic is checked against. ``bin1_offset`` is included because
    ``bin1_offset[hi] - bin1_offset[lo]`` is the free per-genome density proxy
    of §4 and the viewer surfaces it as a sortable column.
    """
    grp = node["indexes"]
    return {
        key: [int(v) for v in grp[key][:]]
        for key in grp
        if isinstance(grp[key], h5py.Dataset)
    }


# ---------------------------------------------------------------------------
# Matrices
# ---------------------------------------------------------------------------


def dense(mc, rows: tuple[int, int], cols: tuple[int, int], integral: bool) -> list[list]:
    """`mc.matrix(balance=False)[r0:r1, c0:c1]` as nested JSON numbers.

    cooler already resolves the storage-mode symmetry and, for a block whose
    column range precedes its row range, the transpose. That is exactly the
    behaviour §5.3 says the JS must reproduce, so this is the oracle for it —
    including the deliberately reversed orientations built in `matrix_specs`.
    """
    block = mc.matrix(balance=False)[rows[0] : rows[1], cols[0] : cols[1]]
    arr = np.asarray(block)
    if integral:
        return [[int(v) for v in row] for row in arr]
    return [[float(v) for v in row] for row in arr]


def aggregated(uri: str, mc, level: str) -> tuple[list[list], str, str | None]:
    """Full contig- or genome-level matrix, plus which method produced it.

    Prefers the public ``metacooler.ops.aggregate.aggregate`` (write a ``.cool``,
    read it dense) because that is the documented route and it preserves float
    counts. Falls back to ``_aggregate_sparse`` — the same primitive ``show``
    uses — when cooler cannot round-trip the names.
    """
    import cooler
    from metacooler.ops.aggregate import _aggregate_sparse, aggregate

    try:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / f"{level}.cool"
            aggregate(uri, tmp, level=level)
            arr = np.asarray(cooler.Cooler(str(tmp)).matrix(balance=False)[:])
        method, error = "aggregate", None
    except Exception as exc:  # noqa: BLE001 — recorded, not swallowed
        arr = _aggregate_sparse(mc, level).toarray()
        method, error = "_aggregate_sparse", f"{type(exc).__name__}: {exc}"

    arr = np.nan_to_num(arr, nan=0.0)
    if np.all(arr == np.floor(arr)):
        values = [[int(v) for v in row] for row in arr]
    else:
        values = [[float(v) for v in row] for row in arr]
    return values, method, error


def pair_genomes(genomes: list[dict]) -> list[str]:
    """The displayable genomes used for pair oracles, chosen deterministically.

    Smallest-first by ``(n_bins, name)``: the pair blocks are quadratic in bin
    count and every one of them is committed, so the three smallest MAGs give
    two independent pairs for a few hundred cells rather than a few hundred
    thousand. ``__unbinned__`` is excluded because it is never selectable as
    either axis of a pair (spec §7.4).
    """
    displayable = [g for g in genomes if g["name"] != UNBINNED and g["n_bins"] > 0]
    displayable.sort(key=lambda g: (g["n_bins"], g["name"]))
    return [g["name"] for g in displayable[:3]]


def matrix_specs(mc, genomes: list[dict], contigs: list[dict], binsize: int) -> list[dict]:
    """Bin-level selections to materialise, chosen deterministically.

    Both orientations of both pairs are emitted because a reader that omits the
    transpose returns a *blank* off-diagonal block, which looks like "no
    inter-genome contacts" rather than like a bug — and blankness is exactly
    what a plausible-looking metagenomic panel might legitimately show.
    """
    chosen = pair_genomes(genomes)
    if len(chosen) < 2:
        return []
    g1, g2 = chosen[0], chosen[1]
    g3 = chosen[2] if len(chosen) > 2 else None
    e1 = mc.genome_extent(g1)
    e2 = mc.genome_extent(g2)

    gid1 = next(i for i, g in enumerate(genomes) if g["name"] == g1)
    first_contig = next(c["name"] for c in contigs if c["genome_id"] == gid1)
    ce = mc.contig_extent(first_contig)
    region = f"{first_contig}:1-{min(3 * binsize, (ce[1] - ce[0]) * binsize)}"

    nbins = mc.shape[0]
    win = min(40, nbins // 4)

    specs = [
        {"id": f"genome:{g1}", "level": "bin", "rows": e1, "cols": e1, "note": "on-diagonal genome block"},
        {"id": f"genome:{g2}", "level": "bin", "rows": e2, "cols": e2, "note": "on-diagonal genome block"},
        {"id": f"pair:{g1}|{g2}", "level": "bin", "rows": e1, "cols": e2, "note": "off-diagonal pair"},
        {"id": f"pair:{g2}|{g1}", "level": "bin", "rows": e2, "cols": e1, "note": "off-diagonal pair, reversed — fails without the transpose"},
        {"id": f"contig:{first_contig}", "level": "bin", "rows": ce, "cols": ce, "note": "on-diagonal contig block"},
        {"id": f"region:{region}", "level": "bin", "rows": mc.extent(region), "cols": mc.extent(region), "note": "contig:start-end; see the `ranges` block for the coordinate convention"},
        {"id": f"bins:0-{win}x0-{win}", "level": "bin", "rows": (0, win), "cols": (0, win), "note": "raw bin window, on-diagonal"},
        {"id": f"bins:0-{win}x{nbins - win}-{nbins}", "level": "bin", "rows": (0, win), "cols": (nbins - win, nbins), "note": "raw bin window, upper triangle"},
        {"id": f"bins:{nbins - win}-{nbins}x0-{win}", "level": "bin", "rows": (nbins - win, nbins), "cols": (0, win), "note": "raw bin window, lower triangle — must equal the transpose of the previous"},
    ]
    if g3 is not None:
        e3 = mc.genome_extent(g3)
        specs.extend(
            [
                {"id": f"pair:{g1}|{g3}", "level": "bin", "rows": e1, "cols": e3, "note": "second off-diagonal pair"},
                {"id": f"pair:{g3}|{g1}", "level": "bin", "rows": e3, "cols": e1, "note": "second off-diagonal pair, reversed"},
            ]
        )
    return [
        s
        for s in specs
        if s["rows"][1] - s["rows"][0] <= MAX_GOLDEN_AXIS
        and s["cols"][1] - s["cols"][0] <= MAX_GOLDEN_AXIS
        and s["rows"][1] > s["rows"][0]
        and s["cols"][1] > s["cols"][0]
    ]


# ---------------------------------------------------------------------------
# Range battery
# ---------------------------------------------------------------------------


def range_battery(mc, genomes: list[dict], contigs: list[dict], binsize: int) -> list[dict]:
    """Every ``parse_metacooler_range`` case, successes and failures alike.

    The failures are the point. Three of the spec's refusals (§5.4, §10) are
    range-level and each must be *distinguishable*: a coordinate suffix on a
    genome name, an unknown label, and ``__unbinned__``. Note what Python
    actually does with the last one — it resolves it, because ``__unbinned__``
    *is* a genome as far as metacooler is concerned. The viewer's extra refusal
    is a viewer policy (§7.4), and this record is what proves the JS is adding
    it rather than inheriting it.
    """
    from metacooler.ops.range import parse_metacooler_range

    displayable = [g["name"] for g in genomes if g["name"] != UNBINNED]
    first_genome = displayable[0] if displayable else genomes[0]["name"]
    contig = contigs[0]["name"]
    long_contig = max(contigs, key=lambda c: c["length"])["name"]
    long_len = max(c["length"] for c in contigs)

    candidates = [
        first_genome,
        f"{first_genome}:1-{binsize}",
        contig,
        f"{contig}:1-{binsize}",
        f"{long_contig}:1-{long_len}",
        f"{long_contig}:{binsize + 1}-{2 * binsize}",
        f"{long_contig}:1-1",
        f"{long_contig}:0-{binsize}",
        # The three probes below pin down the coordinate convention, which the
        # spec and metacooler's own docstrings both describe as "1-based, fully
        # closed". They are not: cooler's parse_region is 0-based half-open, so
        # `:{binsize}-{binsize + 1}` selects the *second* bin and
        # `:{binsize}-{binsize}` selects none at all. A JS reader that
        # implements the documented convention is off by one bin on every
        # region query, and only these cases distinguish the two.
        f"{long_contig}:{binsize - 1}-{binsize}",
        f"{long_contig}:{binsize}-{binsize + 1}",
        f"{long_contig}:{binsize}-{binsize}",
        f"{long_contig}:{10 * long_len}-{20 * long_len}",
        "no_such_label",
        "no_such_label:1-100",
        "",
    ]
    if any(g["name"] == UNBINNED for g in genomes):
        candidates.extend([UNBINNED, f"{UNBINNED}:1-{binsize}"])

    results = []
    for spec in candidates:
        record: dict[str, Any] = {"range": spec}
        try:
            lo, hi = parse_metacooler_range(mc, spec)
            record.update(ok=True, extent=[int(lo), int(hi)])
        except Exception as exc:  # noqa: BLE001 — the failures are the oracle
            record.update(
                ok=False,
                error_type=type(exc).__name__,
                error_message=scrub(str(exc)),
            )
        results.append(record)
    return results


# ---------------------------------------------------------------------------
# Per-fixture builders
# ---------------------------------------------------------------------------


def metacool_golden(path: Path, group: str, uri: str, descriptor: dict) -> dict:
    """Build the golden for one metacool (a file, or one mmetacool entry)."""
    from metacooler.api import MetaCooler

    with h5py.File(path, "r") as fh:
        node = fh[group.lstrip("/")] if group != "/" else fh
        out: dict[str, Any] = {
            "fixture": descriptor["name"],
            "uri": uri,
            "kind": "metacool",
            "group": group,
            "attrs": attrs_block(node),
            "dtypes": {
                tbl: dataset_kinds(node, tbl)
                for tbl in ("genomes", "contigs", "bins", "pixels", "indexes")
            },
            "genomes": raw_table(node, "genomes"),
            "contigs": raw_table(node, "contigs"),
            "indexes": indexes_block(node),
            "chroms_is_soft_link": isinstance(
                node.get("chroms", getlink=True), h5py.SoftLink
            ),
        }

    genomes = out["genomes"]["rows"]
    contigs = out["contigs"]["rows"]
    chrom_offset = out["indexes"]["chrom_offset"]
    bin1_offset = out["indexes"]["bin1_offset"]
    genome_offset = out["indexes"].get("genome_offset")
    n_bins = chrom_offset[-1]

    # §7.4 — the one retained number. Reported as a QC statistic, never as a row.
    unbinned = next((i for i, g in enumerate(genomes) if g["name"] == UNBINNED), None)
    out["unbinned"] = {
        "present": unbinned is not None,
        "name": UNBINNED,
        "genome_id": unbinned,
        "n_contigs": genomes[unbinned]["n_contigs"] if unbinned is not None else 0,
        "n_bins": genomes[unbinned]["n_bins"] if unbinned is not None else 0,
        "frac_contigs": (
            genomes[unbinned]["n_contigs"] / len(contigs) if unbinned is not None else 0.0
        ),
        "frac_bins": (genomes[unbinned]["n_bins"] / n_bins if unbinned is not None else 0.0),
    }
    out["displayable_genomes"] = [g["name"] for g in genomes if g["name"] != UNBINNED]

    # §4 — the free density proxy, from an index already in memory. Emitted for
    # every genome including __unbinned__: the viewer excludes it at display
    # time, and computing it here proves nothing was renumbered to hide it.
    if genome_offset is not None:
        proxy = {}
        for gid, genome in enumerate(genomes):
            c_lo, c_hi = genome_offset[gid], genome_offset[gid + 1]
            b_lo = chrom_offset[c_lo]
            b_hi = chrom_offset[c_hi]
            proxy[genome["name"]] = int(bin1_offset[b_hi] - bin1_offset[b_lo])
        out["density_proxy"] = proxy

    # Not caught: a fixture Python cannot open is a broken fixture, and the
    # generator's job is to say so rather than to write a partial oracle around
    # it. The one shape that used to land here — non-ASCII contig names, which
    # cooler decodes with an ASCII ``astype('U')`` — is a file metacooler now
    # refuses to write at all.
    mc = MetaCooler(uri)
    out["python_open"] = {"ok": True}
    out["golden"] = "full"

    info = {k: jsonable(v) for k, v in mc.info.items() if k not in VOLATILE_INFO_KEYS}
    out["info"] = info
    out["info_volatile_keys"] = sorted(VOLATILE_INFO_KEYS)
    metadata = {
        k: deep_scrub(jsonable(v)) for k, v in mc.metadata.items() if k != "commands"
    }
    out["metadata"] = metadata
    out["metadata_volatile_keys"] = ["commands"]

    binsize = int(mc.binsize) if mc.binsize is not None else None
    out["binsize"] = binsize
    out["shape"] = [int(mc.shape[0]), int(mc.shape[1])]
    out["chromnames"] = list(mc.chromnames)
    out["chromsizes"] = {k: int(v) for k, v in mc.chromsizes.items()}

    out["genome_extent"] = {}
    for genome in genomes:
        try:
            lo, hi = mc.genome_extent(genome["name"])
            out["genome_extent"][genome["name"]] = [int(lo), int(hi)]
        except Exception as exc:  # noqa: BLE001
            out["genome_extent"][genome["name"]] = {
                "error_type": type(exc).__name__,
                "error_message": scrub(str(exc)),
            }

    step = max(1, len(contigs) // CONTIG_SAMPLE)
    sample = [contigs[i]["name"] for i in range(0, len(contigs), step)]
    if contigs and contigs[-1]["name"] not in sample:
        sample.append(contigs[-1]["name"])
    out["contig_extent"] = {
        name: [int(v) for v in mc.contig_extent(name)] for name in sample
    }
    out["contig_extent_sample"] = sample

    out["ranges"] = range_battery(mc, genomes, contigs, binsize or 1)

    integral = out["dtypes"]["pixels"]["count"]["kind"] in ("i", "u")
    out["count_dtype_kind"] = out["dtypes"]["pixels"]["count"]["kind"]

    matrices = []
    for spec in matrix_specs(mc, genomes, contigs, binsize or 1):
        rows = [int(spec["rows"][0]), int(spec["rows"][1])]
        cols = [int(spec["cols"][0]), int(spec["cols"][1])]
        matrices.append(
            {
                **spec,
                "rows": rows,
                "cols": cols,
                "method": "Cooler.matrix(balance=False)",
                "values": dense(mc, (rows[0], rows[1]), (cols[0], cols[1]), integral),
            }
        )

    for level in ("contig", "genome"):
        values, method, error = aggregated(uri, mc, level)
        entry = {
            "id": f"aggregate:{level}",
            "level": level,
            "labels": [c["name"] for c in (contigs if level == "contig" else genomes)],
            "method": method,
            "values": values,
        }
        if error:
            entry["fallback_reason"] = error
        matrices.append(entry)
    out["matrices"] = matrices

    # §5.3 — the transpose oracle. `pixels_for_genome_pair` is symmetric in its
    # arguments by construction, so g1×g2 and g2×g1 must be byte-identical; a
    # reader that only ever queries the upper triangle produces one of them
    # empty.
    chosen = pair_genomes(genomes)
    pairs = []
    if len(chosen) >= 2:
        g1, g2 = chosen[0], chosen[1]
        orientations = [(g1, g2), (g2, g1), (g1, g1)]
        if len(chosen) > 2:
            orientations.extend([(g1, chosen[2]), (chosen[2], g1)])
        for a, b in orientations:
            df = mc.pixels_for_genome_pair(a, b)
            if len(df):
                df = df.sort_values(["bin1_id", "bin2_id"]).reset_index(drop=True)
            pairs.append(
                {
                    "g1": a,
                    "g2": b,
                    "n": int(len(df)),
                    "sum": (int(df["count"].sum()) if integral else float(df["count"].sum()))
                    if len(df)
                    else 0,
                    "pixels": [
                        {
                            "bin1_id": int(r.bin1_id),
                            "bin2_id": int(r.bin2_id),
                            "count": int(r.count) if integral else float(r.count),
                        }
                        for r in df.itertuples(index=False)
                    ],
                }
            )
    out["pixels_for_genome_pair"] = pairs
    return out


def refused_golden(path: Path, descriptor: dict) -> dict:
    """Golden for a fixture the viewer must refuse.

    Carries the attributes that *cause* the refusal with their stored Python
    types, because that is the whole test: ``bin-size`` on ``variable.metacool``
    is the string ``'null'``, and a reader that trusts ``Number()`` or
    truthiness accepts it.
    """
    code = descriptor["expect"].split(":", 1)[1]
    with h5py.File(path, "r") as fh:
        attrs = attrs_block(fh)
        dtypes = {
            tbl: dataset_kinds(fh, tbl)
            for tbl in ("genomes", "contigs", "bins", "pixels", "indexes")
        }
    reasons = {
        "bad-ordering": (
            "contig-ordering is {ordering!r}, not 'genome-then-length'; genomes are "
            "not one contiguous bin range so genome_extent is meaningless (spec C4, §10)."
        ),
        "variable-bins": (
            "bin-type is {bin_type!r} and bin-size is {bin_size!r}; the viewer is "
            "fixed-bin only so that /bins never has to be read (spec §3.3, §10)."
        ),
    }
    ordering = attrs.get("contig-ordering", {}).get("value")
    bin_type = attrs.get("bin-type", {}).get("value")
    bin_size = attrs.get("bin-size", {}).get("value")
    return {
        "fixture": descriptor["name"],
        "uri": descriptor["name"],
        "kind": descriptor["kind"],
        "refuse": code,
        "reason": reasons[code].format(
            ordering=ordering, bin_type=bin_type, bin_size=bin_size
        ),
        "trigger": {
            "contig-ordering": attrs.get("contig-ordering"),
            "bin-type": attrs.get("bin-type"),
            "bin-size": attrs.get("bin-size"),
        },
        "attrs": attrs,
        "dtypes": dtypes,
    }


def mmetacool_golden(path: Path, descriptor: dict) -> dict:
    """Golden for an mmetacool: the root refusal, then a full golden per entry."""
    from metacooler.api import MetaCooler
    from metacooler.schema import list_entry_names, list_metacoolers

    with h5py.File(path, "r") as fh:
        attrs = attrs_block(fh)

    try:
        MetaCooler(str(path))
        root_error = None
    except Exception as exc:  # noqa: BLE001 — this message is the oracle
        root_error = {
            "error_type": type(exc).__name__,
            "error_message": scrub(str(exc)),
        }

    entries = list_entry_names(path)
    numeric = all(name.isdigit() and int(name) > 0 for name in entries) and bool(entries)

    out: dict[str, Any] = {
        "fixture": descriptor["name"],
        "uri": descriptor["name"],
        "kind": "mmetacool",
        "refuse": "mmetacool-root",
        "reason": "an mmetacool is a container of metacools and is not itself a cooler; "
        "open one entry with the '::' syntax (spec §3.4).",
        "attrs": attrs,
        "entries": entries,
        "entry_uris": [f"{descriptor['name']}::{p.lstrip('/')}" for p in list_metacoolers(path)],
        "entry_style": "ladder" if numeric else "samples",
        "root_open": root_error,
        "entry_golden": {},
    }
    for name in entries:
        uri = f"{path}::entries/{name}"
        out["entry_golden"][name] = metacool_golden(
            path, f"/entries/{name}", uri, {"name": f"{descriptor['name']}::entries/{name}"}
        )
        # The URI recorded inside each entry golden is machine-local; rewrite it
        # to the repo-relative form the JS suite will use.
        out["entry_golden"][name]["uri"] = f"{descriptor['name']}::entries/{name}"
    return out


def cooler_golden(path: Path, group: str, descriptor: dict, uri: str) -> dict:
    """Golden for a plain cooler resolution (spec §9, region level only)."""
    import cooler

    clr = cooler.Cooler(f"{path}::{group}" if group != "/" else str(path))
    with h5py.File(path, "r") as fh:
        node = fh[group.lstrip("/")] if group != "/" else fh
        attrs = attrs_block(node)
        dtypes = {tbl: dataset_kinds(node, tbl) for tbl in ("chroms", "bins", "pixels", "indexes")}
        chrom_offset = [int(v) for v in node["indexes/chrom_offset"][:]]
        bin1_offset = [int(v) for v in node["indexes/bin1_offset"][:]]

    info = {k: jsonable(v) for k, v in clr.info.items() if k not in VOLATILE_INFO_KEYS}
    chromnames = list(clr.chromnames)
    chromsizes = {k: int(v) for k, v in clr.chromsizes.items()}
    assembly = info.get("genome-assembly") or "unknown"

    integral = dtypes["pixels"]["count"]["kind"] in ("i", "u")
    first = chromnames[0]
    nbins = int(clr.shape[0])
    win = min(40, nbins // 4)
    matrices = []
    for spec in (
        {"id": f"chrom:{first}", "rows": clr.extent(first), "cols": clr.extent(first)},
        {"id": f"bins:0-{win}x0-{win}", "rows": (0, win), "cols": (0, win)},
        {"id": f"bins:0-{win}x{nbins - win}-{nbins}", "rows": (0, win), "cols": (nbins - win, nbins)},
        {"id": f"bins:{nbins - win}-{nbins}x0-{win}", "rows": (nbins - win, nbins), "cols": (0, win)},
    ):
        r, c = spec["rows"], spec["cols"]
        if r[1] - r[0] > MAX_GOLDEN_AXIS or c[1] - c[0] > MAX_GOLDEN_AXIS:
            continue
        arr = np.asarray(clr.matrix(balance=False)[r[0] : r[1], c[0] : c[1]])
        matrices.append(
            {
                "id": spec["id"],
                "level": "bin",
                "rows": [int(r[0]), int(r[1])],
                "cols": [int(c[0]), int(c[1])],
                "method": "Cooler.matrix(balance=False)",
                "values": [[int(v) for v in row] for row in arr]
                if integral
                else [[float(v) for v in row] for row in arr],
            }
        )

    return {
        "fixture": descriptor["name"],
        "uri": uri,
        "kind": descriptor["kind"],
        "group": group,
        "attrs": attrs,
        "dtypes": dtypes,
        "info": info,
        "info_volatile_keys": sorted(VOLATILE_INFO_KEYS),
        "binsize": int(clr.binsize) if clr.binsize is not None else None,
        "shape": [int(clr.shape[0]), int(clr.shape[1])],
        "chromnames": chromnames,
        "chromsizes": chromsizes,
        "indexes": {"chrom_offset": chrom_offset, "bin1_offset": bin1_offset},
        "bins_columns": sorted(dtypes["bins"]),
        # §9: the metacool view is synthesised so no downstream path branches.
        # One genome row named from the assembly, every contig in it.
        "synthesised_genomes": {
            "columns": ["name", "length", "n_contigs", "n_bins"],
            "rows": [
                {
                    "name": assembly,
                    "length": sum(chromsizes.values()),
                    "n_contigs": len(chromnames),
                    "n_bins": int(clr.shape[0]),
                }
            ],
        },
        "synthesised_genome_offset": [0, len(chromnames)],
        "count_dtype_kind": dtypes["pixels"]["count"]["kind"],
        "matrices": matrices,
        "entry_point": "contigs",
    }


def mcool_golden(path: Path, descriptor: dict) -> dict:
    """Golden for an mcool: root attrs, resolution list, one golden per level."""
    with h5py.File(path, "r") as fh:
        attrs = attrs_block(fh)
        resolutions = sorted(fh["resolutions"].keys(), key=int)
    out = {
        "fixture": descriptor["name"],
        "uri": descriptor["name"],
        "kind": "mcool",
        "attrs": attrs,
        "entries": resolutions,
        "entry_uris": [f"{descriptor['name']}::resolutions/{r}" for r in resolutions],
        "entry_style": "ladder",
        "entry_golden": {},
    }
    for res in resolutions:
        uri = f"{descriptor['name']}::resolutions/{res}"
        out["entry_golden"][res] = cooler_golden(
            path, f"/resolutions/{res}", {**descriptor, "name": uri}, uri
        )
    return out


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    global _SCRUB_PREFIX

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    _SCRUB_PREFIX = f"{args.fixtures.resolve()}/"

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )
    # metacooler warns on float counts and on genome-table divergence; neither
    # is news here and both would drown the progress log.
    logging.getLogger("metacooler").setLevel(logging.ERROR)
    logging.getLogger("cooler").setLevel(logging.ERROR)

    spec_path = args.fixtures / "_fixtures.json"
    if not spec_path.exists():
        raise SystemExit(f"run scripts/make_fixtures.py first: {spec_path} is missing")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_entries = []

    for descriptor in spec["fixtures"]:
        name = descriptor["name"]
        path = args.fixtures / name
        stem = name.replace(".", "_")
        log.info("golden: %s", name)

        if descriptor["expect"].startswith("refuse:") and descriptor["kind"] == "metacool":
            golden = refused_golden(path, descriptor)
        elif descriptor["kind"] == "mmetacool":
            golden = mmetacool_golden(path, descriptor)
        elif descriptor["kind"] == "mcool":
            golden = mcool_golden(path, descriptor)
        elif descriptor["kind"] == "cool":
            golden = cooler_golden(path, "/", descriptor, name)
        else:
            golden = metacool_golden(path, "/", str(path), descriptor)
            golden["uri"] = name

        target = args.out / f"{stem}.json"
        size = dump(golden, target)

        entry = {
            "name": name,
            "kind": descriptor["kind"],
            "expect": descriptor["expect"],
            "golden": target.name,
            "golden_bytes": size,
            "fixture_bytes": descriptor["bytes"],
            "description": descriptor["description"],
            "coverage": golden.get("golden", "full"),
        }
        if "entries" in golden:
            entry["entries"] = golden["entries"]
            entry["entry_uris"] = golden["entry_uris"]
            entry["entry_expect"] = descriptor.get("entry_expect", "accept")
            entry["entry_style"] = golden["entry_style"]
        if "note" in descriptor:
            entry["note"] = descriptor["note"]
        manifest_entries.append(entry)

    import cooler

    import metacooler

    manifest = {
        "generator": "scripts/make_golden.py",
        "metacooler_version": metacooler.__version__,
        "cooler_version": cooler.__version__,
        "info_volatile_keys": sorted(VOLATILE_INFO_KEYS),
        "metadata_volatile_keys": ["commands"],
        "unbinned_name": UNBINNED,
        "non_finite_encoding": "null",
        "reader_notes": READER_NOTES,
        "fixtures": manifest_entries,
    }
    size = dump(manifest, args.out / "_manifest.json")

    log.info("")
    for entry in manifest_entries:
        log.info(
            "  %-26s %9d B  %-22s %s",
            entry["golden"],
            entry["golden_bytes"],
            entry["expect"],
            entry["coverage"],
        )
    log.info("  %-26s %9d B", "_manifest.json", size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
