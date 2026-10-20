import { describe, expect, it } from 'vitest';
import { completionItems, keyContext } from '../src/completion';

/** The context where `|` is (removed from the text). */
function at(typed: string) {
  const cursor = typed.indexOf('|');
  const before = typed.slice(0, cursor).split('\n');
  return keyContext(
    typed.slice(0, cursor) + typed.slice(cursor + 1),
    before.length - 1,
    before.at(-1)!.length,
  );
}

describe('keyContext', () => {
  it('finds the uses: of a step written after with:, quoted, with a comment', () => {
    expect(
      at(
        ['steps:', '  - with:', '      a: 1', '      |', "    uses: 'octo/setup@v2' # pinned", ''].join('\n'),
      ),
    ).toEqual({
      block: 'with',
      uses: 'octo/setup@v2',
      present: ['a'],
      range: { line: 3, start: 6, end: 6 },
    });
  });

  it('covers the whole key being typed, and the keys after it', () => {
    const ctx = at(
      [
        'jobs:',
        '  a:',
        '    uses: ./x.yml',
        '    secrets:',
        '      to|ken',
        '      b: x',
        '  c:',
        '    d: 1',
      ].join('\r\n'),
    );
    expect(ctx).toMatchObject({
      block: 'secrets',
      uses: './x.yml',
      present: ['b'],
      range: { line: 4, start: 6, end: 11 },
    });
  });

  it("does not look into another step's uses:", () => {
    expect(at(['steps:', '  - uses: octo/a@v1', '  - with:', '      |', ''].join('\n'))).toBeUndefined();
  });

  it('offers no key under an inline value, nor after a colon', () => {
    expect(at(['  - uses: octo/a@v1', '    with: { a: 1 }', '      |'].join('\n'))).toBeUndefined();
    expect(at(['  - uses: octo/a@v1', '    with:', '      a: |'].join('\n'))).toBeUndefined();
  });

  it("counts only the block's own keys: not a block scalar's lines, nor a later block's keys", () => {
    const ctx = at(
      [
        'jobs:',
        '  a:',
        '    uses: ./a.yml',
        '    with:',
        '      |',
        '      script: |',
        '        x: 1',
        '  b:',
        '    uses: ./b.yml',
        '    with:',
        '      other: 1',
        '',
      ].join('\n'),
    );
    expect(ctx?.present).toEqual(['script']);
  });

  it("does not take the next step's uses: for this one", () => {
    expect(at(['steps:', '  - with:', '      |', '  - uses: octo/b@v1', ''].join('\n'))).toBeUndefined();
  });
});

describe('completionItems', () => {
  const ctx = {
    block: 'with' as const,
    uses: 'acme/x/.github/workflows/y.yml@v1',
    present: [],
    range: { line: 4, start: 6, end: 6 },
  };

  it('offers only names it can write as they are, and shows descriptions as text', () => {
    const items = completionItems(
      [
        { name: 'config', required: true, description: 'See [docs](https://example.com) **now**' },
        // From a lockfile a pull request edited: it would add `secrets: inherit` to the call.
        { name: 'x\n    secrets: inherit\n    y', required: true },
        { name: 'evil: x', required: false },
      ],
      ctx,
    );
    expect(items.map((i) => i.textEdit && 'newText' in i.textEdit && i.textEdit.newText)).toEqual([
      'config: ',
    ]);
    expect((items[0]!.documentation as { value: string }).value).toContain(
      'See \\[docs\\]\\(https://example\\.com\\) \\*\\*now\\*\\*',
    );
  });
});
