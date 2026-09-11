#!/usr/bin/env python3
"""Build a hub — the static catalogue the viewer's Hubs section reads (SPECS §23.3).

Run with any Python 3.9 or newer.  **Standard library only**, deliberately::

    python3 scripts/make_hub.py 4dn    --out out/4dn.json    --timestamp
    python3 scripts/make_hub.py encode --out out/encode.json --timestamp
    python3 scripts/make_hub.py bucket https://my-lab.s3.amazonaws.com/hic/ \\
        --name 'Lab Hi-C' --out hub.json
    python3 scripts/make_hub.py check out/4dn.json

The output is a Contract-1 hub: ``kind``, ``version``, ``name``, ``columns`` and
``entries``, each entry a label, a URI, a kind, a size when it is known, a note
and one value per column.  ``src/state/hub.ts`` parses it and
``.github/workflows/hubs.yml`` publishes what this writes to the ``hubs``
branch, where the viewer reads it over ``raw.githubusercontent.com``.

**Why a script and not the browser.**  The join a shelf needs — accession to
cell line, assay, assembly, lab — lives in a portal's search API, and a portal
is free to refuse a browser's origin, to rate-limit it, or to answer in three
seconds.  None of that is a thing to do on a reader's first click.  So the join
happens here, once a week, and what the reader fetches is one static JSON on a
host that already serves ``Access-Control-Allow-Origin: *``.  It is also what
juicebox.js does — its ENCODE and 4DN menus are tables a script regenerated and
somebody committed (``igvteam/igv-data``, MIT) — and the reason this viewer's
version of that table is not simply *their* table is in SPECS §23.3: a hub that
hot-links another project's file inherits that project's cadence and schema.

**No dependencies, for the same reason the viewer has no backend.**  A weekly
workflow that needs ``pip install`` is a weekly workflow that breaks on a
resolver change, and a contributor who wants to regenerate a hub by hand should
need nothing but the interpreter that is already on the machine.  ``urllib``
fetches, ``json`` parses, ``xml.etree`` reads a bucket listing.

Three front ends, because there are three places a catalogue can come from:

``4dn``
    The 4DN portal's ``ExperimentSetReplicate`` search, **with no experiment-type
    filter**.  igv-data's ``update4DN.py`` names seven experiment types in its
    query, which was right for a reader of ``.hic`` in 2019 and silently drops
    Micro-C, sn-Hi-C variants and whatever the consortium publishes next.  The
    filter that matters here is on the *file*: keep every ``processed_files[]``
    with an ``open_data_url`` ending in a wanted format and a
    ``genome_assembly``.  That is one rule, on the thing being catalogued, and
    it needs no maintenance when the vocabulary grows.

``encode``
    The ENCODE portal's released experiments carrying a ``.hic``.  A row's URI
    is the file's ``cloud_metadata.url`` — the unsigned object on the
    ``encode-public`` bucket — and not the portal's ``@@download`` path, which
    answers ``307`` to a URL presigned for ``GET`` alone.  This viewer's probe
    path copes with such a link; a catalogue that will be read for a year should
    not depend on it.

``bucket``
    ``ListObjectsV2`` over a prefix, one row per object this viewer has a route
    for.  This is the ``make_catalog.py`` GAPS G10 and SPECS §11 promised, aimed
    at a lab's own bucket — no portal, no metadata beyond the file name and the
    size, which is still enough to choose from.

**Two facts worth not rediscovering**, both recorded in SPECS §23.3:

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
from typing import Any, Iterable, Optional

log = logging.getLogger("make_hub")

#: `src/state/hub.ts` refuses anything else, and refuses a newer major version
#: the way it refuses a newer workspace. Bump both together or not at all.
HUB_KIND = "metacooler.hub"
HUB_VERSION = 1

#: Named, because a portal that rate-limits or blocks has to be able to tell who
#: this is and where to complain. `urllib`'s default identifies only Python.
USER_AGENT = "metacooler.js make_hub.py (+https://github.com/js2264/metacooler.js)"

#: Seconds. A portal answering `limit=all` is doing real work — 4DN's set query
#: is thousands of embedded files — so this is generous; it exists to stop a
#: hung socket from holding a weekly job open for six hours.
TIMEOUT = 300

PORTAL_4DN = "https://data.4dnucleome.org"
PORTAL_ENCODE = "https://www.encodeproject.org"

#: The `field=` list igv-data's `update4DN.py` uses, minus its experiment-type
#: filter (see the module docstring). `field=processed_files` embeds each file
#: whole, which is where `open_data_url`, `genome_assembly`, `file_size` and
#: `track_and_facet_info` come from — there is no second request per file.
QUERY_4DN = (
    f"{PORTAL_4DN}/search/?type=ExperimentSetReplicate"
    "&field=award.project"
    "&field=processed_files"
    "&field=dataset_label"
    "&field=lab.display_title"
    "&field=experiments_in_set.experiment_type.display_title"
    "&field=experiments_in_set.biosample.biosource.organism.name"
    "&field=publications_of_set.display_title"
    "&format=json"
    "&limit=all"
)

#: The experiment carries the description a reader filters on; the file carries
#: the bytes. Both halves are asked for in one query, because a search per
#: experiment would be four hundred requests to build one table.
QUERY_ENCODE = (
    f"{PORTAL_ENCODE}/search/?type=Experiment"
    "&files.file_format=hic"
    "&status=released"
    "&field=accession"
    "&field=biosample_summary"
    "&field=assay_title"
    "&field=assay_term_name"
    "&field=lab.title"
    "&field=target.title"
    "&field=files.accession"
    "&field=files.file_format"
    "&field=files.assembly"
    "&field=files.file_size"
    "&field=files.output_type"
    "&field=files.status"
    "&field=files.href"
    "&field=files.cloud_metadata.url"
    "&field=files.biological_replicates"
    "&field=files.technical_replicates"
    "&format=json"
    "&limit=all"
)

#: Fixed per front end, and fixed in *order*: the columns are the table's header
#: row, so a generator that emitted them in dictionary order would reshuffle a
#: reader's shelf every week for no reason. Assembly leads because it is the
#: first thing anybody filters on and the first sort key below.
COLUMNS_4DN = [
    {"key": "assembly", "label": "Assembly"},
    {"key": "biosource", "label": "Biosource"},
    {"key": "assay", "label": "Assay"},
    {"key": "dataset", "label": "Dataset"},
    {"key": "lab", "label": "Lab"},
    {"key": "project", "label": "Project"},
]

COLUMNS_ENCODE = [
    {"key": "assembly", "label": "Assembly"},
    {"key": "biosample", "label": "Biosample"},
    {"key": "assay", "label": "Assay"},
    {"key": "target", "label": "Target"},
    {"key": "lab", "label": "Lab"},
    {"key": "output", "label": "Output"},
]

DEFAULT_FORMATS = ("hic", "mcool", "cool")


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


# ---------------------------------------------------------------------------
# The two transports
# ---------------------------------------------------------------------------


def _request(url: str, accept: str) -> bytes:
    """One GET, or a ``SystemExit`` naming the host and what would fix it."""
    request = urllib.request.Request(
        url, headers={"Accept": accept, "User-Agent": USER_AGENT}
    )
    log.debug("GET %s", url)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.read()
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
        raw = _request(url, "application/json")
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


def _json_or_none(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None


def fetch_xml(url: str) -> bytes:
    """Fetch a bucket listing, turning a refusal into the sentence that fixes it.

    A bucket answers ``403 AccessDenied`` when anonymous listing is off and
    ``404 NoSuchBucket`` when the name is wrong, both with an XML ``<Error>``
    body that says which — and those two are the whole of what goes wrong here,
    so the message repeats the bucket's own words rather than the status.
    """
    try:
        return _request(url, "application/xml")
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
    that (SPECS §23.3).
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


# ---------------------------------------------------------------------------
# Front end: 4DN
# ---------------------------------------------------------------------------


def entries_4dn(graph: list, formats: tuple[str, ...], limit: Optional[int]) -> list[dict]:
    """One entry per processed file with an open-data URL in a wanted format."""
    entries: list[dict] = []
    for record in graph:
        if not isinstance(record, dict):
            continue

        # `field=` does not return `accession` unless asked for it, and the
        # contract fixes the field list, so the set's accession comes off its
        # `@id` (`/experiment-set-replicates/4DNES.../`) when it is not there.
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

        for item in listed(record.get("processed_files")):
            if not isinstance(item, dict):
                continue
            url = text(item.get("open_data_url"))
            assembly = text(item.get("genome_assembly"))
            # The whole filter, and it is on the file rather than on the
            # experiment type: an open-data URL in a format this viewer opens,
            # mapped to an assembly it can label. Everything else about the set
            # is metadata for the row, not a condition on it.
            if url == "" or assembly == "":
                continue
            if not any(url.lower().endswith(f".{fmt}") for fmt in formats):
                continue
            kind = route_of(url)
            if kind is None:
                continue

            facets = item.get("track_and_facet_info")
            facets = facets if isinstance(facets, dict) else {}
            accession = text(item.get("accession")) or Path(
                urllib.parse.urlsplit(url).path
            ).stem
            biosource = text(facets.get("biosource_name")) or organisms
            experiment_type = text(facets.get("experiment_type")) or set_types
            assay_info = text(facets.get("assay_info"))
            dataset = text(facets.get("dataset")) or set_dataset
            condition = text(facets.get("condition"))
            replicate = text(facets.get("replicate_info"))
            lab = text(facets.get("experimental_lab")) or set_lab

            # "in situ Hi-C (MboI)": the experiment type carries what was done
            # and `assay_info` the enzyme that distinguishes two runs of it.
            # One cell, because a table with an Assay column and an Enzyme
            # column has a column nobody filters on.
            assay = (
                f"{experiment_type} ({assay_info})"
                if experiment_type and assay_info
                else experiment_type or assay_info
            )
            extension = Path(urllib.parse.urlsplit(url).path).suffix.lstrip(".").lower()
            headline = (
                dataset
                or text(facets.get("track_title"))
                or join_unique([experiment_type, biosource])
                or accession
            )

            entries.append(
                {
                    "label": f"{headline} — {accession} ({extension})",
                    "url": url,
                    "kind": kind,
                    "size": size_of(item.get("file_size")),
                    "note": joined_note(
                        accession, experiment_set, publications, condition, replicate
                    ),
                    "fields": {
                        "assembly": assembly,
                        "biosource": biosource,
                        "assay": assay,
                        "dataset": dataset,
                        "lab": lab,
                        "project": project,
                    },
                }
            )
            if limit is not None and len(entries) >= limit:
                return entries
    return entries


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


# ---------------------------------------------------------------------------
# Front end: ENCODE
# ---------------------------------------------------------------------------

#: A target title reads "CTCF (Homo sapiens)"; the species is already the
#: assembly's business. Binomial-shaped only, so a target whose name genuinely
#: ends in a parenthesis keeps it.
SPECIES_SUFFIX = re.compile(r"\s*\(([A-Z][a-z]+ [a-z]+)\)\s*$")


def entries_encode(graph: list, limit: Optional[int]) -> list[dict]:
    """One entry per released ``.hic`` file of a released experiment."""
    entries: list[dict] = []
    for record in graph:
        if not isinstance(record, dict):
            continue
        experiment = text(record.get("accession")) or accession_in(record.get("@id"))
        biosample = text(record.get("biosample_summary"))
        assay = text(record.get("assay_title")) or text(record.get("assay_term_name"))
        target = SPECIES_SUFFIX.sub("", text(dig(record, "target", "title")))
        lab = text(dig(record, "lab", "title"))

        for item in listed(record.get("files")):
            if not isinstance(item, dict):
                continue
            if text(item.get("file_format")).lower() != "hic":
                continue
            status = text(item.get("status"))
            # Absent is kept, `released` is kept, anything else is not. The
            # experiment-level `status=released` in the query does not settle a
            # file's own status — a released experiment can carry a revoked
            # file — and being tolerant of the field vanishing matters more
            # than the one revoked row it would let through: an empty hub
            # exits 2 and blocks the week's publish.
            if status != "" and status.lower() != "released":
                continue
            # The unsigned object, never `@@download`: SPECS §23.3.
            url = text(dig(item, "cloud_metadata", "url"))
            if url == "":
                href = text(item.get("href"))
                url = f"{PORTAL_ENCODE}{href}" if href.startswith("/") else href
            if url == "":
                continue
            kind = route_of(url) or "map"
            accession = text(item.get("accession")) or Path(
                urllib.parse.urlsplit(url).path
            ).stem
            replicates = joined_note(
                _replicates("biorep", item.get("biological_replicates")),
                _replicates("techrep", item.get("technical_replicates")),
            )
            headline = biosample or assay or experiment

            entries.append(
                {
                    "label": f"{headline} — {accession} (hic)",
                    "url": url,
                    "kind": kind,
                    "size": size_of(item.get("file_size")),
                    "note": joined_note(accession, experiment, replicates),
                    "fields": {
                        "assembly": text(item.get("assembly")),
                        "biosample": biosample,
                        "assay": assay,
                        "target": target,
                        "lab": lab,
                        "output": text(item.get("output_type")),
                    },
                }
            )
            if limit is not None and len(entries) >= limit:
                return entries
    return entries


def _replicates(label: str, value: Any) -> str:
    """``biorep 1, 2`` — or ``''`` when the file names none."""
    joined = join_unique(listed(value))
    return f"{label} {joined}" if joined else ""


# ---------------------------------------------------------------------------
# Front end: a bucket prefix
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


def walk_bucket(
    prefix_url: str,
    *,
    limit: Optional[int],
    max_keys: int,
    pages: Optional[list[bytes]] = None,
) -> list[dict]:
    """Every routable object under a prefix, as entries.

    ``pages`` replaces the network with recorded XML — one page per file, in
    name order — which is how the continuation-token seam is exercised without
    a bucket.
    """
    root, bucket, prefix = bucket_address(prefix_url)
    # The folder part of the prefix, so that a partial prefix (`…/wfoutput/000`)
    # still reports whole folder names rather than the tail of one.
    prefix_dir = prefix[: prefix.rfind("/") + 1]
    entries: list[dict] = []
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
                    "url": f"{root}/{urllib.parse.quote(key)}",
                    "kind": kind,
                    "size": item["size"],
                    "note": folder,
                    "fields": {},
                }
            )
            if limit is not None and len(entries) >= limit:
                log.info("Stopped at the --limit of %d entries.", limit)
                return entries
        if token is None:
            break

    log.info("Walked %d objects under %s in %s.", walked, prefix or "/", bucket)
    return entries


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
# Checking a hub against Contract 1
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
        elif base is None and not re.match(r"^[a-z][a-z0-9+.-]*:", uri, re.I):
            problems.append(
                f"{where} ({label}) has the relative uri {uri!r} and the hub declares no base, "
                "so it would resolve against wherever the hub happens to be served from."
            )
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
        assembly = text((fields or {}).get("assembly")) if isinstance(fields, dict) else ""
        current = (assembly, label)
        if previous is not None and current < previous:
            problems.append(
                f"{where} ({label}) sorts before the entry above it; entries are ordered by "
                "assembly then label."
            )
        previous = current

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
    "Processed Hi-C, Micro-C and related contact maps published as open data by the 4D Nucleome "
    "Data Coordination and Integration Centre. Every row is read straight off the 4DN open-data "
    "bucket; the portal is not contacted when this hub is opened."
)

DESCRIPTION_ENCODE = (
    "Released .hic contact maps from the ENCODE portal, each named by its unsigned object on the "
    "encode-public bucket. The portal is not contacted when this hub is opened."
)


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


def report(path: Path, problems: list[str]) -> bool:
    """Print what is wrong with a hub. Answers whether anything was."""
    if not problems:
        log.info("%s: valid.", path)
        return False
    log.error("%s is not a Contract-1 hub:", path)
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
            help="Re-read what was written and validate it against Contract 1 before exiting.",
        )
        return sub

    portal_4dn = generator("4dn", "The 4DN portal's processed files with an open-data URL.")
    portal_4dn.add_argument(
        "--from-json",
        type=Path,
        help="Read a recorded search response (or a directory of paged ones) instead of querying.",
    )
    portal_4dn.add_argument(
        "--formats",
        default=",".join(DEFAULT_FORMATS),
        help=f"Comma-separated file extensions to keep (default: {','.join(DEFAULT_FORMATS)}).",
    )

    portal_encode = generator("encode", "The ENCODE portal's released .hic files.")
    portal_encode.add_argument(
        "--from-json",
        type=Path,
        help="Read a recorded search response (or a directory of paged ones) instead of querying.",
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

    checker = fronts.add_parser("check", help="Validate hub files against Contract 1.")
    checker.add_argument("paths", nargs="+", type=Path)

    return parser


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

    if args.front == "4dn":
        formats = tuple(
            part.strip().lstrip(".").lower() for part in args.formats.split(",") if part.strip()
        )
        if not formats:
            raise SystemExit("--formats named nothing to keep.")
        graph, source = searched(QUERY_4DN, args.from_json, "experiment sets")
        hub = assemble(
            name=args.name or "4DN open data",
            description=DESCRIPTION_4DN,
            source=source,
            columns=COLUMNS_4DN,
            entries=entries_4dn(graph, formats, args.limit),
        )

    elif args.front == "encode":
        graph, source = searched(QUERY_ENCODE, args.from_json, "experiments")
        hub = assemble(
            name=args.name or "ENCODE Hi-C",
            description=DESCRIPTION_ENCODE,
            source=source,
            columns=COLUMNS_ENCODE,
            entries=entries_encode(graph, args.limit),
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
        entries = walk_bucket(
            prefix, limit=args.limit, max_keys=args.max_keys, pages=pages
        )
        segments = [part for part in urllib.parse.urlsplit(prefix).path.split("/") if part]
        hub = assemble(
            name=args.name or (segments[-1] if segments else urllib.parse.urlsplit(prefix).netloc),
            description=f"Every file under {prefix} this viewer has a route for.",
            source=prefix,
            # No columns: a bucket knows a name and a size and nothing else, and
            # a table of empty columns is worse than a table without them.
            columns=[],
            entries=entries,
        )

    if not hub["entries"]:
        log.error(
            "No entries. Nothing was written, and the exit code is 2 so a workflow can tell this "
            "from a portal failure and leave the published hub alone."
        )
        return 2

    written = write_hub(hub, args.out, timestamp=args.timestamp)
    for path in written:
        log.info("wrote %s (%d entries)", path, len(hub["entries"]))

    if args.check and report(args.out, check_hub(args.out)):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
