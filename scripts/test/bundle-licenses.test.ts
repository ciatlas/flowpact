import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { purlOf } from '../bundle-licenses';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('what the committed action bundle contains', () => {
  const sbom = JSON.parse(read('packages/action/dist/sbom.cdx.json')) as {
    bomFormat: string;
    specVersion: string;
    serialNumber: string;
    metadata: { component: { name: string; version: string; purl: string } };
    components: { name: string; version: string; licenses: unknown[] }[];
  };
  const notices = read('packages/action/dist/THIRD_PARTY_LICENSES.txt');

  it('lists the same packages in the SBOM and the notices, each with a license', () => {
    const { version } = JSON.parse(read('packages/action/package.json')) as { version: string };
    expect(sbom.metadata.component).toMatchObject({
      name: 'flowpact-action',
      version,
      purl: `pkg:github/ciatlas/flowpact@v${version}`,
    });
    expect(notices).toContain(
      `bundles the code of the following ${sbom.components.length} third-party packages`,
    );
    for (const c of sbom.components) {
      expect(notices).toContain(`\n${c.name} ${c.version} (`);
      expect({ package: c.name, licenses: c.licenses.length }).toEqual({ package: c.name, licenses: 1 });
    }
    expect(notices).not.toContain('no license declared');
  });

  it('is a CycloneDX document that actions/attest accepts, with a serial number derived from its contents', () => {
    // actions/attest takes a file as CycloneDX only with bomFormat, serialNumber and specVersion.
    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5' });
    expect(sbom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('leaves out @actions/artifact and its packages: the action uploads the drift artifact itself', () => {
    const names = sbom.components.map((c) => c.name);
    for (const name of ['@actions/artifact', '@azure/storage-blob', 'archiver', 'unzip-stream'])
      expect(names).not.toContain(name);
  });

  it('leaves out undici, which the action never calls, for a stub that says so if it is', async () => {
    expect(sbom.components.map((c) => c.name)).not.toContain('undici');
    const { ProxyAgent } = await import('../../packages/action/src/stubs/undici');
    expect(() => new ProxyAgent()).toThrow('undici is not part of the flowpact action');
    expect(read('packages/action/dist/index.js')).toContain('undici is not part of the flowpact action');
  });
});

describe('package URLs in the SBOM', () => {
  it('names a package from npm by its npm name', () => {
    expect(purlOf({ name: 'yaml', version: '2.9.1' })).toBe('pkg:npm/yaml@2.9.1');
    expect(purlOf({ name: '@actions/core', version: '3.0.1' })).toBe('pkg:npm/%40actions/core@3.0.1');
  });

  it('names a private package, a git dependency on a version tag, by its GitHub repository and tag', () => {
    const core = { name: '@ciatlas/core', version: '0.1.0', private: true };
    for (const repository of [
      { type: 'git', url: 'git+https://github.com/ciatlas/core.git' },
      'https://github.com/CIAtlas/core',
      'github:ciatlas/core',
      'ciatlas/core',
      'git@github.com:ciatlas/core.git',
      'git+ssh://git@github.com/ciatlas/core.git',
    ])
      expect(purlOf({ ...core, repository }), JSON.stringify(repository)).toBe(
        'pkg:github/ciatlas/core@v0.1.0',
      );
  });

  it('refuses a private package it cannot place, rather than naming an npm package that may belong to someone else', () => {
    for (const repository of [undefined, 'gitlab:ciatlas/core', 'https://gitlab.com/ciatlas/core.git'])
      expect(() => purlOf({ name: '@ciatlas/core', version: '0.1.0', private: true, repository })).toThrow(
        '@ciatlas/core is private',
      );
  });
});
