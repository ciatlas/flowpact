import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Logo } from '@/components/logo';
import { appName, gitConfig, installLinks } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <Logo className="size-6" />
          {appName}
        </span>
      ),
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Rules', url: '/docs/rules' },
      {
        type: 'menu',
        text: 'Install',
        items: [
          { text: 'CLI', description: 'npx flowpact lint, from npm', url: installLinks.npm, external: true },
          {
            text: 'GitHub Action',
            description: 'On every pull request',
            url: installLinks.action,
            external: true,
          },
          {
            text: 'VS Code',
            description: 'Visual Studio Marketplace',
            url: installLinks.vscode,
            external: true,
          },
          {
            text: 'Open VSX',
            description: 'VSCodium, Cursor, Windsurf',
            url: installLinks.openVsx,
            external: true,
          },
        ],
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
