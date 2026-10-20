/**
 * What a rule's page links to besides its own text: the rules that report a neighbouring problem, and the guides that
 * explain its feature. Docs-side only, so the rule definitions stay about the rule (scripts/test/docs.test.ts checks
 * that every code here exists).
 */

/** Rules that report a neighbouring problem, by code. */
export const RELATED: Record<string, string[]> = {
  FP101: ['FP102', 'FP103', 'FP107'],
  FP102: ['FP101', 'FP108'],
  FP103: ['FP101'],
  FP104: ['FP106', 'FP108'],
  FP105: ['FP107', 'FP401'],
  FP106: ['FP104'],
  FP107: ['FP105', 'FP101'],
  FP108: ['FP102', 'FP104'],
  FP201: ['FP202', 'FP205'],
  FP202: ['FP201', 'FP205'],
  FP203: ['FP204'],
  FP204: ['FP203', 'FP205'],
  FP205: ['FP204', 'FP201'],
  FP301: ['FP302', 'FP304', 'FP303'],
  FP302: ['FP301', 'FP608'],
  FP303: ['FP301'],
  FP304: ['FP301'],
  FP401: ['FP402', 'FP404', 'FP105'],
  FP402: ['FP401', 'FP404'],
  FP403: ['FP405'],
  FP404: ['FP402'],
  FP405: ['FP403'],
  FP406: ['FP403'],
  FP502: ['FP503', 'FP505'],
  FP503: ['FP502', 'FP504'],
  FP504: ['FP503'],
  FP505: ['FP502'],
  FP601: ['FP602'],
  FP602: ['FP601'],
  FP603: ['FP612', 'FP611'],
  FP604: ['FP302'],
  FP606: ['FP610'],
  FP607: ['FP609'],
  FP608: ['FP302'],
  FP609: ['FP607'],
  FP610: ['FP606'],
  FP611: ['FP612', 'FP603'],
  FP612: ['FP603', 'FP611'],
  FP613: ['FP609', 'FP503'],
  FP801: ['FP802', 'FP804'],
  FP802: ['FP801', 'FP803'],
  FP803: ['FP802', 'FP810'],
  FP804: ['FP801'],
  FP805: ['FP802'],
  FP810: ['FP811', 'FP812', 'FP813', 'FP814'],
  FP811: ['FP810'],
  FP812: ['FP810'],
  FP813: ['FP810'],
  FP814: ['FP810'],
  FP901: ['FP902', 'FP903'],
  FP902: ['FP901', 'FP905'],
  FP903: ['FP901'],
  FP904: ['FP905'],
  FP905: ['FP904', 'FP902'],
};

/** A guide that explains a rule's feature: its title and its docs path. */
export type Guide = [title: string, href: string];

const REMOTES: Guide = ['Remote interfaces', '/docs/remote-interfaces'];
const MATRICES: Guide = [
  'How matrices are expanded',
  '/docs/how-it-works#4-expand-matrices--the-part-that-catches-silent-empties',
];
const MATRIX_SHAPES: Guide = ['Matrix shapes', '/docs/configuration#matrix-shapes'];
const CONTRACTS: Guide = ['Contracts', '/docs/contracts'];
const IMPACT: Guide = ['Impact mode', '/docs/impact-mode'];
const OVERRIDES: Guide = ['Overrides', '/docs/configuration#overrides'];
const IGNORE_COMMENTS: Guide = ['Ignore comments', '/docs/configuration#ignore-comments'];

/** The guides a rule's page links to: by code first, else by its code's range. */
const GUIDES: Record<string, Guide[]> = {
  // These check calls into other repositories too, against the remote interfaces lockfile.
  FP101: [REMOTES],
  FP102: [REMOTES],
  FP103: [REMOTES],
  FP201: [REMOTES],
  FP202: [REMOTES],
  FP205: [REMOTES],
  FP301: [REMOTES],
  FP401: [MATRICES],
  FP402: [MATRICES],
  FP403: [MATRIX_SHAPES, MATRICES],
  FP404: [MATRICES],
  FP405: [MATRIX_SHAPES],
  FP406: [MATRICES],
  FP603: [REMOTES],
  FP611: [REMOTES],
  FP612: [REMOTES],
  FP613: [REMOTES],
  FP904: [IGNORE_COMMENTS],
  FP905: [IGNORE_COMMENTS],
};

const RANGE_GUIDES: [prefix: string, guides: Guide[]][] = [
  ['FP81', [IMPACT]],
  ['FP80', [CONTRACTS]],
  ['FP9', [OVERRIDES]],
];

/** The guides that explain a rule's feature. */
export const guidesOf = (code: string): Guide[] =>
  GUIDES[code] ?? RANGE_GUIDES.find(([prefix]) => code.startsWith(prefix))?.[1] ?? [];
