import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@flowpact/core': src('core'),
      '@flowpact/lint': src('lint'),
      '@flowpact/reporters': src('reporters'),
      '@flowpact/language-server': src('language-server'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    // The CLI e2e tests spawn node processes, which take seconds each on shared CI runners.
    testTimeout: 60_000,
    // The CLI e2e suites run the bundle; build it once (scripts/test/build-cli.ts). The invalid YAML fixture is
    // generated (scripts/test/broken-fixture.ts).
    globalSetup: ['scripts/test/build-cli.ts', 'scripts/test/broken-fixture.ts'],
    // @actions/workflow-parser imports JSON without import attributes; let Vite transform it like the bundler does.
    server: { deps: { inline: [/@actions\/workflow-parser/, /@actions\/expressions/] } },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      // The extension's entry points run only inside VS Code; the e2e smoke test (packages/vscode/e2e) covers them.
      exclude: [
        'packages/cli/src/index.ts',
        'packages/vscode/src/extension.ts',
        'packages/vscode/src/server.ts',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
        'packages/core/src/**': { lines: 90 },
        'packages/lint/src/**': { lines: 90 },
      },
    },
  },
});
