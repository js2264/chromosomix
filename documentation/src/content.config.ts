import { defineCollection } from 'astro:content'
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders'
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // The interface's own words where the app has its own for the same thing:
  // the search well says what the app's says (`src/content/i18n/en.json`).
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
}
