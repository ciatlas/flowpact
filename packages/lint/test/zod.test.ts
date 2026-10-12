/** What packages/lint/src/zod.ts keeps from classic zod now that the schemas use zod/mini. */
import { describe, expect, it } from 'vitest';
import { config } from 'zod/mini';
import { defaultConfig, parseConfig } from '../src/config';
import { useEnglishByDefault } from '../src/zod';

describe('config defaults', () => {
  it('are a new object on every parse, so changing one config cannot change the next', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    for (const key of [
      'rules',
      'ignore',
      'overrides',
      'matrixShapes',
      'plugins',
      'impact',
      'limits',
    ] as const)
      expect(a[key], key).not.toBe(b[key]);
    expect(a.generated.include).not.toBe(b.generated.include);
    expect(a.impact.labels).not.toBe(b.impact.labels);

    a.ignore.push('**');
    a.rules.FP101 = 'off';
    a.impact.labels.major = 'changed';
    const c = parseConfig({ impact: {} });
    expect(c.ignore).toEqual([]);
    expect(c.rules).toEqual({});
    expect(c.impact.labels.major).toBe('semver:major');
    expect(defaultConfig().impact.labels.major).toBe('semver:major');
  });
});

describe('messages', () => {
  it('are English by default', () => {
    expect(() => parseConfig({ limits: { nestingDepth: 0 } })).toThrow(
      expect.objectContaining({ issues: ['limits.nestingDepth: Too small: expected number to be >0'] }),
    );
  });

  it('keep the locale an application chose, as classic zod did', () => {
    const before = config().localeError;
    const chosen = () => 'Ungültige Eingabe';
    try {
      config({ localeError: chosen });
      useEnglishByDefault();
      expect(config().localeError).toBe(chosen);
    } finally {
      config({ localeError: before });
    }
  });
});
