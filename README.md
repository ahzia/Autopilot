# StayOn Autopilot

**Run several Claude Code agents on one project, around the clock, and only hear
from them when a real decision is yours.**

StayOn Autopilot is a small service that runs on your own computer. A planner
agent turns your project documents into tasks. Builder agents implement tasks in
parallel, each on its own git branch and worktree. Every result goes through
your checks and an independent reviewer agent; routine work merges
automatically, while sensitive changes and genuine product questions become
**cards** in a phone-friendly inbox. A question pauses only its own task — the
rest keeps going, and your answer resumes the task where it stopped.

It drives the official `claude` CLI with your Claude subscription (never an API
key) and works with or without GitHub.

```
 your docs ─► planner ─► tasks ─► builder A ┐            ┌─► auto-merge (routine)
                                ─► builder B ┴► checks ► review ─┤
               phone inbox ◄──────── cards ◄───────────────────────┘ (sensitive / questions)
```

> **Status: 0.1, experimental.** The supervisor is covered by an extensive test
> suite, but real-world use is just beginning. Read
> [what is stable and what is experimental](#status) before you point it at a
> repository you care about.

## Who it is for

* Developers who already use Claude Code with a Claude plan and want several
  agents to keep working on a repository unattended, with a human gate for
  anything that matters.
* People comfortable running a local service and reviewing a merge policy.

It is not a hosted service, not a sandbox (agents run as your user — see
[Safety](#safety)), and not a substitute for human review of high-stakes code.

## How it works

* **Planner** — reads your documents and an exploration charter, keeps a small
  queue of tasks with owned paths, dependencies and risk levels, and asks at most
  a couple of non-blocking product questions per plan.
* **Builders** — two or more `claude -p` runs in parallel, each in its own
  worktree. Tasks that touch the same area never run at once.
* **Gate in code** — configured checks on the exact commit, an independent
  read-only reviewer, protected and sensitive paths, size and risk limits, then a
  serialized merge that re-runs the checks on the merged result.
* **Cards** — blocking questions pause only their task; answers are saved
  transactionally and delivered even after a restart; review approvals are bound
  to one commit; repeated failures end in one diagnostic card.
* **Phone inbox** — an installable web app with options, recommendations,
  comments, swipe shortcuts, code changes, a 24-hour digest, a task board and a
  global pause. Private access through Tailscale; Web Push notifications that
  carry counts only.

More: [docs/architecture.md](docs/architecture.md).

## Requirements

* macOS or Linux (see [Platform support](#platform-support)), Node.js 24 or
  newer, and git.
* For real runs: [Claude Code](https://code.claude.com/docs) 2.1.302 or newer,
  logged in with a Claude subscription (`claude auth login`). The demo and the tests need
  neither.
* Optional: the GitHub CLI (`gh`) for pull-request mode, Tailscale for phone
  access, an ntfy server for an extra pager.

## Quick start (demo, no Claude usage)

```bash
git clone https://github.com/ahzia/StayOn-Autopilot.git
cd StayOn-Autopilot
npm install
./bin/autopilot.ts init demo --source /tmp/autopilot-demo --create --runner fake --check "test=node -e process.exit(0)"
./bin/autopilot.ts run
```

Open the printed pairing link. Scripted agents plan four tasks, build two at a
time, ask you two questions (one of them pauses its task until you answer),
auto-merge routine work and send a sensitive change to you as a review card.
Answer the cards and watch the tasks resume. Stop with Ctrl-C.

To type `autopilot` instead of `./bin/autopilot.ts`, run this in the
repository folder. It puts `autopilot` on your `PATH`:

```bash
npm link
```

If npm reports a permission error for its global folder, add an alias instead,
from the repository folder (and to your shell profile, with the absolute path):

```bash
alias autopilot="$PWD/bin/autopilot.ts"
```

## Use it on your own project

1. Log the Claude CLI in, then check your setup:

   ```bash
   claude auth login
   ```

   ```bash
   autopilot doctor
   ```

2. Optional but recommended: prove that real Claude workers run on your machine
   (a few minutes of subscription usage, on a throwaway repository; it skips
   with a message if the CLI is missing or not logged in):

   ```bash
   npm run smoke
   ```

3. Create the project. The autopilot works in its own private clone, never in
   your working copy:

   ```bash
   autopilot init my-app --source /path/to/your-app --docs /path/to/your-app/docs/product.md --check "test=npm test" --setup "npm install"
   ```

4. Review the generated policy in `~/.stayon-autopilot/projects/my-app/config.json`
   (see [Configuration](#configuration)), then start it:

   ```bash
   autopilot run
   ```

   A config that changes after the autopilot has loaded it takes effect only
   after you approve a card. If you edit a config yourself while the autopilot
   is stopped, start it with `autopilot run --accept-config` to apply the change
   directly.

Phone access, notifications, the background service and GitHub mode are covered
in [docs/setup.md](docs/setup.md).

## Configuration

Each project has one policy file, `config.json`, in the autopilot's home
directory (`~/.stayon-autopilot/projects/<id>/`, or under `$AUTOPILOT_HOME`). It
is validated strictly: unknown keys and invalid values pause the project instead
of running with a guess, and changes made while the autopilot runs take effect
only after you approve a card.

| Section | What it controls |
| --- | --- |
| `repo` | Source repository, target branch, branch prefix, `local` or `github` forge |
| `docs`, `charter` | What the planner reads, and what may be explored without asking |
| `execution` | Runner, model, permission mode, tool rules, builder and reviewer slots, timeouts, retry budgets |
| `planner` | Queue size, cooldown, tasks per plan |
| `checks` | Setup commands and the check commands every commit must pass |
| `integration` | Merge strategy, auto-merge, required review, sensitive, protected and allowed paths, size limits |
| `inbox` | Pending-card limit, ntfy, public URL |
| `feedback` | GitHub polling and the trusted reviewers whose comments count |

Builders also follow your repository's own conventions in `CLAUDE.md` or
`AGENTS.md`. Full reference: [docs/configuration.md](docs/configuration.md). A
complete example: [examples/example-app.json](examples/example-app.json).

## Cards and the card protocol

Cards are how agents and the supervisor ask you something: a product choice, a
review of one exact commit, an authorization, or a diagnostic when work cannot
progress. Agents raise them mid-run through MCP tools; the inbox reads and
answers them through a local JSON API with revision-bound, idempotent answers.
The protocol is documented in [docs/card-protocol.md](docs/card-protocol.md) so
other clients can implement it. It is **experimental (version 0)** and may
change before 1.0.

## Safety

* Builders are denied the tools to push, merge or approve (`git push`,
  `gh pr merge`, `gh pr review` and similar), and a changed policy file applies
  only after you approve a card; only the supervisor integrates, after checks,
  an independent review and the policy pass on the exact commit.
* Sensitive paths (dependencies, auth, migrations, CI, Claude settings, …)
  always come to you as review cards; protected paths are rejected.
* Workers run with API-key variables removed, so they use your subscription and
  never fall back to paid API billing; a startup guard stops any run that would.
* The inbox listens on `127.0.0.1` by default, needs a session from a
  single-use pairing link and a CSRF header for every write; notifications
  never contain card text.
* No telemetry: the supervisor contacts only Claude Code, your git remotes,
  `gh`, your phone browser's push service and ntfy if configured; agents can
  still use the network through Claude Code's tools.

**Threat model:** the autopilot defends against confused or careless agents and
against prompt-injected attempts that go through git, `gh` or Claude Code's file
tools — not against code running with your user's privileges. Builders run
shell commands and your checks run code they wrote, all as your user, so treat
these rails as protection against mistakes, not as a sandbox. Details and
limits:
[docs/architecture.md](docs/architecture.md#security-boundaries) and
[SECURITY.md](SECURITY.md).

Running several agents continuously uses your plan's limits quickly; plan limits
assume ordinary individual use, so start with two builders.

## Status

Version 0.1. **Stable** means the behaviour is covered by tests and intended to
stay; **experimental** means it may change or has not yet been proven against
the real service.

| Area | Status |
| --- | --- |
| Supervisor loop, task store, leases, merge policy, local git mode | **Stable** — unit tests plus 77 end-to-end failure drills (crashes, restarts, stale answers, conflicts, red builds after merge, usage limits, auth loss, branch tampering, secrets, policy edits) |
| Configuration file (`version: 1`) | **Stable** — strict validation; breaking changes will bump the version |
| CLI (`init`, `run`, `doctor`, `status`, `task`, `decisions`, `answer`, `pause`, `resume`, `logs`, `pair`) | **Stable** |
| Demo mode and the phone inbox | **Stable** in demo mode |
| Real Claude workers (`claude -p` runner) | **Experimental** — developed against Claude Code 2.1.304's headless interface, with a startup guard; prove it on your machine with `npm run smoke` |
| Card protocol (MCP tools and inbox API) | **Experimental** — version 0, may change before 1.0 |
| GitHub mode | **Experimental** — tested against a simulated `gh`, not yet against real repositories |
| Web Push | **Experimental** — encryption verified against the RFC 8291 test vector; delivery to real devices not yet verified |
| `autopilot service` (LaunchAgent) | **Experimental**, macOS only |
| Running workers in a separate OS account | Not available yet |

## Platform support

| Platform | Support |
| --- | --- |
| macOS | Everything, including `autopilot service` (LaunchAgent) and copying the pairing link to the clipboard |
| Linux | Supervisor, CLI, inbox and tests; run the supervisor under your own service manager (`autopilot service` is macOS-only) |
| Windows | Not supported (WSL may work but is untested) |

## Development

```bash
npm install
npm run check     # type-check + all tests (unit tests and failure drills)
```

The tests use scripted agents and a simulated `gh`; they need no network, no
Claude or GitHub login and no global git configuration. `npm run smoke` runs
real Claude workers against a throwaway repository and skips with a message when
the Claude CLI is missing or not logged in.

```
bin/autopilot.ts        CLI
src/supervisor.ts       scheduling loop and merge controller
src/store.ts, db.ts     SQLite state (tasks, leases, runs, decisions, outbox, audit)
src/config.ts           per-project policy with fail-closed validation
src/prompts.ts          planner / builder / reviewer prompts and result schemas
src/runner/             claude -p runner, stream parser, scripted agents
src/agent-api.ts        tools agents call mid-run (request_decision, …)
src/mcp/server.ts       stdio MCP bridge for those tools
src/git/                local and GitHub forges (worktrees, integration, pull requests)
src/policy/             merge classifier and path globs
src/checks.ts           deterministic check runner
src/http/, src/inbox/   JSON API and the phone inbox
src/push.ts, notify.ts  Web Push (VAPID) and ntfy notifications
docs/                   architecture, setup, configuration, card protocol
examples/               an example project policy
test/                   unit tests and end-to-end failure drills
```

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md)
(commits need a DCO sign-off) and report vulnerabilities privately as described
in [SECURITY.md](SECURITY.md).

## Related projects

Claude Code itself provides headless runs, worktrees, background sessions and
MCP tools, which this project builds on; Anthropic's Claude Ship adds GitHub
agents that review and approve pull requests for Team and Enterprise
organizations. Open-source orchestrators such as Agent Orchestrator and
Paperclip coordinate agents and pull requests. StayOn Autopilot focuses on the
layer in between: a local, policy-based merge gate and an asynchronous decision
inbox that work on a personal plan.

## License

[MIT](LICENSE) © 2026 ahzia and StayOn contributors.

The MIT license covers the code. It does not grant any rights to the "StayOn"
name or logo: forks and derived projects must use a different name and logo and
must not suggest they are endorsed by StayOn.

StayOn Autopilot is an independent project, not affiliated with or endorsed by
Anthropic. Claude and Claude Code are trademarks of Anthropic.
