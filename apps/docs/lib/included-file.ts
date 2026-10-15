import { replaceSource } from 'fumadocs-core/mdx-plugins/stringifier';

type MdNode = { type: string; depth?: number; children?: MdNode[] };
type MdFile = Parameters<typeof replaceSource>[0];
type SourceNode = Parameters<typeof replaceSource>[1];

/** The trees `<include>` put in place of its tags: each a root within the page's. */
function includedRoots(node: MdNode): MdNode[] {
  return (node.children ?? []).flatMap((child) => [
    ...(child.type === 'root' ? [child] : []),
    ...includedRoots(child),
  ]);
}

const isHeading = (node: MdNode | undefined, depth?: number) =>
  node?.type === 'heading' && (depth === undefined || node.depth === depth);

const LINKS = new Set(['link', 'linkReference']);

/** A link's text in place of the link (`[text](url)`, or `[text]` with the url defined elsewhere). */
const unlinked = (nodes: MdNode[]) => nodes.flatMap((n) => (LINKS.has(n.type) ? (n.children ?? []) : [n]));

/**
 * Fits an `<include>`d Markdown file into the page, as the changelog page includes CHANGELOG.md:
 *
 * - its own `# ` title gives way to the page's: it is not a second title, an entry in the outline, nor a line of the
 *   page's Markdown (llms.txt, the copy button), which is cut from the included source;
 * - a link in a heading (a release's compare link) becomes its text: each heading is a link to itself on the site, and
 *   a link cannot hold another.
 */
export const remarkIncludedFile = () => (tree: MdNode, file: MdFile) => {
  for (const root of includedRoots(tree)) {
    const children = root.children ?? [];
    if (isHeading(children[0], 1)) replaceSource(file, children.shift() as SourceNode, '');
    for (const heading of children.filter((n) => isHeading(n)))
      heading.children = unlinked(heading.children ?? []);
  }
};
