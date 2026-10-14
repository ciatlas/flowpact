import {
  type Binding,
  type InputDecl,
  type JobDecl,
  lookup,
  type Occurrence,
  type ProjectIndex,
  type SecretDecl,
  type WorkflowDecl,
} from '@ciatlas/core';
import { interfaceCalls, interfaceUses, isExternal } from '@flowpact/lint';

/** A `with:` or `secrets:` key of a call or step whose remote interface the lockfile has. */
export interface RemoteBinding {
  at: Occurrence;
  /** The reference as the lockfile writes it. */
  ref: string;
  binding: Binding;
  decl: { kind: 'input'; decl: InputDecl } | { kind: 'secret'; decl: SecretDecl };
}

/**
 * The `with:` and `secrets:` keys of remote calls and steps whose interface the lockfile has. Core's locator knows only
 * this repository's units, so these keys have no symbol there; each gets `remote:<ref>#inputs.<name>` (or `secrets.`),
 * with the reference as the lockfile writes it, so every caller passing one input shares its symbol.
 */
export class RemoteBindings {
  private readonly byFile = new Map<string, RemoteBinding[]>();
  private readonly bySymbol = new Map<string, RemoteBinding[]>();

  constructor(index: ProjectIndex) {
    for (const { job, callee } of interfaceCalls(index)) if (isExternal(callee)) this.addCall(job, callee);
    for (const { step, action } of interfaceUses(index))
      if (isExternal(action))
        for (const b of Object.values(step.with)) this.input(action.path, b, action.inputs);
  }

  /** The key at a position (1-based). */
  at(file: string, line: number, column: number): RemoteBinding | undefined {
    return this.byFile.get(file)?.find(({ at: { loc } }) => {
      const after = line > loc.line || (line === loc.line && column >= loc.column);
      const before = line < loc.endLine || (line === loc.endLine && column <= loc.endColumn);
      return after && before;
    });
  }

  /** Every key that passes the same input or secret of the same reference. */
  occurrences(symbol: string): Occurrence[] {
    return (this.bySymbol.get(symbol) ?? []).map((b) => b.at);
  }

  private addCall(job: JobDecl, callee: WorkflowDecl) {
    if (!callee.call) return;
    for (const b of Object.values(job.with)) this.input(callee.path, b, callee.call.inputs);
    for (const b of Object.values(job.secrets)) {
      const decl = lookup(callee.call.secrets, b.name);
      if (decl) this.add(callee.path, b, { kind: 'secret', decl });
    }
  }

  private input(ref: string, b: Binding, inputs: Record<string, InputDecl>) {
    const decl = lookup(inputs, b.name);
    if (decl) this.add(ref, b, { kind: 'input', decl });
  }

  private add(ref: string, binding: Binding, decl: RemoteBinding['decl']) {
    const symbol = `remote:${ref}#${decl.kind}s.${decl.decl.name}`;
    const entry: RemoteBinding = { at: { symbol, loc: binding.loc, role: 'binding' }, ref, binding, decl };
    for (const [map, key] of [
      [this.byFile, binding.loc.file],
      [this.bySymbol, symbol],
    ] as const) {
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
  }
}
