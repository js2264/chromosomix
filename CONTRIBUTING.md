# Contributing to chromosomix

Thank you for helping. Bug reports, fixes, file formats, analyses and corrections to the documentation
are all welcome.

## Reporting a problem

Open an [issue](https://github.com/js2264/chromosomix/issues/new/choose) and pick the form that fits.
Say which build you used (**About → version**, or `chromosomix --version`), what you did, what you
expected and what happened. A link to the view is the fastest way to show it. Report a security
problem privately, as [`SECURITY.md`](SECURITY.md) says, not in an issue.

## Building and testing

Node 22.12 or later.

```sh
npm install
npm run dev               # the web app at http://localhost:5173
npm run typecheck
npm test                  # every test a fresh clone can run
npm run docs:build        # the documentation site, every internal link checked
```

`npm test` says at its top what it left out:

- **The suites over metacooler's fixtures**, which `npm run fixtures` builds with a Python that has
  metacooler installed, a private repository. CI builds and runs them.
- **The tests of the dev features** (`SPECS.md` §29), which `npm run test:dev` adds. CI runs them on
  every push.

## What a pull request carries

- **One concern.** A fix, a feature or a refactor, not several.
- **`SPECS.md` is the contract.** A change in behaviour changes the section that governs it.
- **`CHANGELOG.md`**: a line under *Unreleased*, in *Added*, *Changed* or *Fixed*.
- **The documentation site**: a change a user can see changes the page that tells them about it
  (`documentation/`, `SPECS.md` §32). Dev features are not documented there.
- **Tests**, held to a reference implementation wherever one exists, not to the code's own output.
- **Screenshots** of the real app for any change to what is on screen.
- **An analysis that changes** what it computes, its defaults or its speed is checked against the
  package it reproduces, and its section of `notebooks/validation.qmd` is updated.

Commit messages: a subject that names the area and the change, with the SPECS section it touches —
`Notebooks: ask again when a download's server fails (§18.10)` — and a body that says why.

## Adding a file format or an analysis

[Adding a reader or a task](https://doc.chromosomix.app/contributing/readers-and-tasks/) on the
documentation site says where each goes and what it must come with.

## Licence

chromosomix is under the [GNU General Public License, version 3 or later](LICENSE). By contributing,
you agree that your contribution is released under the same licence.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
