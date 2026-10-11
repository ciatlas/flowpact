import { jsonSafe } from '@flowpact/core';
import { type AnalysisResult, toJsonReport } from '@flowpact/lint';

export function renderJson(result: AnalysisResult, opts: { includeGraph?: boolean } = {}): string {
  return jsonSafe(`${JSON.stringify(toJsonReport(result, opts), null, 2)}\n`);
}
