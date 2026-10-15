import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import { asset } from '@/lib/shared';

/**
 * A screenshot rendered from real flowpact output: terminal SVGs from the CLI (scripts/gen-screenshots.ts), which keep
 * the text crisp at any zoom, and editor PNGs from VS Code (packages/vscode/e2e/screenshots.mjs). A click zooms it.
 * A `themed` one has a `-light` and a `-dark` file, and shows the one for the site's theme (GitHub's own pages).
 */
export function Screenshot({
  name,
  alt,
  caption,
  format = 'svg',
  themed = false,
}: {
  name: string;
  alt: string;
  caption?: string;
  format?: 'svg' | 'png';
  themed?: boolean;
}) {
  const files = themed
    ? [
        { file: `${name}-light`, className: 'dark:hidden' },
        { file: `${name}-dark`, className: 'hidden dark:block' },
      ]
    : [{ file: name, className: undefined }];
  return (
    <figure className="my-6">
      {files.map(({ file, className }) => (
        <div key={file} className={className}>
          {/* Its own <img>: ImageZoom's default next/image needs a width and height for a path. */}
          <ImageZoom src={asset(`/screenshots/${file}.${format}`)} alt={alt}>
            <img
              src={asset(`/screenshots/${file}.${format}`)}
              alt={alt}
              className="w-full cursor-zoom-in rounded-xl border border-fd-border shadow-sm"
              loading="lazy"
            />
          </ImageZoom>
        </div>
      ))}
      {caption ? (
        <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
