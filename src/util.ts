// SPDX-License-Identifier: MIT
// Small shared helpers. Keep this file dependency-free.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** URL-safe random secret (default 32 bytes of entropy). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const uuid = (): string => randomUUID();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "Add onboarding flow!" -> "add-onboarding-flow" (max 40 chars). */
export function slugify(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'task';
}

/** Remove obvious secrets from text that may be shown in the inbox or logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…[redacted]')
    .replace(/\b(sk-[A-Za-z0-9]{4})[A-Za-z0-9_-]{16,}/g, '$1…[redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]{20,}/g, '$1…[redacted]')
    .replace(/\b(github_pat_[A-Za-z0-9]{4})[A-Za-z0-9_]{20,}/g, '$1…[redacted]')
    .replace(/\b(AKIA[A-Z0-9]{4})[A-Z0-9]{12}\b/g, '$1…[redacted]')
    .replace(/\b(xox[abpr]-[A-Za-z0-9]{4})[A-Za-z0-9-]{10,}/g, '$1…[redacted]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)["']?[^\s"']{6,}/gi, '$1[redacted]');
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe secret key', /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ['Supabase service role key', /service_role[^\n]{0,40}eyJ[A-Za-z0-9_-]{20,}/],
];

/**
 * Secret-looking values on the added lines of a unified diff. A cheap guard
 * before anything is published or merged; not a replacement for a real scanner.
 */
export function findSecrets(patch: string): { file: string; kind: string }[] {
  const out: { file: string; kind: string }[] = [];
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '').trim();
      if (/(^|\/)\.env(\.|$)(?!example|sample|template)/.test(file)) out.push({ file, kind: 'environment file' });
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) out.push({ file, kind });
  }
  return out.filter((x, i) => out.findIndex((y) => y.file === x.file && y.kind === x.kind) === i);
}

/** Untracked files the supervisor must never auto-commit on a builder's behalf. */
export const NEVER_AUTO_COMMIT = /(^|\/)(\.env(?!\.example|\.sample|\.template)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa)[^/]*|credentials[^/]*|secrets?\/.*)$/i;

/**
 * Environment for commands the supervisor runs over builder-controlled files
 * (git in worktrees, checks): no Claude/GitHub/cloud credentials, no git prompts,
 * and git ignores replace refs and grafts (refs/replace/*, info/grafts, which workers
 * can write), as with FORCED_GIT_ENV in git/git.ts.
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|AWS_|GOOGLE_APPLICATION_CREDENTIALS|AZURE_)/.test(k)) continue;
    if (['CLAUDECODE', 'CLAUDE_PID', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK'].includes(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_GRAFT_FILE = '/dev/null/no-grafts'; // a file that cannot exist: no grafts, and no hint
  return env;
}

/**
 * git flags that stop repository-controlled hooks and helpers from running, and keep replace refs
 * off even where the repository's config switches them on (see HARDENING_CONFIG in git/git.ts).
 */
export const SAFE_GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.ext.allow=never', '-c', 'core.useReplaceRefs=false'];

/** Keep the last `max` characters of a string, cut at a line boundary when possible. */
export function tail(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf('\n');
  return (nl > 0 && nl < 200 ? cut.slice(nl + 1) : cut);
}
