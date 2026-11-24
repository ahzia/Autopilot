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

/** The kinds of secret-looking values in a piece of text, such as a commit message. */
export function secretKinds(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}

/**
 * A path as git prints it in a diff header: as is, or C-quoted when it holds unusual bytes (any
 * non-ASCII byte, with the default core.quotePath), e.g. "b/caf\303\251/.env".
 */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes: number[] = [];
  for (const m of path.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/gs)) {
    if (m[2] !== undefined) bytes.push(...Buffer.from(m[2], 'utf8'));
    else if (/^[0-7]{3}$/.test(m[1])) bytes.push(parseInt(m[1], 8));
    else bytes.push(escapes[m[1]] ?? m[1].charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Secret-looking values on the added lines of a unified diff (or of `git log -p`
 * output). A cheap guard before anything is published or merged; not a
 * replacement for a real scanner.
 *
 * "--- " and "+++ " are file names only in a file's header, between its "diff "
 * line and its first hunk ("@@"). Inside a hunk every line starts with its
 * change marker, so "+++ x" there is the added line "++ x".
 *
 * A merge commit's combined diff (`diff --cc`, hunk headers with one "@" per
 * parent plus one) has a marker column per parent. A line is added only when
 * every column is "+": a line missing from just some parents is already in
 * another one.
 */
export function findSecrets(patch: string): { file: string; kind: string }[] {
  const out: { file: string; kind: string }[] = [];
  let file = '';
  let inHeader = true;
  let added = '+'; // the markers of an added line in the current hunk
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff ')) {
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      added = '+'.repeat(/^@+/.exec(line)![0].length - 1);
      continue;
    }
    if (inHeader) {
      // A file's new name: "+++ b/<path>", or "rename to <path>" / "copy to <path>", the only
      // name a rename or copy without content changes has (`git log -M`/`-C` print no "+++"),
      // C-quoted when it holds unusual bytes.
      const name = /^(\+\+\+ |rename to |copy to )(.*)$/.exec(line);
      if (name) {
        file = unquoteGitPath(name[2].trim());
        if (name[1] === '+++ ') file = file.replace(/^b\//, '');
        // Any case: on a case-insensitive file system .ENV is the same file as .env.
        if (/(^|\/)\.env(\.|$)(?!example|sample|template)/i.test(file)) out.push({ file, kind: 'environment file' });
      }
      continue;
    }
    if (!line.startsWith(added)) continue;
    for (const kind of secretKinds(line.slice(added.length))) out.push({ file, kind });
  }
  // One finding per file and kind, in order (a Set: a scan can cover up to 32 MiB of changes).
  const seen = new Set<string>();
  return out.filter((x) => {
    const key = `${x.file}\0${x.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
