import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Markdown } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import rehypeRaw from 'rehype-raw';

/**
 * A Markdown file of content/generated (scripts/gen-screenshots.ts writes them), rendered at build time in a frame, as
 * GitHub shows a job summary. Its headings are not the page's: they stay out of the outline. Its HTML (`<details>`,
 * `<sub>`) is kept, as GitHub keeps it; the files are flowpact's own output for a fixture.
 */
export function RenderedMarkdown({ file, title }: { file: string; title: string }) {
  const text = readFileSync(join(process.cwd(), 'content/generated', file), 'utf8');
  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm">
      <figcaption className="border-b border-fd-border px-4 py-2 text-sm font-medium text-fd-muted-foreground">
        {title}
      </figcaption>
      <div className="px-4 pb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_h3]:mt-6 [&_h3]:text-lg">
        <Markdown
          remarkPlugins={[remarkGfm]}
          remarkRehypeOptions={{ allowDangerousHtml: true }}
          rehypePlugins={[rehypeRaw]}
        >
          {text}
        </Markdown>
      </div>
    </figure>
  );
}
