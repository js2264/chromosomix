# Upstream licences

The licence texts of material copied into `src/` from projects that are not npm packages, verbatim
as each project ships it. `scripts/third-party-notices.mjs` reproduces them in the
`THIRD-PARTY-NOTICES.txt` of every build that carries the material; a package compiled in from
`node_modules/`, or a devDependency a generator copied from, has its licence read from the
package as installed instead, and needs nothing here.

| File | Upstream | What `src/` holds of it |
| --- | --- | --- |
| `chromosight.txt` | chromosight 1.6.3, `LICENSE` | the preset pattern kernels, `src/analysis/chromosightKernels.ts` |
| `matplotlib.txt` | matplotlib 3.10.9, `LICENSE/LICENSE` | the colour tables, `src/render/luts.ts`, and `seismic` in `src/render/colormaps.ts` |
| `colorbrewer.txt` | matplotlib 3.10.9, `LICENSE/LICENSE_COLORBREWER` | the `Reds` and `RdBu_r` control points, `src/render/colormaps.ts` |

Regenerating one of those files from a newer upstream is the moment to compare its licence with
the copy here.
