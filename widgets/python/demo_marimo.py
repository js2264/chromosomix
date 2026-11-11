import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # chromosomix in marimo

    `demo.ipynb` in marimo: the app itself in a cell, driven from Python, and telling Python where the
    reader has taken it — on the repository's yeast demo, served by the kernel from this disk.

    One rule is marimo's own. A cell that names a `mo.ui.anywidget` is run again every time the frame
    reports, which it does on every move and every finished picture. So the wrapper, `live`, is named
    only by the cells that *read* where the reader is; the cells that *drive* the view name the widget
    itself, `view`, and run once.
    """)
    return


@app.cell
def _():
    from pathlib import Path

    import marimo as mo

    from chromosomix import Chromosomix

    DEMO = (mo.notebook_dir() or Path.cwd()).joinpath('../../demo/yeast').resolve()
    MAP = DEMO / 'Yeast_microC_G2M_1kb.cool'
    return Chromosomix, DEMO, MAP, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## A map and its tracks
    """)
    return


@app.cell
def _(Chromosomix, DEMO, MAP, mo):
    view = Chromosomix(
        MAP,
        region='IV:1000000-1400000',
        tracks=[DEMO / 'Yeast_ATAC.bw', DEMO / 'Yeast_MNase.bw', DEMO / 'Yeast_annotations.gtf'],
        transform='log10',
        height=860,
    )
    live = mo.ui.anywidget(view)
    live
    return live, view


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## Where the reader is

    The next cell names `live`, so marimo runs it again wherever the reader takes the map.
    """)
    return


@app.cell
def _(live, mo):
    _state = live.state or {}
    mo.md(f"`{_state.get('region', _state.get('view', ''))}` · {_state.get('transform', '')}")
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## Driving it from Python

    These name `view`, not `live`: named through `live`, `goto` would pull the map back each time the
    reader moved it, and `add` would add the model again on every report, without end.
    """)
    return


@app.cell
def _(view):
    view.goto('IV:1150000-1300000')
    return


@app.cell
def _(view):
    view.navigate(transform='log2', oe=True)
    return


@app.cell
def _(DEMO, view):
    view.add(DEMO / 'Yeast_structure.g3d.gz')
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## A 1D browser
    """)
    return


@app.cell
def _(Chromosomix, DEMO):
    browser = Chromosomix(
        tracks=[DEMO / 'Yeast_ATAC.bw', DEMO / 'Yeast_ChIP_Pol2-vs-input.bw', DEMO / 'Yeast_annotations.gtf'],
        height=540,
    )
    browser
    return (browser,)


@app.cell
def _(browser):
    browser.goto('IV:400,001-460,000')
    return


if __name__ == "__main__":
    app.run()
