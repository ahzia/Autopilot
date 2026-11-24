# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change
the configuration format, the card protocol or CLI behaviour; such changes are
called out here.

## [Unreleased] — 0.1.0

First public release.

### Added

- Supervisor loop that keeps a project moving: a planner run turns your
  documents and an exploration charter into tasks; builder runs implement tasks
  in parallel, each on its own branch and git worktree; configured checks run on
  the exact commit; an independent read-only reviewer run judges it; a merge
  policy in code decides between auto-merge, a review card, a repair or a
  rejection; integration is serialized, re-runs the checks on the merged tree
  and moves the target branch with a compare-and-swap.
- Durable state in SQLite (Node's built-in `node:sqlite`): task state machine,
  fenced leases, runs, decisions with revisions and idempotency keys, an outbox
  for answers, and an audit log, so a crash or restart loses nothing.
- Decision cards that never block other work: blocking questions pause only
  their task, answers resume the same Claude session, review approvals are bound
  to one commit, duplicate questions merge, and failures end in one diagnostic
  card instead of endless retries.
- Phone inbox: an installable web app (PWA) served locally, paired with a
  single-use link, with options, recommendations, comments, swipe shortcuts,
  code changes, a 24-hour digest, a task board, status and a global pause.
- Notifications through Web Push (VAPID and aes128gcm implemented with
  `node:crypto`, verified against the RFC 8291 test vector) and optional ntfy;
  notifications carry counts only.
- Claude Code runner for `claude -p` with stream-json parsing, structured
  results, session resume, an MCP tool bridge (`request_decision`,
  `check_decision`, `propose_task`, `report_progress`, `get_task_context`),
  idle and total timeouts, process-group cleanup, a quota governor, usage-limit
  pauses and a startup guard that refuses runs billed to an API key.
- Local git mode (private bare clone, no GitHub needed) and GitHub mode (pull
  requests through `gh`, feedback from trusted reviewers, `/approve CODE`
  comments bound to one commit).
- Safety rails: builders are denied push, merge and review tools, and a changed
  policy file applies only after your approval; reviewers and planners get no
  edit tools and no prefix rules beyond `git status`, `git ls-files` and `ls`
  (a reviewer may also run, exactly as listed, the `git diff`/`git log` commands
  for the revision under review and your plain-word check commands, which run
  the branch's code); protected and sensitive paths; target-branch tamper
  detection that accepts an upstream move only to a head the configured source
  reported at a sync (without OS-level isolation, workers can still change what
  it reports); secret scanning of every commit and commit message before
  publishing and merging, failing closed when the history is too large to scan;
  git commands that never run repository hooks, fsmonitor or `ext::`
  transports and ignore replace refs and grafts, with credentials removed for
  git commands in builder worktrees and for check commands.
- `autopilot` CLI: `init`, `doctor`, `run`, `pair`, `status`, `task`,
  `decisions`, `answer`, `pause`, `resume`, `logs`, and `service` (macOS
  LaunchAgent). It can be installed with `npm link`; `run` allows one run per
  home directory and warns when the inbox is served over plain HTTP on a
  non-loopback address without an `https://` `publicUrl`.
- Scripted demo mode that shows the whole loop without using Claude.
- Test suite of unit tests and end-to-end failure drills that runs without
  network access, credentials or a Claude login; an opt-in live smoke test
  (`npm run smoke`) for real Claude runs.
