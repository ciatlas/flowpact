import { describe, expect, it } from 'vitest';
import { byCode, lint, WF, yaml } from '../helpers';

const callee = yaml`
  on:
    workflow_call:
      secrets:
        token: { required: true }
        optional: { required: false }
        unused: {}
  jobs:
    j:
      runs-on: x
      steps:
        - run: deploy \${{ secrets.token }} \${{ secrets.optional }} \${{ secrets.GITHUB_TOKEN }}
`;
const caller = (secrets: string) =>
  `on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n${secrets}`;

describe('FP201 missing-required-secret', () => {
  it('flags a missing required secret', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets:\n      optional: x\n'),
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP201').map((f) => f.message)).toEqual([
      'jobs.call calls .github/workflows/callee.yml without required secret "token"',
    ]);
  });
  it('accepts secrets: inherit', () => {
    const r = lint({ [`${WF}/caller.yml`]: caller('    secrets: inherit\n'), [`${WF}/callee.yml`]: callee });
    expect(byCode(r, 'FP201')).toEqual([]);
  });
});

describe('FP202 unknown-secret', () => {
  it('flags undeclared secrets with a suggestion', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets:\n      token: x\n      tokn: y\n'),
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP202')[0]?.message).toBe(
      '.github/workflows/callee.yml has no secret "tokn" — did you mean "token"?',
    );
  });
});

describe('FP203 unused-secret', () => {
  it('flags declared secrets that are never read', () => {
    const r = lint({ [`${WF}/callee.yml`]: callee });
    expect(byCode(r, 'FP203').map((f) => f.symbol)).toEqual([`${WF}/callee.yml#secrets.unused`]);
  });
  it('counts secrets forwarded to a callee through inherit', () => {
    const r = lint({
      [`${WF}/mid.yml`]: yaml`
        on:
          workflow_call:
            secrets:
              token: {}
        jobs:
          j:
            uses: ./.github/workflows/leaf.yml
            secrets: inherit
      `,
      [`${WF}/leaf.yml`]:
        'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.token }}\n',
    });
    expect(byCode(r, 'FP203')).toEqual([]);
  });
});

/** ciatlas/core#20: mid.yml declares `deploy` and hands every secret to leaf.yml, which reads them with `read`. */
const everySecret = (read: string, pass = 'secrets: inherit') => ({
  [`${WF}/leaf.yml`]: `on: { workflow_call: }\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ ${read} }}"\n`,
  [`${WF}/mid.yml`]: yaml`
    on:
      workflow_call:
        secrets:
          deploy: { required: true }
    jobs:
      call:
        uses: ./.github/workflows/leaf.yml
        ${pass}
  `,
  [`${WF}/top.yml`]:
    'on: push\njobs:\n  call:\n    uses: ./.github/workflows/mid.yml\n    secrets: { deploy: x }\n',
});

describe('FP203 and FP204: a callee behind secrets: inherit that reads every secret (ciatlas/core#20)', () => {
  it.each(['toJSON(secrets)', 'secrets.*', 'secrets[github.event.action]'])(
    'counts %s as a read of every secret the caller hands on, and keeps secrets: inherit',
    (read) => {
      const r = lint(everySecret(read));
      expect(byCode(r, 'FP203')).toEqual([]);
      expect(byCode(r, 'FP204')).toEqual([]);
    },
  );

  it('also through a callee that hands every secret on in turn', () => {
    const files = everySecret('toJSON(secrets)');
    const r = lint({
      ...files,
      [`${WF}/mid.yml`]: files[`${WF}/mid.yml`]!.replace('leaf.yml', 'pass.yml'),
      [`${WF}/pass.yml`]:
        'on: workflow_call\njobs:\n  j:\n    uses: ./.github/workflows/leaf.yml\n    secrets: inherit\n',
    });
    expect(byCode(r, 'FP203')).toEqual([]);
    expect(byCode(r, 'FP204')).toEqual([]);
  });

  it('still reports a secret that reaches such a callee through secrets: only by name, and a callee reading none', () => {
    const r = lint(everySecret('toJSON(secrets)', 'secrets: {}'));
    expect(byCode(r, 'FP203').map((f) => f.message)).toEqual([
      'Secret "deploy" of .github/workflows/mid.yml is never read',
    ]);
    const none = lint(everySecret("'no secret'"));
    expect(byCode(none, 'FP204').map((f) => [f.message, f.fix])).toEqual([
      [
        'jobs.call inherits all secrets; .github/workflows/leaf.yml and its callees read none',
        'Remove `secrets: inherit`; the callee reads no secrets.',
      ],
    ]);
  });
});

/** top.yml hands every secret to mid.yml, which declares `deploy` and hands every secret on to `uses` with `pass`. */
const handsOn = (uses: string, files: Record<string, string> = {}, pass = 'secrets: inherit') => ({
  ...files,
  [`${WF}/mid.yml`]: yaml`
    on:
      workflow_call:
        secrets:
          deploy: { required: true }
    jobs:
      call:
        uses: ${uses}
        ${pass}
  `,
  [`${WF}/top.yml`]:
    'on: push\njobs:\n  call:\n    uses: ./.github/workflows/mid.yml\n    secrets: inherit\n',
});
const REMOTE = 'acme/infra/.github/workflows/deploy.yml@v1';

describe('FP203 and FP204: a callee behind secrets: inherit whose reads are unknown', () => {
  it.each([
    ['a remote workflow', REMOTE, {}],
    ['a local workflow that is missing', './.github/workflows/nowhere.yml', {}],
    [
      'a callee with an expression that does not parse',
      './.github/workflows/leaf.yml',
      { [`${WF}/leaf.yml`]: everySecret('fromJSON(secrets[')[`${WF}/leaf.yml`]! },
    ],
  ])('keeps the secrets mid.yml hands on to %s, and secrets: inherit into mid.yml', (_, uses, files) => {
    const r = lint(handsOn(uses, files));
    expect(byCode(r, 'FP203')).toEqual([]);
    expect(byCode(r, 'FP204')).toEqual([]);
  });

  it('still lists the secrets mid.yml reads when it passes them to the remote workflow by name', () => {
    const r = lint(handsOn(REMOTE, {}, "secrets: { token: '${{ secrets.deploy }}' }"));
    expect(byCode(r, 'FP203')).toEqual([]);
    expect(byCode(r, 'FP204').map((f) => [f.message, f.fix])).toEqual([
      [
        'jobs.call inherits all secrets; .github/workflows/mid.yml and its callees read deploy',
        'Replace with:\nsecrets:\n  deploy: ${{ secrets.deploy }}',
      ],
    ]);
  });
});

describe('FP204 secrets-inherit', () => {
  it('lists the secrets the callee tree actually reads and suggests an explicit mapping', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets: inherit\n'),
      [`${WF}/callee.yml`]: callee.replace(
        'jobs:',
        'jobs:\n  nested:\n    uses: ./.github/workflows/leaf.yml\n    secrets: inherit',
      ),
      [`${WF}/leaf.yml`]:
        'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.NPM_TOKEN }}\n',
    });
    const f = byCode(r, 'FP204').find((x) => x.loc.file.endsWith('caller.yml'));
    expect(f?.message).toBe(
      'jobs.call inherits all secrets; .github/workflows/callee.yml and its callees read NPM_TOKEN, optional, token',
    );
    expect(f?.fix).toContain('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(f?.severity).toBe('info');
  });
});

describe('FP205 undeclared-secret-ref', () => {
  it('flags reads of undeclared secrets when a caller does not inherit', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets:\n      token: x\n'),
      [`${WF}/callee.yml`]: callee.replace(
        '${{ secrets.GITHUB_TOKEN }}',
        '${{ secrets.GITHUB_TOKEN }} ${{ secrets.EXTRA }}',
      ),
    });
    expect(byCode(r, 'FP205').map((f) => f.message)).toEqual([
      '.github/workflows/callee.yml reads secrets.EXTRA, which is not declared — it is empty when called from 1 caller without `secrets: inherit`',
    ]);
  });
  it('is quiet when every caller inherits', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('    secrets: inherit\n'),
      [`${WF}/callee.yml`]: callee.replace('${{ secrets.GITHUB_TOKEN }}', '${{ secrets.EXTRA }}'),
    });
    expect(byCode(r, 'FP205')).toEqual([]);
  });

  describe('callers for which the read never runs (mastodon build-container-image.yml)', () => {
    const files = (callers: string, guard = "contains(inputs.push_to_images, 'tootsuite')", jobIf = '') => ({
      [`${WF}/callers.yml`]: `on: push\njobs:\n${callers}`,
      [`${WF}/build.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              push_to_images: { type: string }
              push: { type: boolean }
              registry: { type: string, default: docker.io }
        jobs:
          build:
            runs-on: x${jobIf}
            steps:
              - name: Log in to Docker Hub
                if: ${guard}
                uses: docker/login-action@v3
                with:
                  username: \${{ secrets.DOCKERHUB_USERNAME }}
      `,
    });
    const call = (id: string, w = '', s = '') =>
      `  ${id}:\n    uses: ./.github/workflows/build.yml\n${w ? `    with:\n${w}` : ''}${s}`;
    const fp205 = (f: Record<string, string>) => byCode(lint(f), 'FP205').map((x) => x.message);

    it('skips callers that omit the input the step requires', () => {
      expect(
        fp205(
          files(
            call('test', '      push_to_images: ""\n') +
              call('test2') +
              call('push', '      push_to_images: tootsuite/mastodon\n', '    secrets: inherit\n'),
          ),
        ),
      ).toEqual([]);
    });

    it('still counts callers whose values make it run, or that pass values only known at runtime', () => {
      expect(
        fp205(
          files(
            call('test') +
              call('nightly', '      push_to_images: tootsuite/mastodon\n') +
              call('dyn', '      push_to_images: ${{ github.event.inputs.images }}\n'),
          ),
        ),
      ).toEqual([
        '.github/workflows/build.yml reads secrets.DOCKERHUB_USERNAME, which is not declared — it is empty when called from 2 callers without `secrets: inherit`',
      ]);
    });

    it('applies defaults and type defaults, and job conditions', () => {
      // `push` is a boolean: omitted means false.
      expect(fp205(files(call('a'), 'inputs.push'))).toEqual([]);
      // `registry` defaults to docker.io.
      expect(fp205(files(call('a'), "inputs.registry == 'docker.io'"))).toHaveLength(1);
      expect(fp205(files(call('a', '      registry: ghcr.io\n'), "inputs.registry == 'docker.io'"))).toEqual(
        [],
      );
      expect(fp205(files(call('a'), 'always()', '\n            if: inputs.push'))).toEqual([]);
      expect(fp205(files(call('a'), 'always()', '\n            if: inputs.registry'))).toHaveLength(1);
    });

    it('skips reads that never run: if: false, quoted or not', () => {
      expect(fp205(files(call('a'), 'always()'))).toHaveLength(1);
      for (const cond of ['false', "'false'", '${{ false }}']) {
        expect(fp205(files(call('a'), cond)), `step if: ${cond}`).toEqual([]);
        expect(fp205(files(call('a'), 'always()', `\n            if: ${cond}`)), `job if: ${cond}`).toEqual(
          [],
        );
      }
    });
  });
});
