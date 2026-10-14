import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRegistry, DOCS_BASE_URL } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { indexPage, rulePage } from '../gen-rule-docs';

const RULES_DIR = join(import.meta.dirname, '../../apps/docs/content/docs/rules');
const registry = createRegistry();

describe('rule docs', () => {
  const pages = readdirSync(RULES_DIR).filter((f) => /^fp\d{3}\.mdx$/.test(f));

  it('has a page for every registered rule and a rule for every page', () => {
    expect(pages.sort()).toEqual(
      registry
        .all()
        .map((r) => `${r.code.toLowerCase()}.mdx`)
        .sort(),
    );
  });

  it('pages are up to date with the rule definitions (run `pnpm docs:gen`)', () => {
    for (const rule of registry.all()) {
      expect(readFileSync(join(RULES_DIR, `${rule.code.toLowerCase()}.mdx`), 'utf8')).toBe(rulePage(rule));
    }
    expect(readFileSync(join(RULES_DIR, 'index.mdx'), 'utf8')).toBe(indexPage(registry.all()));
  });

  it('keeps code spans as the rule writes them: MDX takes them literally, so an escape would show', () => {
    const spans = (s: string) => s.match(/(`+)[\s\S]*?[^`]\1(?!`)/g) ?? [];
    for (const rule of registry.all()) {
      const prose = [rule.docs.why, rule.docs.fix, rule.docs.scope ?? ''].join('\n');
      const page = rulePage(rule);
      for (const span of spans(prose)) expect(page, `${rule.code}: ${span}`).toContain(span);
    }
    // Summaries go in the index's table cells, where a code span cannot hold a pipe or a backslash.
    const index = indexPage(registry.all());
    for (const rule of registry.all())
      for (const span of spans(rule.docs.summary)) {
        expect(span, `${rule.code}: ${span}`).not.toMatch(/[|\\]/);
        expect(index).toContain(span);
      }
  });

  it('gives impact mode its own group in the index, and reserves only FP7xx', () => {
    const index = indexPage(registry.all());
    expect(index).toContain('## Contracts (`FP80x`)');
    expect(index).toContain('## Impact mode (`FP81x`)');
    expect(index).toContain('- `FP7xx`: hygiene rules (none yet).');
    expect(index).not.toMatch(/FP[89]xx` —/);
  });

  it('every docs URL printed by the tool maps to a docs page route', () => {
    for (const rule of registry.all()) {
      const url = registry.docsUrl(rule);
      expect(url.startsWith(`${DOCS_BASE_URL}/docs/rules/`)).toBe(true);
      const slug = url.slice(`${DOCS_BASE_URL}/docs/`.length);
      expect(existsSync(join(RULES_DIR, '..', `${slug}.mdx`))).toBe(true);
    }
  });

  it('published schemas match the code', async () => {
    const { configJsonSchema, contractJsonSchema, reportJsonSchema } = await import('@flowpact/lint');
    const pub = (n: string) =>
      JSON.parse(
        readFileSync(join(import.meta.dirname, `../../apps/docs/public/schemas/${n}/v1.json`), 'utf8'),
      );
    expect(pub('config')).toEqual(JSON.parse(JSON.stringify(configJsonSchema())));
    expect(pub('report')).toEqual(JSON.parse(JSON.stringify(reportJsonSchema())));
    expect(pub('contract')).toEqual(JSON.parse(JSON.stringify(contractJsonSchema())));
  });
});

describe('generated files', () => {
  it('the configuration page lists every rule that skips generated files', () => {
    const page = readFileSync(join(RULES_DIR, '..', 'configuration.mdx'), 'utf8');
    const section = page.slice(page.indexOf('## Generated files'), page.indexOf('## Plugins'));
    const listed = [...section.matchAll(/^\| \[`(FP\d{3})`\]/gm)].map((m) => m[1]);
    const skipping = registry
      .all()
      .filter((r) => r.generatedFiles === 'skip')
      .map((r) => r.code);
    expect(listed).toEqual(skipping);
  });
});

describe('rule counts in prose', () => {
  it('match the registry everywhere they are stated', () => {
    const n = createRegistry().all().length;
    const files = [
      'README.md',
      ...['index', 'how-it-works', 'roadmap'].map((p) => `apps/docs/content/docs/${p}.mdx`),
    ];
    for (const f of files) {
      const text = readFileSync(join(import.meta.dirname, '../..', f), 'utf8');
      for (const m of text.matchAll(/\b(\d+) rules\b/g))
        expect({ file: f, count: Number(m[1]) }).toEqual({ file: f, count: n });
    }
  });
});

describe('version references', () => {
  it('are on the current release line (run `node scripts/sync-version-refs.mjs`)', async () => {
    // @ts-expect-error -- plain JavaScript module without types
    const { FILES, currentVersion, syncRefs } = await import('../sync-version-refs.mjs');
    const version: string = currentVersion();
    for (const file of FILES as string[]) {
      const text = readFileSync(join(import.meta.dirname, '../..', file), 'utf8');
      expect({ file, text: syncRefs(text, version) }).toEqual({ file, text });
    }
  });

  it('move to the next release line', async () => {
    // @ts-expect-error -- plain JavaScript module without types
    const { syncRefs: sync } = await import('../sync-version-refs.mjs');
    // An explicit location, so the test does not depend on where flowpact lives.
    const location = { repository: 'acme/flowpact', previousRepositories: ['old/flowpact'] };
    const syncRefs = (text: string, version: string) => sync(text, version, location);
    const text =
      'uses: acme/flowpact@v0.3\nuses: acme/flowpact@v0.3.2\nnpx flowpact@0.3 lint\n`flowpact` on npm, flowpact@ v0\nFLOWPACT_VERSION: 0.3.2';
    expect(syncRefs(text, '0.4.0')).toBe(
      'uses: acme/flowpact@v0.4\nuses: acme/flowpact@v0.4.0\nnpx flowpact@0.4 lint\n`flowpact` on npm, flowpact@ v0\nFLOWPACT_VERSION: 0.4.0',
    );
    expect(
      syncRefs(
        ' flowpact  v0.1.0  config schema v1\n<sub>flowpact v0.1.0 · config schema v1</sub>\n"tool": "flowpact", "version": "0.1.0"',
        '0.4.0',
      ),
    ).toBe(
      ' flowpact  v0.4.0  config schema v1\n<sub>flowpact v0.4.0 · config schema v1</sub>\n"tool": "flowpact", "version": "0.4.0"',
    );
    // A terminal screenshot's banner: the version's width changes, and the words after it move with it.
    const banner = (v: string, w: string, x: string) =>
      `<text y="67"><tspan x="28.4" textLength="67.2" fill="#3b4252">flowpact</tspan><tspan x="112.4" textLength="${w}" lengthAdjust="spacingAndGlyphs" fill="#d8dee9">${v}</tspan><tspan x="${x}" textLength="50.4">config</tspan></text>`;
    expect(syncRefs(banner('v0.3.2', '50.4', '179.6'), '0.10.0')).toBe(banner('v0.10.0', '58.8', '188.0'));
    expect(syncRefs(banner('v1.0.0-rc.1', '92.4', '221.6'), '1.0.0')).toBe(banner('v1.0.0', '50.4', '179.6'));
    expect(syncRefs('uses: acme/flowpact@v1.0.0-rc.1', '1.0.0')).toBe('uses: acme/flowpact@v1.0.0');
    expect(syncRefs(text, '1.2.0')).toBe(
      'uses: acme/flowpact@v1\nuses: acme/flowpact@v1.2.0\nnpx flowpact@1 lint\n`flowpact` on npm, flowpact@ v0\nFLOWPACT_VERSION: 1.2.0',
    );
    // After a move, references through a previous repository follow it; another owner's copy (a mirror) does not.
    expect(
      syncRefs('uses: old/flowpact@v0.3\nuses: old/flowpact@v0.3.2\nuses: mirror/flowpact@v0.3', '0.4.0'),
    ).toBe('uses: acme/flowpact@v0.4\nuses: acme/flowpact@v0.4.0\nuses: mirror/flowpact@v0.3');
  });
});
