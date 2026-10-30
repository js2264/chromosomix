"""The notebooks .github/workflows/notebooks.yml renders, and the site publishes, in one table.

Each page is rendered by a job of its own — the validation and the timings by one, since the timings
run the validation's commands again on the validation's inputs — and a last job gathers the pages,
publishes them and writes the run's summary. **The laptop is the exception**: it is rendered by hand, on
a laptop, and committed as notebooks/laptop.html, which is what the site publishes at laptop/; the
workflow still renders it on a runner with every release, for the run's artifact and its summary, and
never publishes that. Every one of those steps asks the same things of a page:
where it is published, which folder of work/ its outputs are in, which files go beside it, and which
of them a release keeps. They are answered here, once, and `rendered.py` reads the same table, so a
fifth notebook is one more entry — and one more in `src/notebooks.ts`, the list the app's About names
under *Notebooks*, which test/unit/notebooks.test.ts holds to this one. Nothing beyond Python itself
is needed.

    python notebooks/scripts/pages.py gather validation timing    # the pages into pages/
    python notebooks/scripts/pages.py published                    # the folders the workflow publishes
    python notebooks/scripts/pages.py assets v0.17.0 assets/       # a release's copies, from pages/
    python notebooks/scripts/pages.py summary                      # Markdown for the run's summary
    python notebooks/scripts/pages.py committed dist/              # the committed pages, into the site

A page rendered by hand carries the files published beside it — its tables and its `rendered.json` —
inside itself, as links that download them (`Render.attach()`), so that the one file committed is the
whole of it and its table cannot disagree with its picture. `committed` writes each such page into the
site as `<path>/index.html` and unpacks those files beside it.

`summary` reads the published copies in pages/: each page's `rendered.json` (when, from what, and the
one-line summary the notebook wrote with `Render.foot()`) and the tables beside it. NEEDS is the
workflow's `toJSON(needs)`, for a page whose job failed; SITE and PUBLISHED say where the pages went.
"""
import base64
import csv
import datetime
import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

NOTEBOOKS = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Page:
    #: Where it is published under the site, without its slash.
    path: str
    title: str
    #: The folder of notebooks/work/ its outputs are in.
    work: str
    #: The job of notebooks.yml that renders it.
    job: str
    #: The files published beside it, each with the name a release keeps it under, if it keeps it.
    files: dict = field(default_factory=dict)
    #: Rendered by hand and committed as notebooks/<name>.html: the workflow's own render of it is kept
    #: as the run's artifact and never published, nor kept by a release.
    local: bool = False


PAGES = {
    'validation': Page('validation', 'Validation', 'validation', 'validation',
                       {'commands.json': None, 'summary.tsv': 'validation-{tag}.tsv',
                        'validation.txt': 'validation-{tag}.txt'}),
    'timing': Page('timings', 'Timings', 'validation', 'validation',
                   {'timings.tsv': 'timings-{tag}.tsv', 'viewers.tsv': 'viewers-{tag}.tsv'}),
    'parity': Page('parity', 'Parity', 'parity', 'parity', {'summary.tsv': 'parity-{tag}.tsv'}),
    'laptop': Page('laptop', 'Laptop', 'laptop', 'laptop', {'timings.tsv': None}, local=True),
}


def gather(names, into=Path('pages')):
    """Each page and the files beside it, as they are published: whatever was made, so that a render
    that failed part of the way still leaves its tables to the run's artifact."""
    for name in names:
        page, work = PAGES[name], NOTEBOOKS / 'work' / PAGES[name].work
        target = into / page.path
        made = [(NOTEBOOKS / f'{name}.html', 'index.html'), (work / f'rendered-{name}.json', 'rendered.json'),
                *[(work / file, file) for file in page.files]]
        for source, published in made:
            if source.exists():
                target.mkdir(parents=True, exist_ok=True)
                shutil.copy(source, target / published)
        print(f'{name}: ' + (', '.join(sorted(p.name for p in target.iterdir())) if target.exists() else 'nothing'))


def published():
    """The folders the workflow publishes to its branch: every page but those rendered by hand."""
    return [page.path for page in PAGES.values() if not page.local]


def assets(tag, out, pages=Path('pages')):
    """A release's own copies of every page the workflow publishes and of the tables it keeps, named after
    the tag. A page rendered by hand is in the release's source as committed."""
    out.mkdir(parents=True, exist_ok=True)
    for page in PAGES.values():
        if page.local:
            continue
        shutil.copy(pages / page.path / 'index.html', out / f'{page.path}-{tag}.html')
        for file, kept in page.files.items():
            if kept:
                shutil.copy(pages / page.path / file, out / kept.format(tag=tag))
    print('\n'.join(sorted(p.name for p in out.iterdir())))


def _rows(path):
    with open(path, newline='') as handle:
        return list(csv.DictReader(handle, delimiter='\t'))


def _details(title, header, rows):
    if not rows:
        return []
    return ['', f'<details><summary>{title}</summary>', '', '| ' + ' | '.join(header) + ' |',
            '|' + '---|' * len(header), *['| ' + ' | '.join(str(cell) for cell in row) + ' |' for row in rows],
            '', '</details>']


def _tables(name, folder):
    """The table under a page's summary, folded: every verdict, every file, every analysis."""
    if name == 'validation' and (folder / 'summary.tsv').exists():
        rows = _rows(folder / 'summary.tsv')
        return _details(f'Every verdict ({len(rows)})', ['§', 'Analysis', 'Reference', 'Verdict'],
                        [[r['§'], r['Analysis'], r['Reference'], r['Verdict']] for r in rows])
    if name == 'parity' and (folder / 'summary.tsv').exists():
        cases = {}
        for row in _rows(folder / 'summary.tsv'):
            cases.setdefault((row['case'], row['task']), []).append(row['verdict'])
        return _details(f'Every task ({len(cases)})', ['Case', 'Task', 'Files', 'Identical', 'Data differs',
                                                        'One side only'],
                        [[case, f'`{task}`', len(v), v.count('identical'), v.count('data differs'),
                          sum(x in ('browser only', 'command line only') for x in v)]
                         for (case, task), v in cases.items()])
    if name == 'laptop' and (folder / 'timings.tsv').exists():
        rows = _rows(folder / 'timings.tsv')

        def shown(row, column, form):
            # The app's figures are blank for a run it did not finish, as is a table from before it had any.
            value = row.get(column) or 'nan'
            return '—' if value == 'nan' else form.format(float(value))
        return _details(f'Every analysis ({len(rows)})', ['Data', 'Analysis', 'Resolution', 'Command line, s',
                                                           'App, s', 'Command line, MB', 'App, MB'],
                        [[r['data'], r['analysis'], r['resolution'], shown(r, 'wall_s', '{:,.1f}'),
                          shown(r, 'app_wall_s', '{:,.1f}'), shown(r, 'peak_mb', '{:,.0f}'),
                          shown(r, 'app_peak_mb', '{:,.0f}')] for r in rows])
    return []


def summary(pages=Path('pages')):
    """One section per page: where it is and from what, its own one-line summary, and its table."""
    site = os.environ.get('SITE', '')
    published = os.environ.get('PUBLISHED') == 'true'
    needs = json.loads(os.environ.get('NEEDS') or '{}')
    run = f"{os.environ.get('GITHUB_SERVER_URL')}/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/" \
          f"{os.environ.get('GITHUB_RUN_ID')}#artifacts"
    lines = ['## Notebooks']
    for name, page in PAGES.items():
        folder = pages / page.path
        lines += ['', f'### {page.title}', '']
        stamp = folder / 'rendered.json'
        if not stamp.exists():
            result = needs.get(page.job, {}).get('result')
            said = {'failure': 'failed', 'cancelled': 'was cancelled', 'skipped': 'was skipped',
                    'success': 'finished without it'}.get(result, 'did not run')
            lines.append(f'Not rendered: the `{page.job}` job {said}.')
            lines += _tables(name, folder)
            continue
        facts = json.loads(stamp.read_text())
        if page.local:
            where = (f'not published: the site\'s is the render committed as `notebooks/{name}.html` '
                     f'([this run\'s artifact]({run}))')
        elif published:
            where = f'[{site}{page.path}/]({site}{page.path}/)'
        else:
            where = f'not published ([artifact]({run}))'
        c = facts['chromosomix']
        finished = datetime.datetime.fromisoformat(facts['finished']).strftime('%Y-%m-%d %H:%M UTC')
        took = f"{facts['seconds'] // 60} min" if facts['seconds'] >= 60 else f"{facts['seconds']} s"
        lines.append(f"{where} · chromosomix {c['version']} at `{(c['commit'] or '')[:7]}`"
                     + (f", release {c['tag']}" if c['tag'] else '')
                     + f" · rendered in {took}, finished {finished}")
        if facts.get('summary'):
            lines += ['', facts['summary']]
        lines += _tables(name, folder)
    print('\n'.join(lines))


class _Attachments(HTMLParser):
    """Every link in a page that downloads a file it carries: `<a href="data:…;base64,…" download="…">`."""

    def __init__(self):
        super().__init__()
        self.found = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        href, name = attrs.get('href') or '', attrs.get('download')
        if tag == 'a' and name and href.startswith('data:') and ';base64,' in href:
            self.found[name] = base64.b64decode(href.split(';base64,', 1)[1], validate=True)


def committed(into, source=NOTEBOOKS):
    """Each page rendered by hand, as committed, into the site: `<path>/index.html`, and beside it the files
    the page carries — those its entry names and its `rendered.json`, and nothing else, whatever it holds.
    A page not committed yet is left out, and said to be."""
    for name, page in PAGES.items():
        if not page.local:
            continue
        html = source / f'{name}.html'
        if not html.exists():
            print(f'{name}: no {html.name} committed, so no {page.path}/')
            continue
        target = into / page.path
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy(html, target / 'index.html')
        reader = _Attachments()
        reader.feed(html.read_text(encoding='utf-8'))
        written = ['index.html']
        for file in [*page.files, 'rendered.json']:
            if file in reader.found:
                (target / file).write_bytes(reader.found[file])
                written.append(file)
        print(f'{name}: {", ".join(written)}')


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    if command == 'gather':
        gather(args or list(PAGES))
    elif command == 'published':
        print('\n'.join(published()))
    elif command == 'assets':
        assets(args[0], Path(args[1]))
    elif command == 'summary':
        summary()
    elif command == 'committed':
        committed(Path(args[0]), *(Path(arg) for arg in args[1:2]))
    else:
        sys.exit(f'pages.py: no command {command!r} (gather, published, assets, summary, committed)')
