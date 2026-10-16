import { remarkMdxFiles, remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { defineDocs } from 'fumadocs-mdx/macro';
import { remarkIncludedFile } from './included-file';
import { absoluteUrl, docsRoute, getPageMarkdownUrl, tagline } from './shared';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    // A collection's own MDX options replace Fumadocs' defaults, so they are built from its preset: ```mermaid blocks
    // become <Mermaid>, ```files blocks file trees, and ```npm blocks the package managers' tabs, kept across pages.
    // remarkIncludedFile runs first, before the headings are collected for the outline.
    mdxOptions: applyMdxPreset({
      remarkPlugins: (preset) => [remarkIncludedFile, ...preset, remarkMdxMermaid, remarkMdxFiles],
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

/** Markdown with its links into the site made absolute: the pages link to `/docs/…`, without the base path. */
const absoluteLinks = (markdown: string) => markdown.replace(/\]\(\//g, `](${absoluteUrl('/')}`);

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${absoluteUrl(page.url)})

${absoluteLinks(await page.data.getText('processed'))}`,
});

/** llms.txt: what flowpact is, then every page as a link to its Markdown. */
export async function llmsIndex(): Promise<string> {
  const markdown = new Map(source.getPages().map((p) => [p.url, absoluteUrl(getPageMarkdownUrl(p).url)]));
  const pages = (await docsLlms.index())
    .replace(/^# .*\n+/, '')
    .replace(/\]\(([^)]+)\)/g, (link, url: string) => (markdown.has(url) ? `](${markdown.get(url)})` : link));
  return `# flowpact

> ${tagline} A data-flow linter for GitHub Actions: it checks reusable workflows and actions against their callers, and every value across workflows, actions and matrix combinations.

Each link is the page's Markdown. [llms-full.txt](${absoluteUrl('/llms-full.txt')}) holds every page in one file.

${pages}`;
}
