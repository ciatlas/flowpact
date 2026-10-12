import { jsonSafe, type Loc } from '@ciatlas/core';
import { inRepository } from './github';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

/** A rule of a SARIF run (a reporting descriptor), with what GitHub code scanning shows of it. */
export interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text: string };
  fullDescription?: { text: string };
  helpUri?: string;
  help?: { text: string; markdown?: string };
  defaultConfiguration?: { level: 'error' | 'warning' | 'note' | 'none' };
  properties?: { tags?: string[] };
}

const region = (loc: Loc) => ({
  startLine: loc.line,
  startColumn: loc.column,
  endLine: loc.endLine,
  endColumn: loc.endColumn,
});

/** A SARIF physical location: the file relative to the repository (`%SRCROOT%`) and the region `loc` covers. */
export const sarifLocation = (loc: Loc, pathPrefix?: string) => ({
  artifactLocation: { uri: inRepository(loc.file, pathPrefix), uriBaseId: '%SRCROOT%' },
  region: region(loc),
});

/** The tool that produced a SARIF run. */
export interface SarifDriver {
  name: string;
  version: string;
  informationUri?: string;
  rules: SarifRule[];
}

/** A SARIF 2.1.0 log with one run, as JSON safe to embed anywhere (see jsonSafe). */
export function sarifLog(driver: SarifDriver, results: unknown[]): string {
  const sarif = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: driver.name,
            version: driver.version,
            semanticVersion: driver.version,
            informationUri: driver.informationUri,
            rules: driver.rules,
          },
        },
        columnKind: 'utf16CodeUnits',
        results,
      },
    ],
  };
  return jsonSafe(`${JSON.stringify(sarif, null, 2)}\n`);
}
