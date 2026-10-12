import { defineConfig } from 'tsup';
import { bundleLicenses } from '../../scripts/bundle-licenses';
import pkg from './package.json' with { type: 'json' };

// Everything but `vscode` (which the editor provides) is bundled, so the .vsix needs no node_modules. Not `/.*/`, which
// would override `external: ['vscode']`.
const bundleAll = [/^(?!vscode$)/];

/** Smaller bundles that load faster, with names kept so stack traces in bug reports stay readable. */
/** dist/THIRD_PARTY_LICENSES.txt and dist/sbom.cdx.json, merged over the client and the server, shipped in the .vsix. */
const licenses = bundleLicenses({
  name: 'vscode-flowpact',
  version: pkg.version,
  description: 'The flowpact extension for VS Code',
  // The extension is not an npm package: it is `<publisher>.<name>` on the VS Code Marketplace and Open VSX.
  purl: `pkg:vscode-extension/${pkg.publisher.toLowerCase()}/${pkg.name.toLowerCase()}@${pkg.version}`,
});

const compact = (options: { minifyWhitespace?: boolean; minifySyntax?: boolean }) => {
  options.minifyWhitespace = true;
  options.minifySyntax = true;
};

export default defineConfig([
  {
    // The client: CommonJS, because vscode-languageclient is CommonJS and requires `vscode`.
    entry: { extension: 'src/extension.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.js' }),
    platform: 'node',
    target: 'node22',
    external: ['vscode'],
    noExternal: bundleAll,
    esbuildOptions: compact,
    esbuildPlugins: [licenses],
  },
  {
    // The server: a separate process, ESM like the CLI. No `clean` here or above: the two builds run in parallel into
    // the same directory (the build script empties it first).
    entry: { server: 'src/server.ts' },
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    platform: 'node',
    target: 'node22',
    noExternal: bundleAll,
    banner: {
      // Some bundled dependencies are CommonJS and call require(); give the ESM bundle one.
      js: "import { createRequire as __flowpactCreateRequire } from 'node:module';\nconst require = __flowpactCreateRequire(import.meta.url);",
    },
    esbuildOptions(options) {
      compact(options);
      options.conditions = ['source'];
    },
    esbuildPlugins: [licenses],
  },
]);
