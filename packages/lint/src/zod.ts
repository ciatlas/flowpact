/**
 * flowpact's config, contract and report schemas use zod/mini, which validates without generating code: classic zod
 * compiles object parsers with `new Function` at run time, and that code ends up in every bundle (code scanning
 * reports it as code construction from improperly sanitized values). Import it as `import * as z from 'zod/mini'`,
 * so bundles keep only the parts in use, and import this module for what classic zod did by itself.
 */
import { config, globalRegistry, type ZodMiniType } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

/**
 * zod's English messages, which flowpact shows in config errors, unless the application that loads flowpact chose a
 * locale: zod's configuration is global, and classic zod also only filled in English when none was set.
 */
export function useEnglishByDefault(): void {
  if (!config().localeError) config(en());
}

useEnglishByDefault();

/**
 * `schema` with a description for the JSON Schema and editor hovers. It is registered rather than added with
 * `.check(z.describe(…))`: that clones the schema, and the clone of a schema with a default hands every parse the same
 * default object, so a plugin that changed one config's `ignore` would change the next config's.
 */
export function described<T extends ZodMiniType>(schema: T, description: string): T {
  globalRegistry.add(schema, { description });
  return schema;
}
