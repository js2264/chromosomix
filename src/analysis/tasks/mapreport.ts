/**
 * The map report, as a descriptor.
 *
 * One run that answers the questions a library is judged by before anything is
 * read off it — how many contacts, how many cis, how they decay, how evenly they
 * cover the genome, which sequences keep to themselves, and down to which bin
 * size the map still has contacts in most of its bins — and one page that holds
 * the answers, written from the run (`analysis/report/page.ts`).
 *
 * **A composite** (§18.2): P(s), coverage and cis and trans per sequence are
 * those tasks' own runs, at their own defaults but for what is answered here
 * ({@link upstreamParams}), so the numbers in the report are the numbers each
 * task gives on its own, and a run of any of them already in hand is reused.
 * What it adds is the library's totals and the resolution ladder
 * (`analysis/mapreport.ts`).
 *
 * **Numbers only.** Nothing in the report passes or fails: Rao et al.'s map
 * resolution and every other cut in the field is a threshold somebody chose,
 * and the report gives what a cut is applied to instead (§18.9's argument,
 * applied to a verdict as it is to a call).
 */

import { mapReportPage } from '../report/page'
import { multiqcLadder, multiqcPs, multiqcResolution, multiqcSummary } from '../report/multiqc'
import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'base',
    label: 'ladder from',
    hint: 'The resolution the library is counted at and the ladder climbs from.',
    default: 'finest',
    options: [
      {
        value: 'finest',
        label: 'the file’s finest resolution',
        hint: 'Where the file stores more than one, its finest is read for the ladder, whatever is on screen.',
      },
      { value: 'map', label: 'this map’s resolution' },
    ],
  },
  // P(s) is read balanced where the file is, as the P(s) task reads it; the
  // coverage is always the raw counts, since a balanced coverage is flat by
  // construction and says nothing about depth.
  BALANCE_PARAM,
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const finest =
    params.base !== 'map' && context.resolutions !== undefined && context.resolutions.length > 0
      ? Math.min(...context.resolutions)
      : context.binsize
  const at = finest < context.binsize ? `the file’s finest resolution, ${finest.toLocaleString()} bp` : 'this map'
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note: `One pass over the pixel table of ${at}, beside the runs of P(s), coverage and cis and trans`,
  }
}

export const MAP_REPORT_TASK: AnalysisTask = {
  id: 'mapreport',
  title: 'Map report',
  blurb: 'A library’s QC on one page: its contacts, their decay and coverage, and the resolutions it can bear.',
  keywords: ['QC', 'quality', 'report', 'map resolution', 'MultiQC', 'summary', 'depth'],
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['table', 'curve'],
  requires: ['expected', 'coverage', 'cistrans'],
  upstreamParams: (id, params): Params => {
    if (id === 'expected') return { scope: 'file', balance: params.balance === true }
    if (id === 'coverage') return { total: true, fraction: false, cis: false, trans: false, balance: false }
    return {}
  },
  documents: [
    { id: 'report', extension: 'html', label: 'HTML report', type: 'text/html', write: mapReportPage },
    { id: 'summary_mqc', extension: 'tsv', label: 'MultiQC summary', type: 'text/tab-separated-values', shellOnly: true, write: multiqcSummary },
    { id: 'resolutions_mqc', extension: 'tsv', label: 'MultiQC resolutions', type: 'text/tab-separated-values', shellOnly: true, write: multiqcLadder },
    { id: 'resolution_mqc', extension: 'json', label: 'MultiQC contacts per bin', type: 'application/json', shellOnly: true, write: multiqcResolution },
    { id: 'ps_mqc', extension: 'json', label: 'MultiQC P(s)', type: 'application/json', shellOnly: true, write: multiqcPs },
  ],
  estimate,
}
