# Working in this repository

- **After any change to the UI, send a gallery.** Whatever touches what is on screen — a
  panel, a cell of the deck, a control, a style, a wording — is not done until the real app has
  been driven and the reader has seen screenshots of it: run `.claude/skills/ui-gallery`
  (`node scripts/ui-gallery.mjs gallery` against `npm run dev`), look at every picture, fix what
  they show, and send them to the reader as files with a line on what each shows. Tests passing
  is not the deliverable for UI work; the pictures are.
- SPECS.md is the contract; a change that alters behaviour changes the section that governs
  it, and CHANGELOG.md's Unreleased list, in the same commit.
