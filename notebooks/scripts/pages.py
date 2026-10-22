"""The notebooks .github/workflows/notebooks.yml renders and publishes, in one table.

Each page is rendered by a job of its own — the validation and the timings by one, since the timings
run the validation's commands again on the validation's inputs — and a last job gathers the pages,
publishes them and writes the run's summary. Every one of those steps asks the same things of a page:
where it is published, which folder of work/ its outputs are in, which files go beside it, and which
of them a release keeps. They are answered here, once, and `rendered.py` reads the same table, so a
fifth notebook is one more entry — and one more in `src/notebooks.ts`, the list the app's About names
under *Notebooks*, which test/unit/notebooks.test.ts holds to this one. Nothing beyond Python itself
is needed.

    python notebooks/scripts/pages.py gather validation timing    # the pages into pages/
    python notebooks/scripts/pages.py assets v0.17.0 assets/       # a release's copies, from pages/
    python notebooks/scripts/pages.py summary                      # Markdown for the run's summary

`summary` reads the published copies in pages/: each page's `rendered.json` (when, from what, and the
one-line summary the notebook wrote with `Render.foot()`) and the tables beside it. NEEDS is the
workflow's `toJSON(needs)`, for a page whose job failed; SITE and PUBLISHED say where the pages went.
"""
import csv
import datetime
import json
import os
import shutil
import sys
from dataclasses import dataclass, field
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


PAGES = {
    'validation': Page('validation', 'Validation', 'validation', 'validation',
                       {'commands.json': None, 'summary.tsv': 'validation-{tag}.tsv',
                        'validation.txt': 'validation-{tag}.txt'}),
    'timing': Page('timings', 'Timings', 'validation', 'validation',
                   {'timings.tsv': 'timings-{tag}.tsv', 'viewers.tsv': 'viewers-{tag}.tsv'}),
    'parity': Page('parity', 'Parity', 'parity', 'parity', {'summary.tsv': 'parity-{tag}.tsv'}),
    'laptop': Page('laptop', 'Laptop', 'laptop', 'laptop', {'timings.tsv': 'laptop-{tag}.tsv'}),
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


def assets(tag, out, pages=Path('pages')):
    """A release's own copies of every page and of the tables it keeps, named after the tag."""
    out.mkdir(parents=True, exist_ok=True)
    for page in PAGES.values():
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
        return _details(f'Every analysis ({len(rows)})', ['Data', 'Analysis', 'Resolution', 'Wall-clock, s',
                                                           'Peak memory, MB'],
                        [[r['data'], r['analysis'], r['resolution'], f"{float(r['wall_s']):,.1f}",
                          f"{float(r['peak_mb']):,.0f}"] for r in rows])
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
        where = f'[{site}{page.path}/]({site}{page.path}/)' if published else f'not published ([artifact]({run}))'
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


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    if command == 'gather':
        gather(args or list(PAGES))
    elif command == 'assets':
        assets(args[0], Path(args[1]))
    elif command == 'summary':
        summary()
    else:
        sys.exit(f'pages.py: no command {command!r} (gather, assets, summary)')
