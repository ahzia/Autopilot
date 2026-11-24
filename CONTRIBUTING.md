# Contributing to StayOn Autopilot

Thanks for helping. StayOn Autopilot is small on purpose; please keep changes
focused, and open an issue first for anything larger than a fix.

## Setup

1. Install Node.js 24 or newer and git. Claude Code is needed only to run real
   workers, not to develop or test.
2. `npm install`
3. Try the scripted demo, which uses no Claude usage (see *Quick start* in the
   [README](README.md)).

## Before you open a pull request

```bash
npm run check
```

That runs `tsc` and the whole test suite: unit tests plus end-to-end failure
drills that run the real supervisor, git integration and check runner against
temporary repositories with scripted agents. It needs no network, no Claude or
GitHub login and no global git configuration; please keep it that way.

Also:

- Add or update a test for behaviour you change. Supervisor behaviour belongs in
  a drill (`test/drills/`).
- If you change how real `claude -p` runs are started or read
  (`src/runner/claude-cli.ts`, `src/runner/stream.ts`), also run
  `npm run smoke` (needs a logged-in `claude`; uses a few minutes of your
  subscription) and say in the pull request that you did.
- Update the docs when you change a command, a default, the configuration
  format or the [card protocol](docs/card-protocol.md).
- Add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Sign off your commits (DCO)

Contributions are accepted under the [MIT license](LICENSE) and the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): by
signing off, you certify that you wrote the change or otherwise have the right
to submit it under the project's license.

Sign off every commit with `git commit -s`, which adds a line like this to the
commit message, using the name and email from your git configuration:

```
Signed-off-by: Your Name <you@example.com>
```

Pull requests with commits that are not signed off cannot be merged. To add a
missing sign-off, run `git commit --amend -s` for the last commit or
`git rebase --signoff main` for all commits on your branch, then force-push your
branch.

## Ground rules for the code

- **No runtime dependencies.** Node's standard library covers everything the
  supervisor needs; new dependencies need discussion first.
- **Policy lives in code, not in prompts.** Anything that decides whether work
  may merge, publish or run must be enforced by the supervisor, never only by
  instructions to an agent.
- **Fail closed.** Unknown configuration keys, missing check results or an
  unclear review lead to a stop or a card, never to a merge.
- **Agent text is data.** Render it with `textContent`, never execute or
  interpolate it into shell commands.
- **Tests never touch real user state.** Use temporary directories, set
  `AUTOPILOT_HOME`, and use the fake `claude` and `gh` in `test/fixtures/`.
- **Erasable TypeScript only.** Node runs the sources directly with type
  stripping, so no enums, namespaces or parameter properties (`tsc` enforces
  this with `erasableSyntaxOnly`).
- Start every source file with `// SPDX-License-Identifier: MIT` (right after
  the `#!` line in executable scripts).

## Reporting bugs

Open an issue with your OS, `node --version`, `claude --version` (for real
runs), what you did, what you expected, and the relevant log lines (remove
anything private first). Security problems: see [SECURITY.md](SECURITY.md).
