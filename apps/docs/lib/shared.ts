import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'flowpact';
export const docsRoute = '/docs';
const docsContentRoute = '/llms.mdx/docs';
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const gitConfig = {
  user: 'ciatlas',
  repo: 'flowpact',
  branch: 'main',
  /** Where the MDX sources live inside the repository. */
  contentDir: 'apps/docs/content/docs',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];
  return { segments, url: getContentUrl(segments, page.locale) };
}

/** Where flowpact is published. */
export const installLinks = {
  vscode: 'https://marketplace.visualstudio.com/items?itemName=flowpact.vscode-flowpact',
  openVsx: 'https://open-vsx.org/extension/flowpact/vscode-flowpact',
  action: 'https://github.com/marketplace/actions/flowpact',
  npm: 'https://www.npmjs.com/package/flowpact',
} as const;

/** Prefixes a public asset path with the deployment base path. */
export const asset = (path: string) => `${basePath}${path}`;
