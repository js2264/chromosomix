---
title: "Installing the command line"
description: "Install the chromosomix command from npm, pin the release a pipeline runs, and check which build you have."
---

The `chromosomix` command runs the tasks of the app's **Analysis** panel from a shell, with the same parameters and the same results. It is published to npm with every release, and it runs on Node.js.

## What it needs

Node.js 22.12 or later. Check the version you have:

```sh
node --version
```

## Install the latest release

```sh
npm install -g chromosomix
```

This puts the `chromosomix` command on your `PATH`. Check that it answers by listing its tasks:

```sh
chromosomix tasks
```

## Pin a release

A pipeline, a script you will run again next year, or a methods section should name the release it used. Install that one:

```sh
npm install -g chromosomix@<version>
```

Or let `npx` run a given release without installing anything:

```sh
npx chromosomix@<version> insulation sample.cool --window 10 --out results/
```

The releases are listed on [GitHub](https://github.com/js2264/chromosomix/releases) and on [npm](https://www.npmjs.com/package/chromosomix).

## Check which build you have

```sh
chromosomix --version
```

It prints four lines:

```text
chromosomix <version> (<commit>)
node <version> on <platform>-<arch>
h5wasm <version>
@gmod/bbi <version>
```

- The first is the release and the commit it was built from. Every table the command writes opens with the same release, as `# chromosomix <version> cli`.
- The second is the Node.js it runs on, with the platform.
- The last two are the libraries that read every map and every track, as they are installed beside the command. npm settles their versions when the package is installed, not when it was built, so two installs of one release can read your files through different builds of them. Keep all four lines in a pipeline's record, not only the first.

`--version` is answered wherever it is on a line, and nothing else runs.

## From a clone

To run a change that is not released yet, build the command from the repository:

```sh
git clone https://github.com/js2264/chromosomix
cd chromosomix
npm install
npm run build:cli && npm link
```

`npm link` puts this build on your `PATH` as `chromosomix`.

:::note[The viewer is in the package too]
The npm package also carries the viewer itself, built to run from any folder on any server. It is what the notebook widgets fetch with `install_viewer()` to serve beside your files ([Jupyter](/embed/jupyter/), [R](/embed/r/)), and a copy you can put on a server of your own ([Running your own copy](/advanced/self-hosting/)).
:::

Next: [Running a task](/cli/running/), then [In a pipeline](/cli/pipelines/).
