/** What `check-links.ts` decides about a link, apart from reading files: unit-tested in scripts/test/docs-links.test.ts. */

/** The ids an exported page defines, which its anchors can name. */
export const htmlIds = (html: string): Set<string> =>
  new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&')));

/** The `#anchor` of a link, decoded; undefined without one (or with an empty one). */
export function anchorOf(target: string): string | undefined {
  const hash = target.indexOf('#');
  const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
  return anchor || undefined;
}

/** Why a link's `#anchor` names no id on its page, or undefined when it has none or names one. */
export function anchorProblem(target: string, ids: Set<string>): string | undefined {
  const anchor = anchorOf(target);
  return anchor === undefined || ids.has(anchor) ? undefined : `no #${anchor} on the page`;
}

/** Whether a site path is under the site's base path (`/flowpact`). */
export const underBase = (target: string, base: string) =>
  target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}#`);

const SITE_URL = /https:\/\/ciatlas\.github\.io\/flowpact(?:\/[^\s"'`<>)\]\\]*)?/g;

/**
 * The site paths (with their `#anchor`) a text names in full URLs. A URL a template builds (`…/rules/${code}`) is
 * skipped: what it builds is checked where it is printed. Trailing sentence punctuation is not part of a URL.
 */
export function siteLinksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SITE_URL)) {
    if (m[0].includes('${')) continue;
    const url = new URL(m[0].replace(/[.,;:!?]+$/, ''));
    out.push(`${url.pathname}${url.hash}`);
  }
  return out;
}

/** The names of the commands among a module's exports: each `defineCommand` result has `meta.name`. */
export const commandNames = (mod: Record<string, unknown>): string[] =>
  Object.values(mod).flatMap((v) => {
    const name = (v as { meta?: { name?: unknown } } | null)?.meta?.name;
    return typeof name === 'string' ? [name] : [];
  });
