import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { ArrowRightFromLine, Ban, EyeOff, FolderX, Grid3x3, KeyRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Screenshot } from '@/components/screenshot';
import { gitConfig, installLinks } from '@/lib/shared';
import docsPackage from '../../package.json';

/** The released version (release-please bumps apps/docs/package.json), and the action tag that follows it. */
const version = docsPackage.version;
const actionTag = `v${version.split('.').slice(0, 2).join('.')}`;
const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** The workflow of the incident that started flowpact, as the fixture has it: the proof shows the real file. */
const incidentYaml = readFileSync(
  join(process.cwd(), '../../fixtures/incident-matrix/.github/workflows/tests.yml'),
  'utf8',
);

const actionYaml = `name: flowpact
on: pull_request
permissions:
  contents: read
jobs:
  flowpact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7       # pin to a commit SHA
      - uses: ciatlas/flowpact@${actionTag}     # pin to a commit SHA`;

const publisherYaml = `steps:
  - uses: actions/checkout@v7
  - uses: ciatlas/flowpact@${actionTag}
    with:
      mode: check    # compare with the contracts
      impact: auto   # grade the release`;

/** A remote call's finding and a moved tag's grade, as flowpact prints them (from real runs). */
const remoteFinding = `✖  ERROR  FP102 unknown-input
  actions/setup-node@v6 has no input "always-auth"

  ▶ .github/workflows/release.yml:10:11
    10 │           always-auth: true
       │           ━━━━━━━━━━━`;

const driftCheck = `$ flowpact remotes update --dry-run --fail-on breaks
  changed actions/setup-node@v6: 2028fbc → 2499707, breaks 1 of 2 calls
    input "always-auth" was removed — callers that pass it will fail
    breaks .github/workflows/release.yml:7 jobs.publish step #2
      FP102 actions/setup-node@v6 has no input "always-auth"
    1 other call fits`;

const hides: { icon: ReactNode; title: string; body: string; rules: string[] }[] = [
  {
    icon: <Grid3x3 />,
    title: 'One matrix leg gets nothing',
    body: 'An include entry lacks a key, and that combination passes an empty value on.',
    rules: ['FP401', 'FP402'],
  },
  {
    icon: <EyeOff />,
    title: 'A step that never runs',
    body: 'An optional input without a default decides an if:, and a caller leaves it out.',
    rules: ['FP105', 'FP107'],
  },
  {
    icon: <KeyRound />,
    title: 'A secret that is always empty',
    body: 'Read but never declared, and a caller does not use secrets: inherit. In one large public repository: 31 callers, a token that was always empty.',
    rules: ['FP205'],
  },
  {
    icon: <ArrowRightFromLine />,
    title: 'An output nobody sets',
    body: "A step's script writes other outputs but never this one, or an expression reads an output nothing defines.",
    rules: ['FP304', 'FP301'],
  },
  {
    icon: <FolderX />,
    title: "A local action that isn't there",
    body: 'After actions/checkout with path:, ./.github/actions/… points nowhere.',
    rules: ['FP606'],
  },
  {
    icon: <Ban />,
    title: 'Runs GitHub rejects',
    body: 'Call cycles, call chains deeper than GitHub allows, matrices of more than 256 jobs.',
    rules: ['FP601', 'FP602', 'FP406'],
  },
];

const grading: [string, string][] = [
  ['A job renamed, so its check name is gone', 'major'],
  ['An output removed', 'major'],
  ['A new required input', 'major'],
  ['Broader permissions', 'major'],
  ['A runner label callers may not have', 'major'],
  ['An optional input added', 'minor'],
];

const intents: [string, string, string][] = [
  ['Find problems in my workflows', '/docs/getting-started', 'Run it once and read a finding.'],
  ['See findings while I edit', '/docs/editors', 'VS Code, VSCodium, Cursor, Neovim.'],
  ['Run it on every pull request', '/docs/ci', 'The GitHub Action, or the CLI in any CI.'],
  ['Check calls to other repositories', '/docs/remote-interfaces', 'A lockfile of their interfaces.'],
  [
    'Know what a version bump does to my calls',
    '/docs/remote-interfaces#when-a-version-changes',
    'A drift check, and a verdict on bot pull requests.',
  ],
  ['Stop breaking the repositories that use my workflows', '/docs/contracts', 'Contracts and impact mode.'],
  ['Look up a finding', '/docs/rules', 'Every rule, with why and how to fix it.'],
  ['Roll it out across my organization', '/docs/integrating', 'Organization defaults and rules.'],
  ['Review flowpact’s security', '/docs/security', 'What it reads and writes, signed releases.'],
];

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
        {lead ? <p className="max-w-2xl text-fd-muted-foreground">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

const RuleChip = ({ code }: { code: string }) => (
  <Link
    href={`/docs/rules/${code.toLowerCase()}`}
    className="rounded-md border border-fd-border px-1.5 py-0.5 font-mono text-xs text-fd-muted-foreground hover:text-fd-foreground"
  >
    {code}
  </Link>
);

const buttonPrimary = 'rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground';
const buttonSecondary = 'rounded-lg border border-fd-border px-5 py-2.5 font-medium';

function Hero() {
  return (
    <section className="flex flex-col items-center gap-6 text-center">
      <span className="rounded-full border border-fd-border px-3 py-1 font-mono text-xs text-fd-muted-foreground">
        Data-flow linter for GitHub Actions · v{version}
      </span>
      <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
        Find the GitHub Actions values that arrive empty while the run stays green.
      </h1>
      <p className="max-w-2xl text-lg text-fd-muted-foreground">
        flowpact follows every input, secret, env var, matrix key and output through reusable workflows,
        composite actions and calls into other repositories, evaluates every combination of the matrices in
        your YAML, and shows where a value goes missing: as you type, in your terminal and on every pull
        request.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/docs/getting-started" className={buttonPrimary}>
          Get started
        </Link>
        <a href={installLinks.vscode} className={buttonSecondary}>
          Install for VS Code
        </a>
        <a href={repoUrl} className={buttonSecondary}>
          GitHub
        </a>
      </div>
      <div className="w-full max-w-2xl text-left">
        <Tabs items={['Terminal', 'GitHub Action', 'Editor']} groupId="surface" persist>
          <Tab value="Terminal">
            <ServerCodeBlock lang="sh" code="npx flowpact lint" />
          </Tab>
          <Tab value="GitHub Action">
            <ServerCodeBlock lang="yaml" code={actionYaml} />
          </Tab>
          <Tab value="Editor">
            <p className="text-sm text-fd-muted-foreground">
              Install from the{' '}
              <a href={installLinks.vscode} className="underline underline-offset-4">
                Visual Studio Marketplace
              </a>{' '}
              or{' '}
              <a href={installLinks.openVsx} className="underline underline-offset-4">
                Open VSX
              </a>
              . Neovim and other LSP editors run <code>flowpact lsp</code>.
            </p>
          </Tab>
        </Tabs>
      </div>
      <p className="text-sm text-fd-muted-foreground">
        No config · Runs nothing from your YAML · No telemetry · MIT
      </p>
    </section>
  );
}

function Proof() {
  return (
    <Section
      id="incident"
      title="The bug that started flowpact"
      lead={
        <>
          One <code>include</code> entry had no <code>config</code>. The reusable workflow it calls skips its
          tests when <code>config</code> is empty, so the windows tests never ran, and every run was green.
        </>
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2 [&_figure]:my-0">
          <ServerCodeBlock
            lang="yaml"
            code={incidentYaml}
            codeblock={{ title: '.github/workflows/tests.yml' }}
          />
        </div>
        <div className="[&_figure]:my-0">
          <Screenshot
            name="lint-incident"
            alt="flowpact lint reporting FP401: input config is empty for the windows matrix combination"
          />
        </div>
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-xl border border-fd-border p-4">
          <div className="font-semibold">GitHub Actions</div>
          <div className="text-fd-muted-foreground">Green: the windows tests were skipped.</div>
        </div>
        <div className="rounded-xl border border-fd-border p-4">
          <div className="font-semibold">actionlint 1.7.12</div>
          <div className="text-fd-muted-foreground">0 findings.</div>
        </div>
        <div className="rounded-xl border border-fd-primary p-4">
          <div className="font-semibold">flowpact</div>
          <div className="text-fd-muted-foreground">
            <RuleChip code="FP401" /> for <code>{'{ name: windows }'}</code>
          </div>
        </div>
      </div>
      <p className="text-center text-sm">
        <Link href="/docs/comparison" className="underline underline-offset-4">
          More cases side by side with actionlint and GitHub’s extension →
        </Link>
      </p>
    </Section>
  );
}

function Hides() {
  return (
    <Section id="what-a-green-run-hides" title="What a green run hides">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {hides.map((h) => (
          <div key={h.title} className="flex flex-col gap-2 rounded-xl border border-fd-border p-5">
            <div className="flex items-center gap-2 font-semibold [&_svg]:size-4 [&_svg]:text-fd-primary">
              {h.icon}
              {h.title}
            </div>
            <p className="text-sm text-fd-muted-foreground">{h.body}</p>
            <div className="mt-auto flex flex-wrap gap-1.5">
              {h.rules.map((r) => (
                <RuleChip key={r} code={r} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-sm">
        <Link href="/docs/rules" className="underline underline-offset-4">
          Every rule, with why it matters, how to fix it and an example →
        </Link>
      </p>
    </Section>
  );
}

function Flow() {
  return (
    <Section
      id="trace"
      title="Know exactly what flows between your workflows"
      lead={
        <>
          flowpact builds a graph of every value: what a caller binds under <code>with:</code>, outputs going
          back up to a caller&apos;s <code>needs</code>, <code>secrets: inherit</code> expanded to what is
          read. Follow any value down to where it is used, or up to where it comes from.
        </>
      }
    >
      <Tabs
        items={['Where it goes', 'Where it comes from', 'Which workflows call which']}
        className="mx-auto w-full max-w-3xl"
      >
        <Tab value="Where it goes">
          <Screenshot
            name="trace-down"
            alt="flowpact trace following an input down through reusable workflows"
          />
        </Tab>
        <Tab value="Where it comes from">
          <Screenshot name="trace-up" alt="flowpact trace --up following a value up to where it comes from" />
        </Tab>
        <Tab value="Which workflows call which">
          <Screenshot
            name="graph-tree"
            alt="flowpact graph drawing which workflows call which reusable workflows"
          />
        </Tab>
      </Tabs>
    </Section>
  );
}

function Remotes() {
  return (
    <Section
      id="remote-calls"
      title="Calls into other repositories, checked too"
      lead={
        <>
          Record the interfaces of the workflows and actions you call once, with{' '}
          <code>flowpact remotes update</code>, and commit the lockfile. A missing required input, an unknown
          input or secret, a literal of the wrong type or an output that is not declared is then a finding,
          with no network during the run.
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">A call that no longer fits</h3>
          <ServerCodeBlock lang="text" code={remoteFinding} />
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">A version bump or a moved tag that drops an input you pass</h3>
          <ServerCodeBlock lang="text" code={driftCheck} />
          <p className="text-sm text-fd-muted-foreground">
            Run it on a schedule, and the action grades the references a Renovate or Dependabot pull request
            moves, against interfaces it fetches itself.
          </p>
        </div>
      </div>
      <p className="text-center text-sm">
        <Link href="/docs/remote-interfaces" className="underline underline-offset-4">
          Remote interfaces, GitHub Enterprise Server and GitHub&apos;s actions.lock →
        </Link>
      </p>
    </Section>
  );
}

function Editor() {
  return (
    <Section
      id="editor"
      title="In your editor, before you push"
      lead="The same findings as you type, for closed files too: editing a reusable workflow updates its callers' findings at once. Hover any value to see where it comes from and where it goes."
    >
      <Tabs items={['Findings', 'Hover', 'Definition', 'References']} className="mx-auto w-full max-w-4xl">
        <Tab value="Findings">
          <Screenshot
            name="editor-diagnostics"
            format="png"
            alt="VS Code showing FP401 on matrix.config: the windows matrix entry has no config"
          />
        </Tab>
        <Tab value="Hover">
          <Screenshot
            name="editor-hover"
            format="png"
            alt="flowpact's hover card in VS Code: where an input comes from and where it goes"
          />
        </Tab>
        <Tab value="Definition">
          <Screenshot
            name="editor-definition"
            format="png"
            alt="VS Code peeking the definition of a caller's config key: the input it lands on in run-suite.yml"
          />
        </Tab>
        <Tab value="References">
          <Screenshot
            name="editor-references"
            format="png"
            alt="VS Code listing the references of a reusable workflow input across files"
          />
        </Tab>
      </Tabs>
      <div className="flex flex-wrap justify-center gap-3">
        <a href={installLinks.vscode} className={buttonPrimary}>
          Visual Studio Marketplace
        </a>
        <a href={installLinks.openVsx} className={buttonSecondary}>
          Open VSX
        </a>
      </div>
    </Section>
  );
}

function Publishers() {
  return (
    <Section
      id="publishers"
      title="Publish workflows without breaking the repositories that use them"
      lead="Other repositories pin what you publish to a tag such as @v1. A removed output or a renamed job breaks them without an error in your repository."
    >
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">Contracts make every interface change a diff in review</h3>
          <Screenshot
            name="generate-dry-run"
            alt="flowpact generate --dry-run listing new contract files and a unified diff of their contents"
          />
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">Impact mode fails a patch that needs a major</h3>
          <Screenshot
            name="impact"
            alt="flowpact impact failing with FP810: declared patch, but a removed output and a renamed job require major"
          />
        </div>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-fd-border text-left">
              <th className="py-2 font-semibold">Change to a published workflow or action</th>
              <th className="py-2 font-semibold">Release</th>
            </tr>
          </thead>
          <tbody>
            {grading.map(([change, level]) => (
              <tr key={change} className="border-b border-fd-border">
                <td className="py-2 text-fd-muted-foreground">{change}</td>
                <td className="py-2 font-mono">{level}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ServerCodeBlock lang="yaml" code={publisherYaml} />
      </div>
      <p className="text-center text-sm">
        <Link href="/docs/contracts" className="underline underline-offset-4">
          Contracts
        </Link>
        {' · '}
        <Link href="/docs/impact-mode" className="underline underline-offset-4">
          Impact mode
        </Link>
      </p>
    </Section>
  );
}

function PullRequests() {
  const items: [string, string][] = [
    ['Annotations', 'on the files and lines they are about, with why and how to fix it'],
    [
      'A job summary',
      'of every finding, with links to the files at the commit, and the call graph if you like',
    ],
    ['SARIF', 'for code scanning, alongside your other tools'],
    ['A patch', 'of the regenerated contracts, which contributors without Node.js can git apply'],
  ];
  return (
    <Section id="pull-requests" title="On every pull request">
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map(([title, body]) => (
          <div key={title} className="rounded-xl border border-fd-border p-5">
            <span className="font-semibold">{title}</span>{' '}
            <span className="text-fd-muted-foreground">{body}.</span>
          </div>
        ))}
      </div>
      <p className="text-center text-sm">
        <Link href="/docs/action" className="underline underline-offset-4">
          The GitHub Action →
        </Link>
      </p>
    </Section>
  );
}

function Alongside() {
  const tools: [string, string][] = [
    [
      'actionlint',
      'Each file in depth: syntax, shell scripts, expression types, runner labels, popular actions.',
    ],
    ['zizmor', 'Security: template injection, credentials left in the checkout, risky triggers.'],
    ['flowpact', 'Between files and matrix combinations: where a value goes, and where it arrives empty.'],
  ];
  return (
    <Section id="alongside" title="Use it next to actionlint and zizmor">
      <div className="grid gap-4 sm:grid-cols-3">
        {tools.map(([name, body]) => (
          <div
            key={name}
            className={`rounded-xl border p-5 ${name === 'flowpact' ? 'border-fd-primary' : 'border-fd-border'}`}
          >
            <div className="mb-1 font-semibold">{name}</div>
            <p className="text-sm text-fd-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
      <p className="text-center text-sm">
        <Link href="/docs/comparison" className="underline underline-offset-4">
          flowpact and other tools, case by case →
        </Link>
      </p>
    </Section>
  );
}

function Safety() {
  return (
    <Section
      id="security"
      title="Safe to run on any repository"
      lead="flowpact parses your YAML and runs nothing from it, sends nothing anywhere unless you ask it to fetch remote interfaces, and collects no telemetry. Releases are built only by GitHub Actions, attested with an SBOM, and published to npm with provenance."
    >
      <p className="text-center text-sm">
        <Link href="/docs/security" className="underline underline-offset-4">
          Security
        </Link>
        {' · '}
        <Link href="/docs/threat-model" className="underline underline-offset-4">
          Threat model
        </Link>
        {' · '}
        <a href="https://www.bestpractices.dev/projects/15403" className="underline underline-offset-4">
          OpenSSF Best Practices
        </a>
        {' · '}
        <a
          href="https://www.bestpractices.dev/projects/15403/baseline-2"
          className="underline underline-offset-4"
        >
          OpenSSF Baseline, level 2
        </a>
      </p>
    </Section>
  );
}

function Start() {
  return (
    <Section id="start" title="Start where you are">
      <Cards>
        {intents.map(([title, href, body]) => (
          <Card key={href + title} title={title} href={href}>
            {body}
          </Card>
        ))}
      </Cards>
    </Section>
  );
}

function Closing() {
  return (
    <section className="flex flex-col items-center gap-4 rounded-2xl border border-fd-border p-8 text-center">
      <h2 className="text-2xl font-semibold tracking-tight">One command, no config</h2>
      <code className="rounded-lg bg-fd-muted px-4 py-2 font-mono text-sm">npx flowpact lint</code>
      <p className="max-w-2xl text-sm text-fd-muted-foreground">
        A few standalone workflows with no calls between them? actionlint alone may be enough. flowpact earns
        its place once workflows call each other.
      </p>
    </section>
  );
}

function Footer() {
  const links: [string, string][] = [
    ['Docs', '/docs'],
    ['Rules', '/docs/rules'],
    ['Changelog', '/docs/changelog'],
    ['Roadmap', '/docs/roadmap'],
    ['Security', '/docs/security'],
    ['llms.txt', '/llms.txt'],
  ];
  return (
    <footer className="flex flex-wrap justify-center gap-x-5 gap-y-2 border-t border-fd-border pt-6 text-sm text-fd-muted-foreground">
      {links.map(([text, href]) => (
        <Link key={href} href={href} className="hover:text-fd-foreground">
          {text}
        </Link>
      ))}
      <a href={`${repoUrl}/releases`} className="hover:text-fd-foreground">
        Releases
      </a>
      <a href={repoUrl} className="hover:text-fd-foreground">
        GitHub
      </a>
      <a href={installLinks.npm} className="hover:text-fd-foreground">
        npm
      </a>
      <span>MIT</span>
    </footer>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-24 px-4 py-16">
      <Hero />
      <Proof />
      <Hides />
      <Flow />
      <Remotes />
      <Editor />
      <Publishers />
      <PullRequests />
      <Alongside />
      <Safety />
      <Start />
      <Closing />
      <Footer />
    </main>
  );
}
