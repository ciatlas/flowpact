/** The docs' remark plugin for `<include>`d Markdown files (apps/docs/lib), as the changelog page includes CHANGELOG.md. */
import { describe, expect, it } from 'vitest';
import { remarkIncludedFile } from '../../apps/docs/lib/included-file';

type Node = { type: string; depth?: number; children?: Node[] };
const text = (): Node => ({ type: 'text' });
const heading = (depth: number, ...children: Node[]): Node => ({ type: 'heading', depth, children });
const run = (tree: Node) =>
  remarkIncludedFile()(tree, {} as Parameters<ReturnType<typeof remarkIncludedFile>>[1]);

describe('remarkIncludedFile', () => {
  it("removes an included file's own title, and keeps the rest of it", () => {
    const release = heading(2);
    const included: Node = { type: 'root', children: [heading(1), { type: 'paragraph' }, release] };
    run({ type: 'root', children: [included] });
    expect(included.children).toEqual([{ type: 'paragraph' }, release]);
  });

  it("puts a link's text in place of a link in an included heading", () => {
    const version = text();
    const date = text();
    const release = heading(2, { type: 'link', children: [version] }, date);
    const first = heading(2, { type: 'linkReference', children: [text()] }, text());
    run({ type: 'root', children: [{ type: 'root', children: [release, first] }] });
    expect(release.children).toEqual([version, date]);
    expect(release.children?.[0]).toBe(version);
    expect(first.children).toEqual([text(), text()]);
  });

  it('finds a file included within another', () => {
    const inner: Node = { type: 'root', children: [heading(1), heading(2)] };
    run({ type: 'root', children: [{ type: 'root', children: [{ type: 'paragraph', children: [inner] }] }] });
    expect(inner.children).toEqual([heading(2)]);
  });

  it("keeps the page's own headings, and an included file that starts otherwise", () => {
    const link: Node = { type: 'link', children: [text()] };
    const page: Node = {
      type: 'root',
      children: [
        heading(1),
        heading(2, link),
        { type: 'root', children: [{ type: 'paragraph' }, heading(1)] },
      ],
    };
    run(page);
    expect(page.children).toEqual([
      heading(1),
      heading(2, link),
      { type: 'root', children: [{ type: 'paragraph' }, heading(1)] },
    ]);
  });
});
