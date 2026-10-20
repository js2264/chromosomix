# Upstream licences

The licence texts of material copied or ported into `src/` from projects that are not npm packages,
verbatim as each project ships it. `scripts/third-party-notices.mjs` reproduces them in the
`THIRD-PARTY-NOTICES.txt` of every build that carries the material; a package compiled in from
`node_modules/`, or a devDependency a generator copied from, has its licence read from the
package as installed instead, and needs nothing here — unless it ships none, when the text here
stands in for it.

| File | Upstream | What `src/` holds of it |
| --- | --- | --- |
| `chromosight.txt` | chromosight 1.6.3, `LICENSE` | the preset pattern kernels, `src/analysis/chromosightKernels.ts`, their presets, `chromosightPresets.ts`, and the detection functions of `chromosight/utils/`, ported in `src/analysis/chromosight.ts` |
| `matplotlib.txt` | matplotlib 3.10.9, `LICENSE/LICENSE` | the colour tables, `src/render/luts.ts`, and `seismic` in `src/render/colormaps.ts` |
| `colorbrewer.txt` | matplotlib 3.10.9, `LICENSE/LICENSE_COLORBREWER` | the `Reds` and `RdBu_r` control points, `src/render/colormaps.ts` |
| `cooltools.txt` | cooltools 0.7.1, `LICENSE` | `dots()`'s HiCCUPS, ported in `src/analysis/hiccups.ts`, and `find_peak_prominence` in `src/analysis/insulation.ts` |
| `cooler.txt` | cooler, `LICENSE` | `parse_humanized`, `_tokenize`, `parse_region_string` and `parse_region`, ported in `src/metacooler/range.ts` |
| `scipy.txt` | SciPy 1.16.3, `LICENSE.txt` | `fminbound`, ported in `src/analysis/idr.ts` |
| `xsf.txt` | SciPy's `xsf`, `LICENSE` | the cephes functions below, as `xsf` carries them |
| `cephes.txt` | SciPy's `xsf`, the Cephes entry of `LICENSES_bundled.txt` | `pdtrc`, `igam`, `igamc`, `lgam`, `log1p`, `expm1` and `erfc`, ported in `src/analysis/poisson.ts`, and `igam_asymp_coeff_d` in `src/analysis/hiccupsTables.ts` |
| `numpy.txt` | NumPy 2.5.4, `LICENSE.txt` | `pairwise_sum`, ported in `src/analysis/stats.ts` |
| `numpy-random.md` | NumPy 2.5.4, `numpy/random/LICENSE.md` | `random_binomial` and `random_hypergeometric`, ported in `src/metacooler/sampling.ts` |
| `scikit-learn.txt` | scikit-learn 1.9.1, `COPYING` | BIRCH, ported from `_birch.py` in `src/analysis/birch.ts` |
| `boost-hic.txt` | Boost-HiC, `LICENSE` | its enhancement, ported in `src/metacooler/boost.ts` |
| `fdlibm.txt` | fdlibm, the notice at the head of `s_erf.c` | `erf`, transcribed in `src/analysis/idr.ts` |
| `yapc.txt` | yapc 0.1, `LICENSE` (GPL-3.0) | its peak calling, ported in `src/analysis/yapc.ts` |
| `idr.txt` | IDR 2.0.3, `LICENSE` (GPL-2.0, which its `setup.py` licenses "or later") | `fit_model_and_calc_local_idr` and `calc_global_IDR`, ported in `src/analysis/idr.ts` |
| `generic-filehandle2.txt` | the MIT licence `generic-filehandle2`'s `package.json` declares, naming its author | nothing of `src/`: the package ships no licence text, in its tarball or its repository, and MIT asks for one in every copy |

yapc and IDR are why chromosomix is under the GPL, version 3 or later (`LICENSE`). Anything ported in
must be compatible with that.

Regenerating one of those files from a newer upstream, or porting a function from one, is the moment
to compare its licence with the copy here — and porting from a project that is not listed is the
moment to add it, with a `VENDORED` entry in `scripts/third-party-notices.mjs` and a line in
`src/licences.ts`.
