// Starts VS Code (downloaded into .vscode-test/) with fixtures/deep-nesting open and runs smoke.cjs inside it.
// VSCODE_VERSION picks the version (default: stable); FLOWPACT_EXTENSION_PATH tests another copy of the extension,
// such as an unpacked .vsix.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = fileURLToPath(new URL('.', import.meta.url));
const extension = process.env.FLOWPACT_EXTENSION_PATH || join(here, '..');
const { publisher, name } = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
try {
  await runTests({
    version: process.env.VSCODE_VERSION || 'stable',
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(here, 'smoke.cjs'),
    extensionTestsEnv: { FLOWPACT_EXTENSION_ID: `${publisher}.${name}` },
    // --disable-gpu: on CI's virtual display (xvfb), VS Code's window can hang at startup ("CodeWindow: detected
    // unresponsive") before any test runs; it needs no GPU for these tests.
    launchArgs: [join(here, '../../../fixtures/deep-nesting'), '--disable-extensions', '--disable-gpu'],
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
