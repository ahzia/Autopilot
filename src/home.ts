// SPDX-License-Identifier: MIT
// On-disk layout of the autopilot's private data (outside every project repo,
// so builders cannot edit policy or state through their worktrees).

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface Home {
  root: string;
  dbPath: string;
  projectsDir: string;
  projectDir(id: string): string;
  configPath(id: string): string;
  runDir(runId: string): string;
  serverConfigPath: string;
}

export function resolveHome(root?: string): Home {
  const r = resolve(root ?? process.env.AUTOPILOT_HOME ?? join(homedir(), '.stayon-autopilot'));
  return {
    root: r,
    dbPath: join(r, 'autopilot.db'),
    projectsDir: join(r, 'projects'),
    projectDir: (id) => join(r, 'projects', id),
    configPath: (id) => join(r, 'projects', id, 'config.json'),
    runDir: (runId) => join(r, 'runs', runId),
    serverConfigPath: join(r, 'server.json'),
  };
}

export interface ServerSettings {
  host: string;
  port: number;
  /** URL the phone uses (e.g. https://mac.tailnet-name.ts.net); defaults to http://host:port. */
  publicUrl: string | null;
}

export function readServerSettings(home: Home): ServerSettings {
  const defaults: ServerSettings = { host: '127.0.0.1', port: 4777, publicUrl: null };
  if (!existsSync(home.serverConfigPath)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(home.serverConfigPath, 'utf8'));
    return {
      host: typeof raw.host === 'string' ? raw.host : defaults.host,
      port: Number.isInteger(raw.port) ? raw.port : defaults.port,
      publicUrl: typeof raw.publicUrl === 'string' ? raw.publicUrl.replace(/\/+$/, '') : null,
    };
  } catch {
    return defaults;
  }
}
