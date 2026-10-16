import { type Loc, type Occurrence, sym } from '@ciatlas/core';
import { isMap, isScalar, isSeq, LineCounter, type Node, type Pair, parseDocument, type YAMLMap } from 'yaml';

/** Where a node is in the file. */
type Locate = (node: Node) => Loc | undefined;

/** A mapping's pairs whose key is a string. */
const pairsOf = (node: unknown): Pair[] =>
  isMap(node) ? node.items.filter((p) => isScalar(p.key) && typeof p.key.value === 'string') : [];

/** The value of a mapping's key, as a node. */
const valueAt = (map: unknown, key: string): unknown =>
  pairsOf(map).find((p) => (p.key as { value: string }).value === key)?.value;

/** A string scalar's text. */
const text = (node: unknown): string | undefined =>
  isScalar(node) && typeof node.value === 'string' ? node.value : undefined;

/** The unit a `uses:` of `calls` names: a local path as the symbol of the unit, a remote reference as its own. */
const callee = (uses: string) => (uses.includes('@') ? sym.remote(uses) : uses.replace(/^\.\//, ''));

/** Occurrences of the names an `interface` declares: inputs (call and dispatch), secrets and outputs. */
function interfaceOccurrences(unit: string, iface: unknown, at: Locate): Occurrence[] {
  const kinds: [string, (name: string) => string][] = [
    ['inputs', (n) => sym.input(unit, n)],
    ['dispatchInputs', (n) => sym.input(unit, n)],
    ['secrets', (n) => sym.secret(unit, n)],
    ['outputs', (n) => sym.output(unit, n)],
  ];
  return kinds.flatMap(([key, symbol]) =>
    pairsOf(valueAt(iface, key)).flatMap((p) => occurrence(symbol(text(p.key)!), p.key as Node, at)),
  );
}

/** An occurrence of `symbol` at `node`, when the node has a position. */
function occurrence(symbol: string, node: Node | undefined, at: Locate): Occurrence[] {
  const loc = node && at(node);
  return loc ? [{ symbol, loc, role: 'read' }] : [];
}

/** The items of a sequence that are mappings. */
const entries = (node: unknown): YAMLMap[] =>
  isSeq(node) ? node.items.filter((i): i is YAMLMap => isMap(i)) : [];

/** Occurrences in `calls`: the job that calls, and the workflow or action it calls. */
function callOccurrences(unit: string, calls: unknown, at: Locate): Occurrence[] {
  return entries(calls).flatMap((c) => {
    const job = valueAt(c, 'job') as Node | undefined;
    const uses = valueAt(c, 'uses') as Node | undefined;
    return [
      ...(text(job) ? occurrence(sym.job(unit, text(job)!), job, at) : []),
      ...(text(uses) ? occurrence(callee(text(uses)!), uses, at) : []),
    ];
  });
}

/** Occurrences in `consumers`: the consumer, its job, the inputs it passes and the outputs it reads. */
function consumerOccurrences(unit: string, consumers: unknown, at: Locate): Occurrence[] {
  return entries(consumers).flatMap((c) => {
    const from = valueAt(c, 'from') as Node | undefined;
    const job = valueAt(c, 'job') as Node | undefined;
    const names = (key: string, symbol: (name: string) => string) =>
      isSeq(valueAt(c, key))
        ? (valueAt(c, key) as { items: unknown[] }).items.flatMap((n) =>
            text(n) ? occurrence(symbol(text(n)!), n as Node, at) : [],
          )
        : [];
    return [
      ...(text(from) ? occurrence(text(from)!, from, at) : []),
      ...(text(from) && text(job) ? occurrence(sym.job(text(from)!, text(job)!), job, at) : []),
      ...names('passes', (n) => sym.input(unit, n)),
      ...names('reads', (n) => sym.output(unit, n)),
    ];
  });
}

/**
 * What a contract file names, at the places it names them: the workflow or action it describes (`path:`), the inputs,
 * secrets and outputs of its interface, the jobs and units of its calls, and its consumers with the jobs, inputs and
 * outputs they use. The editor hovers and goes to definition from these.
 */
export function contractOccurrences(file: string, source: string): Occurrence[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const at: Locate = (node) => {
    if (!node.range) return undefined;
    const a = lineCounter.linePos(node.range[0]);
    const b = lineCounter.linePos(node.range[1]);
    return { file, line: a.line, column: a.col, endLine: b.line, endColumn: b.col };
  };
  const root = doc.contents;
  const path = valueAt(root, 'path') as Node | undefined;
  const unit = text(path);
  if (!unit) return [];
  return [
    ...occurrence(unit, path, at),
    ...interfaceOccurrences(unit, valueAt(root, 'interface'), at),
    ...callOccurrences(unit, valueAt(root, 'calls'), at),
    ...consumerOccurrences(unit, valueAt(root, 'consumers'), at),
  ];
}
