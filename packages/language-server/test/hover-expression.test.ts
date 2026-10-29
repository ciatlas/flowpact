/** The hover of an expression where no symbol is, and when a step output may be ''. */
import { memoryFileSystem, SymbolLocator } from '@ciatlas/core';
import { analyze, DOCS_BASE_URL, parseConfig } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { expressionAt, expressionMarkdown, hoverMarkdown } from '../src/hover';

const WF = '.github/workflows/scan.yml';
const ACTION = '.github/actions/notify/action.yml';

const files: Record<string, string> = {
  [WF]: `on:
  workflow_call:
    inputs:
      report-file: { type: string, required: false }
      strict: { type: boolean, required: false }
jobs:
  detect:
    runs-on: ubuntu-latest
    timeout-minutes: \${{ inputs.strict && 10 || 30 }}
    outputs:
      is-report: \${{ steps.changed.outputs.any == 'true' || inputs.report-file }}
      mode: \${{ inputs.strict && 'strict' }}
    steps:
      - id: changed
        if: github.event_name == 'push'
        run: echo "any=true" >> "$GITHUB_OUTPUT"
      - id: off
        if: false
        run: echo "x=1" >> "$GITHUB_OUTPUT"
      - id: always
        if: always()
        run: echo "x=1" >> "$GITHUB_OUTPUT"
      - if: \${{ steps.changed.outputs.any != '' && inputs.strict }}
        env:
          REPORT: \${{ inputs.report-file }}
        continue-on-error: \${{ fromJSON(env.REPORT) }}
        run: echo "\${{ steps.off.outputs.x }} \${{ steps.always.outputs.x }} \${{ inputs.strict || 'x' }}"
      - if: \${{ inputs.strict }} and more
        run: echo
`,
  [ACTION]: `name: notify
inputs:
  enabled: { description: x, required: true }
runs:
  using: composite
  steps:
    - id: gen
      if: inputs.enabled
      run: echo "id=1" >> "$GITHUB_OUTPUT"
      shell: bash
    - run: echo \${{ steps.gen.outputs.id }}
      shell: bash
`,
};

const { index } = analyze({
  root: '/virtual/repo',
  fs: memoryFileSystem(files),
  config: parseConfig({}),
  validateSchema: false,
  repository: 'acme/repo',
});
const locator = new SymbolLocator(index);

/** The line and column (1-based) of `needle` in a file, moved right by `offset`. */
function position(file: string, needle: string, offset = 0) {
  const i = files[file]!.indexOf(needle);
  if (i < 0) throw new Error(`${needle} not found`);
  const before = files[file]!.slice(0, i + offset).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

/** The expression card at `needle`, or undefined where no expression is. */
function card(needle: string, offset = 0, file = WF): string | undefined {
  const { line, column } = position(file, needle, offset);
  const e = expressionAt(index, file, line, column);
  return e && expressionMarkdown(index, e);
}

/** The symbol hover at `needle`. */
function symbolHover(file: string, needle: string, offset = 0): string {
  const { line, column } = position(file, needle, offset);
  return hoverMarkdown(locator, locator.at(file, line, column)!);
}

describe('expressionMarkdown', () => {
  it('says that a value is passed on as text, what it yields, and what `||` gives', () => {
    expect(card("== 'true' ||", 1)).toBe(
      [
        `**flowpact** · expression · [docs](${DOCS_BASE_URL}/docs/editors#hover)`,
        '',
        "`outputs.is-report` is a value, passed on as text: true becomes 'true'  ",
        "yields 'true' | text of `inputs.report-file` | '' (`inputs.report-file` omitted)  ",
        '`||` gives the first operand that is true as it is, not true or false',
      ].join('\n'),
    );
    expect(card("&& 'strict'")).toContain(
      "yields 'false' | text  \n`&&` gives the first operand that is false",
    );
  });

  it('says how a condition decides, and that text around `${{ }}` makes one always true', () => {
    expect(card("!= '' && inputs.strict")).toBe(
      [
        `**flowpact** · expression · [docs](${DOCS_BASE_URL}/docs/editors#hover)`,
        '',
        "condition: '', 0, false and null are false, any other value true  ",
        'yields true | false',
      ].join('\n'),
    );
    expect(card('push')).toContain('condition:');
    expect(card('inputs.strict }} and more')).toContain(
      'an `if:` with text around its `${{ }}`: a string, which is always true',
    );
  });

  it('names the type a field takes, and how a script gets a value', () => {
    expect(card('fromJSON(env.REPORT)')).toContain(
      "`continue-on-error` takes true or false, not text (`fromJSON()` turns 'true' into true)  \nyields a value known at run time",
    );
    // `||` drops the `&&`'s false: it gives a number either way.
    expect(card('&& 10')).toContain('`timeout-minutes` takes a number  \nyields a number  \n`||` gives');
    expect(card("|| 'x'")).toContain("written into the script as text  \nyields 'true' | text  \n`||` gives");
  });

  it('finds no expression outside `${{ }}` and conditions', () => {
    expect(card('ubuntu-latest')).toBeUndefined();
    expect(card('echo "any')).toBeUndefined();
    expect(card('}} and more', 3)).toBeUndefined();
  });

  it('spans the expression with its `${{ }}`, and a bare condition as it is', () => {
    const at = (needle: string, offset = 0) => {
      const { line, column } = position(WF, needle, offset);
      const e = expressionAt(index, WF, line, column);
      return e && `${e.loc.line}:${e.loc.column}-${e.loc.endColumn}`;
    };
    expect(at('${{ inputs.strict && 10')).toBe('9:22-54');
    expect(at('30 }}', 4)).toBe('9:22-54');
    expect(at("github.event_name == 'push'")).toBe('15:13-40');
  });
});

describe("hoverMarkdown: a step output that may be ''", () => {
  it('says when the step can be skipped, and not for one that always runs', () => {
    expect(symbolHover(WF, 'steps.changed.outputs.any', 15)).toContain(
      "\n\nmay be '' · the step runs only `if: github.event_name == 'push'`",
    );
    expect(symbolHover(WF, 'steps.off.outputs.x', 12)).toContain(
      "\n\nalways '' · the step never runs (`if: false`)",
    );
    expect(symbolHover(WF, 'steps.always.outputs.x', 15)).not.toContain("''");
    expect(symbolHover(ACTION, 'steps.gen.outputs.id', 12)).toContain(
      "may be '' · the step runs only `if: inputs.enabled`",
    );
  });
});
