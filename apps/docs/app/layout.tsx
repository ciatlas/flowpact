import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import { siteOrigin, tagline } from '@/lib/shared';
import './global.css';

export const metadata: Metadata = {
  // Absolute URLs for the Open Graph image (app/opengraph-image.png); Next.js adds the base path.
  metadataBase: new URL(siteOrigin),
  title: { template: '%s · flowpact', default: 'flowpact — data-flow linter for GitHub Actions' },
  description: tagline,
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
