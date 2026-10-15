/** Adding an override to a config file's text: the result is a config that parses, with the new override last. */
import { addOverride, type ConfigInsertion, type OverrideEntry, parseConfigText } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';

const entry: OverrideEntry = {
  rule: 'FP104',
  target: '.github/workflows/ci.yml#inputs.legacy',
  reason: 'Read by the release dispatcher: "legacy" stays until Q3',
  expires: '2026-12-31',
};

/** The text with the insertion made. */
function inserted(text: string, at: ConfigInsertion): string {
  const lines = text.split('\n');
  const offset = lines.slice(0, at.line - 1).reduce((n, l) => n + l.length + 1, 0) + at.column - 1;
  return text.slice(0, offset) + at.newText + text.slice(offset);
}

const overridesOf = (text: string) => parseConfigText(text, 'flowpact.config.yml').config.overrides ?? [];

describe('addOverride', () => {
  it('writes a whole config file when there is none', () => {
    const at = addOverride(undefined, entry)!;
    expect(at.create).toBe(true);
    expect(overridesOf(inserted('', at))).toEqual([
      expect.objectContaining({ rule: 'FP104', reason: entry.reason }),
    ]);
  });

  it('adds an overrides list to a config without one, with or without a final line break', () => {
    for (const text of ['rules:\n  FP604: warning\n', 'rules:\n  FP604: warning']) {
      const out = inserted(text, addOverride(text, entry)!);
      expect(out.startsWith('rules:\n  FP604: warning\noverrides:\n  - rule: FP104\n')).toBe(true);
      expect(overridesOf(out)).toHaveLength(1);
    }
  });

  it('appends to the overrides a config has, at their indentation', () => {
    for (const indent of ['  ', '']) {
      const text = `overrides:\n${indent}- rule: FP105\n${indent}  file: .github/workflows/a.yml\n${indent}  reason: Checked by hand already\nrules:\n  FP604: warning\n`;
      const out = inserted(text, addOverride(text, entry)!);
      const overrides = overridesOf(out);
      expect(overrides.map((o) => o.rule)).toEqual(['FP105', 'FP104']);
      expect(overrides[1]).toMatchObject({
        target: entry.target,
        reason: entry.reason,
        expires: '2026-12-31',
      });
      expect(out).toContain(`${indent}- rule: FP104\n`);
    }
  });

  it('fills an empty overrides key', () => {
    const text = 'overrides:\nrules:\n  FP604: warning\n';
    expect(overridesOf(inserted(text, addOverride(text, entry)!))).toHaveLength(1);
  });

  it('leaves a flow list, and a file with CRLF line endings, to the user', () => {
    expect(addOverride('overrides: []\n', entry)).toBeUndefined();
    expect(addOverride('rules:\r\n  FP604: warning\r\n', entry)).toBeUndefined();
  });
});
