# Setup and daily use

Everything runs on your own computer. Claude work uses your Claude subscription
through the official `claude` CLI; nothing is billed to an API key. macOS gets
every convenience (a background service and clipboard copy); on Linux the
supervisor, CLI, inbox and tests work the same, and you run the supervisor under
your own service manager.

## 1. Prerequisites

* Node.js 24 or newer, and git.
* Claude Code CLI, updated: `claude update` (developed against 2.1.304; newer
  builds add better headless controls). Workers use the `opus` model by default
  (`execution.model`); set `"sonnet"` to stretch your usage limits further.
  Keep "usage credits" turned off in your Claude account so nothing can fall
  back to paid usage.
* Log the **CLI** in for unattended runs. The Claude desktop app logs in its own
  sessions, but a background supervisor needs the CLI's login:

  ```bash
  claude auth login
  ```

  Recommended when running several workers in parallel: create a long-lived
  subscription token once, so parallel workers do not compete to refresh the
  keychain login. Run `claude setup-token`, then save the printed token where
  only you can read it (macOS, with the token on the clipboard):

  ```bash
  (umask 077 && mkdir -p ~/.stayon-autopilot && pbpaste > ~/.stayon-autopilot/claude-oauth-token)
  ```

  On Linux, write the token into that file with an editor and make it private
  with `chmod 600` (and the folder with `chmod 700`). Alternatively, export
  `CLAUDE_CODE_OAUTH_TOKEN` in the shell that runs `autopilot run`; the
  background service from `autopilot service install` does not see shell
  variables, so use the token file there. Never set `ANTHROPIC_API_KEY` for the autopilot: workers
  strip it anyway so a stray key can never move work to paid API billing.

## 2. Install

```bash
git clone https://github.com/ahzia/StayOn-Autopilot.git && cd StayOn-Autopilot && npm install
```

The command is `./bin/autopilot.ts` in the repository folder. To call it as
`autopilot` from anywhere, run this in the repository folder. It links the
command into npm's global folder and so puts `autopilot` on your `PATH`:

```bash
npm link
```

npm needs permission to write to its global folder. If it reports a permission
error, add an alias instead (run this in the repository folder, and put the same
line with the absolute path into your shell profile):

```bash
alias autopilot="$PWD/bin/autopilot.ts"
```

The rest of this guide writes `autopilot`.

## 3. Try the demo first (no Claude usage)

```bash
autopilot init demo --source /tmp/autopilot-demo --create --runner fake --check "test=node -e process.exit(0)"
```

```bash
autopilot run
```

Open the printed pairing link. Scripted agents plan four tasks, build two at a
time, ask you two questions (who the first release is for, which blocks
nothing, and the welcome tone, which pauses its task), auto-merge routine work
and send the sensitive `package.json` change to you as a review card. Answer the
cards and watch the tasks resume. Stop with Ctrl-C. To remove the demo
completely before you add real projects, delete `~/.stayon-autopilot` and
`/tmp/autopilot-demo` (deleting only `~/.stayon-autopilot/projects/demo` leaves
its tasks and cards in the database and the inbox).

## 4. Create a real project

New repository (`--source` must be a new or empty folder, so keep the
documents somewhere else; `init` refuses a folder that already holds files and
writes nothing):

```bash
autopilot init my-app --create --source /path/to/my-app --name "My App" --docs /path/to/notes/product.md,/path/to/notes/architecture.md --check "typecheck=npm run typecheck" --check "test=npm test" --setup "npm install"
```

Existing repository: drop `--create` and point `--source` at it. The autopilot
works in its own private clone (`~/.stayon-autopilot/projects/<id>/repo.git`),
never in your working copy. With `repo.pushIntegratedTo: "autopilot/main"` the
integrated work is pushed to that branch of your repository so you can pull or
merge it whenever you like.

Then review `~/.stayon-autopilot/projects/my-app/config.json`. Every field is
described in [configuration.md](configuration.md), and
[examples/example-app.json](../examples/example-app.json) shows a complete
policy, including an exploration charter. Every field is validated when the
supervisor loads it; an invalid config pauses that project instead of running
with a guess.

Builders also follow your repository's own conventions: keep coding rules in
`CLAUDE.md` or `AGENTS.md` at the root of your repository, product context in
the documents listed under `docs`, and what the planner may explore without
asking in `charter`.

Policy changes are deliberate: if `config.json` changes while the autopilot is
running (or differs from the last approved version when it restarts), you get a
card "Apply the changed policy file for My App?" and the old policy stays in force until
you approve. Builders run as your user and could edit the file, so this is on
purpose. When you have just edited configs yourself, start with
`autopilot run --accept-config` to apply them without cards.

Check everything:

```bash
autopilot doctor
```

Then prove that real Claude workers work on your machine before trusting the
autopilot with a project (a few minutes of subscription usage, on a throwaway
repository; it checks the tool bridge, a decision yield-and-resume and the
merge). Run it from the repository folder:

```bash
npm run smoke
```

## 5. Run it

In a terminal (stops when you close it):

```bash
autopilot run
```

On macOS, `caffeinate -is ./bin/autopilot.ts run` (in the repository folder,
or `caffeinate -is autopilot run` after `npm link`; `caffeinate` cannot run a
shell alias) also keeps the Mac awake while the autopilot works. Ctrl-C stops
the workers; their Claude sessions are kept and resumed on the next run.

Or, on macOS, as a background service that starts at login and restarts after a
crash (a LaunchAgent; it also keeps the Mac awake while it runs):

```bash
autopilot service install
```

`autopilot service status` shows whether it runs, the log is
`~/.stayon-autopilot/logs/supervisor.log`, and `autopilot service uninstall`
removes it (your projects and history stay). Preview the definition first with
`autopilot service install --dry-run`. A closed lid still sleeps the Mac unless
it is on power with an external display; work resumes on wake. The service
remembers the absolute paths of Node and of this folder, so run
`autopilot service install` again after moving the folder or changing Node
versions, and it receives only `PATH` and `HOME` from your environment, so give
it the token file rather than an exported token.

On Linux, run `autopilot run` under a service manager of your choice, for
example a systemd user service; `autopilot service` is macOS-only.

Only one `autopilot run` can use a home directory at a time, because a second
one would stop the first one's workers. A second `autopilot run` on the same
home, for example in a terminal while the background service runs, stops at
once with a message that names the running one's process id. To run in a
terminal instead, first stop the service with `autopilot service uninstall`.
While it runs, the autopilot keeps its process id in `supervisor.lock` in the
home directory; a lock left behind by a crash is replaced at the next start.

## 6. Use it from your phone

1. Install Tailscale on the computer and on your phone and sign both into the
   same tailnet.
2. On the computer: `tailscale serve --bg 4777`. This publishes the inbox
   **only inside your tailnet** with an HTTPS certificate. Do not use Funnel
   (that would expose it to the internet). Certificate names are published in
   Certificate Transparency logs, so give the machine a name that reveals
   nothing.
3. Tell the autopilot its phone URL in `~/.stayon-autopilot/server.json`:

   ```json
   { "host": "127.0.0.1", "port": 4777, "publicUrl": "https://your-computer.your-tailnet.ts.net" }
   ```

4. `autopilot pair` prints a single-use link (valid 10 minutes; on macOS it is
   also copied to the clipboard). Open it on your phone, then add the page to
   the Home Screen (iPhone: Share → Add to Home Screen).
5. Open the Home Screen app → Status → **Enable notifications**. New cards then
   arrive as normal notifications (Web Push; on iPhone this needs iOS 16.4 or
   later and the Home Screen app).

Use Tailscale Serve rather than `--host 0.0.0.0`: serving the inbox on your
local network is plain HTTP, so anyone who can watch that network can capture
the pairing link and the session cookie. `autopilot run` prints a warning when
it serves the inbox on any address other than `127.0.0.1` (or another loopback
address) and `publicUrl` is not an `https://` address; it still starts. A
paired phone stays signed in for 30 days; there is no command yet to sign out
a lost phone, so if that happens, stop the autopilot and start over
(section 9).

Optional extra pager: set `inbox.ntfyUrl` / `inbox.ntfyTopic` in a project
config to also notify through ntfy. Notifications never contain the question
text, only a count such as "My App: 2 decisions need you".

## 7. Daily use

* **Inbox**: one card at a time. Tap an option and Send, swipe right to accept
  the recommendation (only for reversible choices), swipe left or tap Later to
  defer. Review cards show the exact commit and its code changes; changing your
  mind later is a new card, never a silent change.
* **Digest**: what merged, what failed, what you answered in the last 24 hours.
* **Board**: every task and its state; open one to see runs, checks, the review
  and a copyable `claude --resume <session>` command to inspect what an agent
  did in a normal Claude Code session.
* **Status**: pause everything (stops running workers immediately), pause one
  project, see usage-limit pauses, turn notifications on or off.
* Terminal equivalents: `autopilot status`, `autopilot decisions`,
  `autopilot answer D-7 warm`, `autopilot task add my-app "…"`,
  `autopilot pause` (stops new work; running workers finish their current
  run), `autopilot logs R-12`. These commands know a project once
  `autopilot run` has loaded its config.

## 8. GitHub mode (optional)

Local mode needs no GitHub at all. For pull requests:

1. `gh auth login`.
2. In the project config's `repo` section: `"forge": "github"` and
   `"github": "owner/repo"` (or create the project with
   `autopilot init <id> --source <repo> --forge github --github owner/repo`),
   and `feedback.trustedActors` = your GitHub login (only these people's comments
   can request changes).
3. Know the GitHub limits for a personal account (checked November 2026):
   * GitHub never lets a pull request's author approve it. Because the autopilot
     opens pull requests as you, its reviewer posts a **comment**, not an
     approval, and the supervisor merges with
     `gh pr merge --squash --match-head-commit <sha>` after its own checks and
     policy pass.
   * On a private personal repository, branch protection, rulesets, required
     checks and auto-merge need GitHub Pro; merge queues are not available on
     personal repositories at all.
   * If you require approvals in branch protection, the autopilot cannot satisfy
     them with your login. Options: a separate reviewer identity (a private
     GitHub App or one machine account), or leave approvals off and rely on the
     autopilot's gate. A refused merge becomes one card explaining this, not one
     card per pull request.
4. Pull request comments from trusted actors send the task back to its builder.
   Because GitHub does not let you approve pull requests opened with your own
   login, a review card in GitHub mode shows a one-time code: commenting
   `/approve CODE` on the pull request (for example from GitHub Mobile) approves
   exactly that revision. The code is shown only on the card and never returned
   by the agents' tools, so an agent that can use your `gh` login cannot approve
   its own work just by commenting (code running as your user could still read
   it from the local database; see the threat model). A real
   GitHub approval from another trusted account counts only if it was given on
   the current commit.
5. Hardened variant (not automated yet): a ruleset on `main` with no bypass,
   required checks for CI and for your own reviewer GitHub App's status,
   CODEOWNERS naming you for `.github/**`, `.claude/**`, `CLAUDE.md`, policy and
   dependency files, builders pushing as one machine account, and native
   auto-merge. Then GitHub itself enforces the gate, and you can approve
   sensitive pull requests in GitHub Mobile because you are not their author.

## 9. Where your data lives, updating and resetting

Everything the autopilot keeps is in `~/.stayon-autopilot` (or the directory in
`$AUTOPILOT_HOME`): the database (tasks, cards, history and the inbox's
notification keys), project configs, private clones and worktrees, each run's
full transcript (`runs/<run-id>/stream.jsonl`, shown by
`autopilot logs <run-id>`), service logs and, if you created it, the Claude
token file. Nothing is written into your own working copies,
except the optional `repo.pushIntegratedTo` branch pushed to your repository.

* Remove one project: stop the autopilot, then delete
  `~/.stayon-autopilot/projects/<id>` (its config, private clone and
  worktrees). Its tasks and cards stay in the database and still show in
  `autopilot status` and the inbox; to remove those too, start over completely.
* Start over completely: stop the autopilot (and `autopilot service uninstall`
  on macOS), then delete `~/.stayon-autopilot`. This also deletes the token
  file and invalidates paired phones.
* Remove the `autopilot` command: run `npm uninstall -g stayon-autopilot` if
  you used `npm link` (or delete the alias from your shell profile), then
  delete the repository folder.

**Updating:** run `git pull && npm install` in the repository folder, then
restart the autopilot. Configs, history and paired phones are kept; the database
is migrated automatically when the supervisor starts. Check
[CHANGELOG.md](../CHANGELOG.md) for changes to the configuration format or the
card protocol.

## 10. Safety and limits

* Builders never push or merge; only the supervisor integrates, and only after
  checks, an independent review and the policy pass on the exact commit.
* Changes to sensitive paths (dependencies, auth, migrations, CI, Claude
  settings, …) always come to you as a review card.
* The policy file lives outside the repository; builders cannot widen their own
  permissions, and branches that touch `.autopilot/**` or Claude settings are
  rejected.
* Usage limits pause new runs account-wide until the stated reset (or a backoff)
  and never consume a task's attempts.
* Anthropic's terms say plan limits assume ordinary, individual use. Start with
  2 builders and raise it only if your usage allows.
* Workers run as your OS user. Read the threat model in
  [architecture.md](architecture.md#security-boundaries) before you point the
  autopilot at anything sensitive.
