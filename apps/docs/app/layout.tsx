import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

export const metadata: Metadata = {
  // Absolute URLs for the Open Graph image (app/opengraph-image.png); Next.js adds the base path.
  metadataBase: new URL('https://ciatlas.github.io'),
  title: { template: '%s · flowpact', default: 'flowpact — data-flow linter for GitHub Actions' },
  description: 'Change shared workflows and actions without breaking the repositories that use them.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
