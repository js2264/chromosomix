---
title: "The console"
description: "The console records every analysis run, file opened, track loaded and file written in this window, each run as the chromosomix command that repeats it, and keeps a week of it in your browser."
---

The console is a log, along the bottom of the window, of what this window has done. Every analysis
you run is written there as the `chromosomix` command line that repeats it, at the moment it runs.
Tune a run on screen until the picture is right, then take its line to a shell for the other two
hundred files, or into the methods section of a paper.

<!-- screenshot: the console open along the bottom of the window under a map, with today's runs as chromosomix commands and one file written -->

## Opening it

Press the console's button in the header, the terminal mark after the share and save buttons, or
<kbd>Ctrl</kbd>+<kbd>backtick</kbd>: Control and the key left of <kbd>1</kbd>, which is
<kbd>Ctrl</kbd>+<kbd>²</kbd> on a French PC keyboard. It is Control on a Mac too, not ⌘. The
command palette lists it as **Console**. The button's tooltip says how many lines are recorded.

The console floats over the bottom of the window. Drag its top edge to make it taller or shorter:
the height is remembered, and so is whether you left it open. Press Escape or its × to close it.
Closing it stops nothing, and the console goes on recording.

It is not a dialog. Every shortcut keeps working while it is open, so you can pan the map while you
read this morning's commands, and the Analysis drawer and the console can be open at the same time.

## What it records

One line for each thing this window did:

- **an analysis run**, one line per job. **run on all maps** over six maps is six lines, each naming
  its own file, while a task that reads tracks rather than a map is one line however many maps there
  are. The line is written when the job starts, so a run that fails keeps its line and its parameters,
  with the error under it, and so does a run you cancel. A press of **run** that could not start,
  with nothing open or no map in view, leaves a sentence saying why instead of a command;
- **a file opened**, as `opened` and the file's name, once it has been read;
- **a track loaded**, as `loaded` and its name, when you add one. Tracks the app brings back after a
  reload are not listed again;
- **a file written**, as `wrote` and its name: every export, figure, table and workspace, under the
  name you gave it in the save dialog. A save you cancelled writes no line.

Moving around is not recorded. A pan reads the file without changing anything, and the view a
result belongs to is already in its record.

Each row shows the time, a mark for its kind, the line itself, the file it is about and how long it
took. The mark's tooltip says the state: *running*, *done*, *failed*, *cancelled*, or *interrupted*
for a run that was going when its window closed. The copy button at the row's end, **Copy this
line**, copies that row alone.

## The command on a line

A run's line is the same command the **copy CLI command** button gives under a finished result in
the Analysis drawer. It is built to repeat the run exactly:

- it names every parameter, the defaults included, so a later change of default cannot change what
  it runs;
- it gives the window as the screen shows it, 1-based and with digits grouped, such as
  `--window IV:1,000,001-1,400,000`;
- it adds, as flags of their own, what the view set without being a parameter: the score the map is
  drawn from (`--value`), the sequences declared circular and their origins (`--circular`,
  `--origin`), the cells of an `.scool` (`--cell`), the total the map is drawn to (`--contacts`) and
  a resolution you added (`--coarsen`), each only where it differs from the default. A run on raw
  counts says `--no-balance`, since balanced is the default;
- a file read from an address is named by that address, and the command reads it by range, as the
  app did.

What a shell command cannot say is written as a `#` note above the command: for example a window
that spans several sequences or lies off the diagonal, or a map drawn balanced but read raw. A
command that runs but answers a slightly different question would be worse than one that says what
it left out.

See [From the app to a script](/cli/from-the-app/) for taking these lines further, and the
[command line reference](/reference/command-line/) for every flag.

## Copying and saving

There are three ways to take lines away:

- a row's own copy button, for one line;
- **copy this day**, on the separator that heads each day (*today*, *yesterday*, or the date, with
  its count of lines);
- **copy** in the console's header, for everything, and **save**, which writes the same text as a
  file, `chromosomix-console-<stamp>.sh`.

What you copy is a shell script rather than a transcript. Commands are bare and everything else is
a `#` comment: each day's heading, the opens, the tracks, the files written, the notes, and a failure
as `# failed:` and its message under its command. Paste a day into a file and it runs, in the order
it ran the first time, with the rest of the afternoon left in as comments saying what each command
was for. A saved file opens with:

```sh
#!/bin/sh
# chromosomix console, saved 2026-11-03T14:52:33.000Z
# Commands are bare; everything else is a comment.
```

The save is a file leaving the app, so it is recorded too.

**provenance**, a switch in the header, is off by default. Switched on, each row shows its full
record above it: the build, the task and its version, the view in words, and every parameter on a
line of its own, which is the header every exported table opens with. Copying and saving then take
the record too. Switched off, you get clean commands, and the notes about what a shell cannot be
told stay either way.

**clear** forgets every line. Anything still running keeps running. With nothing recorded,
**copy**, **save** and **clear** are greyed.

## How long it is kept

The console keeps at most 500 lines and seven days, in this browser, dropping the oldest first.
Nothing in it is ever sent anywhere.

- Two windows of chromosomix share one log, so neither loses the other's morning. **clear** empties
  it in both.
- A run that was still going when its window closed comes back marked *interrupted*.
- A chromosomix view embedded in another page records nothing and has no console.

The console is listed as its own line, **Console**, under **What this browser is remembering** in
the command palette, since it is a list of the files you opened and the places you looked at.
**forget everything** there drops it. See
[Sessions, workspaces and links](/browse/sessions-and-links/#making-it-forget).
