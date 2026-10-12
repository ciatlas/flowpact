/**
 * An esbuild plugin (for tsup's `esbuildPlugins`) that records what a bundle contains: the third-party packages whose
 * code esbuild put into it, read from the build's metafile. It writes two files next to the bundle:
 * - `THIRD_PARTY_LICENSES.txt`: each package with its version, license and license text;
 * - `sbom.cdx.json`: a CycloneDX 1.5 SBOM of the same packages.
 * Both are deterministic (sorted, no timestamps, a serial number derived from the contents), so the committed action
 * bundle stays reproducible. Builds that share
 * an output directory (the VS Code extension's client and server) are merged into one pair of files.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

interface Plugin {
  name: string;
  setup(build: {
    initialOptions: { metafile?: boolean; outdir?: string; outfile?: string; absWorkingDir?: string };
    onEnd(
      callback: (result: { metafile?: { inputs: Record<string, unknown> }; errors: unknown[] }) => void,
    ): void;
  }): void;
}

export interface BundleLicensesOptions {
  /** The product the bundle belongs to, as it appears in the SBOM, e.g. `flowpact` or `vscode-flowpact`. */
  name: string;
  /** Its version (from the package's package.json). */
  version: string;
  /** What the bundle is, for the first line of the notices, e.g. "The flowpact command-line tool". */
  description: string;
  /**
   * The product's package URL, when it is not an npm package: the GitHub Action is `pkg:github/<owner>/<repo>@v<version>`
   * and the VS Code extension `pkg:vscode-extension/<publisher>/<name>@<version>`. Default: `pkg:npm/<name>@<version>`.
   */
  purl?: string;
}

interface BundledPackage {
  name: string;
  version: string;
  /** Where the package comes from, as a package URL (see purlOf). */
  purl: string;
  license: string;
  homepage?: string;
  texts: string[];
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i;

/** Packages per output directory, merged across builds that write there. */
const bundled = new Map<string, Map<string, BundledPackage>>();

function licenseOf(pkg: Record<string, unknown>): string {
  const license = pkg.license ?? pkg.licenses;
  if (typeof license === 'string') return license;
  const one = (l: unknown) =>
    typeof l === 'object' && l && 'type' in l ? String((l as { type: unknown }).type) : '';
  if (Array.isArray(license)) return license.map(one).filter(Boolean).join(' OR ') || 'UNKNOWN';
  return one(license) || 'UNKNOWN';
}

function homepageOf(pkg: Record<string, unknown>): string | undefined {
  if (typeof pkg.homepage === 'string') return pkg.homepage;
  const repo = pkg.repository;
  const url =
    typeof repo === 'string' ? repo : typeof repo === 'object' && repo ? (repo as { url?: string }).url : '';
  return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : undefined;
}

/** The package root of a bundled file: everything up to the package name after the last `node_modules`. */
function packageRoot(file: string): string | undefined {
  const parts = file.split(sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const scoped = parts[at + 1]!.startsWith('@');
  return parts.slice(0, at + (scoped ? 3 : 2)).join(sep);
}

function readPackage(root: string): BundledPackage | undefined {
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return undefined;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') return undefined;
  const texts = readdirSync(root)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n').trim());
  const homepage = homepageOf(pkg);
  return {
    name: pkg.name,
    version: pkg.version,
    purl: purlOf(pkg),
    license: licenseOf(pkg),
    ...(homepage ? { homepage } : {}),
    texts,
  };
}

const purl = (name: string, version: string) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

const productPurl = (opts: BundleLicensesOptions) => opts.purl ?? purl(opts.name, opts.version);

/** `owner/repo` of a manifest's GitHub `repository` (`github:owner/repo`, `owner/repo` or a github.com URL). */
function githubRepository(pkg: Record<string, unknown>): string | undefined {
  const repo = pkg.repository;
  const url =
    typeof repo === 'string'
      ? repo
      : typeof repo === 'object' && repo
        ? (repo as { url?: unknown }).url
        : undefined;
  if (typeof url !== 'string') return undefined;
  const match =
    /^(?:github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url) ??
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url) ??
    /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  return match?.[1];
}

/**
 * The package URL of a bundled package. A package from npm is `pkg:npm/<name>@<version>`. A private package cannot
 * come from npm: it is a git dependency on a version tag (`github:ciatlas/core#v0.1.0`), named by its repository and
 * that tag, `pkg:github/<owner>/<repo>@v<version>`, so the SBOM never points at an npm name someone else could take.
 */
export function purlOf(pkg: Record<string, unknown>): string {
  const name = String(pkg.name);
  const version = String(pkg.version);
  if (pkg.private !== true) return purl(name, version);
  const repository = githubRepository(pkg);
  if (!repository)
    throw new Error(
      `${name} is private, so it was not installed from npm, and its repository is not on GitHub: say in scripts/bundle-licenses.ts where it comes from`,
    );
  return `pkg:github/${repository.toLowerCase()}@v${version}`;
}

function notices(opts: BundleLicensesOptions, packages: BundledPackage[]): string {
  const rule = '-'.repeat(80);
  const parts = [
    `${opts.description} (${opts.name} ${opts.version}) bundles the code of the following ${packages.length} third-party packages.`,
  ];
  for (const p of packages) {
    parts.push(
      [
        rule,
        `${p.name} ${p.version} (${p.license === 'UNKNOWN' ? 'no license declared' : p.license})`,
        ...(p.homepage ? [p.homepage] : []),
        '',
        ...p.texts.flatMap((t) => [t, '']),
      ]
        .join('\n')
        .trimEnd(),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * The SBOM's `serialNumber`: a name-based (version 5 style) UUID of what it lists, so the same bundle always gets the
 * same one. CycloneDX tools, among them `actions/attest`, expect one.
 */
function serialNumber(opts: BundleLicensesOptions, packages: BundledPackage[]): string {
  const hash = createHash('sha1')
    .update([`${opts.name}@${opts.version}`, ...packages.map((p) => p.purl)].join('\n'))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sbom(opts: BundleLicensesOptions, packages: BundledPackage[]): string {
  // An SPDX identifier, an SPDX expression, or (like "MIT/X11") a name; nothing when the package declares none.
  const licenses = (license: string) =>
    license === 'UNKNOWN'
      ? []
      : /^[A-Za-z0-9.+-]+$/.test(license)
        ? [{ license: { id: license } }]
        : /\b(AND|OR|WITH)\b/.test(license)
          ? [{ expression: license }]
          : [{ license: { name: license } }];
  return `${JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      serialNumber: serialNumber(opts, packages),
      version: 1,
      metadata: {
        component: {
          type: 'application',
          'bom-ref': productPurl(opts),
          name: opts.name,
          version: opts.version,
          purl: productPurl(opts),
          licenses: [{ license: { id: 'MIT' } }],
        },
      },
      components: packages.map((p) => ({
        type: 'library',
        'bom-ref': p.purl,
        name: p.name,
        version: p.version,
        purl: p.purl,
        licenses: licenses(p.license),
        ...(p.homepage ? { externalReferences: [{ type: 'website', url: p.homepage }] } : {}),
      })),
      dependencies: [{ ref: productPurl(opts), dependsOn: packages.map((p) => p.purl) }],
    },
    null,
    2,
  )}\n`;
}

export function bundleLicenses(opts: BundleLicensesOptions): Plugin {
  return {
    name: 'flowpact-bundle-licenses',
    setup(build) {
      build.initialOptions.metafile = true;
      const cwd = build.initialOptions.absWorkingDir ?? process.cwd();
      const outdir = resolve(
        cwd,
        build.initialOptions.outdir ?? dirname(build.initialOptions.outfile ?? 'dist/index.js'),
      );
      build.onEnd((result) => {
        if (result.errors.length || !result.metafile) return;
        const seen = bundled.get(outdir) ?? new Map<string, BundledPackage>();
        bundled.set(outdir, seen);
        for (const input of Object.keys(result.metafile.inputs)) {
          const root = packageRoot(resolve(cwd, input));
          if (!root) continue;
          const pkg = readPackage(root);
          if (pkg && !pkg.name.startsWith('@flowpact/')) seen.set(`${pkg.name}@${pkg.version}`, pkg);
        }
        const packages = [...seen.values()].sort((a, b) =>
          a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
        );
        // esbuild ends before tsup writes the bundle, so the directory may not exist yet.
        mkdirSync(outdir, { recursive: true });
        writeFileSync(join(outdir, 'THIRD_PARTY_LICENSES.txt'), notices(opts, packages));
        writeFileSync(join(outdir, 'sbom.cdx.json'), sbom(opts, packages));
      });
    },
  };
}
