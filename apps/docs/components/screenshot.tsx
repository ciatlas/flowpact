import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import { asset } from '@/lib/shared';

/**
 * A screenshot rendered from real flowpact output: terminal SVGs from the CLI (scripts/gen-screenshots.ts), which keep
 * the text crisp at any zoom, and editor PNGs from VS Code (packages/vscode/e2e/screenshots.mjs). A click zooms it.
 */
export function Screenshot({
  name,
  alt,
  caption,
  format = 'svg',
}: {
  name: string;
  alt: string;
  caption?: string;
  format?: 'svg' | 'png';
}) {
  return (
    <figure className="my-6">
      {/* Its own <img>: ImageZoom's default next/image needs a width and height for a path. */}
      <ImageZoom src={asset(`/screenshots/${name}.${format}`)} alt={alt}>
        <img
          src={asset(`/screenshots/${name}.${format}`)}
          alt={alt}
          className="w-full cursor-zoom-in rounded-xl border border-fd-border shadow-sm"
          loading="lazy"
        />
      </ImageZoom>
      {caption ? (
        <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
