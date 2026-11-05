/**
 * The site's table of contents: every hand-written page, by its address, in
 * the order a reader meets them, and where the generated ones go.
 *
 * Each entry names a page by its slug, so a page listed here that does not
 * exist fails the build, and so does a task with no page (`astro.config.mjs`).
 * The tasks are not listed by hand: they are the Analysis panel's cards, in
 * its order, read from the registry (`src/generated/data.json`).
 */

/** The hand-written guides, by group. */
export const GUIDES = [
  {
    label: 'Get started',
    items: [
      ['start/introduction', 'What chromosomix is'],
      ['start/ways', 'Ways to use it'],
      ['start/first-map', 'Your first map'],
      ['start/window', 'A tour of the window'],
      ['start/tutorial', 'The guided tutorial'],
      ['start/where-to-run', 'Web, desktop or one file'],
    ],
  },
  {
    label: 'Your files',
    items: [
      ['files/opening', 'Opening files'],
      ['files/contact-maps', 'Contact maps'],
      ['files/tracks', 'Tracks and features'],
      ['files/interactions', 'Interactions'],
      ['files/sequences', 'Reference sequences'],
      ['files/structures', '3D models'],
      ['files/stores', 'Data stores'],
      ['files/problems', 'When a file will not open'],
    ],
  },
  {
    label: 'Using the browser',
    items: [
      ['browse/navigating', 'Moving around'],
      ['browse/contact-maps', 'Reading a contact map'],
      ['browse/comparing', 'Comparing two maps'],
      ['browse/turn', 'The 45° view'],
      ['browse/genome-browser', 'The genome browser'],
      ['browse/deck', 'Maps side by side'],
      ['browse/structures', '3D models beside the map'],
      ['browse/annotations', 'Annotations and bookmarks'],
      ['browse/sessions-and-links', 'Sessions, workspaces and links'],
      ['browse/figures', 'Figures and export'],
      ['browse/console', 'The console'],
      ['browse/keyboard', 'Keyboard and command palette'],
    ],
  },
  { label: 'Analyses', analyses: true },
  {
    label: 'Command line',
    items: [
      ['cli/install', 'Installing it'],
      ['cli/running', 'Running a task'],
      ['cli/from-the-app', 'From the app to a script'],
      ['cli/pipelines', 'In a pipeline'],
    ],
  },
  {
    label: 'Notebooks and web pages',
    items: [
      ['embed/jupyter', 'Jupyter notebooks'],
      ['embed/r', 'R, Quarto and Shiny'],
      ['embed/web-page', 'Embedding in a web page'],
    ],
  },
  {
    label: 'Advanced',
    items: [
      ['advanced/hosting', 'Hosting your data'],
      ['advanced/data-store', 'Your own data store'],
      ['advanced/track-hubs', 'UCSC track hubs'],
      ['advanced/self-hosting', 'Running your own copy'],
      ['advanced/privacy', 'Privacy'],
    ],
  },
  {
    label: 'Reference',
    items: [
      ['reference/files-and-stores', 'Files, hosts and stores'],
      ['reference/links', 'Link keys'],
      ['reference/command-line', 'Command line'],
      ['reference/embedding', 'Embedding messages'],
      ['glossary', 'Glossary'],
    ],
  },
  { label: 'Release notes', releases: true },
  {
    label: 'Contributing',
    items: [
      ['contributing', 'Source code and contributing'],
      ['contributing/readers-and-tasks', 'Adding a reader or a task'],
    ],
  },
]

/** The pages of the Analyses group that are not tasks. */
export const ANALYSIS_GUIDES = [
  ['analyses', 'How analyses run'],
  ['analyses/validation', 'How the results are checked'],
]

/** The sidebar Starlight reads, with the tasks' groups from the registry's data. */
export function sidebar(data) {
  const byId = new Map(data.tasks.map((task) => [task.id, task]))
  const pages = (items) => items.map(([slug, label]) => ({ slug, label }))
  return GUIDES.map((group) => {
    if (group.analyses === true) {
      return {
        label: group.label,
        items: [
          ...pages(ANALYSIS_GUIDES),
          ...data.groups.map((card) => ({
            label: card.label,
            collapsed: true,
            items: card.tasks.map((id) => ({ slug: `analyses/${id}`, label: byId.get(id)?.title ?? id })),
          })),
        ],
      }
    }
    if (group.releases === true) {
      return { label: group.label, collapsed: true, items: [{ autogenerate: { directory: 'releases' } }] }
    }
    return { label: group.label, items: pages(group.items) }
  })
}
