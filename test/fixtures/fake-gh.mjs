#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Fake `gh` CLI for tests. Never talks to GitHub.
//
// - Appends {"argv": [...], "stdin": "..."} as one JSON line to $FAKE_GH_LOG.
// - Replies from the JSON object in $FAKE_GH_RESPONSES, keyed by the first args:
//     "pr create", "pr merge", "pr view", ...            (first two arguments)
//     "api repos/o/r/issues/7/comments"                  (api + endpoint without its query string)
//     "pr"                                               (fallback: first argument alone)
//   Each value is { "stdout"?: string, "stderr"?: string, "code"?: number, "exec"?: string[] },
//   or an array of them: the Nth call with that key gets the Nth reply (the last one repeats).
//   Call counts live in "$FAKE_GH_RESPONSES.counts.json"; delete it when replacing the replies.
//   "exec" runs a command (argument array, no shell) before replying, to simulate a side effect
//   such as GitHub moving a branch when a pull request is merged.
// - Unknown commands exit 1 with "fake-gh: no canned response for: ...".

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  stdin = '';
}

if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ argv, stdin })}\n`);

const responsesFile = process.env.FAKE_GH_RESPONSES;
const responses = responsesFile ? JSON.parse(readFileSync(responsesFile, 'utf8')) : {};

/** Flags of `gh api` that consume the next argument. */
const API_FLAGS_WITH_VALUE = new Set(['-q', '--jq', '-H', '--header', '-f', '--raw-field', '-F', '--field', '-X', '--method', '--hostname', '-t', '--template', '--input', '-p', '--preview', '--cache']);

function keyFor(args) {
  if (args[0] === 'api') {
    for (let i = 1; i < args.length; i++) {
      if (API_FLAGS_WITH_VALUE.has(args[i])) i++;
      else if (!args[i].startsWith('-')) return `api ${args[i].split('?')[0]}`;
    }
    return 'api';
  }
  return args.slice(0, 2).join(' ');
}

/** The reply for this call: arrays are consumed in order, one element per call. */
function pick(key, value) {
  if (!Array.isArray(value)) return value;
  const countsFile = responsesFile ? `${responsesFile}.counts.json` : null;
  const counts = countsFile && existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
  const n = counts[key] ?? 0;
  counts[key] = n + 1;
  if (countsFile) writeFileSync(countsFile, JSON.stringify(counts));
  return value[Math.min(n, value.length - 1)];
}

const key = keyFor(argv);
const matched = key in responses ? key : argv[0] in responses ? argv[0] : null;
const reply = matched ? pick(matched, responses[matched]) : { code: 1, stderr: `fake-gh: no canned response for: ${argv.join(' ')}\n` };

if (Array.isArray(reply.exec) && reply.exec.length > 0) {
  const res = spawnSync(reply.exec[0], reply.exec.slice(1), { encoding: 'utf8' });
  if (res.status !== 0) {
    process.stderr.write(`fake-gh: exec failed: ${reply.exec.join(' ')}\n${res.stderr ?? ''}${res.error ? res.error.message : ''}\n`);
    process.exit(97);
  }
}

if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exitCode = typeof reply.code === 'number' ? reply.code : 0;
