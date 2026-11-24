# Architecture

StayOn Autopilot is a small local service. Ordinary code makes every scheduling
and safety decision; Claude Code is called only for bounded jobs (plan, build,
review). State lives in one SQLite file, so a crash or restart loses nothing.

```mermaid
flowchart LR
  Docs["Your docs + charter"] --> P["Planner run (claude -p, read-only)"]
  P -->|tasks with owned paths + deps| Q[("SQLite: tasks, runs, decisions, outbox, audit")]
  Q --> S["Supervisor loop (plain code)"]
  S -->|claim with fenced lease| B1["Builder run in worktree A"]
  S -->|claim with fenced lease| B2["Builder run in worktree B"]
  B1 & B2 -->|MCP: request_decision, propose_task, report_progress| API["Local HTTP API"]
  API --> Q
  S --> C["Deterministic checks (configured commands)"]
  C --> R["Reviewer run (claude -p, read-only)"]
  R --> M{"Merge policy (code)"}
  M -->|eligible| I["Serialized integration: merge + re-run checks + CAS ref update"]
  M -->|sensitive / unsure| Card["Decision card"]
  Card --> Inbox["Phone inbox (PWA)"]
  Inbox -->|revision-bound answer| API
  I --> Main[("target branch")]
```

## Components

| Path | Role |
| --- | --- |
| `src/supervisor.ts` | The loop: syncs project configs, heartbeats live work, breaks expired leases, delivers outbox events, dispatches planner/builders/reviewers, runs checks, classifies and integrates merges, turns exceptions into cards. |
| `src/store.ts`, `src/db.ts` | SQLite (Node's built-in `node:sqlite`, WAL). Task state machine, leases with fencing tokens, runs, decisions with revisions and idempotency keys, outbox, audit events, checks, reviews, feedback, inbox sessions. |
| `src/config.ts` | Per-project policy with fail-closed validation (unknown keys are errors). Profiles: `supervised`, `balanced_autopilot`, `integration_only`, `pause`. |
| `src/runner/claude-cli.ts` | Runs `claude -p --output-format stream-json` with the prompt on stdin, `--json-schema` for the result, `--mcp-config` for the autopilot tools, allow/deny tool lists, idle and total timeouts, process-group kill. Strips API-key variables so runs use the subscription. |
| `src/runner/stream.ts` | Parses stream-json, classifies outcomes: success, usage limit (with reset time when stated), auth failure, overload, other failures. |
| `src/runner/fake.ts`, `src/runner/demo.ts` | Scripted agents for tests and the no-Claude demo mode. |
| `src/agent-api.ts`, `src/mcp/server.ts` | Tools agents can call mid-run (`get_task_context`, `request_decision`, `check_decision`, `propose_task`, `report_progress`). The stdio MCP server forwards to the local API with a per-run bearer token; every call is fenced against the run's lease. |
| `src/git/local-forge.ts` | Private bare clone, one worktree per task, squash/merge integration in a dedicated integration worktree, checks on the merged tree, compare-and-swap ref update, idempotent via `Autopilot-Task`/`Autopilot-Head` trailers. |
| `src/git/github-forge.ts` | Same, plus push + PR via `gh`, `gh pr merge --match-head-commit`, PR comments, and polling of conversation comments, reviews and inline review comments. |
| `src/policy/merge-policy.ts` | The merge classifier: `auto_merge`, `human_review`, `repair` or `reject`. |
| `src/checks.ts` | Runs the configured check commands (argument arrays, timeouts, redacted output). |
| `src/http/*`, `src/inbox/*` | JSON API + the phone inbox (vanilla JS PWA; cookie session from a one-time pairing link; CSRF header; strict CSP). |
| `src/push.ts`, `src/notify.ts` | Web Push to the installed PWA (VAPID + aes128gcm with `node:crypto`, verified against the RFC 8291 vector) and optional ntfy. Notifications carry counts only, never card text. |
| `bin/autopilot.ts` | CLI: `init`, `doctor`, `run`, `service` (macOS LaunchAgent), `pair`, `status`, `task`, `decisions`, `answer`, `pause`/`resume`, `logs`. |

## Scheduling rules worth knowing

* Slots are counted from the moment a task is claimed, so asynchronous worktree
  setup can never let more than `maxBuilders` builders (or `maxReviewers`
  reviewers) run.
* Two tasks whose `ownedPaths` overlap never run at the same time; a task that
  owns `**` runs alone. Tasks wait for their `dependsOn` tasks to integrate.
* When a project has `inbox.maxPendingDecisions` or more pending cards, it
  starts a new builder only when none of its builders is running, and its
  planner pauses (you are the bottleneck, so do not create more questions).
* Quota governor: a Claude Code `rate_limit_event` warning limits all projects to
  one builder for 30 minutes; a rejection pauses all model runs until the stated
  reset (or a growing backoff). Checks and merges keep going meanwhile.
* Workers always run with `--strict-mcp-config`, an explicit permission mode
  and `--permission-prompts none`, and by default with `--setting-sources user`
  (builders follow `execution.settingSources`; the planner and reviewer always
  use `user`), so unless you allow project settings a branch cannot inject
  hooks, environment variables or an `apiKeyHelper` into unattended runs.

## Task lifecycle

```
proposed → ready → building → checking → review_ready → reviewing → merge_ready → merging → integrated
                       │          │                         │             │            │
                       └──────────┴────── repair (back to ready, budgeted) ┴────────────┘
             building / reviewing / merging ──► waiting_decision ──(answer)──► ready | merge_ready | checking
             budget spent ──► exhausted ──(diagnostic card: retry)──► ready
             any open task ──(cancel: inbox or `autopilot task cancel`)──► cancelled
```

* **Leases and fencing.** Claiming a task bumps its `lease_generation`. A run's
  tool calls and its final result are accepted only while it still owns that
  generation. Live processes are heartbeated; leases left by a crashed process
  expire or are broken on restart, and the old worker is fenced out.
* **Budgets.** `maxAttempts` counts builder runs that failed for task reasons;
  `maxRepairCycles` counts failed checks, change requests and merge conflicts.
  Usage limits, auth failures, pauses and lost resumes do not consume attempts.
* **Resume.** A task keeps its worktree and its last Claude session id. After a
  decision, review or repair, the next builder run resumes that session with the
  new information; if the session cannot be resumed, a fresh run gets the task's
  durable notes instead.

## Decisions (cards)

* Kinds: `choice` (product intent), `review` (judge a concrete revision),
  `authorization` (one exact operation on one exact artifact), `diagnostic`
  (work cannot progress), `info`.
* An answer is saved in one transaction with an outbox event; delivery is
  retried until processed, so a lost notification never loses an answer.
* Every answer carries the card's `revision` and an idempotency key. Revised
  cards reject old answers; retries return the stored result.
* Review cards are bound to the exact commit (`artifactRef`). If the branch
  moves after the card was shown, an approval re-verifies instead of merging.
* Duplicate questions merge on a `dedupeKey` and block every waiting task.
* Blocking cards stop only their task; everything else keeps running. With
  `inbox.maxPendingDecisions` or more pending cards in a project, it starts new
  builders only one at a time.
* No answer means pending, never permission.

The data model, the agent tools and the inbox API are specified in
[card-protocol.md](card-protocol.md).

## Merge policy

Order of checks in `classifyMerge`:

1. Protected paths changed (default `.autopilot/**`, `.claude/settings.json`, `.claude/settings.local.json`) → **reject** (builder must revert).
2. Any configured check missing or not passed on this exact head → **repair** (missing evidence is not success).
3. No independent review of this exact head, reviewer asked for a human, or an approval that still lists blocker/major findings → **human review**; change requests → **repair**.
4. Pending blocking cards or open change requests → **human review**.
5. Auto-merge only if the profile allows it and: no sensitive paths, inside `allowedPaths` when set, under `maxAutoMergeLines`, not high risk, not an integration task, not a mass deletion.

Your approval of the exact head (card or GitHub review by a trusted actor)
overrides step 5 only. Integration then merges in a separate worktree, re-runs
the checks on the merged tree, and moves the target branch with a
compare-and-swap; a conflict or a red integrated build sends the task back for
repair and never moves the branch.

## Security boundaries

**Threat model, stated plainly.** Builders run as your OS user. The
autopilot is designed against confused or careless agents and against
prompt-injected attempts that use git, `gh` or file tools — not against a
determined attacker running with your user's privileges, who could, for
example, edit the database directly. Closing that gap needs OS-level
isolation (running workers as a separate OS user or in a VM), which is not
done yet. Note that your check commands run code the builders wrote, as your
user, before any review.

Within that model:

* **Target branch integrity.** Worktrees share refs with the private clone, so
  a builder could move the target branch with `git update-ref`, `branch -f` or a
  local push. The supervisor records the last head it set, checks it every tick
  and before every merge, and on any mismatch restores it, pauses the project
  and raises an urgent card (drill: "a builder that moves the target branch").
  Its own merge commits are recognized by their trailers and parent, including
  after a crash between merging and recording.
* **Policy changes need you.** A `config.json` that changes while the
  autopilot runs (or differs from the last approved one at restart) produces an
  authorization card; until you approve, the previous policy stays in force.
  New project configs that appear while running also need approval.
  `autopilot run --accept-config` skips this when you edited the files yourself.
* **No repository hooks in supervisor git commands.** Every git command the
  supervisor runs uses `core.hooksPath=/dev/null`, `core.fsmonitor=false`,
  `core.untrackedCache=false` and `protocol.ext.allow=never`, and ignores
  replace refs and grafts (`core.useReplaceRefs=false`,
  `GIT_NO_REPLACE_OBJECTS=1` and `GIT_GRAFT_FILE=/dev/null/no-grafts`, a file
  that cannot exist), so a worker that writes `refs/replace/*` or `info/grafts`
  cannot make the supervisor diff, scan or review other objects or history than
  the ones it merges and pushes. Every worker run gets the two variables as
  well, and `core.useReplaceRefs=false` in `GIT_CONFIG_PARAMETERS` (after any
  settings already there, as `git -c` passes them on), so a reviewer's own
  `git diff` and `git log` show the same commits. The git commands the
  supervisor runs inside builder worktrees, and all check commands, also run
  with Claude/GitHub/cloud credentials removed from the environment; fetches,
  pushes and merges in the private clone keep your environment because they may
  need your git credentials.
* **Secrets.** Leftover files are auto-committed only if they do not look like
  secrets (`.env*`, keys, credentials); every branch's net changes (its diff
  against the base, up to 2 MB) are scanned for secret-looking values before it
  is published and again before it merges. A secret added and removed again in
  intermediate commits is not detected.
* **Approvals are bound to commits.** Inbox approvals, GitHub approvals and
  `/approve CODE` comments all apply to one exact revision; your "request
  changes" is recorded so that revision can never merge later.
* Policy, state and credentials live in `~/.stayon-autopilot`, outside every
  worktree. Builders cannot edit the config through their branch; changes to
  protected paths are rejected at merge time, and tool rules deny reading the
  database, token, configs and run logs.
* Builders are denied the tools to push or merge (`git push`, `gh pr merge`,
  `gh pr review`), and only the supervisor integrates. Reviewers and the planner
  run with `dontAsk` permission mode and no edit tools: read tools and read-only
  git commands, plus your configured check commands for the reviewer and
  WebSearch/WebFetch for the planner.
* Workers run with API-key variables removed, so they always use the Claude
  subscription; there is no silent paid-API fallback.
* The agent bridge (`/agent/tools/*`) accepts only loopback connections with a
  per-run bearer token. The inbox needs a session cookie from a single-use
  pairing link, a CSRF header for every write, and a strict CSP; agent text is
  rendered with `textContent` only.
* Untrusted text (issues, comments, docs, web pages) is data: prompts say so,
  GitHub feedback is accepted only from `feedback.trustedActors`, and nothing an
  agent writes can change policy or approve its own work.

## Failure drills

`test/drills/drills.test.ts` runs the real supervisor, git forge and check
runner against temporary repositories:

| Drill | Expected behaviour |
| --- | --- |
| Two builders in parallel | Both run concurrently; both auto-merge; no cards. |
| Blocking decision | Task yields; other work merges meanwhile; the answer resumes the same Claude session. |
| Answer while the supervisor is down | Saved + outbox; delivered after restart; duplicate answer is idempotent. |
| Crashed worker returns | Restart breaks its lease; its later tool calls get 401/409 and its result is fenced out. |
| Expired lease while running | Lease broken, generation bumped, task rebuilt. |
| Two branches edit the same file | Second merge conflicts; builder merges the target and resolves; then merges. |
| Green branch, red integration | Target branch never moves; repair; then merges. |
| Usage limit | Account-wide pause; no attempt consumed; resumes after the window. |
| Protected policy edit | Rejected; builder reverts; then merges without the policy change. |
| Sensitive change | Review card bound to the commit; a stale approval does not merge a newer commit. |
| Reviewer requests changes | Findings go back to the builder; second review approves. |
| Auth failure | Everything pauses; one card; resume continues. |
| Repeated failures | Budget exhausted; one diagnostic card; "retry" continues. |
| Check step keeps crashing | Three bounded retries, then one card; "retry" re-runs only the checks, not the builder. |
| Planner dependencies | Foundation task runs alone first; dependents follow. |
| Plan application (`planner.test.ts`) | Duplicate titles skipped, `maxTasksPerPlan` enforced, dependency cycles broken, proposals accepted, obsolete tasks cancelled, questions are non-blocking, an answer invites a new plan. |
| GitHub feedback (`github-feedback.test.ts`) | Trusted change request repairs once even if redelivered; untrusted comments ignored; a trusted GitHub approval of the exact head merges and supersedes the card; feedback after merge becomes a follow-up task; `/approve` needs the card's one-time code. |
| Target branch tampering | A builder that moves `main` is caught; `main` restored; project paused with an urgent card; the work later merges only through the gate. |
| Quota governor | After a usage warning, later builders start only when no other builder runs. |
| Regressions (`regressions.test.ts`) | Policy edits need approval and update the runtime in place; a rejected revision never merges; cancelling one task keeps a shared card for the others; no cancel during a merge; secrets never published or merged; a replace ref cannot hide a change from the merge gate; an answer arriving before the run ends resumes without a second card; a builder that switches branches keeps its work; after merging `main` into its branch, a task is judged only on its own changes. |
