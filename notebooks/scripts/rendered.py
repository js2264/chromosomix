"""When, from what, by what and on what a notebook was rendered (validation.qmd, timing.qmd).

`Render.head()` is the block under each notebook's title and `Render.foot()` the line at its end,
both Markdown for a cell with `output: asis`; `foot()` also writes the same facts as JSON beside the
notebook's outputs, which .github/workflows/notebooks.yml publishes with the page. Everything is
asked of the checkout and the machine, or read from what GitHub Actions sets, so a page rendered by
hand says so rather than borrowing a run's link.

The two notebooks link to each other through `Render.link()`. Where NOTEBOOKS_SITE names the site
they are published on, a link goes to the other's page there, and a download to the file published
beside the page; rendered by hand, to the other's HTML file and to the file in work/validation/.
"""
import datetime
import json
import os
import platform
import re
import subprocess
from pathlib import Path

from IPython.display import Markdown

REPO = Path(__file__).resolve().parents[2]
NOTEBOOKS = REPO / 'notebooks'
WORK = NOTEBOOKS / 'work' / 'validation'
#: Each notebook by its file's name: where it is published under the site, and what it is called.
PAGES = {'validation': ('validation/', 'Validation'), 'timing': ('timings/', 'Timings')}


def _git(*args):
    run = subprocess.run(['git', *args], capture_output=True, text=True, cwd=REPO)
    return run.stdout.strip() if run.returncode == 0 else ''


def _processor():
    try:
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.startswith('model name'):
                return line.split(':', 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def _memory_gb():
    try:
        return round(os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 1024 ** 3, 1)
    except (AttributeError, OSError, ValueError):
        return None


def _quarto():
    binary = Path(os.environ.get('QUARTO_BIN_PATH', '')) / 'quarto'
    if not binary.exists():
        return None
    run = subprocess.run([str(binary), '--version'], capture_output=True, text=True)
    return run.stdout.strip() or None


def _source(package):
    """The repository's web address: the one a CI run is in, else the one package.json names."""
    server, slug = os.environ.get('GITHUB_SERVER_URL'), os.environ.get('GITHUB_REPOSITORY')
    if server and slug:
        return f'{server}/{slug}'
    url = package.get('repository', {}).get('url', '')
    match = re.search(r'github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$', url)
    return f'https://github.com/{match.group(1)}' if match else None


def _when(moment):
    return moment.strftime('%-d %B %Y, %H:%M UTC')


class Render:
    """One render of one notebook, from the moment its first cell runs."""

    def __init__(self, page):
        self.page = page
        self.started = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        package = json.loads((REPO / 'package.json').read_text())
        self.version = package['version']
        self.commit = _git('rev-parse', 'HEAD') or None
        self.short = _git('rev-parse', '--short', 'HEAD') or 'unknown'
        self.tag = (os.environ['GITHUB_REF_NAME'] if os.environ.get('GITHUB_REF_TYPE') == 'tag'
                    else _git('describe', '--tags', '--exact-match', 'HEAD')) or None
        self.source = _source(package)
        self.site = os.environ.get('NOTEBOOKS_SITE', '').strip()
        if self.site and not self.site.endswith('/'):
            self.site += '/'
        run_id = os.environ.get('GITHUB_RUN_ID')
        self.run = None
        if os.environ.get('GITHUB_ACTIONS') == 'true' and run_id and self.source:
            self.run = {'url': f'{self.source}/actions/runs/{run_id}', 'number': os.environ.get('GITHUB_RUN_NUMBER'),
                        'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'workflow': os.environ.get('GITHUB_WORKFLOW'),
                        'event': os.environ.get('GITHUB_EVENT_NAME'), 'actor': os.environ.get('GITHUB_ACTOR')}
        self.machine = {'system': f'{platform.system()} {platform.release()}', 'architecture': platform.machine(),
                        'processor': _processor(), 'cores': os.cpu_count(), 'memory_gb': _memory_gb(),
                        'python': platform.python_version(), 'quarto': _quarto()}

    def url(self, page):
        """Where the notebook named `page` is read: its published address, or its HTML file here."""
        return f'{self.site}{PAGES[page][0]}' if self.site else f'{page}.html'

    def anchor(self, page, text=None):
        """A link to the other notebook, as Markdown text."""
        return f'[{text or f"`{page}.qmd`"}]({self.url(page)})'

    def link(self, page, text=None):
        """The same, for an inline expression: `{python} R.link('timing')`."""
        return Markdown(self.anchor(page, text))

    def download(self, name, text=None):
        """A file published beside this page; rendered by hand, the one in work/validation/."""
        target = name if self.site else os.path.relpath(WORK / name, NOTEBOOKS)
        return f'[{text or f"`{name}`"}]({target})'

    def _chromosomix(self):
        commit = f'[`{self.short}`]({self.source}/commit/{self.commit})' if self.commit and self.source \
            else f'`{self.short}`'
        release = ''
        if self.tag:
            release = f', release [{self.tag}]({self.source}/releases/tag/{self.tag}),' if self.source \
                else f', release {self.tag},'
        return f'**chromosomix** {self.version}{release} at {commit}'

    def _by(self):
        if self.run is None:
            return '**By** hand, not by the workflow that publishes these pages'
        how = {'release': 'for its release', 'workflow_dispatch': f'on demand of {self.run["actor"]}'}.get(
            self.run['event'], f'on {self.run["event"]}')
        attempt = f', attempt {self.run["attempt"]}' if self.run['attempt'] not in (None, '1') else ''
        return f'**By** GitHub Actions, [{self.run["workflow"]} run {self.run["number"]}]({self.run["url"]}){attempt}, {how}'

    def _on(self):
        m = self.machine
        memory = f', {m["memory_gb"]:g} GB' if m['memory_gb'] else ''
        tools = f'Python {m["python"]}' + (f', Quarto {m["quarto"]}' if m['quarto'] else '')
        return f'**On** {m["processor"]}, {m["cores"]} cores{memory}, {m["system"]} ({m["architecture"]}); {tools}'

    def head(self, also=''):
        """The block under the title: when, from what, by what, on what, and `also` after it."""
        lines = [f'**Rendered** {_when(self.started)}', self._chromosomix(), self._by(), self._on()]
        body = ' · '.join(lines[:2]) + '  \n' + '  \n'.join(lines[2:])
        if also:
            body += f'\n\n{also}'
        return f'::: {{.callout-note appearance="simple" icon=false}}\n{body}\n:::\n'

    def facts(self):
        """Everything head() and foot() say, as one JSON-ready dictionary."""
        finished = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        return {'page': self.page, 'published_at': self.url(self.page) if self.site else None,
                'started': self.started.isoformat(), 'finished': finished.isoformat(),
                'seconds': int((finished - self.started).total_seconds()),
                'chromosomix': {'version': self.version, 'commit': self.commit, 'tag': self.tag,
                                'source': self.source},
                'run': self.run, 'machine': self.machine}

    def foot(self):
        """The closing line, and the same facts written to work/validation/rendered-<page>.json."""
        facts = self.facts()
        WORK.mkdir(parents=True, exist_ok=True)
        (WORK / f'rendered-{self.page}.json').write_text(json.dumps(facts, indent=2) + '\n')
        minutes, seconds = divmod(facts['seconds'], 60)
        took = f'{minutes} min {seconds} s' if minutes else f'{seconds} s'
        finished = datetime.datetime.fromisoformat(facts['finished'])
        return (f'\n---\n\n*Rendered in {took}, from {_when(self.started)} to {finished.strftime("%H:%M UTC")}, '
                f'by chromosomix {self.version} at `{self.short}`.*\n')
