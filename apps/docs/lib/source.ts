import { remarkMdxFiles, remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { defineDocs } from 'fumadocs-mdx/macro';
import { docsRoute } from './shared';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    // A collection's own MDX options replace Fumadocs' defaults, so they are built from its preset: ```mermaid blocks
    // become <Mermaid>, ```files blocks file trees, and ```npm blocks the package managers' tabs, kept across pages.
    mdxOptions: applyMdxPreset({
      remarkPlugins: [remarkMdxMermaid, remarkMdxFiles],
      remarkNpmOptions: { persist: { id: 'package-manager' } },
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  // `icon: Terminal` in meta.json and frontmatter: a lucide icon by name.
  plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
