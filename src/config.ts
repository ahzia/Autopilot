// SPDX-License-Identifier: MIT
// Project policy: schema, defaults and fail-closed validation.
// A config that does not validate is never used; unknown keys are errors.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Profile } from './types.ts';

export const PROFILES: readonly Profile[] = ['supervised', 'balanced_autopilot', 'integration_only', 'pause'];
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface CheckCommand {
  name: string;
  run: string[];
  timeoutSeconds: number;
}

export interface ProjectConfig {
  version: 1;
  id: string;
  name: string;
  profile: Profile;
  repo: {
    /** Local path or git URL the autopilot clones into its own private working clone. */
    source: string;
    targetBranch: string;
    branchPrefix: string;
    forge: 'local' | 'github';
    /** "owner/name" when forge is github. */
    github: string | null;
    /** Local forge only: branch in the source repo that receives integrated commits; null keeps them in the private clone. */
    pushIntegratedTo: string | null;
  };
  /** Founder documents the planner reads (absolute after loading). */
  docs: string[];
  /** Exploration charter / standing instructions for the planner and builders. */
  charter: string;
  execution: {
    runner: 'claude-cli' | 'fake';
    claudeBin: string;
    model: string | null;
    plannerModel: string | null;
    reviewerModel: string | null;
    effort: (typeof EFFORTS)[number] | null;
    permissionMode: (typeof PERMISSION_MODES)[number];
    /** Ask Claude Code to sandbox Bash (filesystem/network) for builder runs. */
    sandbox: boolean;
    /** Setting sources for workers (e.g. ["project","local"]); null = Claude Code default. */
    settingSources: string[] | null;
    allowedTools: string[];
    disallowedTools: string[];
    maxBuilders: number;
    maxReviewers: number;
    maxTurns: number;
    runTimeoutMinutes: number;
    idleTimeoutMinutes: number;
    maxRepairCycles: number;
    maxAttempts: number;
  };
  planner: {
    enabled: boolean;
    /** Plan more work when ready + active tasks fall below this. */
    minQueue: number;
    /** Never keep more than this many ready tasks. */
    maxQueue: number;
    cooldownMinutes: number;
    maxTasksPerPlan: number;
  };
  checks: {
    /** Commands run once in every new worktree (e.g. ["npm","ci"]). */
    setup: string[][];
    /** Deterministic gate run by the supervisor, never by the model. */
    commands: CheckCommand[];
  };
  integration: {
    strategy: 'squash' | 'merge';
    /** Merge eligible low-risk work without a human click (only in balanced_autopilot / integration_only). */
    autoMerge: boolean;
    requireAgentReview: boolean;
    /** Changes here are never auto-merged; they become review cards. */
    sensitivePaths: string[];
    /** Builders may not change these at all; such branches are rejected. */
    protectedPaths: string[];
    /** When non-empty, auto-merge only applies inside these globs. */
    allowedPaths: string[];
    maxAutoMergeLines: number;
    maxOpenPrs: number;
  };
  inbox: {
    /** Above this many pending decisions, new builder dispatch slows down. */
    maxPendingDecisions: number;
    ntfyUrl: string | null;
    ntfyTopic: string | null;
    /** Base URL the phone uses (e.g. a tailnet https URL), used in notification links. */
    publicUrl: string | null;
  };
  feedback: {
    pollSeconds: number;
    /** GitHub logins whose comments may request changes. */
    trustedActors: string[];
  };
}

export const DEFAULT_SENSITIVE_PATHS = [
  '.github/**',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/secrets/**',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/migrations/**',
  '**/supabase/**',
  '**/*.sql',
  '**/auth/**',
  '**/payments/**',
  '**/billing/**',
  '**/Dockerfile',
  '**/docker-compose*.yml',
  '**/vercel.json',
  '**/eas.json',
  '**/firebase.json',
  '**/*.rules',
  'CLAUDE.md',
  '**/CLAUDE.md',
  '.claude/**',
];

export const DEFAULT_PROTECTED_PATHS = ['.autopilot/**', '.claude/settings.json', '.claude/settings.local.json'];

export const DEFAULT_DISALLOWED_TOOLS = [
  'Bash(git push:*)',
  'Bash(git push)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh repo delete:*)',
  'Bash(rm -rf /:*)',
];

export function defaultConfig(id: string, name: string, source: string): ProjectConfig {
  return {
    version: 1,
    id,
    name,
    profile: 'balanced_autopilot',
    repo: {
      source,
      targetBranch: 'main',
      branchPrefix: 'autopilot/',
      forge: 'local',
      github: null,
      pushIntegratedTo: null,
    },
    docs: [],
    charter: '',
    execution: {
      runner: 'claude-cli',
      claudeBin: 'claude',
      // Pinned so a changed CLI default can never move work to a model with separate limits.
      model: 'opus',
      plannerModel: null,
      reviewerModel: null,
      effort: null,
      permissionMode: 'auto',
      sandbox: false,
      // Only the founder's own settings: a branch's .claude/settings.json (hooks, env,
      // apiKeyHelper) must never apply to unattended runs.
      settingSources: ['user'],
      allowedTools: [],
      disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
      maxBuilders: 2,
      maxReviewers: 1,
      maxTurns: 120,
      runTimeoutMinutes: 45,
      idleTimeoutMinutes: 10,
      maxRepairCycles: 2,
      maxAttempts: 4,
    },
    planner: {
      enabled: true,
      minQueue: 2,
      maxQueue: 6,
      cooldownMinutes: 10,
      maxTasksPerPlan: 5,
    },
    checks: { setup: [], commands: [] },
    integration: {
      strategy: 'squash',
      autoMerge: true,
      requireAgentReview: true,
      sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      allowedPaths: [],
      maxAutoMergeLines: 1500,
      maxOpenPrs: 3,
    },
    inbox: { maxPendingDecisions: 8, ntfyUrl: null, ntfyTopic: null, publicUrl: null },
    feedback: { pollSeconds: 60, trustedActors: [] },
  };
}

// ------------------------------------------------------------ validation

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid autopilot config:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;

class V {
  problems: string[] = [];
  isObj(v: unknown): v is Obj {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  obj(parent: Obj, key: string, path: string, required = true): Obj {
    const v = parent[key];
    if (v === undefined && !required) return {};
    if (!this.isObj(v)) {
      this.problems.push(`${path}${key} must be an object`);
      return {};
    }
    return v;
  }
  unknownKeys(o: Obj, allowed: string[], path: string): void {
    for (const k of Object.keys(o)) {
      if (k === '$schema' && path === '') continue;
      if (!allowed.includes(k)) this.problems.push(`${path}${k} is not a known setting`);
    }
  }
  str(o: Obj, key: string, path: string, def?: string | null, opts: { pattern?: RegExp; nullable?: boolean; oneOf?: readonly string[] } = {}): any {
    const v = o[key];
    if (v === undefined) {
      if (def !== undefined) return def;
      this.problems.push(`${path}${key} is required`);
      return '';
    }
    if (v === null && opts.nullable) return null;
    if (typeof v !== 'string') {
      this.problems.push(`${path}${key} must be a string${opts.nullable ? ' or null' : ''}`);
      return def ?? '';
    }
    if (opts.oneOf && !opts.oneOf.includes(v)) this.problems.push(`${path}${key} must be one of ${opts.oneOf.join(', ')} (got "${v}")`);
    if (opts.pattern && !opts.pattern.test(v)) this.problems.push(`${path}${key} has an invalid format ("${v}")`);
    return v;
  }
  num(o: Obj, key: string, path: string, def: number, min: number, max: number): number {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      this.problems.push(`${path}${key} must be an integer`);
      return def;
    }
    if (v < min || v > max) this.problems.push(`${path}${key} must be between ${min} and ${max} (got ${v})`);
    return v;
  }
  bool(o: Obj, key: string, path: string, def: boolean): boolean {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      this.problems.push(`${path}${key} must be true or false`);
      return def;
    }
    return v;
  }
  strs(o: Obj, key: string, path: string, def: string[] | null, nullable = false): any {
    const v = o[key];
    if (v === undefined) return def === null ? null : [...def];
    if (v === null && nullable) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.problems.push(`${path}${key} must be a list of strings`);
      return def === null ? null : [...def];
    }
    return [...v];
  }
  argvs(o: Obj, key: string, path: string): string[][] {
    const v = o[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((a) => !Array.isArray(a) || a.length === 0 || a.some((x) => typeof x !== 'string'))) {
      this.problems.push(`${path}${key} must be a list of commands, each a non-empty list of strings (e.g. [["npm","ci"]])`);
      return [];
    }
    return v.map((a) => [...a]);
  }
}

/** Validate a raw parsed config. Throws ConfigError listing every problem. */
export function validateConfig(raw: unknown, baseDir = process.cwd()): ProjectConfig {
  const v = new V();
  if (!v.isObj(raw)) throw new ConfigError(['config must be a JSON object']);
  v.unknownKeys(raw, ['version', 'id', 'name', 'profile', 'repo', 'docs', 'charter', 'execution', 'planner', 'checks', 'integration', 'inbox', 'feedback'], '');
  if (raw.version !== 1) v.problems.push('version must be 1');
  const id = v.str(raw, 'id', '', undefined, { pattern: /^[a-z0-9][a-z0-9-]{1,39}$/ });
  const name = v.str(raw, 'name', '', id);
  const profile = v.str(raw, 'profile', '', 'balanced_autopilot', { oneOf: PROFILES }) as Profile;
  const d = defaultConfig(id, name, '');

  const repo = v.obj(raw, 'repo', '');
  v.unknownKeys(repo, ['source', 'targetBranch', 'branchPrefix', 'forge', 'github', 'pushIntegratedTo'], 'repo.');
  const branchRe = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,100}$/;
  const forge = v.str(repo, 'forge', 'repo.', 'local', { oneOf: ['local', 'github'] }) as 'local' | 'github';
  let source = v.str(repo, 'source', 'repo.');
  if (source && !/^[a-z]+:\/\//.test(source) && !/^git@/.test(source) && !isAbsolute(source)) source = resolve(baseDir, source);
  const cfgRepo = {
    source,
    targetBranch: v.str(repo, 'targetBranch', 'repo.', 'main', { pattern: branchRe }),
    branchPrefix: v.str(repo, 'branchPrefix', 'repo.', 'autopilot/', { pattern: /^[A-Za-z0-9._\/-]{1,40}$/ }),
    forge,
    github: v.str(repo, 'github', 'repo.', null, { nullable: true, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ }),
    pushIntegratedTo: v.str(repo, 'pushIntegratedTo', 'repo.', null, { nullable: true, pattern: branchRe }),
  };
  if (forge === 'github' && !cfgRepo.github) v.problems.push('repo.github ("owner/name") is required when repo.forge is "github"');
  if (cfgRepo.pushIntegratedTo && cfgRepo.pushIntegratedTo === cfgRepo.targetBranch) {
    v.problems.push('repo.pushIntegratedTo must differ from repo.targetBranch (git refuses to update a checked-out branch)');
  }

  const docs = (v.strs(raw, 'docs', '', []) as string[]).map((p) => (isAbsolute(p) ? p : resolve(baseDir, p)));
  const charter = v.str(raw, 'charter', '', '');

  const ex = v.obj(raw, 'execution', '', false);
  v.unknownKeys(ex, Object.keys(d.execution), 'execution.');
  const execution: ProjectConfig['execution'] = {
    runner: v.str(ex, 'runner', 'execution.', d.execution.runner, { oneOf: ['claude-cli', 'fake'] }),
    claudeBin: v.str(ex, 'claudeBin', 'execution.', d.execution.claudeBin),
    model: v.str(ex, 'model', 'execution.', d.execution.model, { nullable: true }),
    plannerModel: v.str(ex, 'plannerModel', 'execution.', null, { nullable: true }),
    reviewerModel: v.str(ex, 'reviewerModel', 'execution.', null, { nullable: true }),
    effort: v.str(ex, 'effort', 'execution.', null, { nullable: true, oneOf: EFFORTS }),
    permissionMode: v.str(ex, 'permissionMode', 'execution.', d.execution.permissionMode, { oneOf: PERMISSION_MODES }),
    sandbox: v.bool(ex, 'sandbox', 'execution.', d.execution.sandbox),
    settingSources: v.strs(ex, 'settingSources', 'execution.', d.execution.settingSources, true),
    allowedTools: v.strs(ex, 'allowedTools', 'execution.', d.execution.allowedTools),
    disallowedTools: v.strs(ex, 'disallowedTools', 'execution.', d.execution.disallowedTools),
    maxBuilders: v.num(ex, 'maxBuilders', 'execution.', d.execution.maxBuilders, 0, 8),
    maxReviewers: v.num(ex, 'maxReviewers', 'execution.', d.execution.maxReviewers, 0, 4),
    maxTurns: v.num(ex, 'maxTurns', 'execution.', d.execution.maxTurns, 1, 1000),
    runTimeoutMinutes: v.num(ex, 'runTimeoutMinutes', 'execution.', d.execution.runTimeoutMinutes, 1, 600),
    idleTimeoutMinutes: v.num(ex, 'idleTimeoutMinutes', 'execution.', d.execution.idleTimeoutMinutes, 1, 120),
    maxRepairCycles: v.num(ex, 'maxRepairCycles', 'execution.', d.execution.maxRepairCycles, 0, 10),
    maxAttempts: v.num(ex, 'maxAttempts', 'execution.', d.execution.maxAttempts, 1, 20),
  };
  if (execution.settingSources && execution.settingSources.some((s) => !['user', 'project', 'local'].includes(s))) {
    v.problems.push('execution.settingSources entries must be "user", "project" or "local"');
  }
  if (execution.permissionMode === 'bypassPermissions' && !execution.sandbox) {
    v.problems.push('execution.permissionMode "bypassPermissions" requires execution.sandbox = true');
  }

  const pl = v.obj(raw, 'planner', '', false);
  v.unknownKeys(pl, Object.keys(d.planner), 'planner.');
  const planner: ProjectConfig['planner'] = {
    enabled: v.bool(pl, 'enabled', 'planner.', d.planner.enabled),
    minQueue: v.num(pl, 'minQueue', 'planner.', d.planner.minQueue, 0, 50),
    maxQueue: v.num(pl, 'maxQueue', 'planner.', d.planner.maxQueue, 1, 100),
    cooldownMinutes: v.num(pl, 'cooldownMinutes', 'planner.', d.planner.cooldownMinutes, 0, 1440),
    maxTasksPerPlan: v.num(pl, 'maxTasksPerPlan', 'planner.', d.planner.maxTasksPerPlan, 1, 30),
  };
  if (planner.minQueue > planner.maxQueue) v.problems.push('planner.minQueue must not exceed planner.maxQueue');

  const ch = v.obj(raw, 'checks', '', false);
  v.unknownKeys(ch, ['setup', 'commands'], 'checks.');
  const commands: CheckCommand[] = [];
  if (ch.commands !== undefined) {
    if (!Array.isArray(ch.commands)) v.problems.push('checks.commands must be a list');
    else
      ch.commands.forEach((c, i) => {
        if (!v.isObj(c)) return void v.problems.push(`checks.commands[${i}] must be an object`);
        v.unknownKeys(c, ['name', 'run', 'timeoutSeconds'], `checks.commands[${i}].`);
        const run = c.run;
        if (!Array.isArray(run) || run.length === 0 || run.some((x) => typeof x !== 'string')) {
          v.problems.push(`checks.commands[${i}].run must be a non-empty list of strings`);
        }
        commands.push({
          name: v.str(c, 'name', `checks.commands[${i}].`, undefined, { pattern: /^[A-Za-z0-9 ._:-]{1,40}$/ }),
          run: Array.isArray(run) ? (run as string[]).map(String) : [],
          timeoutSeconds: v.num(c, 'timeoutSeconds', `checks.commands[${i}].`, 900, 5, 7200),
        });
      });
  }
  const checks = { setup: v.argvs(ch, 'setup', 'checks.'), commands };

  const ig = v.obj(raw, 'integration', '', false);
  v.unknownKeys(ig, Object.keys(d.integration), 'integration.');
  const integration: ProjectConfig['integration'] = {
    strategy: v.str(ig, 'strategy', 'integration.', d.integration.strategy, { oneOf: ['squash', 'merge'] }),
    autoMerge: v.bool(ig, 'autoMerge', 'integration.', d.integration.autoMerge),
    requireAgentReview: v.bool(ig, 'requireAgentReview', 'integration.', d.integration.requireAgentReview),
    sensitivePaths: v.strs(ig, 'sensitivePaths', 'integration.', d.integration.sensitivePaths),
    protectedPaths: v.strs(ig, 'protectedPaths', 'integration.', d.integration.protectedPaths),
    allowedPaths: v.strs(ig, 'allowedPaths', 'integration.', d.integration.allowedPaths),
    maxAutoMergeLines: v.num(ig, 'maxAutoMergeLines', 'integration.', d.integration.maxAutoMergeLines, 0, 100000),
    maxOpenPrs: v.num(ig, 'maxOpenPrs', 'integration.', d.integration.maxOpenPrs, 1, 50),
  };
  for (const p of DEFAULT_PROTECTED_PATHS.slice(0, 1)) {
    if (!integration.protectedPaths.includes(p)) v.problems.push(`integration.protectedPaths must keep "${p}" (policy files are not editable by builders)`);
  }

  const ib = v.obj(raw, 'inbox', '', false);
  v.unknownKeys(ib, Object.keys(d.inbox), 'inbox.');
  const inbox: ProjectConfig['inbox'] = {
    maxPendingDecisions: v.num(ib, 'maxPendingDecisions', 'inbox.', d.inbox.maxPendingDecisions, 1, 200),
    ntfyUrl: v.str(ib, 'ntfyUrl', 'inbox.', null, { nullable: true, pattern: /^https?:\/\/[^\s]+$/ }),
    ntfyTopic: v.str(ib, 'ntfyTopic', 'inbox.', null, { nullable: true, pattern: /^[A-Za-z0-9_-]{8,64}$/ }),
    publicUrl: v.str(ib, 'publicUrl', 'inbox.', null, { nullable: true, pattern: /^https?:\/\/[^\s]+$/ }),
  };

  const fb = v.obj(raw, 'feedback', '', false);
  v.unknownKeys(fb, Object.keys(d.feedback), 'feedback.');
  const feedback: ProjectConfig['feedback'] = {
    pollSeconds: v.num(fb, 'pollSeconds', 'feedback.', d.feedback.pollSeconds, 15, 3600),
    trustedActors: v.strs(fb, 'trustedActors', 'feedback.', d.feedback.trustedActors),
  };

  if (profile === 'integration_only' && ['main', 'master', 'production', 'prod'].includes(cfgRepo.targetBranch)) {
    v.problems.push('profile "integration_only" needs a non-production repo.targetBranch (e.g. "autopilot/integration")');
  }

  if (v.problems.length) throw new ConfigError(v.problems);
  return { version: 1, id, name, profile, repo: cfgRepo, docs, charter, execution, planner, checks, integration, inbox, feedback };
}

export function loadConfigFile(path: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError([`cannot read ${path}: ${(err as Error).message}`]);
  }
  return validateConfig(raw, dirname(path));
}

/** Whether this profile may merge without a human click at all. */
export function profileAllowsAutoMerge(cfg: ProjectConfig): boolean {
  return (cfg.profile === 'balanced_autopilot' || cfg.profile === 'integration_only') && cfg.integration.autoMerge;
}

export function profileAllowsDispatch(cfg: ProjectConfig): boolean {
  return cfg.profile !== 'pause';
}

/** Stable hash stored with each policy version so runs can be attributed to the policy in force. */
export function configHash(cfg: ProjectConfig): string {
  return createHash('sha256').update(stableStringify(cfg)).digest('hex').slice(0, 16);
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Obj)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
