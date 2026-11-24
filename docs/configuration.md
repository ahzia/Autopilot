# Configuration reference

StayOn Autopilot reads one `config.json` per project, the project's policy
(what to work on, how workers run and what may merge without you), and an
optional `server.json` for the inbox server. This page describes every
setting, its default, its validation and how changes take effect. A complete
project file is in [examples/example-app.json](../examples/example-app.json).

## Where the files live

The home directory is `--home <dir>` if you pass it (every command accepts
it), else `$AUTOPILOT_HOME`, else `~/.stayon-autopilot`. Each project's policy
is `<home>/projects/<id>/config.json`. The folder name must be the same as the
`id` in the file. Folders without a `config.json` are ignored.

## Creating a config with `autopilot init`

```bash
autopilot init my-app --source /path/to/your-app \
  --docs /path/to/your-app/docs/product.md --check "test=npm test"
```

`init` starts from the defaults, applies your flags, validates the result and
writes the complete file with every path made absolute (folders mode 0700,
file mode 0600). An existing file is only replaced with `--force`, which
rebuilds it from the defaults and your flags, so hand edits are lost.

| Flag | Sets | Notes |
| --- | --- | --- |
| `<id>` (required) | `id` | 2-40 characters: lowercase letters, digits and `-`, not starting with `-`. |
| `--source <path or URL>` (required) | `repo.source` | A local path is made absolute from your current directory (`~` is expanded). URLs (`https://…`, `ssh://…`) and `git@…` addresses are kept as written. |
| `--create` | | Creates a new git repository at `--source` (local paths only) with a README, a `.gitignore` and one commit on the target branch. The folder must be new or empty: if it already holds anything, `init` stops and writes nothing. Missing parent folders are created. |
| `--docs a.md,b.md` | `docs` | Comma-separated and repeatable. Made absolute from your current directory. |
| `--forge local\|github`, `--github owner/name` | `repo.forge`, `repo.github` | `--github` is required with `--forge github`. |
| `--target <branch>` | `repo.targetBranch` | With `--create`, also the name of the first branch. |
| `--name`, `--profile`, `--charter`, `--runner` | `name`, `profile`, `charter`, `execution.runner` | |
| `--check "name=command args"` | `checks.commands` | Repeatable. Without `name=`, the first word of the command is the name. Timeout 900 seconds. |
| `--setup "command args"` | `checks.setup` | Repeatable. |

If `--source` is a local folder with a `package.json`, `init` adds a check for
each of the `typecheck`, `lint` and `test` scripts that exist
(`npm run <script>`) and a setup step: `npm ci` when there is a
`package-lock.json`, otherwise `npm install`. `--check` and `--setup` replace
these. Both flags split the command into arguments the way a shell does:
`'single quotes'` keep everything as written, `"double quotes"` keep
everything except the escapes `\\`, `\"`, `\$` and `` \` ``, and a backslash
outside quotes keeps the next character. `init` expands nothing itself:
variables, `~` and globs such as `*.ts` reach the command as written. The
command runs without a shell, so `init` refuses `|`, `&`, `;`, `<`, `>`,
backticks, `$(` and line breaks outside quotes. For those, wrap the command in
`sh -c '...'`, for example `--check "test=sh -c 'npm test && npm run lint'"`,
or edit the file and use `["sh", "-c", "..."]`. `init` prints every setup step
and check as the list of arguments it will run. After `init` you edit the file
by hand. The autopilot never writes it again.

## General rules

The smallest valid file is shown below. Every other field takes its default.

```json
{ "version": 1, "id": "my-app", "repo": { "source": "/path/to/your-app" } }
```

* Types are strict: `1.5` and `"2"` are not integers, and booleans must be
  `true` or `false`. `null` is accepted only where the tables say "or null";
  a whole section set to `null` is an error.
* A list you set replaces the default list; they are never merged. If you set
  `integration.sensitivePaths`, only your entries apply.
* Relative `repo.source` and `docs` paths are resolved against the folder of
  `config.json`, not your repository or current directory. Use absolute paths.
* Unknown keys are errors at every level, except `$schema` at the top level,
  which is ignored (`init` writes `"$schema": "autopilot-project-v1"`).

## Field reference

### Top level

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `version` | integer | required | `1` | Version of this file format. |
| `id` | string | required | 2-40 characters: `a-z`, `0-9`, `-`; starts with a letter or digit; same as the folder name | The project's key in the database, on cards and in commands such as `autopilot task add my-app "..."`. |
| `name` | string | the `id` | any text | Display name on cards, in notifications and in agent prompts. |
| `profile` | string | `"balanced_autopilot"` | `supervised`, `balanced_autopilot`, `integration_only`, `pause` | How much runs and merges without you. See [Profiles](#profiles). |

### `docs` and `charter`

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `docs` | list of strings | `[]` | file paths | Your product documents. Their paths are listed in the builder and planner prompts, and the folders that contain them are made accessible to every worker (Claude Code `--add-dir`). `autopilot doctor` reports missing files. |
| `charter` | string | `""` | any text | Standing instructions: what to build and what may be explored without asking. Builders get it in their task prompt as the project direction, and the planner gets it in its system prompt as its exploration rule. The reviewer does not see it. Builders are also told to follow your repository's own `CLAUDE.md` or `AGENTS.md`. |

### `repo` (required)

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `repo.source` | string | required | local path, URL (`scheme://…`, where the scheme is lowercase letters only, so `git+ssh://…` is treated as a path) or `git@…` address | The repository to work on. The autopilot clones it into a private clone in its home directory and never touches your working copy. |
| `repo.targetBranch` | string | `"main"` | 1-100 characters: letters, digits, `.`, `_`, `/`, `-`; no leading `-`, no `..` | The branch that tasks start from and merge into. On GitHub it is the pull request base. |
| `repo.branchPrefix` | string | `"autopilot/"` | 1-40 characters: letters, digits, `.`, `_`, `/`, `-` | Task branches are named `<prefix><task id>-<slug>`, for example `autopilot/t-1-add-login`. |
| `repo.forge` | string | `"local"` | `local`, `github` | `local`: the autopilot merges in its private clone. `github`: each task gets a pull request, which is merged with `gh pr merge`, and pull request feedback is read (see [`feedback`](#feedback-github-only)). |
| `repo.github` | string or null | `null` | `owner/name` | The GitHub repository. Required when `repo.forge` is `github`. |
| `repo.pushIntegratedTo` | string or null | `null` | same rules as `targetBranch`; must differ from `targetBranch` | Local forge only. After each merge, the merged work is pushed to this branch of `repo.source`, so you can pull or merge it when you like. With `null`, merged work stays in the private clone. |

The `pushIntegratedTo` branch is created by the first push with work your
target branch lacks. Pushes are never forced; a failed push (for example
after you committed to that branch) is only a warning. Do not check the
branch out in your working copy: git refuses to update a checked-out branch.
With `repo.forge: "github"` the setting is silently ignored.

### `execution`

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `execution.runner` | string | `"claude-cli"` | `claude-cli`, `fake` | `claude-cli` runs real Claude Code workers. `fake` runs a scripted demo that makes no Claude calls. |
| `execution.claudeBin` | string | `"claude"` | command name or path | The Claude Code executable for every worker. `autopilot doctor` checks it. |
| `execution.model` | string or null | `"opus"` | any model name (not checked) | The builder model, and the fallback for the planner and the reviewer. It is set so that a change of Claude Code's default model does not change your runs. `null` uses Claude Code's default. |
| `execution.plannerModel` | string or null | `null` | any model name | The planner model. `null` uses `execution.model`. |
| `execution.reviewerModel` | string or null | `null` | any model name | The reviewer model. `null` uses `execution.model`. |
| `execution.effort` | string or null | `null` | `low`, `medium`, `high`, `xhigh`, `max` | Passed as `--effort` to every worker. `null` leaves it out. |
| `execution.permissionMode` | string | `"auto"` | `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk` | The Claude Code permission mode for builders; it also decides their pre-approved tools (below). `bypassPermissions` requires `sandbox: true`. Reviewers and planners always run in `dontAsk` mode with read-only tools. |
| `execution.sandbox` | boolean | `false` | | Builders only: asks Claude Code to sandbox Bash commands and to allow the Bash commands that run inside the sandbox. |
| `execution.settingSources` | list of strings, or null | `["user"]` | entries `user`, `project`, `local` | Builders only: which Claude Code settings files are loaded (`--setting-sources`). The default loads only your user settings, so a branch's `.claude/settings.json` (hooks, environment, API key helper) cannot affect unattended runs. `null` uses Claude Code's default sources. Reviewers and planners always use `["user"]`. |
| `execution.allowedTools` | list of strings | `[]` | Claude Code permission rules (not checked) | Extra pre-approved tools, for builders only. |
| `execution.disallowedTools` | list of strings | six rules (below) | Claude Code permission rules (not checked) | Extra deny rules for every worker. |
| `execution.maxBuilders` | integer | `2` | 0-8 | How many builders may run at once in this project. `0` starts no new builds. |
| `execution.maxReviewers` | integer | `1` | 0-4 | How many reviewers may run at once. With `0` no agent reviews run, so if `integration.requireAgentReview` is `true`, every merge needs your approval on a card. |
| `execution.maxTurns` | integer | `120` | 1-1000 | `--max-turns` for every worker run. |
| `execution.runTimeoutMinutes` | integer | `45` | 1-600 | A run is stopped after this many minutes. |
| `execution.idleTimeoutMinutes` | integer | `10` | 1-120 | A run that prints nothing for this many minutes is stopped. |
| `execution.maxRepairCycles` | integer | `2` | 0-10 | How many times a task may go back to its builder (failed checks, merge conflicts, requested changes) before it stops with a diagnostic card. |
| `execution.maxAttempts` | integer | `4` | 1-20 | How many builder runs a task may use. Every builder start counts, repair runs included. When a run fails (or its workspace cannot be prepared) and the task has used this many, it stops with a diagnostic card. |

Pre-approved builder tools, besides the autopilot's own and `allowedTools`.
In every mode, anything that would ask for permission is denied.

| `permissionMode` | Pre-approved tools |
| --- | --- |
| `auto`, `bypassPermissions` | `Read`, `Glob`, `Grep`, `TodoWrite`, `Task`; in `auto` mode Claude Code decides about everything else |
| `acceptEdits` | the above plus `Bash`, `WebSearch`, `WebFetch` (the mode itself allows edits) |
| `dontAsk` | the above plus `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebSearch`, `WebFetch` |

The default `disallowedTools` is `["Bash(git push:*)", "Bash(git push)",
"Bash(gh pr merge:*)", "Bash(gh pr review:*)", "Bash(gh repo delete:*)",
"Bash(rm -rf /:*)"]`. These rules always apply anyway, so removing entries
allows nothing. Built-in rules also deny `gh pr`, `gh api`, `gh issue`,
`gh repo`, `gh release`, `gh auth` and `gh secret`; `git push`,
`git update-ref`, `git branch -f`, `git branch --force`, `git branch -D`,
`git branch -M`, `git commit-tree`, `git replace`, `git config`,
`git remote`, `git worktree` and `git -C`; common credential files (`~/.ssh`,
`~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`) and the autopilot's own
state. They also deny `Edit`, `Write` and `NotebookEdit` to reviewers and
planners.

### `planner`

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `planner.enabled` | boolean | `true` | | `false` turns the planner off. You then add tasks yourself with `autopilot task add`. |
| `planner.minQueue` | integer | `2` | 0-50, at most `maxQueue` | The planner runs when fewer than this many tasks are open (ready or in progress; tasks waiting for a card do not count), or when agents have proposed tasks. |
| `planner.maxQueue` | integer | `6` | 1-100 | The planner never fills the ready queue beyond this. |
| `planner.cooldownMinutes` | integer | `10` | 0-1440 | Minimum time between two planner runs. |
| `planner.maxTasksPerPlan` | integer | `5` | 1-30 | The most new tasks one planner run may create. |

The planner waits while the project has `inbox.maxPendingDecisions` or more
pending cards. It only gets read-only tools plus `WebSearch` and `WebFetch`.

### `checks`

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `checks.setup` | list of commands | `[]` | each command a non-empty list of strings, for example `[["npm", "ci"]]` | Prepares a worktree. Runs the first time, and again when the setup commands or a dependency manifest or lockfile change. Stops at the first failing command. Each command has a fixed 30-minute timeout. |
| `checks.commands` | list of objects | `[]` | see the next rows | The checks every branch head must pass before it can merge. The autopilot runs them itself and never relies on a worker's report of them. |
| `checks.commands[].name` | string | required | 1-40 characters: letters, digits, space, `.`, `_`, `:`, `-` | Names the check. A merge needs a passing result for each name on the exact commit. Names are not checked for uniqueness. |
| `checks.commands[].run` | list of strings | required | non-empty | The command and its arguments. It runs without a shell: use `["sh", "-c", "..."]` for shell syntax. |
| `checks.commands[].timeoutSeconds` | integer | `900` | 5-7200 | Time limit for this command. |

* All commands run in order, even after one fails, on every new branch head
  and again on the merged result before the target branch moves.
* Each runs in its worktree with your environment minus credentials,
  plus `CI=1` and `AUTOPILOT_PORT_BASE` (see
  [Environment variables](#environment-variables)). Values of variables whose
  names look secret are removed from the captured output.
* A setup failure when a builder starts is only noted on the task; before the
  checks, it counts as a failed check.
* Without checks, only the agent review and the merge rules gate a merge
  (`autopilot doctor` warns). When you have checks, the reviewer may also run
  a check command itself, exactly as configured and with no added arguments,
  if each of its words is plain (letters, digits and `_@%+=:,./-`).

### `integration`

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `integration.strategy` | string | `"squash"` | `squash`, `merge` | `squash` makes one commit per task. `merge` keeps the branch history and adds a merge commit. On GitHub: `gh pr merge --squash` or `--merge`. |
| `integration.autoMerge` | boolean | `true` | | Allows merging without you when every rule passes. It only has an effect under the `balanced_autopilot` and `integration_only` profiles. With `false`, eligible work becomes a review card. |
| `integration.requireAgentReview` | boolean | `true` | | `true`: after the checks pass, an agent reviews the change, and a merge needs a review of the exact commit. `false`: the task goes straight to the merge rules. |
| `integration.sensitivePaths` | list of globs | 25 patterns (below) | | A change that touches a matching file never merges on its own: you get a review card, and the change is rated at least medium risk. Matching ignores case. |
| `integration.protectedPaths` | list of globs | `[".autopilot/**", ".claude/settings.json", ".claude/settings.local.json"]` | must include `".autopilot/**"` | A branch that touches a matching file is never merged. It goes back to its builder with the instruction to revert those files, which uses one repair cycle. Matching ignores case. |
| `integration.allowedPaths` | list of globs | `[]` | | When not empty, auto-merge applies only if every changed file matches one of these. Matching is case-sensitive. |
| `integration.maxAutoMergeLines` | integer | `1500` | 0-100000 | A change with more added plus deleted lines than this needs a card. |
| `integration.maxOpenPrs` | integer | `3` | 1-50 | GitHub forge only: no new builder starts while this many tasks in progress have a pull request. |

Fixed rules: a branch with no changes, binary files or more than 25 deleted
files, a change rated high risk (by the task or the reviewer) and any
integration task never merge on their own; you get a card instead.

The 25 default `sensitivePaths` cover `.github/**`, `.env` files, keys and
`secrets/`, package manifests and lockfiles, `migrations/`, `supabase/` and
`*.sql`, `auth/`, `payments/` and `billing/`, deployment files (`Dockerfile`,
`vercel.json` and others), `CLAUDE.md` and `.claude/**`. The example file
lists all of them.

Globs match the whole path from the repository root. `*` and `?` never match
`/`, a `**` segment matches any number of folders (including none), `{a,b}`
lists alternatives and `[abc]` is a character class. A pattern without `/`
matches only at the root, so write `**/*.pem` rather than `*.pem`. A trailing
`/` means everything under that folder. Renamed files count under both names.

### `inbox`

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `inbox.maxPendingDecisions` | integer | `8` | 1-200 | When this project has this many pending cards or more, a new builder starts only while no builder is running, and the planner waits. |
| `inbox.ntfyUrl` | string or null | `null` | an `http://` or `https://` URL | An ntfy server, for example `https://ntfy.example.com`. ntfy is used only when both `ntfyUrl` and `ntfyTopic` are set. |
| `inbox.ntfyTopic` | string or null | `null` | 8-64 characters: letters, digits, `_`, `-` | The ntfy topic. It works like a password, so keep it secret; the autopilot never writes it to its logs. |
| `inbox.publicUrl` | string or null | `null` | an `http://` or `https://` URL | The link a notification opens. When `null`, ntfy notifications use `publicUrl` from `server.json`. |

Web Push to paired phones works without this section. Notifications carry
only the project name and a card count, never the question.

### `feedback` (GitHub only)

| Field | Type | Default | Allowed values | What it does |
| --- | --- | --- | --- | --- |
| `feedback.pollSeconds` | integer | `60` | 15-3600 | Minimum time between two checks for new pull request comments and reviews. |
| `feedback.trustedActors` | list of strings | `[]` | GitHub logins (case is ignored) | Only feedback from these accounts is used; other feedback is logged and ignored. With the default empty list, all pull request feedback is ignored. |

From a trusted account, an approving review of the current commit or a
comment `/approve <code>` (with the code from the card) counts as your
approval. A comment on a merged task creates a follow-up task; other comments
are added to the task and send it back to its builder if it awaits merging.

## Profiles

| Profile | Workers run | Merges without you | Your approval merges |
| --- | --- | --- | --- |
| `supervised` | yes | never: every eligible change becomes a card | yes |
| `balanced_autopilot` (default) | yes | yes, when `integration.autoMerge` is `true` and every rule passes | yes |
| `integration_only` | yes | same as `balanced_autopilot` | yes |
| `pause` | no | no | no |

`integration_only` requires a `repo.targetBranch` other than `main`,
`master`, `production` and `prod` (exact names); with one of those, the file
is invalid. Apart from that it behaves like `balanced_autopilot`. Use it to
collect work on a branch you merge yourself.

`pause` stops all scheduled work for the project (sync, checks, merges,
reviews, builds, planning), but running workers are not stopped and card
answers are still processed. Pausing a project in the inbox or with
`autopilot pause my-app` is a separate switch that leaves the file alone; the
inbox's Pause also stops running workers, `autopilot pause` lets them finish.

## Changing the config while the autopilot runs

The autopilot reads every `config.json` again about every 30 seconds and
compares a hash of the validated config, so whitespace or key-order changes
do nothing. Builders run as your user and could edit the file, so a change
never takes effect on its own: you get a card "Apply the changed policy file
for My App?" listing the changed sections (and the profile, if it changed),
and the project keeps its current policy until you answer.

* **Apply the new policy** (it needs an explicit tap) takes effect at once.
  Running workers continue, and new work uses the new policy.
* **Keep the current policy** keeps the old one, and this exact version is not
  proposed again. Any further edit raises a new card, replacing an older one.

The last approved config of each project is stored in the database. If a
`config.json` differs from it at startup, the project starts on the last
approved config and you get the same card. A project the autopilot has never
seen starts directly at startup. A project folder that appears while it runs
gets a card "Start the new project My App?" and does not run until you choose
**Start this project**. A deleted `config.json` takes effect at the next
restart; until then the project keeps its current policy.

`autopilot run --accept-config` is for files you edited yourself. At startup
it applies every valid `config.json` as it is on disk, and while running it
starts new projects without a card. Edits to a project that is already
running still need a card, or a restart with the flag.

## Validation

The whole file is validated before any of it is used, including the rules
that combine fields (described above). If anything is wrong, the
file is rejected and every problem is listed at once:

```text
Invalid autopilot config:
- repo.forge must be one of local, github (got "gitlab")
- execution.maxBuilders must be between 0 and 8 (got 12)
- checks.commands[0].shell is not a known setting
```

`autopilot doctor` shows the problems for each project. `autopilot run`
pauses a project it already knows, with the reason "invalid config: …".
Running workers are not stopped, but nothing new starts and nothing merges. A
project it has never loaded is skipped; its problems are printed at startup,
but a new project folder with an invalid file is skipped silently. The pause
ends by itself when a fixed version is applied, through a card or at the next
start. If you restore exactly the policy that was running, the autopilot sees
no change and the project stays paused until you run `autopilot resume my-app`
or restart the autopilot.

Some problems are only found when the project loads, and pause it the same
way: an empty `repo.source`, branch names that git considers unsafe (such as
`release.` or `a//b`) and a `repo.branchPrefix` starting with `-`. Model names and tool rules are passed to Claude Code
unchecked. A glob that cannot be compiled (for example a brace pattern with
more than 256 alternatives) only fails when a merge is evaluated, with an
error naming the setting.

## `server.json`

```json
{ "host": "127.0.0.1", "port": 4777, "publicUrl": "https://my-computer.example.com" }
```

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `host` | string | `"127.0.0.1"` | Address the inbox server listens on. `autopilot run --host` overrides it. |
| `port` | integer | `4777` | Port of the inbox server. `autopilot run --port` overrides it. |
| `publicUrl` | string or null | `null` | The URL your phone uses to reach the inbox, for example an HTTPS address on your private network. Used for pairing links and as the fallback link in ntfy notifications. Trailing slashes are removed. |

* The file is optional and never written by the autopilot. A missing file or
  invalid JSON silently gives all defaults, a field with the wrong type falls
  back to its default, unknown fields are ignored, and values are not
  otherwise checked (a `publicUrl` without `http://` or `https://` is kept).
* `autopilot run` prints the inbox address: `publicUrl`, or else
  `http://<host>:<port>`, with `0.0.0.0` shown as `127.0.0.1`.
* `autopilot pair` and `autopilot doctor` read only `server.json`: after
  `run --port`, both use the wrong port, and after `run --host`, `pair` uses
  the wrong address. `pair` also uses `host` as written, so with `0.0.0.0`
  and no `publicUrl` its link does not work on your phone.
* A `host` such as `0.0.0.0` or a LAN address makes the inbox reachable from
  that network; phones still need a pairing link to sign in. With a LAN
  address, the server also listens on `127.0.0.1`, because workers reach the
  autopilot through a bridge that only accepts local connections.

## Home directory layout

| Path in the home directory | What it holds | Created by | Permissions and secrets |
| --- | --- | --- | --- |
| (the home folder itself) | everything below | the CLI, mode 0700 | A folder that already exists keeps its mode. Keep it 0700: the files inside rely on it. |
| `autopilot.db` (and `-wal`, `-shm`) | SQLite database: projects and their last approved configs, policy history, tasks, runs, cards, events, inbox sessions and the Web Push key pair | the CLI | Default file mode. Secret: it holds the Web Push private key in plain text and copies of your configs (including any ntfy topic). Session tokens, pairing codes and run tokens are stored only as SHA-256 hashes. |
| `server.json` | inbox server settings | you (optional) | Not secret. |
| `claude-oauth-token` | a long-lived Claude Code token from `claude setup-token` | you (optional) | Secret. Run `chmod 600` on it; the CLI warns if others can read it, but still uses it. |
| `projects/<id>/config.json` | the project's policy | `autopilot init`, mode 0600 | Contains your ntfy topic if you set one. |
| `projects/<id>/repo.git/` | the private bare clone of `repo.source` | the supervisor | Default modes. |
| `projects/<id>/worktrees/` | one working tree per task (named by task id), plus `_integration/` for merging and `_planner/` for the planner | the supervisor | Default modes. |
| `runs/<run id>/stream.jsonl` | the full transcript of one worker run, shown by `autopilot logs <run id>` | the supervisor | Default modes. It can contain anything a worker read or printed. |
| `logs/supervisor.log` | output of the macOS background service | `autopilot service install` (folder mode 0700) | Never rotated. It contains the pairing link printed at each start, valid for 10 minutes. |

Outside the home directory, each Claude run gets a private temporary folder
(`$TMPDIR/autopilot-run-*`, mode 0700) whose `mcp-config.json` (mode 0600)
holds the run's token for the tool bridge until the run ends. On macOS,
`service install` writes `~/Library/LaunchAgents/com.stayon.autopilot.plist`.
Your working copy is never written to. With the local forge, only
`repo.pushIntegratedTo` pushes a branch to your repository. With the GitHub
forge, task branches are pushed to `repo.source` and merged there through pull
requests. `init --create` creates the repository.

Builders work inside the home directory, in their worktrees. Claude Code
permission rules deny all workers reading or editing `autopilot.db*`,
`claude-oauth-token` and `projects/*/config.json`, editing `server.json`, and
reading `runs/**`. These are permission rules, not file permissions: workers
run as your user. That is why config changes wait for your approval.

## Environment variables

Variables the autopilot reads:

| Variable | Effect |
| --- | --- |
| `AUTOPILOT_HOME` | The home directory when `--home` is not given. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The Claude Code token for workers. If it is not set, `run` and `doctor` read it from `<home>/claude-oauth-token`. A value in the environment wins over the file. The macOS background service does not inherit your shell's environment (its definition sets only `PATH` and `HOME`), so a token exported in your shell does not reach it; use the file there. |
| `HOME` | Used for the default home directory, to expand `~` in `init --source` and `--docs`, and by `service install`. |
| `PATH` | Used to find `claude`, `git`, `gh` and your check commands. `service install` writes its own `PATH` into the service definition, with the folders of `node`, `claude`, `git` and `gh`. |
| `TMPDIR` | Where the private per-run folders are created. |
| `ANTHROPIC_API_KEY` | Never used for runs. `autopilot doctor` mentions it when it is set. |

Variables the autopilot removes:

* From Claude workers: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_PROFILE`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_BEDROCK_BASE_URL`,
  `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`
  and `AWS_BEARER_TOKEN_BEDROCK`, so runs use your Claude subscription login,
  never API billing. Also the variables of an enclosing Claude Code session
  (`CLAUDECODE` and session-specific `CLAUDE_CODE_*` variables), so you can
  start the autopilot from inside Claude Code. `CLAUDE_CODE_OAUTH_TOKEN` stays.
* From setup and check commands: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`,
  `AWS_BEARER_TOKEN_BEDROCK`, `GOOGLE_APPLICATION_CREDENTIALS`, `GH_TOKEN`,
  `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`.
* From setup and check commands and from git: variables that point git at
  another repository, such as `GIT_DIR`, `GIT_WORK_TREE` and
  `GIT_INDEX_FILE`. Git always runs with `GIT_TERMINAL_PROMPT=0`.

Variables the autopilot sets:

| Variable | Set for | Value |
| --- | --- | --- |
| `CI` | setup and check commands | `1` |
| `AUTOPILOT_PORT_BASE` | setup and check commands | A port number between 40000 and 48990, derived from the worktree's path, so parallel worktrees normally get different blocks of 10 ports. Test servers can use `AUTOPILOT_PORT_BASE` to `AUTOPILOT_PORT_BASE + 9`. |
| `AUTOPILOT_TASK_ID`, `AUTOPILOT_ROLE` | Claude workers | The task id (for example `T-1`; empty for the planner) and the role: `builder`, `reviewer` or `planner`. |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` | Claude workers | `1`, so a worker that fails to start still reports a result. |
| `GIT_NO_REPLACE_OBJECTS`, `GIT_GRAFT_FILE` | Claude workers and the autopilot's own git | `1` and `/dev/null/no-grafts` (a path that cannot exist), so git ignores replace refs and grafts that a worker writes into the shared repository. |
| `GIT_CONFIG_PARAMETERS` | Claude workers | Your value, if any, plus `core.useReplaceRefs=false`: git before 2.42 lets a repository's own config switch replace refs back on. The autopilot's own git passes the same setting with `-c`. |
| `AUTOPILOT_API_URL`, `AUTOPILOT_RUN_TOKEN` | the autopilot's tool bridge | The local API address and the run's token. They are internal; do not set them yourself. |
