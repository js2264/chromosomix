/**
 * The chart library, with exactly the charts these figures draw registered.
 *
 * A module of its own so that the `import()` that fetches it can be *one*
 * import of *one* chunk. Naming the pieces here, statically, is what lets the
 * bundler drop the rest: ECharts is a large library and its `charts` and
 * `components` entry points are barrels, so an `import('echarts/charts')` at
 * the call site pulls in every chart type there is — gauges, maps, trees,
 * sunbursts — none of which anything here draws. Measured, that mistake is
 * about half a megabyte of the standalone build.
 *
 * `use` runs once, when the chunk is evaluated, which is exactly the semantics
 * wanted: the registry is global to the library, and a second registration is
 * either a no-op or a race.
 */

import * as echarts from 'echarts/core'
import {
  BarChart,
  BoxplotChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
} from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  ScatterChart,
  BarChart,
  BoxplotChart,
  CustomChart,
  // The result matrices — a saddle, a pileup, a cis/trans square (§18.13). Not
  // the contact map, which is a raster of millions of cells behind a reader
  // that pools on the way and has a renderer of its own.
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  // The colour bar a heatmap is read against, and the handles that clip it.
  VisualMapComponent,
  TitleComponent,
  // SVG, not canvas: what comes back is a picture that can be replayed as
  // paths, which is the whole reason the PDF export survives a chart library
  // (`figures/svgPaint.ts`).
  SVGRenderer,
])

export { echarts }
