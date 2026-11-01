"""Every file the notebooks fetch over HTTP(S), asked again when the server or the network fails.

validation.qmd, timing.qmd, parity.qmd and laptop.qmd fetch their data from where each file was
published, on every render. One server's failure was enough to fail a render, and the run with it:
on 1 November 2026, NCBI's ftp.ncbi.nlm.nih.gov, where GEO's files are, answered one request in two,
and at times three in four, with 500 Internal Server Error, now and then with 403 Forbidden — a HEAD,
a range and a whole file alike, the same request answered in full a second later — and the parity's
first download stopped both of that day's runs of .github/workflows/notebooks.yml a minute in.

`download()` writes a URL to a file whole. A response that is a server's error (500, 502, 503, 504,
408, 425, 429, and 403, which NCBI's answers at random), a connection refused, reset or timed out, or a body that
ends before the length it was announced at is asked again, after a wait that doubles from two seconds
to half a minute, and from the byte it reached where the server takes a range. It gives up after
ATTEMPTS failures in a row with no byte between them, so a download of many gigabytes that the
network cuts now and then is resumed as many times as it takes, and a server that is down fails it in
about eight minutes. A local fault — a full disk —, any other 4xx, which names the request, or a
certificate that is not the host's is raised at once. `urlopen()` is the same, for a request answered
in one read: a HEAD or a range.

usage: python download.py URL OUT
"""
import http.client
import re
import shutil
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

#: Failures in a row, with no byte between them, before a download is given up.
ATTEMPTS = 20
#: The longest wait between two attempts, in seconds.
LONGEST_WAIT = 30
#: Seconds a connection or a read may wait for the server before the attempt fails.
TIMEOUT = 120
#: Answers that are the server's fault, or its load, and that asking again may mend; 403 among them,
#: since NCBI's answers it to a request it answers in full a second later.
RETRIED = frozenset({403, 408, 425, 429, 500, 502, 503, 504})


class ShortBody(http.client.HTTPException):
    """A response that ended before the length it was announced at."""


#: What a failed request raises: the network's faults, never a local file's.
NETWORK = (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError, ssl.SSLError)


def _retried(error):
    """Whether asking again may mend this failure: a server's error or the network's, not a request
    the server refused or a certificate that is not the host's."""
    if isinstance(error, urllib.error.HTTPError):
        error.close()
        return error.code in RETRIED
    return not isinstance(getattr(error, 'reason', error), ssl.SSLCertVerificationError)


def _wait(url, error, failures):
    seconds = min(LONGEST_WAIT, 2 ** failures)
    print(f'{url}: {error}; asking again in {seconds} s ({failures} of {ATTEMPTS})', flush=True)
    time.sleep(seconds)


def urlopen(request):
    """`urllib.request.urlopen(request)`, asked again as `download()` asks: for a HEAD or a range read
    whole as soon as it is answered."""
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    failures = 0
    while True:
        try:
            return urllib.request.urlopen(request, timeout=TIMEOUT)
        except NETWORK as error:
            failures += 1
            if not _retried(error) or failures >= ATTEMPTS:
                raise
            _wait(url, error, failures)


def _length(response, start):
    """The length of the whole file this response is part of, or None where it does not say: from a
    206's Content-Range, which must begin at `start`, or else a 200's Content-Length."""
    if response.status == 206:
        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', response.headers.get('Content-Range', '').strip())
        if match is None or int(match[1]) != start:
            raise ShortBody(f'asked for bytes {start}- and was sent {response.headers.get("Content-Range")!r}')
        return None if match[3] == '*' else int(match[3])
    length = response.headers.get('Content-Length')
    return int(length) if length is not None and not response.headers.get('Content-Encoding') else None


def download(url, path):
    """`url` written whole to `path`, through `path` + '.part' renamed once the last byte is in."""
    path = Path(path)
    part = path.with_name(path.name + '.part')
    part.unlink(missing_ok=True)
    failures = 0
    while True:
        start = part.stat().st_size if part.exists() else 0
        request = urllib.request.Request(url, headers={'Range': f'bytes={start}-'} if start else {})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                if start and response.status != 206:
                    start = 0  # the whole file again, not the rest of it: written from the start
                length = _length(response, start)
                with open(part, 'ab' if start else 'wb') as out:
                    shutil.copyfileobj(response, out, 1 << 22)
            size = part.stat().st_size
            if length is not None and size != length:
                raise ShortBody(f'the response ended at byte {size:,} of {length:,}')
            part.rename(path)
            return path
        except NETWORK as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 416 and start:
                error.close()
                part.unlink()  # a range past what the server holds now: the file again, from the start
            elif not _retried(error):
                raise
            reached = part.stat().st_size if part.exists() else 0
            failures = 1 if reached > start else failures + 1
            if failures >= ATTEMPTS:
                raise
            _wait(url, error, failures)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__.rsplit('usage: ', 1)[1].strip())
    download(sys.argv[1], sys.argv[2])
