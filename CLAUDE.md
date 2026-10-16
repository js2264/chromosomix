# Working in this repository

- **After any change to the UI, send a gallery.** Whatever touches what is on screen — a
  panel, a cell of the deck, a control, a style, a wording — is not done until the real app has
  been driven and the reader has seen screenshots of it: run `.claude/skills/ui-gallery`
  (`node scripts/ui-gallery.mjs gallery` against `npm run dev`), look at every picture, fix what
  they show, and send them to the reader as files with a line on what each shows. Tests passing
  is not the deliverable for UI work; the pictures are.
- SPECS.md is the contract; a change that alters behaviour changes the section that governs
  it, and CHANGELOG.md's Unreleased list, in the same commit.
- **Hold a changed analysis task to its reference implementation, in agreement and in time.**
  Any change to what an existing task computes, its defaults or its speed is checked against the
  package it reproduces — coolpuppy for APA, deepTools for the metaplot, cooltools for
  insulation, and so on — and its section of `notebooks/validation.qmd` is added or updated in
  the same pull request, with the commands `notebooks/timing.qmd` times from it (each command's
  `bench` and `group`). Check it by running only that task's commands and its reference's, on
  its section's data, comparing them as the section does, and time them the same way. Neither
  notebook is rendered in full locally unless the reader asks: `.github/workflows/notebooks.yml`
  renders both, on every release and on demand.
