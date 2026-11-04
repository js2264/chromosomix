---
title: "Installing the command line"
description: "Install the chromosomix command from npm, pin the release a pipeline runs, and check which build you have."
---

The `chromosomix` command runs the tasks of the **Analysis** panel from a shell, with the same parameters and results. It needs Node.js 22.12 or later:

```sh
node --version
```

## Install the latest release

```sh
npm install -g chromosomix
```

Check that it answers by listing its tasks:

```sh
chromosomix tasks
```

## Pin a release

A pipeline or a methods section should name the release it used:

```sh
npm install -g chromosomix@<version>
```

Or run a release with `npx`, without installing anything:

```sh
npx chromosomix@<version> insulation sample.cool --window 10 --out results/
```

Releases are listed on [GitHub](https://github.com/js2264/chromosomix/releases) and [npm](https://www.npmjs.com/package/chromosomix).

## Check which build you have

```sh
chromosomix --version
```

It prints four lines, and runs nothing else:

```text
chromosomix <version> (<commit>)
node <version> on <platform>-<arch>
h5wasm <version>
@gmod/bbi <version>
```

The last two are the libraries that read every map and track, which npm settles at install time: two installs of one release can differ, so keep all four lines in a pipeline's record. Every table the command writes opens with the release, as `# chromosomix <version> cli`.

## From a clone

To run a change that is not released yet:

```sh
git clone https://github.com/js2264/chromosomix
cd chromosomix
npm install
npm run build:cli && npm link
```

`npm link` puts this build on your `PATH` as `chromosomix`.

Next: [Running a task](/cli/running/), then [In a pipeline](/cli/pipelines/).
