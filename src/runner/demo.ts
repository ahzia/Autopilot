// SPDX-License-Identifier: MIT
// Demo mode (execution.runner = "fake"): scripted agents that exercise the
// whole loop — planning, parallel builders, a blocking decision card, review,
// auto-merge and a sensitive change that needs the founder — without using
// Claude. Useful to try the inbox and for end-to-end drills.

import { FakeRunner, commitFile, type FakeControl } from './fake.ts';
import type { RunOutcome, RunSpec } from '../types.ts';

function runToken(spec: RunSpec): string {
  const servers = (spec.mcpConfig as any)?.mcpServers;
  return servers?.autopilot?.env?.AUTOPILOT_RUN_TOKEN ?? '';
}

async function callTool(apiUrl: string, spec: RunSpec, name: string, args: unknown): Promise<any> {
  const res = await fetch(`${apiUrl}/agent/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runToken(spec)}` },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const DEMO_TASKS = [
  {
    key: 'readme',
    title: 'Write the project README',
    objective: 'Explain what the project is and how to run it.',
    ownedPaths: ['README.md'],
    acceptanceCriteria: ['README.md describes the project and how to start it'],
  },
  {
    key: 'greeting',
    title: 'Add a greeting module',
    objective: 'Add a tiny greeting function with a test so later features can reuse it.',
    ownedPaths: ['src/greeting/**'],
    acceptanceCriteria: ['src/greeting/index.js exports greet(name)', 'greet("Ada") returns a friendly sentence'],
  },
  {
    key: 'welcome',
    title: 'Pick a tone for the welcome message',
    objective: 'Write the first-run welcome text. The tone is a founder decision.',
    ownedPaths: ['docs/welcome.md'],
    acceptanceCriteria: ['docs/welcome.md contains the welcome text in the chosen tone'],
  },
  {
    key: 'deps',
    title: 'Add a package manifest',
    objective: 'Add package.json so the project can declare scripts. Dependency files are sensitive, so this one needs the founder.',
    ownedPaths: ['package.json'],
    acceptanceCriteria: ['package.json exists with a name and a test script'],
  },
];

async function work(ctl: FakeControl, ms: number, note: string): Promise<void> {
  ctl.emit({ type: 'text', text: note });
  ctl.emit({ type: 'activity', summary: note });
  await ctl.sleep(ms);
}

export function demoRunner(opts: { apiUrl: string; speed?: number }): FakeRunner {
  const k = opts.speed ?? 1;
  return new FakeRunner((spec: RunSpec) => async (ctl: FakeControl): Promise<Partial<RunOutcome>> => {
    if (spec.role === 'planner') {
      await work(ctl, 1500 * k, 'Reading the founder documents and the board…');
      const empty = /Open tasks \(not yet integrated\):\n\(none\)/.test(spec.prompt) && !/Recently integrated:\n- /.test(spec.prompt);
      const plan = empty
        ? {
            summary: 'Demo plan: a README, a reusable module, a welcome text that needs a tone decision, and a sensitive manifest change.',
            newTasks: DEMO_TASKS.map((t, i) => ({ ...t, nonGoals: [], role: i === 1 ? 'backend' : 'full-stack', kind: 'build', priority: i + 1, risk: 'low', dependsOn: [] })),
            acceptTaskIds: [],
            cancelTaskIds: [],
            questions: [
              {
                question: 'Who should the first release speak to?',
                why: 'It changes wording and examples across the app.',
                options: [
                  { id: 'students', label: 'Students', tradeoff: 'Playful, short' },
                  { id: 'professionals', label: 'Young professionals', tradeoff: 'Calm, practical' },
                ],
                recommendation: 'students',
                recommendationReason: 'The documents mention students first.',
              },
            ],
          }
        : { summary: 'Nothing new to plan in demo mode.', newTasks: [], acceptTaskIds: [], cancelTaskIds: [], questions: [] };
      return { status: 'succeeded', structuredOutput: plan, resultText: plan.summary };
    }

    if (spec.role === 'reviewer') {
      await work(ctl, 1200 * k, 'Reviewing the diff and re-running the checks…');
      return {
        status: 'succeeded',
        structuredOutput: { verdict: 'approve', risk: 'low', summary: 'Small, focused change; acceptance criteria met.', findings: [] },
      };
    }

    // builder
    const title = /# Task (T-\d+): (.*)/.exec(spec.prompt)?.[2] ?? 'task';
    const answered = /ANSWERED: ([^\n—]+)/.exec(spec.prompt)?.[1]?.trim();
    await work(ctl, 1500 * k, `Working on "${title}"…`);
    let files: [string, string][] = [];
    if (title.startsWith('Pick a tone')) {
      if (!answered) {
        const r = await callTool(opts.apiUrl, spec, 'request_decision', {
          question: 'Which tone should the welcome message use?',
          why: 'It is the first thing every new user reads.',
          options: [
            { id: 'warm', label: 'Warm and encouraging', tradeoff: 'Friendly, slightly longer' },
            { id: 'brief', label: 'Brief and practical', tradeoff: 'Fast to read, less personality' },
            { id: 'playful', label: 'Playful', tradeoff: 'Memorable, may not suit everyone' },
          ],
          recommendation: 'warm',
          recommendationReason: 'Matches the motivational goal in the documents.',
          blocking: true,
          blockedSummary: 'The welcome text waits for this.',
          continuesSummary: 'README and the greeting module keep going.',
        });
        return {
          status: 'succeeded',
          structuredOutput: { status: 'needs_decision', summary: `Asked ${r.decisionId} about the tone.`, changes: [], testsRun: [], acceptance: [], limitations: [], followUps: [] },
        };
      }
      files = [['docs/welcome.md', `# Welcome\n\nTone: ${answered}.\n\nGood to see you! Small steps add up.\n`]];
    } else if (title.startsWith('Write the project README')) {
      files = [['README.md', '# Demo project\n\nBuilt by StayOn Autopilot demo agents.\n\nRun: `node src/greeting/index.js`\n']];
    } else if (title.startsWith('Add a greeting module')) {
      files = [['src/greeting/index.js', "export function greet(name) {\n  return `Hello, ${name}! Nice to see you.`;\n}\n"]];
    } else if (title.startsWith('Add a package manifest')) {
      files = [['package.json', '{\n  "name": "demo-project",\n  "private": true,\n  "scripts": { "test": "node -e \\"console.log(\'ok\')\\"" }\n}\n']];
    } else {
      files = [[`notes/${(spec.env.AUTOPILOT_TASK_ID || 'task').toLowerCase()}.md`, `# ${title}\n\nDone in demo mode.\n`]];
    }
    for (const [path, content] of files) await commitFile(ctl, path, content, `${title}`);
    await work(ctl, 800 * k, 'Running checks…');
    return {
      status: 'succeeded',
      structuredOutput: {
        status: 'completed',
        summary: `Implemented "${title}" (demo).`,
        changes: files.map(([p]) => `Added ${p}`),
        testsRun: [{ command: 'demo check', passed: true }],
        acceptance: [{ criterion: 'Demo acceptance', met: true, evidence: files.map(([p]) => p).join(', ') }],
        limitations: ['Demo agent: no real implementation'],
        followUps: [],
      },
    };
  });
}
