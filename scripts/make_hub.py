#!/usr/bin/env python3
"""Build a hub — the static catalogue the viewer's Hubs section reads (SPECS §24.3).

Run with any Python 3.9 or newer.  **Standard library only**, deliberately::

    python3 scripts/make_hub.py igv    --out out/igv.json    --timestamp
    python3 scripts/make_hub.py 4dn    --out out/4dn.json    --timestamp
    python3 scripts/make_hub.py encode --out out/encode.json --timestamp
    python3 scripts/make_hub.py bucket https://my-lab.s3.amazonaws.com/hic/ \\
        --name 'Lab Hi-C' --out hub.json
    python3 scripts/make_hub.py check out/4dn.json

The output is a Contract-1 hub: ``kind``, ``version``, ``name``, ``columns`` and
``entries``, each entry a label, a URI, a kind, a size when it is known, a note
and one value per column.  ``src/state/hub.ts`` parses it and
``.github/workflows/hubs.yml`` publishes what this writes to the ``hubs``
branch, where the deploy copies it into the site the viewer reads from.

**Why a script and not the browser.**  The join a shelf needs — accession to
cell line, assay, assembly, lab — lives in a portal's search API, and a portal
is free to refuse a browser's origin, to rate-limit it, or to answer in three
seconds.  None of that is a thing to do on a reader's first click.  So the join
happens here, once a week, and what the reader fetches is one static JSON on a
host that already serves ``Access-Control-Allow-Origin: *``.  It is also what
juicebox.js does — its ENCODE and 4DN menus are tables a script regenerated and
somebody committed (``igvteam/igv-data``, MIT) — and the reason this viewer's
version of that table is not simply *their* table is in SPECS §24.3: a hub that
hot-links another project's file inherits that project's cadence and schema.

**No dependencies, for the same reason the viewer has no backend.**  A weekly
workflow that needs ``pip install`` is a weekly workflow that breaks on a
resolver change, and a contributor who wants to regenerate a hub by hand should
need nothing but the interpreter that is already on the machine.  ``urllib``
fetches, ``json`` parses, ``xml.etree`` reads a bucket listing, ``csv`` reads a
manifest.

## A spine and an enrichment, not one query

The first version of this script asked each portal's search API for *both*
halves of a row — which files exist, and what they are of — and that turned out
to be the wrong shape for "list everything".  A portal's search is paged, slow
over a million records, and answers with whatever its current default facets
allow; an object store's listing is complete by construction, and both of these
stores publish one.  So each portal front end now has two sources and treats
them differently:

``spine``
    What files there are, from a place that cannot be incomplete: 4DN's
    ``ListObjectsV2`` over ``4dn-open-data-public``, and ENCODE's
    ``encode_file_manifest.tsv`` — a 1 GB tab-separated list of every released
    file, rewritten daily at the root of ``encode-public``.  A row exists
    because an object exists.

``enrichment``
    What each file is *of*, from the portal: biosample, assay, target, lab.
    One lean search per portal keyed by accession, never one request per file.
    A file the enrichment does not cover keeps its row and loses cells
    (``--portal optional``), because a catalogue of a million files with two
    empty columns is still a catalogue and a missing one is not.

The old arrangement's failure mode was the silent one: 4DN's
``ExperimentSetReplicate`` search embeds the *set's* processed files and not the
per-experiment ones, so a catalogue built from it alone was missing about nine
files in ten and said nothing about it.

## Five front ends, because there are five places a catalogue comes from

``igv``
    ``igv.org.genomes/genomes.json`` — the reference genomes IGV ships, each a
    FASTA with an index and the annotation tracks that go with it.  One row per
    file this viewer has a route for, and one pre-configured session per genome
    (see below).  IGV's ``refgene`` tracks are UCSC ``genePred`` tables, which
    this viewer has no reader for; they are counted and skipped rather than
    written as rows that cannot open.

``4dn``
    Every routable object on the 4DN open-data bucket, enriched from the
    portal's ``ExperimentSetReplicate`` search.  No experiment-type filter and
    no format filter by default: SPECS §24.3's rule is that the filter belongs
    on *whether this viewer can open the file*, which is one rule that needs no
    maintenance when a consortium's vocabulary grows.

``encode``
    Every released file in ENCODE's manifest this viewer can open, enriched
    from the portal's ``Experiment`` search, **sharded** by assembly and output
    category because the whole of it is 1.2 million rows.  ``--breadth`` picks
    how much of that is published; the default keeps one file per dataset,
    assembly and format, which is 210 thousand rows and every dataset ENCODE
    has.

``bucket``
    ``ListObjectsV2`` over a prefix, one row per object this viewer has a route
    for, aimed at a lab's own bucket — no portal, no metadata beyond the file
    name and the size, which is still enough to choose from.

``check``
    Validate a hub, or a generated session, against its contract.

## Pre-configured sessions

A hub row may be a ``workspace``: a whole saved session, opened through the same
road as ``?config=`` (SPECS §24.1).  That is the right shape for "a genome and
everything published with it" — IGV's hg38 is a FASTA, its index and a gene
track, and offering those as three rows asks the reader to assemble what IGV had
already assembled.  So a front end may also write **session files**: one
``.metacooler.json`` per genome or per experiment set, with the tracks placed,
and a hub of its own listing them (``--sessions-dir``/``--sessions-out``).  The
viewer needs no new code for this — a workspace row is a road it already has.

**Two facts worth not rediscovering**, both recorded in SPECS §24.3:

1. A 4DN search with no hits answers **HTTP 404 with a JSON body**.  That is
   zero results, not a failure, and a generator that crashes on it fails every
   week the query is narrowed by one facet too many.
2. A bucket listing's ``<Contents>`` carries a ``<ChecksumAlgorithm>`` and a
   ``<ChecksumType>`` between ``<ETag>`` and ``<Size>`` on newer objects.  The
   census that preceded this script parsed those blocks with a regular
   expression assuming four elements in a fixed order, and undercounted every
   category by about a quarter — silently.  So the XML is parsed **as XML**,
   element by name, and the order in the document means nothing.

**Zero entries exits 2**, distinct from the 1 an HTTP failure exits with, so the
workflow can refuse to publish an empty hub over a good one without having to
tell a portal outage apart from an empty catalogue by reading a log.

**Every field access is tolerant.**  ``.get`` and a default, never a subscript:
the first live run of any change here happens in CI against a portal nobody can
reach from a development sandbox, and a ``KeyError`` on the four-hundredth
record throws away the other three hundred and ninety-nine.  A field that has
moved leaves a column empty, which is visible in the published hub and fixable
next week; a field that has moved must never lose the row.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

log = logging.getLogger("make_hub")

#: `src/state/hub.ts` refuses anything else, and refuses a newer major version
#: the way it refuses a newer workspace. Bump both together or not at all.
HUB_KIND = "metacooler.hub"
HUB_VERSION = 1

#: `src/state/workspace.ts` and `src/state/SessionConfig.ts`, for the sessions
#: this script writes. Same rule: bump with the reader or not at all.
WORKSPACE_KIND = "metacooler.workspace"
CONFIG_VERSION = 1

#: What a generated session says wrote it. `SessionConfig.producer` is "which
#: build wrote this", and the honest answer for these is not a viewer build.
PRODUCER = "metacooler.js make_hub.py"

#: Named, because a portal that rate-limits or blocks has to be able to tell who
#: this is and where to complain. `urllib`'s default identifies only Python.
USER_AGENT = "metacooler.js make_hub.py (+https://github.com/js2264/metacooler.js)"

#: Seconds. A portal answering `limit=all` is doing real work — 4DN's set query
#: is thousands of embedded files — so this is generous; it exists to stop a
#: hung socket from holding a weekly job open for six hours.
TIMEOUT = 600

PORTAL_4DN = "https://data.4dnucleome.org"
PORTAL_ENCODE = "https://www.encodeproject.org"

#: The 4DN open-data bucket, and the two prefixes everything on it lives under.
#: `wfoutput/` is pipeline output — the maps, the tracks, the pairs — and
#: `files/` is what was uploaded: reference FASTAs, chrom.sizes, some BEDs, and
#: 27,000 FASTQs this viewer has no route for and does not list.
BUCKET_4DN = "https://4dn-open-data-public.s3.amazonaws.com"
PREFIXES_4DN = ("fourfront-webprod/wfoutput/", "fourfront-webprod/files/")

#: ENCODE's own list of every file it has, at the root of the public bucket and
#: rewritten daily. One gigabyte of TSV, which is a minute of CI and the only
#: complete answer to "what does ENCODE have" that does not involve paging a
#: search API a million records deep.
MANIFEST_ENCODE = "https://encode-public.s3.amazonaws.com/encode_file_manifest.tsv"

#: IGV's genome table, as igv.js reads it. The same file the IGV desktop app and
#: igv.js both load their genome menu from, so a reader who knows IGV's hg38
#: recognises this row.
IGV_GENOMES = "https://s3.amazonaws.com/igv.org.genomes/genomes.json"

#: The `field=` list igv-data's `update4DN.py` uses, minus its experiment-type
#: filter (see the module docstring), plus the three file arrays the set-level
#: one leaves out. `field=processed_files` embeds each file whole, which is where
#: `open_data_url`, `genome_assembly`, `file_size` and `track_and_facet_info`
#: come from — there is no second request per file.
#:
#: The three additions matter and cost one request between them:
#: `experiments_in_set.processed_files` is where nine files in ten actually live
#: (a per-experiment .bw, .bed or .pairs belongs to the experiment, not to the
#: replicate set), and the two `other_processed_files` arrays are the
#: supplementary groups a curator attaches — higlass views, loops, insulation.
QUERY_4DN = (
    f"{PORTAL_4DN}/search/?type=ExperimentSetReplicate"
    "&field=accession"
    "&field=award.project"
    "&field=processed_files"
    "&field=other_processed_files"
    "&field=experiments_in_set.processed_files"
    "&field=experiments_in_set.other_processed_files"
    "&field=dataset_label"
    "&field=lab.display_title"
    "&field=experiments_in_set.experiment_type.display_title"
    "&field=experiments_in_set.biosample.biosource.organism.name"
    "&field=publications_of_set.display_title"
    "&format=json"
    "&limit=all"
)

#: ENCODE's datasets, **not** its files: the manifest is the file list, and what
#: the portal is asked for is the join — what each experiment was done on and
#: with. One record per experiment rather than one per file is the difference
#: between a 25,000-record answer and a 1,200,000-record one.
QUERY_ENCODE = (
    f"{PORTAL_ENCODE}/search/?type=Experiment"
    "&status=released"
    "&field=accession"
    "&field=biosample_summary"
    "&field=assay_title"
    "&field=assay_term_name"
    "&field=lab.title"
    "&field=target.title"
    "&field=description"
    "&format=json"
    "&limit=all"
)

#: Fixed per front end, and fixed in *order*: the columns are the table's header
#: row, so a generator that emitted them in dictionary order would reshuffle a
#: reader's shelf every week for no reason. Assembly leads because it is the
#: first thing anybody filters on and the first sort key below.
#:
#: `format` joined the two portal front ends when they stopped being Hi-C-only.
#: With one format per hub it carried nothing; with nine of them it is the
#: column a reader narrows on first — *the bigWigs on GM12878*, not *the files*.
COLUMNS_4DN = [
    {"key": "assembly", "label": "Assembly"},
    {"key": "biosource", "label": "Biosource"},
    {"key": "assay", "label": "Assay"},
    {"key": "format", "label": "Format"},
    {"key": "dataset", "label": "Dataset"},
    {"key": "lab", "label": "Lab"},
    {"key": "project", "label": "Project"},
]

COLUMNS_ENCODE = [
    {"key": "assembly", "label": "Assembly"},
    {"key": "biosample", "label": "Biosample"},
    {"key": "assay", "label": "Assay"},
    {"key": "format", "label": "Format"},
    {"key": "target", "label": "Target"},
    {"key": "output", "label": "Output"},
    {"key": "lab", "label": "Lab"},
]

#: IGV's table is not about experiments, so its columns are not the portals':
#: what distinguishes two rows here is which assembly they belong to and what
#: part of it they are — the sequence, or something drawn along it.
COLUMNS_IGV = [
    {"key": "assembly", "label": "Assembly"},
    {"key": "genome", "label": "Genome"},
    {"key": "role", "label": "Role"},
    {"key": "format", "label": "Format"},
    {"key": "host", "label": "Host"},
]

#: A session hub's columns. `tracks` is a count and is why this is not simply a
#: `kind: workspace` row inside the data hub: the one thing a reader wants to
#: know before opening a pre-configured session is how much it is about to put
#: on screen.
COLUMNS_SESSIONS = [
    {"key": "assembly", "label": "Assembly"},
    {"key": "subject", "label": "Genome or dataset"},
    {"key": "tracks", "label": "Tracks"},
    {"key": "source", "label": "Source"},
]

#: What a name is worth clicking on, mirroring `src/browse/route.ts`.
#:
#: Two implementations of one rule is exactly the arrangement that docblock
#: argues against, and it is unavoidable across a language boundary: this script
#: cannot import TypeScript and the viewer cannot run Python. So the rule is
#: copied with its source named, and the cost of them drifting is bounded — a
#: hub row the viewer greys out, or an openable file missing from a catalogue,
#: neither of which is silent. Keep them in step.
ROUTE_WORKSPACE = re.compile(r"\.metacooler\.json$", re.I)
ROUTE_MAP = re.compile(
    r"(\.([ms]?cool|m?metacool|hic|h5|hdf5)|\.pairs(\.gz)?|\.matrix(\.gz)?)$", re.I
)
ROUTE_GENOME = re.compile(
    r"\.(bw|bigwig|bb|bigbed|chrom\.sizes|sizes|genome|fai|fa|fasta|fna|fas|gtf|gff3?"
    r"|bed|bedpe|narrowPeak|broadPeak|gappedPeak|vcf|bdg|bedgraph|wig|bam)(\.gz)?$",
    re.I,
)


def route_of(name: str) -> Optional[str]:
    """``'map'``, ``'genome'``, ``'workspace'`` — or ``None`` for a name with no door."""
    bare = name.split("?")[0].split("#")[0].rsplit("/", 1)[-1]
    if ROUTE_WORKSPACE.search(bare):
        return "workspace"
    if ROUTE_MAP.search(bare):
        return "map"
    if ROUTE_GENOME.search(bare):
        return "genome"
    return None


#: The suffix a row's Format cell shows, from the file name. Not `route_of`'s
#: answer, which is a door and not a format: a reader filtering for `mcool`
#: does not want every map.
FORMAT_SUFFIXES = (
    ".mcool",
    ".scool",
    ".cool",
    ".metacool",
    ".mmetacool",
    ".hic",
    ".hdf5",
    ".h5",
    ".pairs.gz",
    ".pairs",
    ".matrix.gz",
    ".matrix",
    ".bigwig",
    ".bw",
    ".bigbed",
    ".bb",
    ".bedgraph.gz",
    ".bedgraph",
    ".bdg",
    ".narrowpeak.gz",
    ".narrowpeak",
    ".broadpeak.gz",
    ".broadpeak",
    ".gappedpeak.gz",
    ".gappedpeak",
    ".bedpe.gz",
    ".bedpe",
    ".bed.gz",
    ".bed",
    ".gff3.gz",
    ".gff3",
    ".gff.gz",
    ".gff",
    ".gtf.gz",
    ".gtf",
    ".vcf.gz",
    ".vcf",
    ".wig.gz",
    ".wig",
    ".chrom.sizes",
    ".sizes",
    ".genome",
    ".fasta.gz",
    ".fasta",
    ".fna.gz",
    ".fna",
    ".fas.gz",
    ".fas",
    ".fa.gz",
    ".fa",
    ".fai",
    ".bam",
)


def format_of(name: str) -> str:
    """``mcool``, ``bed.gz``, ``bam`` — the longest known suffix of a file name.

    Longest-match rather than "everything after the last dot", because the
    difference between ``.bed`` and ``.bed.gz`` is whether there is a ``.tbi``
    beside it, and because ``4DNFIOKRZ21H.mcool`` and ``ENCFF001.bed.gz`` are
    both names whose last dot is in the wrong place for one of them.
    """
    bare = name.split("?")[0].split("#")[0].rsplit("/", 1)[-1].lower()
    for suffix in FORMAT_SUFFIXES:
        if bare.endswith(suffix):
            return suffix.lstrip(".")
    tail = bare.rsplit(".", 1)
    return tail[-1] if len(tail) > 1 else ""


# ---------------------------------------------------------------------------
# Reading a response without trusting its shape
# ---------------------------------------------------------------------------


def text(value: Any) -> str:
    """A field as a trimmed string, or ``''`` for anything that is not one.

    A portal that starts answering ``null`` where it answered a string, or a
    number where it answered a string, changes one cell of one row here instead
    of ending the run.
    """
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def listed(value: Any) -> list:
    """A field as a list, wrapping the single-object form and dropping the rest.

    ``biosample.biosource`` is an array in the 4DN schema and a single object in
    plenty of records; ``processed_files`` is absent entirely on an experiment
    set that has none. All three answer here.
    """
    if isinstance(value, list):
        return value
    if value is None or value == "":
        return []
    return [value]


def dig(value: Any, *path: str) -> Any:
    """Walk a nested mapping, answering ``None`` the moment the road stops."""
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def join_unique(values: Iterable[Any], separator: str = ", ") -> str:
    """Join the non-empty values, first occurrence wins, order preserved.

    An experiment set with four experiments of one type must not read
    "in situ Hi-C, in situ Hi-C, in situ Hi-C, in situ Hi-C", and the order
    the portal answered in is the order the curator entered.
    """
    seen: set[str] = set()
    kept: list[str] = []
    for value in values:
        one = text(value)
        if one == "" or one in seen:
            continue
        seen.add(one)
        kept.append(one)
    return separator.join(kept)


def size_of(value: Any) -> Optional[int]:
    """A byte count, or ``None`` when the portal did not give one.

    Contract 1 makes ``size`` optional precisely so that "unknown" and "zero"
    stay different: a row with no size draws no warning, a row of zero bytes is
    a broken upload.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def joined_note(*pieces: Any) -> str:
    """The note cell: the non-empty pieces, ` · `-separated.

    The same separator the demo hub's hand-written notes use, so a generated row
    and a written one look like rows of one table.
    """
    return " · ".join(piece for piece in (text(p) for p in pieces) if piece != "")


def host_of(url: str) -> str:
    """The host a row's bytes come from, for a Host column or a note.

    Worth a cell of its own on the IGV hub and nowhere else: its rows come from
    four hosts — IGV's bucket, UCSC's download server, GenePattern's bucket, the
    1000 Genomes bucket — and which one decides whether a file answers CORS at
    all. On a portal hub every row is on the portal's own bucket and the column
    would be one value repeated.
    """
    try:
        return urllib.parse.urlsplit(url).netloc
    except ValueError:
        return ""


# ---------------------------------------------------------------------------
# The three transports
# ---------------------------------------------------------------------------


def _request(url: str, accept: str) -> Any:
    """One GET, answering the open response — or a ``SystemExit`` naming the host.

    The response rather than its bytes, because the ENCODE manifest is a
    gigabyte and reading it into memory to split it into lines would be a
    gigabyte of string on top of a gigabyte of bytes. Callers that want the
    whole thing say so; the manifest reader streams.
    """
    request = urllib.request.Request(
        url, headers={"Accept": accept, "User-Agent": USER_AGENT}
    )
    log.debug("GET %s", url)
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT)
    except urllib.error.HTTPError as error:
        body = b""
        try:
            body = error.read()
        except Exception:  # noqa: BLE001 - the body is a courtesy, not a requirement
            pass
        raise _HttpFailure(error.code, error.reason, url, body) from error
    except urllib.error.URLError as error:
        raise SystemExit(
            f"Could not reach {url}\n"
            f"  {error.reason}\n"
            "  Nothing was written. A hub is only replaced by a run that succeeded, so the "
            "previously published one is still the one readers see."
        ) from error


def _read(url: str, accept: str) -> bytes:
    """One GET, whole. For everything that is not the manifest."""
    with _request(url, accept) as response:
        return response.read()


class _HttpFailure(Exception):
    """An HTTP status the caller may still want to interpret (see 4DN's 404)."""

    def __init__(self, code: int, reason: Any, url: str, body: bytes) -> None:
        super().__init__(f"HTTP {code} from {url}")
        self.code = code
        self.reason = reason
        self.url = url
        self.body = body


def fetch_json(url: str) -> dict:
    """Fetch a portal search, treating a JSON-bodied 404 as zero results.

    That last clause is 4DN's, and it is load-bearing: the portal answers a
    search matching nothing with ``404`` and an ``HTTPNotFound`` body rather
    than ``200`` and an empty ``@graph``.  A generator that raised there would
    report an outage every time a facet was narrowed too far — and the caller
    already refuses to publish an empty hub, which is the correct response to
    both.  A 404 with an HTML body is something else (a moved endpoint), and
    still fails.
    """
    try:
        raw = _read(url, "application/json")
    except _HttpFailure as failure:
        empty = _json_or_none(failure.body)
        if failure.code == 404 and empty is not None:
            log.info("%s answered 404 with a JSON body: zero results.", failure.url)
            return empty if isinstance(empty, dict) else {}
        raise SystemExit(
            f"{failure.url}\n"
            f"  answered HTTP {failure.code} {failure.reason}.\n"
            "  Nothing was written. Check the portal's status page, then rerun; if the query "
            "itself is wrong the body above says so."
        ) from failure
    parsed = _json_or_none(raw)
    if not isinstance(parsed, dict):
        raise SystemExit(
            f"{url}\n"
            "  answered something that is not a JSON object. A portal that has been put behind "
            "an interstitial answers HTML with status 200, which looks exactly like this."
        )
    return parsed


def fetch_json_list(url: str) -> list:
    """Fetch a JSON document that is a list at its top level — IGV's genome table.

    Its own function rather than a flag on {@link fetch_json}, because the two
    have different failure sentences: a portal that answers a bare list has
    changed its API, and a genome table that answers an object has been replaced
    by an error document.
    """
    raw = _read(url, "application/json")
    parsed = _json_or_none(raw)
    if not isinstance(parsed, list):
        raise SystemExit(
            f"{url}\n"
            "  answered something that is not a JSON array. IGV's genome table is a list of "
            "genome objects; a host that has moved the file answers HTML with status 200, "
            "which looks exactly like this."
        )
    return parsed


def _json_or_none(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None


def fetch_lines(url: str) -> Iterator[str]:
    """Stream a text file line by line, decoded, without holding it in memory.

    For ENCODE's manifest, which is a gigabyte. Held whole it would be two
    gigabytes of process — the bytes and the string — for a file every line of
    which is read once and thrown away, and a CI runner with two gigabytes of
    headroom is not a thing to depend on weekly.
    """
    try:
        response = _request(url, "text/tab-separated-values")
    except _HttpFailure as failure:
        raise SystemExit(
            f"{failure.url}\n"
            f"  answered HTTP {failure.code} {failure.reason}.\n"
            "  Nothing was written. This is the file ENCODE rewrites at the root of its public "
            "bucket every day; a 404 here means it has been moved or renamed."
        ) from failure
    with response:
        # `newline=''` because this is a TSV read through `csv`, which wants the
        # line endings the file has; `errors='replace'` because one mangled byte
        # in a million rows must not end the run.
        stream = io.TextIOWrapper(response, encoding="utf-8", errors="replace", newline="")
        for line in stream:
            yield line


def fetch_xml(url: str) -> bytes:
    """Fetch a bucket listing, turning a refusal into the sentence that fixes it.

    A bucket answers ``403 AccessDenied`` when anonymous listing is off and
    ``404 NoSuchBucket`` when the name is wrong, both with an XML ``<Error>``
    body that says which — and those two are the whole of what goes wrong here,
    so the message repeats the bucket's own words rather than the status.
    """
    try:
        return _read(url, "application/xml")
    except _HttpFailure as failure:
        detail = ""
        try:
            error = ElementTree.fromstring(failure.body)
            if local(error.tag) == "Error":
                detail = f"{child_text(error, 'Code')} — {child_text(error, 'Message')}"
        except ElementTree.ParseError:
            pass
        raise SystemExit(
            f"{failure.url}\n"
            f"  answered HTTP {failure.code} {failure.reason}. {detail}\n"
            "  Files under the prefix may still open by URL; only building a catalogue from it "
            "needs `s3:ListBucket` for anonymous callers."
        ) from failure


#: What a probe answered: whether the file opens at all, and how big it is.
#:
#: The two are one request because they are one question — *can a browser with
#: no credentials read this, and what will it cost* — and because the answer to
#: the second is a header on the answer to the first.
class Probed:
    __slots__ = ("ok", "size", "why")

    def __init__(self, ok: bool, size: Optional[int], why: str = "") -> None:
        self.ok = ok
        self.size = size
        self.why = why


def probe(url: str, timeout: int = 30, attempts: int = 2) -> Probed:
    """Ask for the first byte of *url*, the way the viewer will.

    **A ranged GET and not a ``HEAD``**, because the two are different questions
    on a real bucket: ``igv-genepattern-org`` answers 403 to both and
    ``hgdownload`` refuses ``HEAD`` while serving ranges perfectly. What this
    front end needs to know is whether *the request the viewer makes* succeeds
    without credentials, so it makes that request.

    It exists because IGV's genome table names files on four hosts, and one of
    them is not public: the bucket behind IGV's own ``hg38``, ``hg19`` and three
    smaller genomes answers ``AccessDenied`` to an anonymous reader. Listing
    those as rows would be exactly the failure this front end avoids for
    ``refgene`` tracks — a row that fails when it is clicked — so a row is
    written only for a file that answered. If the permissions are ever fixed,
    next Monday's run picks the rows up with no change here.

    ``Content-Range: bytes 0-0/12400379`` carries the total, which is the size a
    hub row needs (§24.1) and the one thing IGV's table does not carry.

    Two attempts, because a single timeout must not silently cost a genome a
    week, and never fatal: a probe that cannot decide answers "not ok", which
    shows up as a missing row and a line in the log rather than as a broken run.
    """
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"}
    )
    last = ""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                total = _range_total(response.headers.get("Content-Range"))
                return Probed(True, total if total is not None else size_of(
                    response.headers.get("Content-Length")
                ))
        except urllib.error.HTTPError as error:
            # A status is a decision and not a hiccup: 403 on an anonymous read
            # will still be 403 in ten seconds.
            return Probed(False, None, f"HTTP {error.code} {error.reason}")
        except Exception as error:  # noqa: BLE001 - a timeout, a reset, a DNS failure
            last = str(error)
            log.debug("probe %s failed on attempt %d: %s", url, attempt + 1, last)
    return Probed(False, None, last)


def _range_total(header: Any) -> Optional[int]:
    """The total length out of a ``Content-Range``, or ``None``."""
    match = re.search(r"/(\d+)\s*$", text(header))
    return int(match.group(1)) if match is not None else None


def local(tag: str) -> str:
    """An element's name without its namespace.

    S3 answers in ``http://s3.amazonaws.com/doc/2006-03-01/`` and Google's
    interoperability endpoint in ``http://doc.s3.amazonaws.com/2006-03-01`` —
    the same document, two namespaces, and matching on either by name would
    make one of them unreadable for no reason.
    """
    return tag.rsplit("}", 1)[-1]


def child_text(element: ElementTree.Element, name: str) -> str:
    """The text of the first child element with this local name, or ``''``.

    **By name, never by position.** Newer objects carry ``<ChecksumAlgorithm>``
    and ``<ChecksumType>`` between ``<ETag>`` and ``<Size>``; the 4DN census
    that read the block positionally lost a quarter of the bucket to exactly
    that (SPECS §24.3).
    """
    for child in element:
        if local(child.tag) == name:
            return (child.text or "").strip()
    return ""


def parse_listing(raw: bytes) -> tuple[list[dict], Optional[str]]:
    """One ``ListObjectsV2`` page: its objects, and the token for the next.

    Returns ``(objects, token)``; ``token`` is ``None`` on the last page.
    """
    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError as error:
        raise SystemExit(
            "That prefix answered something that is not a bucket listing "
            f"({error}). A bucket that refuses anonymous listing answers an "
            "<Error> document, which parses; a host that is not S3 answers HTML, which does not."
        ) from error
    if local(root.tag) == "Error":
        raise SystemExit(
            "The bucket refused the listing: "
            f"{child_text(root, 'Code')} — {child_text(root, 'Message')}\n"
            "  Reading files under the prefix by URL may still work; only building a catalogue "
            "from it needs `s3:ListBucket` for anonymous callers."
        )
    objects: list[dict] = []
    for element in root:
        if local(element.tag) != "Contents":
            continue
        key = child_text(element, "Key")
        if key == "" or key.endswith("/"):
            # A zero-byte key ending in `/` is a console-made "folder", not a file.
            continue
        objects.append(
            {
                "key": key,
                "size": size_of(child_text(element, "Size")),
                "modified": child_text(element, "LastModified"),
            }
        )
    truncated = child_text(root, "IsTruncated").lower() == "true"
    token = child_text(root, "NextContinuationToken")
    return objects, (token if truncated and token != "" else None)


# ---------------------------------------------------------------------------
# Recorded responses
# ---------------------------------------------------------------------------


def recorded(path: Path, suffix: str) -> list[bytes]:
    """Read one recorded response, or a directory of pages in name order.

    A directory because a paged source records as several files, and because a
    fixture that has to be one document cannot record the seam between two
    pages — which is where a continuation token is either honoured or dropped.
    """
    if path.is_dir():
        pages = sorted(p for p in path.iterdir() if p.suffix.lower() == suffix)
        if not pages:
            raise SystemExit(f"{path} holds no *{suffix} to read.")
        return [page.read_bytes() for page in pages]
    if not path.exists():
        raise SystemExit(f"{path} does not exist.")
    return [path.read_bytes()]


def recorded_graph(path: Path) -> list:
    """The ``@graph`` of one recorded search, or of every page in a directory."""
    graph: list = []
    for page in recorded(path, ".json"):
        parsed = _json_or_none(page)
        if not isinstance(parsed, dict):
            raise SystemExit(f"{path} is not a JSON object.")
        graph.extend(listed(parsed.get("@graph")))
    return graph


def recorded_list(path: Path) -> list:
    """A recorded JSON document that is a list — IGV's genome table."""
    parsed = _json_or_none(recorded(path, ".json")[0])
    if not isinstance(parsed, list):
        raise SystemExit(f"{path} is not a JSON array.")
    return parsed


def recorded_lines(path: Path) -> Iterator[str]:
    """A recorded manifest, line by line, from a ``.tsv`` file."""
    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        for line in handle:
            yield line


# ---------------------------------------------------------------------------
# Walking a bucket
# ---------------------------------------------------------------------------


def bucket_address(prefix_url: str) -> tuple[str, str, str]:
    """``(root, bucket, prefix)`` for an https bucket URL.

    ``root`` is what a listing query and an object URL are both built on, so
    the two cannot disagree about path-style versus virtual-hosted addressing.
    The split mirrors ``addressOf`` in ``src/s3/credentials.ts``.
    """
    parsed = urllib.parse.urlsplit(prefix_url)
    if parsed.scheme not in ("http", "https") or parsed.netloc == "":
        raise SystemExit(
            f"{prefix_url} is not an https URL. The bucket front end walks a public listing "
            "endpoint, so it needs the URL a browser would use — "
            "https://<bucket>.s3.amazonaws.com/<prefix>/ or "
            "https://<endpoint>/<bucket>/<prefix>/."
        )
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path = parsed.path.lstrip("/")
    virtual = re.match(r"^([^.]+)\.s3([.-]|$)", parsed.netloc, re.I)
    if virtual is not None:
        return origin, virtual.group(1), urllib.parse.unquote(path)
    if path == "":
        raise SystemExit(
            f"{prefix_url} does not name a bucket: on a host that is not <bucket>.s3.…, the "
            "first path segment is the bucket name."
        )
    bucket, _, rest = path.partition("/")
    return f"{origin}/{bucket}", bucket, urllib.parse.unquote(rest)


def walk_objects(
    prefix_url: str,
    *,
    max_keys: int = 1000,
    pages: Optional[list[bytes]] = None,
) -> Iterator[dict]:
    """Every object under a prefix, as ``{key, size, modified, root}`` dicts.

    A generator, and the split from the entry-building above it is what made the
    4DN front end possible: the same walk feeds a plain catalogue of a lab's
    bucket and a portal-enriched catalogue of 4DN's, and neither knows about the
    other. ``root`` rides along on each object because a caller assembling a URL
    should not have to re-derive the addressing style the listing was made with.

    ``pages`` replaces the network with recorded XML — one page per file, in
    name order — which is how the continuation-token seam is exercised without
    a bucket.
    """
    root, bucket, prefix = bucket_address(prefix_url)
    token: Optional[str] = None
    recorded_pages = list(pages) if pages is not None else None
    walked = 0

    while True:
        if recorded_pages is not None:
            if not recorded_pages:
                break
            raw = recorded_pages.pop(0)
        else:
            query = {"list-type": "2", "prefix": prefix, "max-keys": str(max_keys)}
            if token is not None:
                query["continuation-token"] = token
            raw = fetch_xml(f"{root}/?{urllib.parse.urlencode(query)}")

        objects, token = parse_listing(raw)
        walked += len(objects)
        for item in objects:
            yield {**item, "root": root}
        if token is None:
            break

    log.info("Walked %d objects under %s in %s.", walked, prefix or "/", bucket)


def object_url(item: dict) -> str:
    """The https URL of one walked object.

    ``quote`` with the default safe set plus ``/``: a key is a path, and a key
    carrying a space or a bracket — 4DN has both — must come out as a URL that
    resolves rather than as one a browser re-encodes differently.
    """
    return f"{item['root']}/{urllib.parse.quote(item['key'])}"


def entries_from_objects(objects: Iterable[dict], prefix: str, limit: Optional[int]) -> list[dict]:
    """Every routable object under a walked prefix, as entries. The ``bucket`` front end.

    No metadata beyond the name, the size and the folder, because that is the
    whole of what a bucket knows — and it is still enough to choose from, which
    is the point GAPS G10 and SPECS §11 were making.
    """
    # The folder part of the prefix, so that a partial prefix (`…/wfoutput/000`)
    # still reports whole folder names rather than the tail of one.
    prefix_path = urllib.parse.unquote(urllib.parse.urlsplit(prefix).path.lstrip("/"))
    prefix_dir = prefix_path[: prefix_path.rfind("/") + 1]
    entries: list[dict] = []
    for item in objects:
        key = item["key"]
        name = key.rsplit("/", 1)[-1]
        kind = route_of(name)
        if kind is None:
            continue
        # The folder the object sits in, relative to the prefix that was
        # walked: on 4DN's bucket that is the file's UUID, which is the only
        # thing distinguishing two objects of the same name.
        inside = key[len(prefix_dir):] if key.startswith(prefix_dir) else key
        folder = inside.rsplit("/", 1)[0] if "/" in inside else ""
        entries.append(
            {
                "label": name,
                "url": object_url(item),
                "kind": kind,
                "size": item["size"],
                "note": folder,
                "fields": {},
            }
        )
        if limit is not None and len(entries) >= limit:
            log.info("Stopped at the --limit of %d entries.", limit)
            return entries
    return entries


# ---------------------------------------------------------------------------
# Front end: 4DN
# ---------------------------------------------------------------------------


def accession_in(at_id: Any) -> str:
    """The accession inside a portal ``@id`` path, or ``''``.

    ``/experiment-set-replicates/4DNESD117NVX/`` → ``4DNESD117NVX``. Written as
    "the last non-empty segment" rather than as igv-data's ``id[28:][:-1]``,
    which is the same answer for as long as nobody renames the collection.
    """
    path = text(at_id)
    if path == "":
        return ""
    segments = [segment for segment in path.split("/") if segment != ""]
    return segments[-1] if segments else ""


def _files_in(value: Any) -> Iterator[dict]:
    """Every file object in one of 4DN's file arrays, flat.

    ``processed_files`` is a list of files; ``other_processed_files`` is a list
    of *groups*, each ``{title, type, files: []}``. Both shapes arrive here and
    neither is worth a second reader — a member with a ``files`` list is a group
    and is descended into, a member without one is a file.
    """
    for item in listed(value):
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("files"), list):
            for held in item["files"]:
                if isinstance(held, dict):
                    yield held
            continue
        yield item


def metadata_4dn(graph: list) -> dict[str, dict]:
    """Every file the portal describes, keyed by accession.

    The enrichment half of the 4DN front end (see the module docstring): what
    each accession is *of*. The bucket says which accessions exist, and this
    says what to put in their cells — so a file the portal has moved out of its
    search still gets a row, and a row the portal describes gets seven columns.

    One pass over the sets, four file arrays deep, and no request per file.
    """
    index: dict[str, dict] = {}
    for record in graph:
        if not isinstance(record, dict):
            continue

        # `field=` does not always return `accession`, and the contract fixes the
        # field list, so the set's accession comes off its `@id`
        # (`/experiment-set-replicates/4DNES.../`) when it is not there.
        experiment_set = text(record.get("accession")) or accession_in(record.get("@id"))
        project = text(dig(record, "award", "project"))
        set_lab = text(dig(record, "lab", "display_title"))
        set_dataset = text(record.get("dataset_label"))
        publications = join_unique(
            dig(publication, "display_title")
            for publication in listed(record.get("publications_of_set"))
        )
        # De-duplicated and joined: a replicate set of four in-situ Hi-C
        # experiments is one assay to a reader, and a set that mixes Hi-C with
        # Micro-C is genuinely two and should say so.
        set_types = join_unique(
            dig(experiment, "experiment_type", "display_title")
            for experiment in listed(record.get("experiments_in_set"))
        )
        # A species is not a biosource, but it beats an empty Biosource cell on
        # a row whose file carries no `track_and_facet_info` — and it is a value
        # worth filtering on, which is what the column is for.
        organisms = join_unique(
            dig(biosource, "organism", "name")
            for experiment in listed(record.get("experiments_in_set"))
            for biosource in listed(dig(experiment, "biosample", "biosource"))
        )

        groups: list[Any] = [record.get("processed_files"), record.get("other_processed_files")]
        for experiment in listed(record.get("experiments_in_set")):
            if not isinstance(experiment, dict):
                continue
            groups.append(experiment.get("processed_files"))
            groups.append(experiment.get("other_processed_files"))

        for group in groups:
            for item in _files_in(group):
                accession = text(item.get("accession")) or accession_in(item.get("@id"))
                if accession == "":
                    continue
                facets = item.get("track_and_facet_info")
                facets = facets if isinstance(facets, dict) else {}
                biosource = text(facets.get("biosource_name")) or organisms
                experiment_type = text(facets.get("experiment_type")) or set_types
                assay_info = text(facets.get("assay_info"))
                # "in situ Hi-C (MboI)": the experiment type carries what was
                # done and `assay_info` the enzyme that distinguishes two runs
                # of it. One cell, because a table with an Assay column and an
                # Enzyme column has a column nobody filters on.
                assay = (
                    f"{experiment_type} ({assay_info})"
                    if experiment_type and assay_info
                    else experiment_type or assay_info
                )
                dataset = text(facets.get("dataset")) or set_dataset
                # First writer wins. An accession appears in more than one of
                # the four arrays — a set's processed file is often also its
                # experiment's — and the set-level description is the one a
                # reader means, so it is not overwritten by a later pass.
                index.setdefault(
                    accession,
                    {
                        "assembly": text(item.get("genome_assembly")),
                        "biosource": biosource,
                        "assay": assay,
                        "dataset": dataset,
                        "lab": text(facets.get("experimental_lab")) or set_lab,
                        "project": project,
                        "title": text(facets.get("track_title")),
                        "set": experiment_set,
                        "publications": publications,
                        "condition": text(facets.get("condition")),
                        "replicate": text(facets.get("replicate_info")),
                        "size": size_of(item.get("file_size")),
                        "type": text(item.get("file_type")) or text(
                            dig(item, "file_format", "file_format")
                        ),
                    },
                )
    log.info("The portal described %d files.", len(index))
    return index


def entries_4dn(
    objects: Iterable[dict],
    index: dict[str, dict],
    formats: Optional[tuple[str, ...]],
    limit: Optional[int],
) -> list[dict]:
    """One entry per routable object on the 4DN bucket, enriched where the portal knows it.

    The whole filter is *can this viewer open the name*, which is `route_of`
    and nothing else. That is the rule SPECS §24.3 argues for: a filter on the
    file rather than on the experiment type needs no maintenance when the
    consortium's vocabulary grows, and it is why Micro-C, sn-Hi-C and whatever
    comes next are in a hub nobody edited. ``--formats`` narrows it for a dry
    run and is ``None`` — everything — for a publish.

    A file the portal did not describe still gets a row: it is a real object on
    an open bucket, its name carries its accession, and the alternative is a
    catalogue that quietly omits what the search API's facets happened to miss.
    """
    entries: list[dict] = []
    described = 0
    for item in objects:
        key = item["key"]
        name = key.rsplit("/", 1)[-1]
        kind = route_of(name)
        if kind is None:
            continue
        suffix = format_of(name)
        if formats is not None and suffix not in formats:
            continue
        url = object_url(item)
        # `4DNFIM7ZVQOQ.hic` → `4DNFIM7ZVQOQ`; a name that is not an accession
        # keeps its stem, which is what the label falls back to.
        accession = name.split(".")[0]
        meta = index.get(accession)
        if meta is not None:
            described += 1
        meta = meta or {}
        # The UUID folder, which is the only thing telling two objects of the
        # same name apart, and the first thing to check against the portal.
        folder = key.rsplit("/", 1)[0].rsplit("/", 1)[-1] if "/" in key else ""
        headline = (
            text(meta.get("dataset"))
            or text(meta.get("title"))
            or join_unique([text(meta.get("assay")), text(meta.get("biosource"))])
            or accession
        )
        entries.append(
            {
                "label": f"{headline} — {accession} ({suffix})" if suffix else f"{headline} — {accession}",
                "url": url,
                "kind": kind,
                # The bucket's own count, not the portal's: the object is what
                # is about to be fetched, and the two disagree on re-uploads.
                "size": item["size"],
                "note": joined_note(
                    accession,
                    meta.get("set"),
                    meta.get("publications"),
                    meta.get("condition"),
                    meta.get("replicate"),
                    "" if meta else folder,
                ),
                "fields": {
                    "assembly": text(meta.get("assembly")),
                    "biosource": text(meta.get("biosource")),
                    "assay": text(meta.get("assay")),
                    "format": suffix,
                    "dataset": text(meta.get("dataset")),
                    "lab": text(meta.get("lab")),
                    "project": text(meta.get("project")),
                },
                # Not published — `assemble` drops what Contract 1 has no key
                # for — and used to group the sessions below.
                "_set": text(meta.get("set")),
                "_accession": accession,
            }
        )
        if limit is not None and len(entries) >= limit:
            log.info("Stopped at the --limit of %d entries.", limit)
            break
    log.info(
        "%d routable objects, %d of them described by the portal.", len(entries), described
    )
    return entries


# ---------------------------------------------------------------------------
# Front end: ENCODE
# ---------------------------------------------------------------------------

#: A target title reads "CTCF (Homo sapiens)"; the species is already the
#: assembly's business. Binomial-shaped only, so a target whose name genuinely
#: ends in a parenthesis keeps it.
SPECIES_SUFFIX = re.compile(r"\s*\(([A-Z][a-z]+ [a-z]+)\)\s*$")

#: The manifest columns this front end reads, by name. Read by name and never by
#: position: ENCODE has added columns to this file before (``azure_uri`` and the
#: two checksum columns are newer than the rest), and a reader that counted
#: fields would have silently shifted every cell the week that happened.
MANIFEST_COLUMNS = (
    "accession",
    "status",
    "file_format",
    "file_type",
    "assembly",
    "cloud_metadata.url",
    "s3_uri",
    "dataset",
    "lab.@id",
    "output_type",
    "output_category",
    "file_size",
    "date_created",
    "replicate_libraries",
)

#: One output type that is half of ENCODE by row count and one experiment by
#: intent: ``footprints`` is a per-biosample BED published as its own annotation
#: dataset, 502 thousand of them, from one analysis. Listing them all is a
#: legitimate thing to want (``--breadth all``) and a poor default: it triples
#: every published byte and buries the other 700 thousand files in a table
#: sorted by assembly.
BULK_OUTPUTS = ("footprints",)

#: Which shard an assembly belongs to. Grouped rather than one file per
#: assembly, because a menu with a row for ``mm10-minimal`` and another for
#: ``GRCm39`` — two thousand files and two — is a menu that reads as noise.
#: Anything unnamed lands in ``other``, which is the arm that must exist: a new
#: assembly appearing at the portal must widen a shard, never vanish.
ASSEMBLY_SHARDS = {
    "GRCh38": "GRCh38",
    "GRCh38-minimal": "GRCh38",
    "hg19": "hg19",
    "mm10": "mm10",
    "mm10-minimal": "mm10",
    "mm9": "mm10",
    "GRCm39": "mm10",
}

#: And which shard an output category belongs to. Three, because they are three
#: different questions a reader arrives with — *show me the signal over this
#: gene*, *where are the peaks*, *let me look at the reads* — and because
#: splitting on them keeps every published file under about 12 MB.
CATEGORY_SHARDS = {
    "signal": "signal",
    "alignment": "alignment",
    "annotation": "annotation",
    "quantification": "annotation",
    "reference": "annotation",
    "raw data": "annotation",
    "validation": "annotation",
}

#: Every shard this front end can write, in the order the picker offers them.
#: Fixed and enumerated rather than discovered, because `src/ui/examples.ts`
#: ships a built-in reference to each one and the two lists have to agree —
#: `test/dom/builtin-hubs.test.ts` checks that they do.
ENCODE_SHARDS = tuple(
    f"{assembly}-{category}"
    for assembly in ("GRCh38", "hg19", "mm10", "other")
    for category in ("signal", "annotation", "alignment")
)

#: What each half of a shard id is called on screen.
SHARD_LABELS = {
    "GRCh38": "GRCh38",
    "hg19": "hg19",
    "mm10": "mouse",
    "other": "other assemblies",
    "signal": "signal",
    "annotation": "peaks and annotations",
    "alignment": "alignments",
}


def shard_of(assembly: str, category: str) -> str:
    """The shard id one file belongs in."""
    return (
        f"{ASSEMBLY_SHARDS.get(assembly, 'other')}-"
        f"{CATEGORY_SHARDS.get(category.lower(), 'annotation')}"
    )


def shard_name(shard: str) -> str:
    """``ENCODE — GRCh38 signal``, the name the picker shows."""
    assembly, _, category = shard.partition("-")
    return (
        f"ENCODE — {SHARD_LABELS.get(assembly, assembly)} "
        f"{SHARD_LABELS.get(category, category)}"
    )


def metadata_encode(graph: list) -> dict[str, dict]:
    """Every experiment the portal describes, keyed by accession.

    The enrichment half, and deliberately *datasets only*: the manifest is the
    file list, so what is wanted here is one record per experiment — 25 thousand
    of them — rather than one per file, which would be the 1.2 million-record
    search this front end exists to avoid.

    **Annotation datasets are not asked for**, and that is a considered gap
    rather than an oversight. Half of ENCODE's openable files belong to
    annotations, and 502 thousand of those datasets are the one-per-biosample
    footprint sets: a search over them costs more than the manifest itself and
    answers with a biosample this front end can put in a cell for files nobody
    publishes by default. So an annotation's row carries its accession, its
    output type, its assembly and its lab — everything the manifest knows — and
    an empty Biosample cell. If that gap is ever worth closing it closes with a
    second query here, keyed the same way, and nothing else changes.
    """
    index: dict[str, dict] = {}
    for record in graph:
        if not isinstance(record, dict):
            continue
        accession = text(record.get("accession")) or accession_in(record.get("@id"))
        if accession == "":
            continue
        index[accession] = {
            "biosample": text(record.get("biosample_summary")),
            "assay": text(record.get("assay_title")) or text(record.get("assay_term_name")),
            "target": SPECIES_SUFFIX.sub("", text(dig(record, "target", "title"))),
            "lab": text(dig(record, "lab", "title")),
            "description": text(record.get("description")),
        }
    log.info("The portal described %d experiments.", len(index))
    return index


def manifest_files(lines: Iterable[str]) -> Iterator[dict]:
    """Every row of ENCODE's file manifest, by column name.

    ``csv`` rather than ``split('\\t')`` because the manifest quotes: a
    description with a tab in it would otherwise shift every column after it,
    and the failure would be one wrong cell in a million rather than an error.
    """
    reader = csv.DictReader(lines, delimiter="\t")
    missing = [
        column for column in MANIFEST_COLUMNS if column not in (reader.fieldnames or [])
    ]
    if missing:
        raise SystemExit(
            "ENCODE's manifest is missing columns this reads by name: "
            + ", ".join(missing)
            + "\n  Nothing was written. The file's header is the contract; if a column has "
            "been renamed, MANIFEST_COLUMNS and the reader below name the new one."
        )
    for row in reader:
        yield row


def _replicate_count(value: str) -> int:
    """How many libraries a file was made from, as a sort key and nothing else.

    A pooled or merged file lists every library it came from, a per-replicate
    file lists one. That is the cheapest available proxy for "this is the one a
    reader means" when `--breadth representative` has to pick between eight
    bigWigs of one experiment, and the manifest carries no `preferred_default`.
    """
    return len([part for part in value.replace(";", ",").split(",") if part.strip()])


def entries_encode(
    rows: Iterable[dict],
    index: dict[str, dict],
    *,
    breadth: str,
    limit: Optional[int],
) -> list[dict]:
    """One entry per released ENCODE file this viewer can open, at the chosen breadth.

    Three breadths, and the middle one is the default (SPECS §24.3):

    ``all``
        Every released file with a route. 1.21 million rows.
    ``full``
        The same, less the bulk footprint dump. 700 thousand rows.
    ``representative``
        ``full``, then one file per dataset, assembly and format — the pooled,
        latest one — so every dataset ENCODE has is still on the shelf and the
        seven other bigWigs of one experiment are not. 210 thousand rows, and
        each carries how many files it was chosen from, so what was collapsed is
        on the row rather than in this docstring.
    """
    kept: dict[tuple[str, str, str], dict] = {}
    entries: list[dict] = []
    seen = 0
    for row in rows:
        if text(row.get("status")).lower() != "released":
            continue
        # The unsigned object on the public bucket, never the portal's
        # `@@download` path: that one answers 307 with a link presigned for
        # `GET` alone, which this viewer's probe path copes with and a
        # catalogue read for a year should not depend on (SPECS §24.3).
        url = text(row.get("cloud_metadata.url"))
        if url == "":
            url = _url_of_s3(text(row.get("s3_uri")))
        if url == "":
            continue
        name = url.split("?")[0].rsplit("/", 1)[-1]
        kind = route_of(name)
        if kind is None:
            continue
        output = text(row.get("output_type"))
        if breadth != "all" and output.lower() in BULK_OUTPUTS:
            continue
        seen += 1
        assembly = text(row.get("assembly"))
        dataset = accession_in(row.get("dataset"))
        suffix = format_of(name)
        candidate = {
            "accession": text(row.get("accession")),
            "url": url,
            "kind": kind,
            "size": size_of(row.get("file_size")),
            "assembly": assembly,
            "format": suffix or text(row.get("file_format")),
            "output": output,
            "category": text(row.get("output_category")),
            "dataset": dataset,
            "lab": _lab_name(text(row.get("lab.@id"))),
            "created": text(row.get("date_created")),
            "replicates": _replicate_count(text(row.get("replicate_libraries"))),
        }
        if breadth != "representative":
            entries.append(_entry_encode(candidate, index, 1))
            if limit is not None and len(entries) >= limit:
                log.info("Stopped at the --limit of %d entries.", limit)
                return entries
            continue
        # One row per dataset, assembly and format, and the chosen file is the
        # one made from the most libraries, then the newest, then the lowest
        # accession — a total order, so two runs a week apart over unchanged
        # data pick the same file and the published diff is empty.
        key = (candidate["dataset"], assembly, candidate["format"])
        held = kept.get(key)
        if held is None:
            candidate["count"] = 1
            kept[key] = candidate
            continue
        held["count"] = held.get("count", 1) + 1
        if _better(candidate, held):
            candidate["count"] = held["count"]
            kept[key] = candidate

    if breadth == "representative":
        for candidate in kept.values():
            entries.append(_entry_encode(candidate, index, candidate.get("count", 1)))
            if limit is not None and len(entries) >= limit:
                log.info("Stopped at the --limit of %d entries.", limit)
                break
        log.info("%d openable files collapsed to %d rows.", seen, len(entries))
    else:
        log.info("%d openable files, all of them listed.", len(entries))
    return entries


def _better(candidate: dict, held: dict) -> bool:
    """Whether *candidate* is the file a reader means, rather than *held*."""
    return (
        candidate["replicates"],
        candidate["created"],
        # Reversed: the lowest accession wins a tie, and a tuple comparison
        # wants the sort key the same way round as the two above it.
        [-ord(char) for char in candidate["accession"]],
    ) > (
        held["replicates"],
        held["created"],
        [-ord(char) for char in held["accession"]],
    )


def _entry_encode(row: dict, index: dict[str, dict], count: int) -> dict:
    """One ENCODE file as a Contract-1 entry."""
    meta = index.get(row["dataset"], {})
    headline = (
        text(meta.get("biosample"))
        or text(meta.get("assay"))
        or row["output"]
        or row["dataset"]
        or row["accession"]
    )
    return {
        "label": f"{headline} — {row['accession']} ({row['format']})",
        "url": row["url"],
        "kind": row["kind"],
        "size": row["size"],
        "note": joined_note(
            row["accession"],
            row["dataset"],
            # Only when something was collapsed, and then exactly what: a row
            # that stands for eight files should say so where the reader is
            # choosing, not in a docstring (SPECS §24.3).
            f"1 of {count} {row['format']} files here" if count > 1 else "",
            meta.get("description"),
        ),
        "fields": {
            "assembly": row["assembly"],
            "biosample": text(meta.get("biosample")),
            "assay": text(meta.get("assay")),
            "format": row["format"],
            "target": text(meta.get("target")),
            "output": row["output"],
            "lab": text(meta.get("lab")) or row["lab"],
        },
        "_shard": shard_of(row["assembly"], row["category"]),
        "_dataset": row["dataset"],
        "_accession": row["accession"],
    }


def _url_of_s3(uri: str) -> str:
    """``s3://encode-public/2020/…`` → the https URL of the same object.

    The fallback for a row whose ``cloud_metadata.url`` is empty — a handful of
    them are — and not a rewrite this viewer needs: ``sources/rewrite.ts`` would
    do the same thing in the browser, and doing it here means the published row
    already carries the form that opens.
    """
    if not uri.lower().startswith("s3://"):
        return ""
    bucket, _, key = uri[len("s3://"):].partition("/")
    if bucket == "" or key == "":
        return ""
    return f"https://{bucket}.s3.amazonaws.com/{urllib.parse.quote(key)}"


def _lab_name(at_id: str) -> str:
    """``/labs/erez-aiden/`` → ``erez-aiden``, for a row the portal did not describe.

    A slug is a poor Lab cell and a much better one than blank: it is what the
    manifest carries, it is filterable, and it is replaced by the lab's real
    title the moment the experiment query covers the dataset.
    """
    return accession_in(at_id)


# ---------------------------------------------------------------------------
# Front end: IGV's genome table
# ---------------------------------------------------------------------------

#: What IGV calls a track format, mapped to whether this viewer has a reader.
#:
#: ``refgene`` is the one that matters and the one that is missing: 29 of IGV's
#: 63 tracks are UCSC ``genePred`` tables (``ncbiRefSeq.txt.gz``), a nine-column
#: tab-separated format this viewer has no parser for. Those tracks are counted
#: and skipped rather than written as rows that fail when they are clicked —
#: `route_of` would refuse them anyway, since the name ends in ``.txt.gz``, and
#: the count is logged so that "IGV has a gene track for hg38 and this hub does
#: not" is a known gap rather than a surprise.
IGV_UNREADABLE = ("refgene", "genepred", "2bit", "cytoband", "alias", "chromsizes")


def _igv_index(url: str, index: str) -> str:
    """``#index=<url>`` for a sidecar this viewer would not have guessed.

    `annotations/loader.ts` already guesses ``<url>.tbi`` for anything gzipped
    and ``<url>.bai`` for a BAM, and IGV names exactly that in almost every
    case. Writing the fragment anyway would be forty rows of noise in the
    published file; writing it when the name differs is the difference between
    a track that opens indexed and one that does not open at all (§8.13).
    """
    if index == "":
        return ""
    guess = f"{url}.tbi" if url.lower().endswith(".gz") else ""
    if url.lower().endswith(".bam"):
        guess = f"{url}.bai"
    return "" if index == guess else f"#index={urllib.parse.quote(index, safe=':/?=&%')}"


def igv_tracks(genome: dict) -> list[dict]:
    """The tracks of one IGV genome this viewer can draw, in IGV's own order.

    IGV's own ``order`` field is deliberately not sorted on: it is a drawing
    order for a browser that has a fixed set of panels, and what a catalogue
    wants is the order the curator wrote, which is the order of the array.
    """
    kept: list[dict] = []
    for track in listed(genome.get("tracks")):
        if not isinstance(track, dict):
            continue
        url = text(track.get("url"))
        if url == "":
            continue
        if text(track.get("format")).lower() in IGV_UNREADABLE:
            continue
        name = url.split("?")[0].rsplit("/", 1)[-1]
        if route_of(name) is None:
            continue
        kept.append(
            {
                "label": text(track.get("name")) or name,
                "url": url,
                "index": text(track.get("indexURL")),
                "format": format_of(name),
            }
        )
    return kept


def entries_igv(genomes: list, limit: Optional[int], *, probing: bool) -> list[dict]:
    """One row per IGV genome file, and one per annotation track it ships with.

    Both, rather than only the genome: a reader who wants *hg38's genes over my
    own map* wants the track on its own, and a reader who wants hg38 wants the
    FASTA. The pre-configured session (``--sessions-dir``) is the third answer
    and the one that puts them together.

    Every URL is probed (see {@link probe}) unless ``probing`` is off, and a
    file that does not answer an anonymous ranged GET gets no row: IGV names
    files on four hosts and one of them is not public. A genome whose *sequence*
    will not open is dropped whole — its tracks are annotations of a genome this
    viewer cannot read — while a single unreadable track costs only its own row.
    """
    entries: list[dict] = []
    skipped = 0
    refused: list[str] = []
    # Memoised, because IGV points several genomes at one file — nine of them
    # share the `geneLocations` BEDs, and hg38 and hg38_1kg share UCSC's
    # `ncbiRefSeq.txt.gz` — and a request per row would ask the same question
    # twice for no answer that could differ.
    probes: dict[str, Probed] = {}

    def readable(url: str) -> Probed:
        if not probing:
            return Probed(True, None)
        if url not in probes:
            probes[url] = probe(url)
            if not probes[url].ok:
                refused.append(f"{url} ({probes[url].why or 'no answer'})")
        return probes[url]

    for genome in genomes:
        if not isinstance(genome, dict):
            continue
        assembly = text(genome.get("id"))
        name = text(genome.get("name")) or assembly
        fasta = text(genome.get("fastaURL"))
        if assembly == "" or fasta == "":
            continue
        skipped += len(listed(genome.get("tracks"))) - len(igv_tracks(genome))
        sequence = readable(fasta)
        if not sequence.ok:
            # The whole genome goes: its tracks annotate coordinates this
            # viewer cannot read, and a gene track with no sequence under it is
            # not what anybody picked IGV's hg38 for.
            log.info("%s: the sequence does not open anonymously — no rows.", assembly)
            continue
        tracks = [track for track in igv_tracks(genome) if readable(track["url"]).ok]
        suffix = format_of(fasta)
        entries.append(
            {
                "label": f"{name} — {assembly} ({suffix})",
                # No `#index=` for a FASTA: this viewer reads sequence by range
                # off the file itself and has no `.fai` reader, so naming one
                # would be a promise the loader does not keep.
                "url": fasta,
                "kind": route_of(fasta.rsplit("/", 1)[-1]) or "genome",
                "size": sequence.size,
                "note": joined_note(
                    assembly,
                    f"{len(tracks)} track{'' if len(tracks) == 1 else 's'} published with it"
                    if tracks
                    else "no tracks this viewer can draw",
                ),
                "fields": {
                    "assembly": assembly,
                    "genome": name,
                    "role": "sequence",
                    "format": suffix,
                    "host": host_of(fasta),
                },
                # Offered from the Tracks card once the genome is open, which is
                # the same offer the demo annotations are (§24.1).
                "tracks": [
                    {"label": track["label"], "url": track["url"]} for track in tracks
                ],
                "_genome": assembly,
            }
        )
        for track in tracks:
            entries.append(
                {
                    "label": f"{name} — {track['label']} ({track['format']})",
                    "url": f"{track['url']}{_igv_index(track['url'], track['index'])}",
                    "kind": "genome",
                    "size": readable(track["url"]).size,
                    "note": joined_note(assembly, track["label"]),
                    "fields": {
                        "assembly": assembly,
                        "genome": name,
                        "role": "annotation",
                        "format": track["format"],
                        "host": host_of(track["url"]),
                    },
                    "_genome": assembly,
                }
            )
        if limit is not None and len(entries) >= limit:
            log.info("Stopped at the --limit of %d entries.", limit)
            return entries[:limit]
    if skipped:
        log.info(
            "Skipped %d IGV tracks in a format this viewer has no reader for (%s).",
            skipped,
            ", ".join(IGV_UNREADABLE),
        )
    if refused:
        # Every one named, not just counted: a file that stopped answering is
        # the sort of thing somebody has to be able to look at on the run page.
        log.warning("%d IGV files did not answer an anonymous ranged GET:", len(refused))
        for one in refused:
            log.warning("  - %s", one)
    return entries


# ---------------------------------------------------------------------------
# Pre-configured sessions
# ---------------------------------------------------------------------------

#: What a file name becomes in a session's track list, mirroring
#: `cardFor`/`kindFor` in `src/annotations/loader.ts`. The same two-implementations
#: -of-one-rule bargain `route_of` makes, and the same instruction: keep them in
#: step. A format missing from here is a format no generated session places.
TRACK_KINDS = {
    "bigwig": ("linear", "track"),
    "bw": ("linear", "track"),
    "bedgraph": ("linear", "track"),
    "bedgraph.gz": ("linear", "track"),
    "bdg": ("linear", "track"),
    "wig": ("linear", "track"),
    "wig.gz": ("linear", "track"),
    "bigbed": ("linear", "segments"),
    "bb": ("linear", "segments"),
    "bed": ("linear", "segments"),
    "bed.gz": ("linear", "segments"),
    "narrowpeak": ("linear", "segments"),
    "narrowpeak.gz": ("linear", "segments"),
    "broadpeak": ("linear", "segments"),
    "broadpeak.gz": ("linear", "segments"),
    "gappedpeak": ("linear", "segments"),
    "gappedpeak.gz": ("linear", "segments"),
    "gtf": ("linear", "gtf"),
    "gtf.gz": ("linear", "gtf"),
    "gff": ("linear", "gtf"),
    "gff.gz": ("linear", "gtf"),
    "gff3": ("linear", "gtf"),
    "gff3.gz": ("linear", "gtf"),
    "vcf": ("linear", "variants"),
    "vcf.gz": ("linear", "variants"),
    "bam": ("linear", "alignments"),
    "bedpe": ("overlay", "pairs"),
    "bedpe.gz": ("overlay", "pairs"),
    "fa": ("linear", "sequence"),
    "fasta": ("linear", "sequence"),
    "fna": ("linear", "sequence"),
    "fas": ("linear", "sequence"),
    "fa.gz": ("linear", "sequence"),
    "fasta.gz": ("linear", "sequence"),
    "fna.gz": ("linear", "sequence"),
}

#: Lane thickness per kind, in CSS pixels — the numbers the published demo
#: sessions use, so a generated session and a hand-composed one open looking
#: like two sessions of one application.
TRACK_SIZES = {
    "sequence": 46,
    "gtf": 92,
    "track": 78,
    "segments": 34,
    "variants": 34,
    "alignments": 96,
    "pairs": 34,
}

#: Okabe–Ito, in the order the demo sessions use it. Assigned by position rather
#: than by content: a generator cannot know that the third track is the input
#: for the second, and a palette walked in order is at least stable — the same
#: genome regenerated next week comes back the same colours.
PALETTE = (
    "#0072b2",
    "#d55e00",
    "#009e73",
    "#cc79a7",
    "#7b3294",
    "#e69f00",
    "#56b4e9",
    "#8c6d31",
)

#: How many tracks a generated session places. A 4DN experiment set can carry
#: two hundred processed files, and a session that opened all of them would take
#: a minute to draw and be unreadable when it had. The cap is on the *session*
#: and not on the catalogue: every one of those files still has its own row.
SESSION_TRACKS = 24


def track_entry(index: int, label: str, url: str, sidecar: str = "") -> Optional[dict]:
    """One ``StoredEntry`` for a session's track list, or ``None`` for a name with no lane.

    The shape is `src/annotations/types.ts`'s and is written in full rather than
    relying on defaults: `readTab` hands `tracks` straight through as
    `StoredEntry[]` without filling anything in, so a field left out here is a
    field the lane draws without.
    """
    name = url.split("?")[0].split("#")[0].rsplit("/", 1)[-1]
    pair = TRACK_KINDS.get(format_of(name))
    if pair is None:
        return None
    card, kind = pair
    colour = "#5b6169" if kind in ("gtf", "sequence") else PALETTE[index % len(PALETTE)]
    return {
        "id": f"hub-{index}",
        "card": card,
        "kind": kind,
        "label": label or name,
        "source": {
            "kind": "remote",
            "name": name,
            "url": url,
            **({"index": sidecar} if sidecar else {}),
        },
        "visible": True,
        "placement": {"bottom": True, "right": False},
        "style": {
            "colour": colour,
            "size": TRACK_SIZES.get(kind, 46),
            # A sequence is drawn as letters and bars rather than filled: the
            # demo sessions' own choice, and the only kind where it differs.
            "mode": "line" if kind == "sequence" else "area",
            # Autoscaled, because a generator cannot know a bigWig's range
            # without reading it — and reading 280,000 of them to write a
            # catalogue is exactly what this script exists not to do. A
            # sequence has no values to scale, and the published demos write it
            # unscaled rather than leaving a ceiling drag that does nothing.
            "limits": {"auto": kind != "sequence", "min": 0, "max": 1},
            "group": "",
            "shape": "element",
            "radius": 7,
            "opacity": 1,
            "flip": False,
        },
    }


def session_document(
    *,
    name: str,
    uri: str,
    tracks: list[dict],
    created: str,
    locus: str = "",
) -> dict:
    """A whole session file: one tab, its view, and its lanes.

    `src/state/workspace.ts`'s `WorkspaceFile` with one tab in it, which is
    what a pre-configured session is — the plural exists for a window somebody
    saved, and a published genome is one window with one thing in front.

    **The view follows the lead file**, which is `landingState`'s own rule
    (`state/ViewState.ts`): a contact map opens on its genome list, because
    that is the one view of a map that needs no region to have been chosen, and
    a genome or a track opens in the 1D browser, because there is no matrix for
    it to be a view of. Getting this from the file rather than fixing it at
    `browser` is the difference between a published 4DN session opening on its
    map and opening on a one-dimensional strip of it.
    """
    placed: list[dict] = []
    for position, track in enumerate(tracks[:SESSION_TRACKS]):
        entry = track_entry(
            position, text(track.get("label")), text(track.get("url")), text(track.get("index"))
        )
        if entry is not None:
            placed.append(entry)
    return {
        "kind": WORKSPACE_KIND,
        "version": CONFIG_VERSION,
        "createdAt": created,
        "producer": PRODUCER,
        "active": 0,
        "tabs": [
            {
                "version": CONFIG_VERSION,
                "createdAt": created,
                "producer": PRODUCER,
                "name": name,
                "state": {
                    "uri": uri,
                    "view": "genomes" if route_of(uri.rsplit("/", 1)[-1]) == "map" else "browser",
                    **({"locus": locus} if locus else {}),
                },
                "tracks": placed,
            }
        ],
    }


def sessions_igv(genomes: list, entries: list[dict], created: str) -> list[dict]:
    """One session per IGV genome: the sequence, and every track IGV lists for it.

    This is the answer to "a pre-configured session" in its clearest form. IGV
    ships hg38 as a FASTA plus a gene track; a reader who picks *IGV hg38* in
    this viewer should get the same thing placed, not three rows to assemble.

    Built from the *rows* rather than from IGV's table a second time, so a file
    the catalogue dropped — an unreadable host, a format with no reader — cannot
    come back as a lane in a session. Two readings of one table is how the two
    halves of a published shelf come to disagree.
    """
    published = {text(entry.get("url")).split("#")[0] for entry in entries}
    out: list[dict] = []
    for genome in genomes:
        if not isinstance(genome, dict):
            continue
        assembly = text(genome.get("id"))
        label = text(genome.get("name")) or assembly
        fasta = text(genome.get("fastaURL"))
        if assembly == "" or fasta == "" or fasta not in published:
            continue
        tracks = [track for track in igv_tracks(genome) if track["url"] in published]
        # The sequence first, so the lane order reads outward from the genome —
        # and by URL, so a session and the row beside it name the same bytes.
        placed = [{"label": "sequence", "url": fasta}] + [
            {"label": track["label"], "url": track["url"], "index": track["index"]}
            for track in tracks
        ]
        out.append(
            {
                "id": f"igv-{_slug(assembly)}",
                "label": f"{label} — IGV genome and its {len(tracks)} track"
                f"{'' if len(tracks) == 1 else 's'}",
                "note": joined_note(assembly, host_of(fasta)),
                "fields": {
                    "assembly": assembly,
                    "subject": label,
                    "tracks": str(len(placed)),
                    "source": "IGV",
                },
                "document": session_document(
                    name=f"IGV {assembly}", uri=fasta, tracks=placed, created=created
                ),
            }
        )
    return out


#: Which file of a set a session should open *as* the map: the richest one
#: first. A multi-resolution cooler beats a single-resolution one because the
#: session opens at whatever zoom the reader lands on; a `.hic` beats a `.cool`
#: for the same reason.
MAP_PREFERENCE = ("mcool", "metacool", "mmetacool", "hic", "scool", "cool", "h5", "hdf5")


def sessions_from_entries(
    entries: list[dict],
    *,
    key: str,
    prefix: str,
    source: str,
    created: str,
) -> list[dict]:
    """One session per group of entries that has a map and something to draw on it.

    The portal front ends' answer to the same question ``sessions_igv`` answers
    for IGV: a 4DN experiment set is a contact map and the bigWigs and peak
    files published beside it, and a reader choosing that set means all of them.

    Groups with no map are skipped rather than opened on a track, which is a
    judgement and worth naming: a session whose lead is a bigWig is a perfectly
    good thing (the Yeast tracks demo is one) and it is *not* what somebody
    picking an experiment set out of a contact-map viewer is asking for. A group
    with a map and no tracks is skipped too — it would be one row opening one
    file, which the map's own row already does.
    """
    # Grouped by dataset **and assembly**, which is not a nicety: ENCODE
    # publishes one experiment against GRCh38 and hg19 both, and a session that
    # grouped on the dataset alone opened an hg19 map with GRCh38 tracks over
    # it — every lane drawn at the wrong coordinates, and nothing on screen
    # saying so. A session is one set of coordinates or it is wrong.
    groups: dict[tuple[str, str], list[dict]] = {}
    for entry in entries:
        name = text(entry.get(key))
        if name == "":
            continue
        assembly = text(entry.get("fields", {}).get("assembly"))
        groups.setdefault((name, assembly), []).append(entry)

    out: list[dict] = []
    for (name, assembly), held in sorted(groups.items()):
        maps = [entry for entry in held if entry["kind"] == "map"]
        tracks = [
            entry
            for entry in held
            if entry["kind"] == "genome" and format_of(entry["url"]) in TRACK_KINDS
        ]
        if not maps or not tracks:
            continue
        lead = min(
            maps,
            key=lambda entry: (
                MAP_PREFERENCE.index(format_of(entry["url"]))
                if format_of(entry["url"]) in MAP_PREFERENCE
                else len(MAP_PREFERENCE),
                entry["label"],
            ),
        )
        fields = lead.get("fields", {})
        subject = (
            text(fields.get("dataset"))
            or text(fields.get("biosample"))
            or text(fields.get("biosource"))
            or name
        )
        out.append(
            {
                # The assembly is part of the id for the same reason it is part
                # of the key: two sessions of one dataset are two files.
                "id": f"{prefix}-{_slug(name)}-{_slug(assembly)}" if assembly else f"{prefix}-{_slug(name)}",
                "label": _session_label(subject, name, assembly, len(tracks)),
                "note": joined_note(
                    name,
                    text(fields.get("assay")),
                    f"the first {SESSION_TRACKS} of {len(tracks)} tracks"
                    if len(tracks) > SESSION_TRACKS
                    else "",
                ),
                "fields": {
                    "assembly": assembly,
                    "subject": subject,
                    "tracks": str(min(len(tracks), SESSION_TRACKS) + 1),
                    "source": source,
                },
                "document": session_document(
                    name=f"{source} {name}{f' ({assembly})' if assembly else ''}",
                    uri=lead["url"],
                    tracks=[
                        {"label": entry["label"], "url": entry["url"]} for entry in tracks
                    ],
                    created=created,
                ),
            }
        )
    return out


def _session_label(subject: str, name: str, assembly: str, tracks: int) -> str:
    """``HFFc6 — 4DNESNMAAN97 on GRCh38, and its 3 tracks``.

    The accession is not repeated when it is all the name there is: a row
    reading "ENCSR000YSM — ENCSR000YSM on GRCh38" is what comes out of a dataset
    the enrichment did not cover, and saying it twice does not make it more
    informative.
    """
    head = f"{subject} — {name}" if subject != name else name
    where = f" on {assembly}," if assembly else ""
    return f"{head}{where} and its {tracks} track{'' if tracks == 1 else 's'}"


def _slug(value: str) -> str:
    """A file-name-safe id: lower case, and nothing that needs escaping in a URL."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.").lower()
    return cleaned or "unnamed"


def write_sessions(sessions: list[dict], directory: Path) -> list[Path]:
    """Write every session document. Returns what it wrote."""
    directory.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for session in sessions:
        path = directory / f"{session['id']}.metacooler.json"
        path.write_text(
            json.dumps(session["document"], indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        written.append(path)
    return written


def session_entries(sessions: list[dict], folder: str) -> list[dict]:
    """The session hub's rows: one ``kind: workspace`` entry per session file.

    Relative, with no ``base``, which is the self-contained-folder case
    `resolveHub` documents: the hub is published beside the directory it names,
    so the pair can be copied to another host — or served from a preview build —
    and still find each other.
    """
    return [
        {
            "label": session["label"],
            "url": f"{folder}/{session['id']}.metacooler.json",
            "kind": "workspace",
            "size": None,
            "note": session["note"],
            "fields": session["fields"],
        }
        for session in sessions
    ]


# ---------------------------------------------------------------------------
# Assembling a Contract-1 hub
# ---------------------------------------------------------------------------


def common_base(urls: list[str]) -> Optional[str]:
    """The longest shared URL prefix ending in ``/``, or ``None``.

    Never shorter than ``scheme://host/``, and ``None`` when the entries do not
    all share an origin — ``https://`` is a common prefix ending in a slash and
    would be a catastrophic base, since every relative name under it would
    resolve to nothing.
    """
    if not urls:
        return None
    first = urls[0]
    mark = first.find("://")
    if mark < 0:
        return None
    slash = first.find("/", mark + 3)
    if slash < 0:
        return None
    origin = first[: slash + 1]
    if not all(url.startswith(origin) for url in urls):
        return None
    shared = urls[0]
    for url in urls[1:]:
        limit = min(len(shared), len(url))
        cut = 0
        while cut < limit and shared[cut] == url[cut]:
            cut += 1
        shared = shared[:cut]
    trimmed = shared[: shared.rfind("/") + 1]
    return trimmed if len(trimmed) >= len(origin) else origin


def assemble(
    *,
    name: str,
    description: str,
    source: str,
    columns: list[dict],
    entries: list[dict],
) -> dict:
    """Sort, relativise and wrap raw entries into the hub Contract 1 describes.

    Sorted by assembly and then label, which is the order the table opens in and
    therefore the order a diff between two weeks is readable in: a hub sorted by
    whatever the portal answered would show four hundred moved rows the week a
    portal changed its default sort.

    Keys beginning with ``_`` are the front ends' own working notes — which
    experiment set a file belongs to, which shard a row goes in — and are
    dropped here rather than filtered at each call site, because Contract 1 has
    no place for them and a hub carrying them would be a second, undocumented
    format nobody reads.
    """
    ordered = sorted(
        entries, key=lambda entry: (entry["fields"].get("assembly", ""), entry["label"])
    )
    base = common_base([entry["url"] for entry in ordered])

    published: list[dict] = []
    for entry in ordered:
        url = entry["url"]
        # A relative name only when there is something left of it: an entry
        # whose URL *is* the base stays absolute rather than becoming ''.
        uri = url[len(base):] if base is not None and url[len(base):] != "" else url
        row: dict[str, Any] = {"label": entry["label"], "uri": uri, "kind": entry["kind"]}
        if entry.get("size") is not None:
            row["size"] = entry["size"]
        if entry.get("note"):
            row["note"] = entry["note"]
        # Empty cells are dropped rather than written as `""`: Contract 1 renders
        # a missing key as empty anyway, so the pair would carry nothing — and a
        # hub that spells out every blank turns next week's diff into a wall.
        fields = {key: value for key, value in entry["fields"].items() if value != ""}
        if fields:
            row["fields"] = fields
        if entry.get("tracks"):
            row["tracks"] = [
                {"label": track["label"], "url": track["url"]} for track in entry["tracks"]
            ]
        published.append(row)

    hub: dict[str, Any] = {
        "kind": HUB_KIND,
        "version": HUB_VERSION,
        "name": name,
        "description": description,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
        "source": source,
    }
    if base is not None:
        hub["base"] = base
    hub["columns"] = columns
    hub["entries"] = published
    return hub


def write_hub(hub: dict, out: Path, *, timestamp: bool) -> list[Path]:
    """Write the hub, and a dated copy beside it when asked. Returns what it wrote."""
    out.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(hub, indent=2, ensure_ascii=False) + "\n"
    written = [out]
    out.write_text(body, encoding="utf-8")
    if timestamp:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
        dated = out.with_name(f"{out.stem}-{stamp}{out.suffix}")
        dated.write_text(body, encoding="utf-8")
        written.append(dated)
    return written


# ---------------------------------------------------------------------------
# Checking a hub, or a session, against its contract
# ---------------------------------------------------------------------------


def check_hub(path: Path) -> list[str]:
    """Every way *path* fails Contract 1, as sentences. Empty means it passes.

    The parser in ``src/state/hub.ts`` is deliberately forgiving — an entry with
    no label is dropped, an unknown key ignored — because a reader's shelf
    should survive a hub somebody else wrote. That forgiveness is exactly why a
    generator needs this: a hub that lost its labels would publish, parse, and
    draw an empty table, and nothing in the pipeline would have said a word.
    """
    problems: list[str] = []
    try:
        hub = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [f"{path} does not exist."]
    except ValueError as error:
        return [f"{path} is not valid JSON: {error}"]
    if not isinstance(hub, dict):
        return [f"{path} is not a JSON object."]
    if hub.get("kind") == WORKSPACE_KIND:
        return check_session(path)

    if hub.get("kind") != HUB_KIND:
        problems.append(f"kind is {hub.get('kind')!r}, not {HUB_KIND!r}.")
    version = hub.get("version")
    if not isinstance(version, int) or isinstance(version, bool):
        problems.append(f"version is {version!r}, which is not an integer.")
    elif version != HUB_VERSION:
        problems.append(f"version is {version}, and this generator writes {HUB_VERSION}.")
    if not text(hub.get("name")):
        problems.append("name is missing or empty; it is what the picker calls the hub.")

    generated = hub.get("generatedAt")
    if generated is not None and not _is_utc_iso(generated):
        problems.append(
            f"generatedAt is {generated!r}, which is not a UTC ISO 8601 instant ending in Z."
        )

    base = hub.get("base")
    if base is not None:
        if not isinstance(base, str) or not re.match(r"^https?://", base):
            problems.append(f"base is {base!r}, which is not an absolute http(s) URL.")
        elif not base.endswith("/"):
            problems.append(f"base is {base!r} and does not end in '/', so names join wrongly.")

    keys: list[str] = []
    columns = hub.get("columns")
    if not isinstance(columns, list):
        problems.append("columns is missing; Contract 1 allows [] but not absent.")
    else:
        for index, column in enumerate(columns):
            if not isinstance(column, dict) or not text(column.get("key")):
                problems.append(f"columns[{index}] has no key.")
                continue
            if not text(column.get("label")):
                problems.append(f"columns[{index}] ({column.get('key')}) has no label.")
            key = text(column.get("key"))
            if key in keys:
                problems.append(f"columns[{index}] repeats the key {key!r}.")
            keys.append(key)

    entries = hub.get("entries")
    if not isinstance(entries, list):
        return problems + ["entries is missing or is not a list."]
    if not entries:
        problems.append("entries is empty; a hub with no rows is not worth publishing.")

    absolute = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
    relatives = 0
    absolutes = 0
    previous: Optional[tuple[str, str]] = None
    for index, entry in enumerate(entries):
        where = f"entries[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{where} is not an object.")
            continue
        label = text(entry.get("label"))
        uri = text(entry.get("uri"))
        if label == "":
            problems.append(f"{where} has no label; the viewer drops it.")
        if uri == "":
            problems.append(f"{where} ({label}) has no uri; the viewer drops it.")
        elif absolute.match(uri):
            absolutes += 1
        else:
            relatives += 1
        if entry.get("kind") not in ("map", "genome", "workspace"):
            problems.append(f"{where} ({label}) has kind {entry.get('kind')!r}.")
        size = entry.get("size")
        if size is not None and (not isinstance(size, int) or isinstance(size, bool) or size < 0):
            problems.append(f"{where} ({label}) has size {size!r}, which is not a byte count.")
        if "note" in entry and not isinstance(entry["note"], str):
            problems.append(f"{where} ({label}) has a note that is not a string.")
        fields = entry.get("fields")
        if fields is not None:
            if not isinstance(fields, dict):
                problems.append(f"{where} ({label}) has fields that are not an object.")
            else:
                for key, value in fields.items():
                    if not isinstance(value, str):
                        problems.append(
                            f"{where} ({label}) has fields[{key!r}] = {value!r}, "
                            "which is not a string; every cell is rendered as text."
                        )
        for position, track in enumerate(listed(entry.get("tracks"))):
            if not isinstance(track, dict) or not text(track.get("url")):
                problems.append(f"{where} ({label}) has tracks[{position}] with no url.")
        assembly = text((fields or {}).get("assembly")) if isinstance(fields, dict) else ""
        current = (assembly, label)
        if previous is not None and current < previous:
            problems.append(
                f"{where} ({label}) sorts before the entry above it; entries are ordered by "
                "assembly then label."
            )
        previous = current

    # Relative names with no base are the self-contained-folder case
    # `resolveHub` documents and the sessions hub uses: the hub is published
    # beside what it names, so the pair travels together. **Mixing** the two
    # with no base is the mistake that check exists to catch — the absolute
    # rows work, the relative ones resolve against whatever host is serving the
    # page, and only half the table is broken.
    if base is None and relatives and absolutes:
        problems.append(
            f"{relatives} entries are relative and {absolutes} are absolute, and the hub "
            "declares no base: the relative ones would resolve against wherever the hub "
            "happens to be served from. Declare a base, or name every entry the same way."
        )

    return problems


def check_session(path: Path) -> list[str]:
    """Every way a generated session fails `src/state/workspace.ts`'s reader.

    Written because the failure mode is the quiet one: `parseWorkspaceFile`
    drops a tab it cannot read and keeps its neighbours, so a session whose one
    tab is malformed is refused as *not a workspace* — the same sentence a
    reader gets for a `package.json` — and a session whose tracks are malformed
    opens with no lanes and no complaint.
    """
    problems: list[str] = []
    try:
        file = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [f"{path} does not exist."]
    except ValueError as error:
        return [f"{path} is not valid JSON: {error}"]
    if not isinstance(file, dict):
        return [f"{path} is not a JSON object."]
    if file.get("kind") != WORKSPACE_KIND:
        problems.append(f"kind is {file.get('kind')!r}, not {WORKSPACE_KIND!r}.")
    if file.get("version") != CONFIG_VERSION:
        problems.append(f"version is {file.get('version')!r}, not {CONFIG_VERSION}.")
    tabs = file.get("tabs")
    if not isinstance(tabs, list) or not tabs:
        return problems + ["tabs is missing or empty; the viewer refuses the file."]
    active = file.get("active")
    if not isinstance(active, int) or isinstance(active, bool) or not 0 <= active < len(tabs):
        problems.append(f"active is {active!r}, which names no tab.")
    for index, tab in enumerate(tabs):
        where = f"tabs[{index}]"
        if not isinstance(tab, dict):
            problems.append(f"{where} is not an object.")
            continue
        state = tab.get("state")
        if not isinstance(state, dict) or not text(state.get("uri")):
            problems.append(f"{where} has no state.uri; the viewer drops the tab.")
            continue
        if not re.match(r"^[a-z][a-z0-9+.-]*:", text(state.get("uri")), re.I):
            problems.append(
                f"{where} names {state.get('uri')!r}, which is not absolute. A published "
                "session is opened from a URL and has no folder to be relative to."
            )
        for position, track in enumerate(listed(tab.get("tracks"))):
            at = f"{where}.tracks[{position}]"
            if not isinstance(track, dict):
                problems.append(f"{at} is not an object.")
                continue
            if track.get("kind") not in TRACK_SIZES:
                problems.append(f"{at} has kind {track.get('kind')!r}, which draws nothing.")
            source = track.get("source")
            if not isinstance(source, dict) or not text(source.get("url")):
                problems.append(f"{at} has no source.url.")
            elif not re.match(r"^[a-z][a-z0-9+.-]*:", text(source.get("url")), re.I):
                problems.append(f"{at} names a relative url, which a published session cannot.")
            if not isinstance(track.get("style"), dict):
                problems.append(f"{at} has no style, so the lane draws with none.")
    return problems


def _is_utc_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


# ---------------------------------------------------------------------------
# The command line
# ---------------------------------------------------------------------------

DESCRIPTION_4DN = (
    "Every file on the 4D Nucleome open-data bucket this viewer can open — contact maps, "
    "signal tracks, peaks, pairs and alignments — joined to the biosource, assay, dataset and "
    "lab the portal names them by. Read straight off the bucket; the portal is not contacted "
    "when this hub is opened."
)

DESCRIPTION_ENCODE = (
    "Released files from the ENCODE portal, each named by its unsigned object on the "
    "encode-public bucket. Built from ENCODE's own daily file manifest and joined to the "
    "biosample, assay and target of the experiment it belongs to. The portal is not contacted "
    "when this hub is opened."
)

DESCRIPTION_IGV = (
    "The reference genomes IGV ships with, and the annotation tracks published beside them: "
    "one row per FASTA and one per track this viewer can draw. Read from IGV's own genome "
    "table, which is the file the IGV desktop app and igv.js both load their genome menu from."
)

DESCRIPTION_SESSIONS = (
    "Pre-configured sessions: a genome or a dataset with its tracks already placed, opened "
    "through the same road as a shared session link. One click puts the sequence, the genes "
    "and the signal on screen together instead of a file at a time."
)


def now_iso() -> str:
    """This instant, as the ISO 8601 every file here stamps itself with."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def searched(query: str, from_json: Optional[Path], what: str) -> tuple[list, str]:
    """``(@graph, source)`` from the live query, or from a recorded response.

    The source string records which of the two it was, because a hub published
    from a fixture by mistake is otherwise indistinguishable from one the portal
    answered — and it would be a *plausible* hub, six rows and all.
    """
    if from_json is not None:
        graph = recorded_graph(from_json)
        source = f"{query} (recorded in {from_json})"
    else:
        graph = listed(fetch_json(query).get("@graph"))
        source = query
    log.info("%s answered %d %s.", query.split("/search/")[0], len(graph), what)
    return graph, source


def enriched(
    query: str, from_json: Optional[Path], what: str, portal: str, reader: Any
) -> tuple[dict[str, dict], str]:
    """The enrichment half of a portal front end, and what to record as its source.

    ``--portal`` decides what a portal outage means, and the three answers are
    three different jobs:

    ``require`` (the default)
        A portal that will not answer fails the run. Nothing is written, so the
        published hub — which has columns — is not replaced by one that does
        not.
    ``optional``
        Publish the spine with empty metadata columns. For the week when a
        portal is down and a fresh catalogue of files still beats a stale one.
    ``skip``
        Do not ask at all. For a dry run, and for a development machine that
        can reach an object store and not a portal.
    """
    if portal == "skip":
        log.info("--portal skip: no metadata, so the columns the portal fills stay empty.")
        return {}, "the bucket listing alone (--portal skip)"
    try:
        graph, source = searched(query, from_json, what)
    except SystemExit:
        if portal != "optional":
            raise
        log.warning(
            "--portal optional: the portal did not answer, so this hub is being written with "
            "its metadata columns empty."
        )
        return {}, f"{query} (unanswered; --portal optional)"
    return reader(graph), source


def report(path: Path, problems: list[str]) -> bool:
    """Print what is wrong with a hub. Answers whether anything was."""
    if not problems:
        log.info("%s: valid.", path)
        return False
    log.error("%s does not meet its contract:", path)
    for problem in problems:
        log.error("  - %s", problem)
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="make_hub.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    fronts = parser.add_subparsers(dest="front", required=True, metavar="FRONT END")

    def generator(name: str, help_text: str) -> argparse.ArgumentParser:
        sub = fronts.add_parser(name, help=help_text)
        sub.add_argument("--out", type=Path, required=True, help="Where to write the hub.")
        sub.add_argument(
            "--name", help="Override the hub's name — what the picker calls this shelf."
        )
        sub.add_argument(
            "--limit",
            type=int,
            help="Stop after this many entries. For a dry run or a test, never for a publish.",
        )
        sub.add_argument(
            "--timestamp",
            action="store_true",
            help="Also write <stem>-YYYYMMDD.json beside --out, for the archive.",
        )
        sub.add_argument(
            "--check",
            action="store_true",
            help="Re-read what was written and validate it against its contract before exiting.",
        )
        return sub

    def with_sessions(sub: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sub.add_argument(
            "--sessions-dir",
            type=Path,
            help="Also write one pre-configured session per genome or dataset into this "
            "directory, and a hub listing them beside --out.",
        )
        sub.add_argument(
            "--sessions-out",
            type=Path,
            help="Where to write the session hub (default: <out-stem>-sessions.json).",
        )
        return sub

    def with_portal(sub: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sub.add_argument(
            "--from-json",
            type=Path,
            help="Read a recorded search response (or a directory of paged ones) instead of "
            "querying the portal.",
        )
        sub.add_argument(
            "--portal",
            choices=("require", "optional", "skip"),
            default="require",
            help="What a portal that will not answer means: fail the run (default), publish "
            "without its columns, or never ask.",
        )
        return sub

    genomes = with_sessions(generator("igv", "IGV's own reference genomes and their tracks."))
    genomes.add_argument(
        "--from-json", type=Path, help="Read a recorded genomes.json instead of fetching it."
    )
    genomes.add_argument(
        "--url", default=IGV_GENOMES, help=f"Where IGV's genome table is (default: {IGV_GENOMES})."
    )
    genomes.add_argument(
        "--probe",
        choices=("on", "off"),
        default="on",
        help="Ask each host for the first byte (default): proves the file opens without "
        "credentials — IGV names files on a bucket that does not — and records its size, which "
        "IGV's table does not carry. One ranged GET per file. 'off' keeps every row and no sizes.",
    )

    portal_4dn = with_sessions(
        with_portal(generator("4dn", "Every openable file on the 4DN open-data bucket."))
    )
    portal_4dn.add_argument(
        "--from-xml",
        type=Path,
        help="Read recorded ListObjectsV2 pages (a file, or a directory of them) instead of "
        "walking the bucket.",
    )
    portal_4dn.add_argument(
        "--formats",
        help="Comma-separated file extensions to keep. The default keeps every format this "
        "viewer has a route for, which is the point of the hub.",
    )
    portal_4dn.add_argument(
        "--bucket", default=BUCKET_4DN, help=f"The open-data bucket (default: {BUCKET_4DN})."
    )
    portal_4dn.add_argument(
        "--max-keys",
        type=int,
        default=1000,
        help="Objects per listing request (default 1000, S3's maximum).",
    )

    portal_encode = with_sessions(
        with_portal(generator("encode", "Every released ENCODE file this viewer can open."))
    )
    portal_encode.add_argument(
        "--from-tsv",
        type=Path,
        help="Read a recorded file manifest instead of fetching ENCODE's.",
    )
    portal_encode.add_argument(
        "--manifest",
        default=MANIFEST_ENCODE,
        help="Where ENCODE's file manifest is (default: the root of encode-public).",
    )
    portal_encode.add_argument(
        "--breadth",
        choices=("representative", "full", "all"),
        default="representative",
        help="How much of ENCODE to list: one file per dataset, assembly and format "
        "(default), every file but the bulk footprint dump, or every file.",
    )
    portal_encode.add_argument(
        "--shards",
        choices=("on", "off"),
        default="on",
        help="Write one hub per assembly and output category (default), or one file with "
        "everything in it.",
    )

    bucket = generator("bucket", "Every routable object under a public bucket prefix.")
    bucket.add_argument("prefix", help="An https bucket URL ending in '/'.")
    bucket.add_argument(
        "--from-xml",
        type=Path,
        help="Read a recorded ListObjectsV2 page (or a directory of pages) instead of walking.",
    )
    bucket.add_argument(
        "--max-keys",
        type=int,
        default=1000,
        help="Objects per listing request (default 1000, S3's maximum).",
    )

    checker = fronts.add_parser("check", help="Validate hubs and sessions against their contracts.")
    checker.add_argument("paths", nargs="+", type=Path)

    return parser


def _objects(prefixes: Iterable[str], *, max_keys: int, pages: Optional[list[bytes]]) -> Iterator[dict]:
    """Walk several prefixes as one stream, or replay recorded pages once.

    Recorded pages replace the *whole* walk rather than being replayed per
    prefix: a fixture is a recording of one listing, and playing it twice would
    double every row and hide exactly the kind of bug this is here to catch.
    """
    if pages is not None:
        yield from walk_objects(next(iter(prefixes)), max_keys=max_keys, pages=pages)
        return
    for prefix in prefixes:
        yield from walk_objects(prefix, max_keys=max_keys)


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )

    if args.front == "check":
        failed = False
        for path in args.paths:
            failed = report(path, check_hub(path)) or failed
        return 1 if failed else 0

    created = now_iso()
    # `(path, hub)` pairs rather than one hub, because ENCODE is sharded and
    # everything downstream — writing, timestamping, checking, the counts in the
    # log — is the same work whether there is one of them or twelve.
    hubs: list[tuple[Path, dict]] = []
    sessions: list[dict] = []

    if args.front == "igv":
        if args.from_json is not None:
            genomes = recorded_list(args.from_json)
            source = f"{args.url} (recorded in {args.from_json})"
        else:
            genomes = fetch_json_list(args.url)
            source = args.url
        log.info("IGV's table lists %d genomes.", len(genomes))
        rows = entries_igv(genomes, args.limit, probing=args.probe == "on")
        hubs.append(
            (
                args.out,
                assemble(
                    name=args.name or "IGV genomes",
                    description=DESCRIPTION_IGV,
                    source=source,
                    columns=COLUMNS_IGV,
                    entries=rows,
                ),
            )
        )
        if args.sessions_dir is not None:
            sessions = sessions_igv(genomes, rows, created)

    elif args.front == "4dn":
        index, portal_source = enriched(
            QUERY_4DN, args.from_json, "experiment sets", args.portal, metadata_4dn
        )
        formats = (
            tuple(
                part.strip().lstrip(".").lower()
                for part in args.formats.split(",")
                if part.strip()
            )
            if args.formats
            else None
        )
        if formats is not None and not formats:
            raise SystemExit("--formats named nothing to keep.")
        pages = recorded(args.from_xml, ".xml") if args.from_xml is not None else None
        prefixes = [f"{args.bucket.rstrip('/')}/{prefix}" for prefix in PREFIXES_4DN]
        entries = entries_4dn(
            _objects(prefixes, max_keys=args.max_keys, pages=pages),
            index,
            formats,
            args.limit,
        )
        hubs.append(
            (
                args.out,
                assemble(
                    name=args.name or "4DN open data",
                    description=DESCRIPTION_4DN,
                    source=f"{args.bucket} + {portal_source}",
                    columns=COLUMNS_4DN,
                    entries=entries,
                ),
            )
        )
        if args.sessions_dir is not None:
            sessions = sessions_from_entries(
                entries, key="_set", prefix="4dn", source="4DN", created=created
            )

    elif args.front == "encode":
        index, portal_source = enriched(
            QUERY_ENCODE, args.from_json, "experiments", args.portal, metadata_encode
        )
        lines = (
            recorded_lines(args.from_tsv)
            if args.from_tsv is not None
            else fetch_lines(args.manifest)
        )
        manifest_source = (
            f"{args.manifest} (recorded in {args.from_tsv})"
            if args.from_tsv is not None
            else args.manifest
        )
        entries = entries_encode(
            manifest_files(lines), index, breadth=args.breadth, limit=args.limit
        )
        source = f"{manifest_source} + {portal_source} (--breadth {args.breadth})"
        if args.shards == "off":
            hubs.append(
                (
                    args.out,
                    assemble(
                        name=args.name or "ENCODE",
                        description=DESCRIPTION_ENCODE,
                        source=source,
                        columns=COLUMNS_ENCODE,
                        entries=entries,
                    ),
                )
            )
        else:
            held: dict[str, list[dict]] = {shard: [] for shard in ENCODE_SHARDS}
            for entry in entries:
                held.setdefault(entry["_shard"], []).append(entry)
            for shard in ENCODE_SHARDS:
                rows = held.get(shard, [])
                if not rows:
                    # Skipped rather than written empty: Contract 1 says a hub
                    # with no rows is not worth publishing, and the picker's
                    # built-in reference to it answers "not generated yet",
                    # which is exactly the state it is in.
                    log.warning("Shard %s has no rows and is not being written.", shard)
                    continue
                hubs.append(
                    (
                        args.out.with_name(f"{args.out.stem}-{shard}{args.out.suffix}"),
                        assemble(
                            name=shard_name(shard),
                            description=DESCRIPTION_ENCODE,
                            source=source,
                            columns=COLUMNS_ENCODE,
                            entries=rows,
                        ),
                    )
                )
        if args.sessions_dir is not None:
            sessions = sessions_from_entries(
                entries, key="_dataset", prefix="encode", source="ENCODE", created=created
            )

    else:  # bucket
        prefix = args.prefix
        if not prefix.endswith("/"):
            # Not refused, because S3 prefixes are literal strings and a partial
            # one is the cheapest way to dry-run a walk of a large bucket
            # (`…/wfoutput/000` is a fortieth of 4DN's). Warned, because it is
            # also how somebody means `…/hic/` and catalogues `…/hic-old/` too.
            log.warning(
                "%s does not end in '/', so it is a literal name fragment: it will also match "
                "siblings such as '%s-old/'. Add the slash for a folder.",
                prefix,
                prefix.rstrip("/"),
            )
        pages = recorded(args.from_xml, ".xml") if args.from_xml is not None else None
        entries = entries_from_objects(
            walk_objects(prefix, max_keys=args.max_keys, pages=pages), prefix, args.limit
        )
        segments = [part for part in urllib.parse.urlsplit(prefix).path.split("/") if part]
        hubs.append(
            (
                args.out,
                assemble(
                    name=args.name or (segments[-1] if segments else urllib.parse.urlsplit(prefix).netloc),
                    description=f"Every file under {prefix} this viewer has a route for.",
                    source=prefix,
                    # No columns: a bucket knows a name and a size and nothing
                    # else, and a table of empty columns is worse than a table
                    # without them.
                    columns=[],
                    entries=entries,
                ),
            )
        )

    if not any(hub["entries"] for _, hub in hubs):
        log.error(
            "No entries. Nothing was written, and the exit code is 2 so a workflow can tell this "
            "from a portal failure and leave the published hub alone."
        )
        return 2

    written: list[Path] = []
    for path, hub in hubs:
        for one in write_hub(hub, path, timestamp=args.timestamp):
            written.append(one)
        log.info("wrote %s (%d entries)", path, len(hub["entries"]))

    if sessions:
        directory = args.sessions_dir
        out = args.sessions_out or args.out.with_name(f"{args.out.stem}-sessions{args.out.suffix}")
        files = write_sessions(sessions, directory)
        # The directory's name *as seen from the hub*, so the two can be copied
        # together and still find each other — `resolveHub`'s self-contained
        # folder, which is the only reason these rows may be relative.
        try:
            folder = Path(directory).resolve().relative_to(Path(out).resolve().parent).as_posix()
        except ValueError:
            folder = Path(directory).name
        hub = assemble(
            name=f"{args.name or args.front.upper()} sessions"
            if args.front != "igv"
            else "IGV genome sessions",
            description=DESCRIPTION_SESSIONS,
            source=f"{args.front}, one session per genome or dataset",
            columns=COLUMNS_SESSIONS,
            entries=session_entries(sessions, folder),
        )
        written.extend(write_hub(hub, out, timestamp=args.timestamp))
        written.extend(files)
        log.info("wrote %s (%d sessions) and %d session files", out, len(sessions), len(files))

    if args.check:
        failed = False
        for path in written:
            failed = report(path, check_hub(path)) or failed
        if failed:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
