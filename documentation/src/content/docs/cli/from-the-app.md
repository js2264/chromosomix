---
title: "From the app to a script"
description: "Take a run you tuned on screen to the command line: copy the command the console wrote for it, or replay a saved workspace over other files."
---

Getting a run right is easier on screen: you move the window, change a parameter, run again and look. Once it is right and you have two hundred files rather than one, the app hands you the command that repeats it, so nothing has to be copied out by eye.

## The command beside a result

Under a finished result in the analysis drawer, **copy CLI command** puts the `chromosomix` line that repeats the run on the clipboard. **copy provenance** beside it copies the header every export opens with: the build, the task and its version, the framing, the file and every parameter.

On a deck run with **run on all maps**, the **all maps** tab copies one command per map, each under a `#` line naming its map.

## The console

The console records the window's day: every analysis run, as the command that repeats it, and every file opened, track loaded and file written, as a comment. Open it with the console button in the header, after the save button, or with <kbd>Ctrl</kbd> and the key left of <kbd>1</kbd>: <kbd>Ctrl</kbd>+<kbd>&#96;</kbd> on a QWERTY keyboard. It is <kbd>Ctrl</kbd> on a Mac too, not <kbd>⌘</kbd>.

<!-- screenshot: the console along the bottom of the window, with two runs of insulation and a file opened, the provenance toggle off -->

A run's line is written when the run starts, not when you look at its result, so a run you changed since, a run on the fifth map of a batch and a run that failed all have theirs. A batch over a deck is a line per map.

What you take from it is a shell script: the commands bare, and everything else a `#` comment — the day headings, the files opened and written, a failure's reason (`# failed: …`). A day pasted into a file runs, in the order it ran the first time.

- The copy button at the end of a row copies that line.
- **copy this day**, on a day's heading, copies the day.
- **copy** copies every line, and **save** writes the same text as a `.sh` file.
- **provenance** prints each entry's full provenance above it, and puts it in what you copy or save. It is off by default, for clean commands.
- **clear** forgets every line.

The console keeps a week, or five hundred lines, in this browser, and sends nothing anywhere. An embedded viewer has none. More on it in [The console](/browse/console/).

## What the line holds

A run of insulation on a map opened from an address is a line like:

```sh
chromosomix insulation https://example.org/sample.mcool::/resolutions/10000 --window 10 --scales 1 --ignoreDiags 2 --call --prominence 0.2 --minValid 0.5 --spacing 0 --domains
```

It is written in the order a person would write it: the task, the map, how the map was read, the files the task needs, then the task's parameters.

- **Every parameter the run had**, the ones left at their defaults included. A later release may change a default; the line still repeats this run.
- **How the map was read**: `--no-balance` where it was read raw, and `--contacts`, `--coarsen`, `--circular`, `--origin`, `--cell` and `--value` wherever you set them on screen. A `.pairs` carries the `--bin-size` you binned it at. `--window` is the part of the map that was on screen, written as the breadcrumb shows it — except for a task with a `--window` of its own, like insulation, whose line has that one instead.
- **The files**, as the browser knows them. A file opened from an address is named by its address, and the command reads it by range as the app did. A file from your disk is named by its file name alone, because a browser is never told which folder a file came from: run the line in the folder that holds it, or put in its path. A track, feature set or reference a parameter names is written by its file name too, wherever it came from.
- **No `--out`.** The line writes into the folder it is run from; add `--out <dir>` to put the files elsewhere.

What a shell cannot be told is said in `#` lines above the command, and kept with it when you copy:

- a parameter that names a set the app computed, with no file behind it: export that row first, and point the parameter at the file;
- the maps a [Reproducibility](/analyses/hicrep/) run compared against, where the record does not name them: add `--against <file>` for each;
- the cells of an `.scool` the map was summed from, where they are not named: add `--cell <name>` for each;
- a map drawn balanced and read raw, or the reverse, which the one `--no-balance` cannot say: the line follows what the task read, so the numbers match.

The two agree: a notebook rendered with every release runs ten tasks in the app, in a headless browser, then from the line its console wrote for each, and compares every file the two wrote: [the parity notebook](https://chromosomix.app/parity/). See [How the results are checked](/analyses/validation/) for the rest.

## A saved workspace, over other files

A workspace remembers, for each tab, the analyses you ran and the parameters you settled on. `chromosomix replay` runs all of them again over other files, each with the parameters it recorded, so a method tuned on one library is applied to the rest unchanged.

1. Run the tasks you want in the app, on one map, until each is right.
2. Save the window with the header's save button, **Save every tab as a file** (<kbd>Ctrl</kbd>+<kbd>S</kbd>, or <kbd>⌘</kbd>+<kbd>S</kbd> on a Mac). The app writes a file such as `workspace-20261103-101244.chromosomix.json`.
3. Replay it over the other maps:

```sh
chromosomix replay workspace.chromosomix.json --over data/*.hic --out results/
```

`--over data/*.hic` is expanded by the shell, and every file it names is run; files named after the workspace are run too. Each file's results are named after it, as a [task's run](/cli/running/) names them, and stderr says how many tasks it found and over how many files.

| Flag | What it does |
| --- | --- |
| `--over <file> …` | the files to run over. With none, the map the tab itself names |
| `--tab <n>` | which tab to replay, counting from 1. By default, the one that was in front when you saved |
| `--track <file>` | the file behind a track the workspace recorded, matched by its file name. Repeat it for each track |
| `--against <file>` | the other maps a recorded [Reproducibility](/analyses/hicrep/) run compared against |
| `--out <dir>` | where to write, as for any task |

A locus the workspace recorded is read as the form showed it. Before any file is opened, a workspace that recorded no analysis is refused (run a task and save again), and so is one that recorded a value this release cannot run, with exit status 2. A recorded task this release does not have, or a Reproducibility run with no `--against`, is skipped with a line saying so, and the others run.

The workspace format is on [Files, hosts and stores](/reference/files-and-stores/); saving and opening workspaces in the app is in [Sessions, workspaces and links](/browse/sessions-and-links/).
