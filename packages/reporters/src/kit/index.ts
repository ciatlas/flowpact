/**
 * The rendering kit: output building blocks for tools built on @ciatlas/core, with nothing of flowpact in them (no
 * findings, rules or reports). flowpact's renderers (the rest of this package) are built from it; another tool such as
 * simul-ci can be too. `.fallowrc.jsonc` keeps it that way: nothing here may import anything else in the repository
 * (@ciatlas/core and npm packages are fine).
 */
export * from './frame';
export * from './github';
export * from './graph';
export * from './markdown';
export * from './sarif';
export * from './theme';
export * from './trace';
