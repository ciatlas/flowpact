import { writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { bundleLicenses } from '../../scripts/bundle-licenses';
import location from '../lint/src/location.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  splitting: false,
  // The runner executes dist/index.js straight from the repository, so everything is bundled into that one file.
  noExternal: [/.*/],
  banner: {
    // Some bundled dependencies are CommonJS and call require(); give the ESM bundle one.
    js: "import { createRequire as __flowpactCreateRequire } from 'node:module';\nconst require = __flowpactCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
    // @actions/http-client imports undici only for getAgentDispatcher(), which the action never calls.
    options.alias = { undici: './src/stubs/undici.ts' };
  },
  // The bundle is an ES module in a .js file. Copied out of this repository (the release archive), the nearest
  // package.json would decide how Node reads it, and a "type": "commonjs" one would break it; this one says ESM.
  async onSuccess() {
    writeFileSync('dist/package.json', '{\n  "type": "module"\n}\n');
  },
  // dist/THIRD_PARTY_LICENSES.txt and dist/sbom.cdx.json: what the committed bundle contains.
  esbuildPlugins: [
    bundleLicenses({
      name: 'flowpact-action',
      version: pkg.version,
      description: 'The flowpact GitHub Action',
      // The action is not an npm package: it is this repository at the release tag.
      purl: `pkg:github/${location.repository.toLowerCase()}@v${pkg.version}`,
    }),
  ],
});
