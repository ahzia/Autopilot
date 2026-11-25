#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// SPDX-License-Identifier: MIT
// StayOn Autopilot command line.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, defaultConfig, loadConfigFile, validateConfig, type ProjectConfig } from '../src/config.ts';
import { gitEnv } from '../src/git/git.ts';
import { resolveHome, readServerSettings, type Home } from '../src/home.ts';
import { Store } from '../src/store.ts';
import type { Decision, SupervisorActions, TaskState } from '../src/types.ts';
import { randomToken } from '../src/util.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `StayOn Autopilot — parallel Claude Code workers with a phone decision inbox.

Usage: autopilot <command> [options]

Setup
  init <id> --source <repo> [--create] [--name N] [--docs a.md,b.md] [--forge local|github --github owner/name]
       [--target main] [--profile balanced_autopilot] [--check "name=cmd args"]... [--setup "npm ci"]...
       [--charter "..."] [--runner claude-cli|fake]
                          Create a project config in the autopilot home (--create makes a new repo)
  doctor                  Check Claude login, git, gh, configs and the inbox server
  pair                    Print a one-time link that signs your phone into the inbox

Run
  run [--port 4777] [--host 127.0.0.1] [--accept-config]
                          Start the supervisor and the inbox (stays in the foreground)
  service install|uninstall|status [--dry-run]
                          Keep the supervisor running in the background (macOS LaunchAgent,
                          restarts on crash, keeps the Mac awake while it runs)
  status                  Projects, task counts, active runs, pending decisions
  pause [project] [--reason R] / resume [project]
                          Stop or allow new work (everything, or one project)

Work
  task add <project> "<title>" [--objective O] [--criteria C]... [--paths G]... [--priority 1-5]
  task list [project] | task show <id> | task retry <id> | task cancel <id>
  decisions [project]     List pending decision cards
  answer <D-id> [option] [--comment "..."]
                          Answer a card from the terminal
  logs <run-id>           Show what a run did

Options: --home <dir> (default ~/.stayon-autopilot or $AUTOPILOT_HOME)
`;

function fail(msg: string): never {
  process.stderr.write(`autopilot: ${msg}\n`);
  process.exit(1);
}

function openStore(home: Home): Store {
  mkdirSync(home.root, { recursive: true, mode: 0o700 });
  return Store.open(home.dbPath);
}

/** Read and validate every project config under <home>/projects/<id>/config.json. */
export function loadProjectConfigs(home: Home): { configs: ProjectConfig[]; errors: { id: string; message: string }[] } {
  const configs: ProjectConfig[] = [];
  const errors: { id: string; message: string }[] = [];
  if (!existsSync(home.projectsDir)) return { configs, errors };
  for (const id of readdirSync(home.projectsDir)) {
    const path = home.configPath(id);
    if (!existsSync(path)) continue;
    try {
      const cfg = loadConfigFile(path);
      if (cfg.id !== id) throw new ConfigError([`config id "${cfg.id}" must match its folder name "${id}"`]);
      configs.push(cfg);
    } catch (err) {
      errors.push({ id, message: err instanceof ConfigError ? err.problems.join('; ') : (err as Error).message });
    }
  }
  return { configs, errors };
}

/**
 * Optional long-lived subscription token from `claude setup-token`, stored by the
 * founder in <home>/claude-oauth-token (mode 0600). Workers then avoid keychain
 * refresh contention between parallel sessions. The value is never printed.
 */
function loadClaudeToken(home: Home): 'env' | 'file' | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'env';
  const file = join(home.root, 'claude-oauth-token');
  if (!existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) process.stderr.write(`autopilot: warning: ${file} is readable by others; run chmod 600 on it\n`);
  const token = readFileSync(file, 'utf8').trim();
  if (!token) return null;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return 'file';
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(process.env.HOME ?? '', p.slice(1)) : p);

/**
 * `--check "test=npm test"` or `--check "npm test"`. Only a plain word before the first
 * '=' is a name, so commands that contain '=' themselves (node -e x=1) stay intact.
 */
export function parseCheckFlag(c: string): { name: string; run: string[]; timeoutSeconds: number } {
  const m = /^([A-Za-z0-9._:-]{1,40})=(.+)$/.exec(c.trim());
  const cmd = (m ? m[2] : c).trim().split(/\s+/);
  return { name: m ? m[1] : cmd[0], run: cmd, timeoutSeconds: 900 };
}

/** Environment for child `claude`/`gh` checks, without variables of an enclosing Claude session. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN')) delete env[k];
  }
  return env;
}

// ---------------------------------------------------------------- commands

async function cmdInit(home: Home, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      name: { type: 'string' },
      docs: { type: 'string', multiple: true },
      forge: { type: 'string' },
      github: { type: 'string' },
      target: { type: 'string' },
      profile: { type: 'string' },
      check: { type: 'string', multiple: true },
      setup: { type: 'string', multiple: true },
      charter: { type: 'string' },
      runner: { type: 'string' },
      force: { type: 'boolean' },
      create: { type: 'boolean' },
      home: { type: 'string' },
    },
  });
  const id = positionals[0];
  if (!id) fail('init needs a project id, e.g. autopilot init my-app --source ~/code/my-app');
  if (!values.source) fail('init needs --source <git repo path or URL>');
  const path = home.configPath(id);
  if (existsSync(path) && !values.force) fail(`${path} exists (use --force to overwrite)`);
  const source = /^[a-z]+:\/\//.test(values.source) || values.source.startsWith('git@') ? values.source : resolve(expandHome(values.source));
  if (values.create) {
    // Brand-new project: create a repository with one commit so worktrees have a base.
    if (/^[a-z]+:\/\//.test(source) || source.startsWith('git@')) fail('--create only works with a local path');
    if (existsSync(join(source, '.git'))) fail(`${source} is already a git repository (drop --create)`);
    mkdirSync(source, { recursive: true });
    const g = (...a: string[]) => execFileSync('git', a, { cwd: source, stdio: 'ignore', env: gitEnv() }); // no GIT_DIR & co. from a calling hook
    g('init', '-q', '-b', values.target ?? 'main');
    writeFileSync(join(source, 'README.md'), `# ${values.name ?? id}\n\nBuilt with StayOn Autopilot.\n`);
    writeFileSync(join(source, '.gitignore'), 'node_modules/\n.env*\n!.env.example\ndist/\n.expo/\ncoverage/\n');
    g('add', '.');
    g('-c', 'user.name=StayOn Autopilot', '-c', 'user.email=autopilot@localhost', 'commit', '-q', '-m', 'Initial commit');
    process.stdout.write(`Created repository ${source}\n`);
  }
  const cfg = defaultConfig(id, values.name ?? id, source);
  if (values.docs) {
    cfg.docs = values.docs
      .flatMap((d) => d.split(','))
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => resolve(expandHome(d)));
  }
  if (values.forge) cfg.repo.forge = values.forge as 'local' | 'github';
  if (values.github) cfg.repo.github = values.github;
  if (values.target) cfg.repo.targetBranch = values.target;
  if (values.profile) cfg.profile = values.profile as ProjectConfig['profile'];
  if (values.charter) cfg.charter = values.charter;
  if (values.runner) cfg.execution.runner = values.runner as 'claude-cli' | 'fake';
  // Sensible defaults for Node projects (scripts that exist, and an install step).
  if (!/^[a-z]+:\/\//.test(source) && existsSync(join(source, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      for (const s of ['typecheck', 'lint', 'test']) {
        if (pkg.scripts?.[s]) cfg.checks.commands.push({ name: s, run: ['npm', 'run', s], timeoutSeconds: 900 });
      }
      cfg.checks.setup = [existsSync(join(source, 'package-lock.json')) ? ['npm', 'ci'] : ['npm', 'install']];
    } catch {
      /* ignore */
    }
  }
  if (values.check?.length) cfg.checks.commands = values.check.map(parseCheckFlag);
  if (values.setup?.length) cfg.checks.setup = values.setup.map((s) => s.trim().split(/\s+/));
  let validated: ProjectConfig;
  try {
    validated = validateConfig(JSON.parse(JSON.stringify(cfg)), dirname(path));
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : String(err));
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ $schema: 'autopilot-project-v1', ...validated }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Created ${path}
Profile: ${validated.profile} · forge: ${validated.repo.forge} · target: ${validated.repo.targetBranch}
Checks: ${validated.checks.commands.map((c) => c.name).join(', ') || '(none — add some so merges are verified)'}
Docs: ${validated.docs.length} file(s)

Next:
  autopilot doctor
  autopilot run
  autopilot pair      # sign your phone into the inbox
`);
}

function check(label: string, ok: boolean | null, detail: string): void {
  const mark = ok === null ? '•' : ok ? '✓' : '✗';
  process.stdout.write(`${mark} ${label}${detail ? ` — ${detail}` : ''}\n`);
}

async function cmdDoctor(home: Home): Promise<void> {
  const tokenSource = loadClaudeToken(home);
  const env = cleanEnv();
  const major = Number(process.versions.node.split('.')[0]);
  check('Node.js', major >= 24, `v${process.versions.node}${major < 24 ? ' (needs 24+)' : ''}`);
  const gitV = spawnSync('git', ['--version'], { encoding: 'utf8' });
  check('git', gitV.status === 0, gitV.stdout.trim());
  const { configs, errors } = loadProjectConfigs(home);
  const claudeBins = new Set(configs.map((c) => c.execution.claudeBin).concat(['claude']));
  for (const bin of claudeBins) {
    const v = spawnSync(bin, ['--version'], { encoding: 'utf8', env });
    check(`Claude Code (${bin})`, v.status === 0, v.status === 0 ? v.stdout.trim() : 'not found');
    if (v.status !== 0) continue;
    const minor = Number(/2\.1\.(\d+)/.exec(v.stdout)?.[1] ?? '0');
    if (minor && minor < 302) check('  version', false, 'autopilot is tested with 2.1.302+ (run `claude update`)');
    else if (minor && minor < 330) check('  version', null, 'consider `claude update` (newer builds add /ship, /steward and better headless controls)');
    if (tokenSource) check('  subscription token', true, tokenSource === 'file' ? `from ${join(home.root, 'claude-oauth-token')}` : 'CLAUDE_CODE_OAUTH_TOKEN is set');
    const s = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', env });
    try {
      const st = JSON.parse(s.stdout);
      const viaToken = !!env.CLAUDE_CODE_OAUTH_TOKEN;
      check(
        'Claude login for unattended runs',
        !!st.loggedIn || viaToken,
        st.loggedIn ? `${st.authMethod}${st.subscriptionType ? ` (${st.subscriptionType})` : ''}` : viaToken ? 'CLAUDE_CODE_OAUTH_TOKEN is set' : 'not logged in: run `claude auth login` (or `claude setup-token`)',
      );
    } catch {
      check('Claude login for unattended runs', false, 'could not read `claude auth status`');
    }
  }
  if (env.ANTHROPIC_API_KEY) check('API key in environment', null, 'ANTHROPIC_API_KEY is set; workers strip it so runs use your subscription, never paid API billing');
  if (configs.some((c) => c.repo.forge === 'github')) {
    const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', env });
    check('GitHub CLI login', gh.status === 0, gh.status === 0 ? 'logged in' : 'run `gh auth login`');
  }
  for (const e of errors) check(`project ${e.id}`, false, `invalid config: ${e.message}`);
  for (const c of configs) {
    // gitEnv(): no GIT_DIR & co. from a calling hook, whose config could answer for the source.
    const ls = spawnSync('git', ['ls-remote', '--heads', c.repo.source, c.repo.targetBranch], { encoding: 'utf8', env: gitEnv(), timeout: 20_000 });
    const ok = ls.status === 0 && ls.stdout.includes(`refs/heads/${c.repo.targetBranch}`);
    check(`project ${c.id}`, ok, ok ? `${c.profile}, ${c.repo.forge}, ${c.checks.commands.length} check(s), ${c.docs.length} doc(s)` : `cannot see branch ${c.repo.targetBranch} in ${c.repo.source}`);
    for (const d of c.docs) if (!existsSync(d)) check(`  doc`, false, `missing ${d}`);
    if (!c.checks.commands.length) check('  checks', null, 'no checks configured: merges rely on the agent review only');
  }
  if (!configs.length && !errors.length) check('projects', null, `none yet — autopilot init <id> --source <repo>`);
  const settings = readServerSettings(home);
  try {
    const res = await fetch(`http://127.0.0.1:${settings.port}/api/me`, { signal: AbortSignal.timeout(1500) });
    check('Inbox server', res.ok || res.status === 401, `running on port ${settings.port}`);
  } catch {
    check('Inbox server', null, `not running (start with: autopilot run)`);
  }
  const ts = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (ts.status === 0) check('Phone access', null, `Tailscale found: run \`tailscale serve --bg ${settings.port}\` and set publicUrl in ${home.serverConfigPath}`);
  else check('Phone access', null, 'install Tailscale (or use the same Wi-Fi with --host 0.0.0.0) to reach the inbox from your phone');
}

async function cmdRun(home: Home, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { port: { type: 'string' }, host: { type: 'string' }, 'accept-config': { type: 'boolean' } } });
  const settings = readServerSettings(home);
  const host = values.host ?? settings.host;
  const port = values.port ? Number(values.port) : settings.port;
  loadClaudeToken(home);
  const store = openStore(home);

  const { Supervisor } = await import('../src/supervisor.ts');
  const { AgentApi } = await import('../src/agent-api.ts');
  const { startHttpServer } = await import('../src/http/server.ts');
  const { createPairingCode } = await import('../src/http/auth.ts');
  const { ClaudeCliRunner } = await import('../src/runner/claude-cli.ts');
  const { LocalForge } = await import('../src/git/local-forge.ts');
  const { GitHubForge } = await import('../src/git/github-forge.ts');
  const { CommandCheckRunner } = await import('../src/checks.ts');
  const { makeNotifier } = await import('../src/notify.ts');
  const { MultiNotifier, WebPushNotifier } = await import('../src/push.ts');
  const { demoRunner } = await import('../src/runner/demo.ts');
  const webPush = new WebPushNotifier(store);

  let supervisor: InstanceType<typeof Supervisor> | null = null;
  const actions: SupervisorActions = {
    wake: () => supervisor?.wake(),
    pauseAll: (r) => supervisor?.pauseAll(r),
    resumeAll: (r) => supervisor?.resumeAll(r),
    pauseProject: (id, r) => supervisor?.pauseProject(id, r),
    resumeProject: (id, r) => supervisor?.resumeProject(id, r),
    addTask: (i) => supervisor!.addTask(i),
    retryTask: (id) => supervisor!.retryTask(id),
    cancelTask: (id) => supervisor!.cancelTask(id),
    taskDiff: (id) => (supervisor ? supervisor.taskDiff(id) : Promise.resolve(null)),
  };
  const agentTools = new AgentApi(store, { onChange: () => supervisor?.wake() });
  const http = await startHttpServer({ store, agentTools, actions, staticDir: join(ROOT, 'src', 'inbox'), host, port });
  const apiUrl = `http://127.0.0.1:${http.port}`;
  supervisor = new Supervisor({
    store,
    home,
    apiUrl,
    mcpServerPath: join(ROOT, 'src', 'mcp', 'server.ts'),
    loadConfigs: () => loadProjectConfigs(home),
    acceptDiskConfig: values['accept-config'] === true,
    makeRunner: (cfg) => (cfg.execution.runner === 'fake' ? demoRunner({ apiUrl }) : new ClaudeCliRunner({ claudeBin: cfg.execution.claudeBin })),
    makeForge: (cfg) => {
      const common = {
        source: cfg.repo.source,
        home: home.projectDir(cfg.id),
        targetBranch: cfg.repo.targetBranch,
        branchPrefix: cfg.repo.branchPrefix,
        strategy: cfg.integration.strategy,
        pushIntegratedTo: cfg.repo.pushIntegratedTo,
      };
      return cfg.repo.forge === 'github' ? new GitHubForge({ ...common, repo: cfg.repo.github! }) : new LocalForge(common);
    },
    makeChecks: (cfg) => new CommandCheckRunner(cfg.checks),
    // Phones subscribed through the inbox (Web Push) plus the optional ntfy topic.
    makeNotifier: (cfg) => new MultiNotifier([webPush, makeNotifier({ ...cfg.inbox, publicUrl: cfg.inbox.publicUrl ?? settings.publicUrl })]),
    log: (l) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${l}\n`),
  });
  await supervisor.start();

  const base = settings.publicUrl ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${http.port}`;
  const code = createPairingCode(store);
  process.stdout.write(`StayOn Autopilot running.
  Inbox:        ${base}
  Pair a phone: ${base}/#code=${code}   (valid 10 minutes, single use; \`autopilot pair\` makes a new one)
  Projects:     ${store.listProjects().map((p) => `${p.id}${p.paused ? ' (paused)' : ''}`).join(', ') || 'none — run autopilot init'}
Press Ctrl-C to stop (running workers are stopped; their sessions can be resumed).
`);
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    process.stderr.write(`\n${sig}: stopping workers…\n`);
    await supervisor!.stop();
    await http.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const SERVICE_LABEL = 'com.stayon.autopilot';

function which(bin: string): string | null {
  const r = spawnSync('/usr/bin/which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** LaunchAgent definition: caffeinate keeps the Mac awake only while the supervisor runs. */
export function servicePlist(home: Home, nodePath: string, cliPath: string, pathEnv: string): string {
  const args = ['/usr/bin/caffeinate', '-is', nodePath, '--disable-warning=ExperimentalWarning', cliPath, 'run', '--home', home.root];
  const log = join(home.root, 'logs', 'supervisor.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(home.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>HOME</key><string>${xml(process.env.HOME ?? '')}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function cmdService(home: Home, args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
  const sub = positionals[0] ?? 'status';
  if (process.platform !== 'darwin') fail('service management is macOS-only; use systemd or a terminal multiplexer elsewhere');
  const plistPath = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? ''}`;
  if (sub === 'install') {
    // LaunchAgents do not inherit the shell PATH: include the folders of node, claude, git and gh.
    const dirs = [process.execPath, which('claude'), which('git'), which('gh')].filter((p): p is string => !!p).map((p) => dirname(p));
    const pathEnv = [...new Set([...dirs, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
    // Prefer the stable `node` on PATH (e.g. /opt/homebrew/bin/node) over a versioned Cellar path.
    const nodePath = which('node') ?? process.execPath;
    const plist = servicePlist(home, nodePath, fileURLToPath(import.meta.url), pathEnv);
    if (values['dry-run']) {
      process.stdout.write(plist);
      return;
    }
    mkdirSync(join(home.root, 'logs'), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(plistPath), { recursive: true });
    spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'ignore' }); // replace an older definition
    writeFileSync(plistPath, plist, { mode: 0o644 });
    const r = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' });
    if (r.status !== 0) fail(`launchctl bootstrap failed: ${r.stderr.trim()}`);
    process.stdout.write(`Installed and started ${SERVICE_LABEL}.\n  Definition: ${plistPath}\n  Log: ${join(home.root, 'logs', 'supervisor.log')}\nIt restarts after crashes and at login. Stop it with: autopilot service uninstall\n`);
  } else if (sub === 'uninstall') {
    if (values['dry-run']) {
      process.stdout.write(`Would run: launchctl bootout ${domain}/${SERVICE_LABEL} and remove ${plistPath}\n`);
      return;
    }
    spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'ignore' });
    if (existsSync(plistPath)) rmSync(plistPath);
    process.stdout.write(`Stopped and removed ${SERVICE_LABEL}. Your projects, tasks and decisions are kept in ${home.root}.\n`);
  } else if (sub === 'status') {
    const r = spawnSync('launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { encoding: 'utf8' });
    if (r.status !== 0) process.stdout.write(`${SERVICE_LABEL} is not installed${existsSync(plistPath) ? ' (definition exists but is not loaded)' : ''}.\n`);
    else {
      const state = /state = (\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
      const pid = /pid = (\d+)/.exec(r.stdout)?.[1];
      process.stdout.write(`${SERVICE_LABEL}: ${state}${pid ? ` (pid ${pid})` : ''}\n`);
    }
  } else {
    fail('service install | uninstall | status');
  }
}

async function cmdPair(home: Home): Promise<void> {
  const store = openStore(home);
  const { createPairingCode } = await import('../src/http/auth.ts');
  const settings = readServerSettings(home);
  const base = settings.publicUrl ?? `http://${settings.host}:${settings.port}`;
  const url = `${base}/#code=${createPairingCode(store)}`;
  process.stdout.write(`${url}\nValid for 10 minutes, single use.\n`);
  if (process.platform === 'darwin') {
    try {
      execFileSync('pbcopy', { input: url });
      process.stdout.write('Copied to the clipboard (paste it on your iPhone via Universal Clipboard, or AirDrop it).\n');
    } catch {
      /* ignore */
    }
  }
  store.close();
}

const STATE_ORDER: TaskState[] = ['building', 'checking', 'review_ready', 'reviewing', 'merge_ready', 'merging', 'waiting_decision', 'ready', 'proposed', 'exhausted', 'integrated', 'cancelled'];

function cmdStatus(home: Home): void {
  const store = openStore(home);
  const usage = store.usagePausedUntil();
  process.stdout.write(`${store.isPausedAll() ? 'PAUSED (all projects)\n' : ''}${usage && usage > Date.now() ? `Usage-limit pause until ${new Date(usage).toLocaleString()}\n` : ''}`);
  for (const p of store.listProjects()) {
    const tasks = store.listTasks({ projectId: p.id });
    const counts = STATE_ORDER.map((s) => [s, tasks.filter((t) => t.state === s).length] as const).filter(([, n]) => n);
    process.stdout.write(`\n${p.name} (${p.id}) · ${p.config.profile}${p.paused ? ` · paused: ${p.pauseReason}` : ''}\n`);
    process.stdout.write(`  tasks: ${counts.map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}\n`);
    process.stdout.write(`  pending decisions: ${store.pendingDecisionCount(p.id)}\n`);
    for (const r of store.listRuns({ projectId: p.id, status: ['running'] })) {
      process.stdout.write(`  ▶ ${r.id} ${r.role}${r.taskId ? ` ${r.taskId}` : ''} for ${Math.round((Date.now() - r.startedAt) / 60000)}m${r.sessionId ? ` (claude --resume ${r.sessionId})` : ''}\n`);
    }
  }
  if (!store.listProjects().length) process.stdout.write('No projects yet (they appear after `autopilot run` loads their configs).\n');
  store.close();
}

function cmdTask(home: Home, args: string[]): void {
  const [sub, ...rest] = args;
  const store = openStore(home);
  try {
    if (sub === 'add') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { objective: { type: 'string' }, criteria: { type: 'string', multiple: true }, paths: { type: 'string', multiple: true }, priority: { type: 'string' } },
      });
      const [projectId, title] = positionals;
      if (!projectId || !title) fail('task add <project> "<title>"');
      if (!store.getProject(projectId)) fail(`unknown project ${projectId} (start \`autopilot run\` once so configs are loaded)`);
      const t = store.createTask({
        projectId,
        title,
        objective: values.objective ?? title,
        acceptanceCriteria: values.criteria ?? [],
        ownedPaths: values.paths ?? [],
        priority: values.priority ? Number(values.priority) : 3,
        origin: 'human',
        state: 'ready',
      });
      process.stdout.write(`${t.id} ready: ${t.title}\n`);
    } else if (sub === 'list' || !sub) {
      const projectId = rest[0];
      for (const t of store.listTasks({ projectId })) {
        process.stdout.write(`${t.id.padEnd(6)} ${t.state.padEnd(16)} p${t.priority} ${t.title}${t.stateReason ? `  — ${t.stateReason}` : ''}\n`);
      }
    } else if (sub === 'show') {
      const t = store.getTask(rest[0]);
      if (!t) fail(`unknown task ${rest[0]}`);
      process.stdout.write(`${JSON.stringify(t, null, 2)}\n`);
      for (const r of store.listRuns({ taskId: t.id, limit: 10 })) process.stdout.write(`run ${r.id} ${r.role} ${r.status} session=${r.sessionId ?? r.resumedSessionId ?? '-'}\n`);
    } else if (sub === 'retry') {
      const t = store.getTask(rest[0]);
      if (!t) fail(`unknown task ${rest[0]}`);
      if (t.leaseOwner) fail(`${t.id} is busy (${t.state})`);
      store.transition(t.id, ['exhausted', 'waiting_decision'], 'ready', 'retried from CLI', { attempts: 0, repairCycles: 0 });
      store.detachTaskFromDecisions(t.id, 'superseded', 'task retried from CLI');
      process.stdout.write(`${t.id} is ready again\n`);
    } else if (sub === 'cancel') {
      const t = store.getTask(rest[0]);
      if (!t) fail(`unknown task ${rest[0]}`);
      if (t.leaseOwner) fail(`${t.id} is busy (${t.state}); cancel it from the inbox so the running worker is stopped`);
      store.transition(t.id, t.state, 'cancelled', 'cancelled from CLI');
      store.detachTaskFromDecisions(t.id, 'cancelled', 'task cancelled from CLI');
      process.stdout.write(`${t.id} cancelled\n`);
    } else {
      fail(`unknown task command ${sub}`);
    }
  } finally {
    store.close();
  }
}

function printDecision(d: Decision): void {
  process.stdout.write(`\n${d.id} r${d.revision} [${d.kind}${d.blocking ? ', blocking' : ''}, ${d.priority}] ${d.projectId}${d.taskId ? ` ${d.taskId}` : ''}\n  ${d.question}\n`);
  if (d.why) process.stdout.write(`  why: ${d.why.split('\n')[0].slice(0, 200)}\n`);
  for (const o of d.options) process.stdout.write(`   - ${o.id}: ${o.label}${o.id === d.recommendation ? '  (recommended)' : ''}${o.requiresComment ? '  [needs --comment]' : ''}\n`);
}

function cmdDecisions(home: Home, args: string[]): void {
  const store = openStore(home);
  const list = store.listDecisions({ projectId: args[0], status: ['pending'] });
  if (!list.length) process.stdout.write('No pending decisions.\n');
  list.forEach(printDecision);
  store.close();
}

function cmdAnswer(home: Home, args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { comment: { type: 'string' } } });
  const [id, optionId] = positionals;
  const store = openStore(home);
  const d = store.getDecision(id);
  if (!d) fail(`unknown decision ${id}`);
  const out = store.respond({ decisionId: d.id, revision: d.revision, optionId: optionId ?? null, comment: values.comment ?? null, actor: 'founder (cli)', idempotencyKey: `cli-${randomToken(12)}` });
  process.stdout.write(`${out.status}${'reason' in out ? `: ${out.reason}` : ''}\n`);
  store.close();
  if (out.status !== 'saved') process.exit(2);
}

function cmdPause(home: Home, args: string[], paused: boolean): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const store = openStore(home);
  const reason = values.reason ?? (paused ? 'paused from CLI' : 'resumed from CLI');
  if (positionals[0] && !store.getProject(positionals[0])) {
    const known = store.listProjects().map((p) => p.id).join(', ') || 'none';
    store.close();
    fail(`unknown project ${positionals[0]} (known: ${known})`);
  }
  if (positionals[0]) store.setProjectPaused(positionals[0], paused, reason);
  else store.setPausedAll(paused, reason);
  if (!paused && !positionals[0]) store.setUsagePause(null, reason);
  process.stdout.write(`${paused ? 'Paused' : 'Resumed'} ${positionals[0] ?? 'everything'}. ${paused ? 'Running workers finish their current run; use the inbox Pause to stop them immediately.' : ''}\n`);
  store.close();
}

function cmdLogs(home: Home, args: string[]): void {
  const runId = args[0];
  if (!runId) fail('logs <run-id>');
  const path = join(home.runDir(runId), 'stream.jsonl');
  if (!existsSync(path)) fail(`no log for ${runId} at ${path}`);
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('[stderr]')) {
      process.stdout.write(`${line}\n`);
      continue;
    }
    try {
      const m = JSON.parse(line);
      if (m.type === 'assistant') {
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text') process.stdout.write(`\n${c.text}\n`);
          else if (c.type === 'tool_use') process.stdout.write(`  → ${c.name} ${JSON.stringify(c.input).slice(0, 160)}\n`);
        }
      } else if (m.type === 'result') {
        process.stdout.write(`\n== result: ${m.is_error ? 'error' : 'ok'} · ${m.num_turns} turns · ${m.terminal_reason ?? m.subtype}\n${typeof m.result === 'string' ? m.result.slice(0, 2000) : ''}\n`);
      }
    } catch {
      process.stdout.write(`${line}\n`);
    }
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // --home is global: take it out before the subcommand parses its own arguments.
  const homeIdx = argv.findIndex((a) => a === '--home' || a.startsWith('--home='));
  let homeDir: string | undefined;
  if (homeIdx >= 0) {
    const a = argv[homeIdx];
    homeDir = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[homeIdx + 1];
    if (!homeDir) fail('--home needs a directory');
    argv.splice(homeIdx, a.includes('=') ? 1 : 2);
  }
  const home = resolveHome(homeDir);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init':
      return cmdInit(home, rest);
    case 'doctor':
      return cmdDoctor(home);
    case 'run':
      return cmdRun(home, rest);
    case 'pair':
      return cmdPair(home);
    case 'service':
      return cmdService(home, rest);
    case 'status':
      return cmdStatus(home);
    case 'task':
      return cmdTask(home, rest);
    case 'decisions':
      return cmdDecisions(home, rest);
    case 'answer':
      return cmdAnswer(home, rest);
    case 'pause':
      return cmdPause(home, rest, true);
    case 'resume':
      return cmdPause(home, rest, false);
    case 'logs':
      return cmdLogs(home, rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      fail(`unknown command "${cmd}". Run autopilot help.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    chmodSync(fileURLToPath(import.meta.url), 0o755);
  } catch {
    /* read-only install */
  }
  main().catch((err) => fail((err as Error).stack ?? String(err)));
}
