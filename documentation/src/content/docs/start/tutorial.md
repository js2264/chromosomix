---
title: "The guided tutorial"
description: "The guided tutorial plays a first session on a real 4DN Hi-C map in the app itself, one step at a time; this page says where to start it, what it covers, the data it uses and how to pick it up again."
---

The guided tutorial is a first session played on the live window, one step at a time. The window is
greyed, the one control the step is about is lit through a hole in the grey, and a card beside it says
what to do with it and what it is for. It is the app itself, used on real data — not a slideshow and
not a sandbox: you press every control yourself, and the tutorial watches and moves on when you have
done what it asked.

![A step of the guided tutorial on 4DN's K562 map: the window greyed, the resolution control lit through the grey at 25 kb, and the card beside it, The map, step 7 of 58, asking to pick 250 kb, with back and skip step.](../../../assets/screens/start/tutorial-step.webp)

In one session it opens a Hi-C map from the 4D Nucleome project (4DN), finds its compartments, its
domains and a loop on one chromosome, saves what you made, and sets your results against the ones 4DN
published.

## Where to start it

- **On the landing page**, under *New here?*: **play the tutorial**. It stands in the margin left of
  *Load files*, or above it in a narrow window.
- **In About**: press *About this viewer* at the right of the header; the button is on the first tab,
  under what the viewer is.
- **In the command palette**: *Guided tutorial*, under Help.

It never opens by itself. It is offered in the web app and in the desktop app; the single HTML file
and a viewer embedded in another page have no data stores, which is where the tutorial begins, and
do not offer it.

If the tab in front holds something when you start from the beginning, the tutorial opens a tab of
its own beside it and leaves yours as it was.

## What you need

- **A network connection.** The map and its tracks are read from 4DN's public bucket.
- **A mouse or a trackpad.** Two steps are drags across the map; each has a *zoom for me* button for
  a reader who would rather not.
- **Somewhere to save two files.** One step saves a track as a bigWig and another the figure as a
  PDF. Each is done once the file is saved, so accept the save dialog if your browser opens one.

## The data

**4DNESC23ZYOF** in the 4DN store: in situ Hi-C (DpnII) on K562 cells, on GRCh38 (Belaghzal et al.
2021), with 186,956,649 contacts — enough for domains and the loops at their corners at 5 kb, in a
map that opens quickly. Its map is `4DNFIKI77KEM.mcool`, 1.9 GB on 4DN's bucket, read by range rather
than downloaded. The set carries three tracks 4DN's own pipeline computed from the same map: the
compartment eigenvector at 250 kb (`4DNFI3OPG4RB`), the insulation score (`4DNFI4GZZC7Z`) and the
boundaries called on it. That is what makes the last part a fair comparison: your E1 and your
insulation, computed in the page, against the consortium's.

Every task runs on **chr15**: an acrocentric chromosome whose empty short arm is the blank square at
the start of its map, and whose long arm has broad, clean compartments. The domains are looked at in
`chr15:38,100,001-50,025,000`, reached from 30–60 Mb at 250 kb. In it, the domain from 45.66 to
48.32 Mb is closed by a loop between its two borders, `chr15:45,662,501 × chr15:48,312,501`, and split
into two subTADs by one weak border at `chr15:47,215,001`. Those two places are the marks you draw.

Every task runs with its defaults but two. You set insulation's **scales** to 4: a window of 10 bins,
50 kb at 5 kb, doubled three times to 100, 200 and 400 kb, because the scales are the TAD hierarchy.
And the tutorial sets the Compartments task's gene model to none itself. Nothing then decides the
sign of E1, so yours may match 4DN's upside down, at a correlation of −1.

## The parts

Fifty-eight steps in twelve parts. Each part's name is printed over its steps on the card.

1. **Welcome**: what the tutorial is, and its parts.
2. **The 4DN store**: open the store drawer from its button in the header; switch it from the lab's
   store to 4DN's; type `4DNESC23ZYOF` in its search box (or press *type it for me*); open the set
   with its tracks.
3. **The map**: the General panel; pick 250 kb; open chr15 from the Chromosomes table; how to scroll,
   drag and double-click on the map; the Aesthetics panel, with its Map, Tracks and Export cards.
4. **Compartments**: draw the map as a *correlation* to see the plaid; open the Analysis panel and its
   three groups of tasks; run Compartments on chr15 alone; read the saddle it draws; compare your E1
   and A/B calls with 4DN's.
5. **Zooming in**: back to *balanced*; drag across 30–60 Mb while holding <kbd>⇧ Shift</kbd> and
   <kbd>⌥ Option</kbd> (<kbd>Shift</kbd> and <kbd>Alt</kbd> off a Mac); switch to 5 kb; drag across
   the domains; turn on O/E and *3 × 3* smoothing, and read domains and compartments on one picture.
6. **Insulation**: run Diamond insulation on chr15 at four scales (*set it for me* types the 4), and
   read the four tracks it draws as a hierarchy of borders.
7. **Marks**: open the Annotations panel; mark the loop with an arrowhead and the weak border with a
   vertical line, typing each place into the Manual annotations card (or pressing *mark it for me*);
   read that border on your four insulation tracks.
8. **Tracks**: save your insulation as a bigWig; draw the domains as a 1D track beside the map rather
   than on it.
9. **The figure**: export the map, the marks and every track as one vector PDF.
10. **Track correlation**: run it over every track — 4DN's insulation and E1, your E1 and your
    insulation at four scales (*tick them for me* ticks them) — and read yours against 4DN's.
11. **The console**: open it, where every file opened and every run made is a command to paste into
    a terminal.
12. **Done**: what you did, and where the tutorial is when you want it again.

## The card, and how a step moves on

Along the top of the card are the part, *step n of 58* and **skip tutorial**, over a bar cut into the
parts and filled as far as you have got. Under them: an icon for what the step asks — press, type,
choose, drag, or only look — its title, and one or two sentences. At the bottom, **back** and
**next**: **next** reads **skip step** while the step is waiting on you, and **finish** on the last.

- **A step is done by what it asks for, not by a click.** It moves on when the drawer is open on the
  store, the map is at 250 kb, the run has finished — however you got there: the lit control, a key,
  the command palette. The icon turns into a tick for a moment, so you see your action land.
- **A name to type** is set in colour, most often with a button beside it that copies it. If what
  you type in the store's search box cannot become the accession, the accession blinks.
- **A press on the grey does nothing** but pulse the ring round the control to press. Inside the lit
  hole, everything works exactly as it does without the tutorial.
- **A control that is not on screen** is named on the card, with what to do: *Not on screen — scroll
  the table to chr15*, say. If what a step needs has gone — the drawer closed, the map left — the
  tutorial goes back to the step that brings it.
- **Steps already done** go by on their own as you go forward. Going back shows them and waits.
- <kbd>←</kbd> and <kbd>→</kbd> go back and on, wherever the keys are not a control's own; <kbd>→</kbd>
  never skips a step that is waiting on you.
- **A dialog** puts the tutorial out of the way; it comes back on the same step when the dialog
  closes.

With your system's *reduce motion* setting on, the card jumps from control to control instead of
gliding, and nothing pulses or blinks.

## Leaving and coming back

**skip tutorial** leaves at any step. Where you got to is kept in this browser, through a reload or a
closed window, and the landing page and About then offer **resume at step n of 58**, with **start
over** beside it.

A resume lands on the first step of the part you left, because the window may have changed since;
every step of that part whose state still holds goes by on its own, so a window that has not moved
lands where you were. **start over** begins again at the first step, in a tab of its own. Once you
have pressed **finish**, both places offer **play the tutorial again**.

The place kept is counted with your other settings under *What this browser is remembering*, in the
command palette.

To do the same session at your own pace, without the card, follow [Your first map](/start/first-map/);
[A tour of the window](/start/window/) names every part of the screen the tutorial lights.
