# Security policy

StayOn Autopilot starts AI agents that read, write and run code on your machine
with your user account's permissions, and it serves a local web inbox that can
approve their work. We take reports seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
**Report a vulnerability** (Security tab of this repository) rather than a
public issue. Include the version or commit, your OS, steps to reproduce and the
impact. We aim to reply within a week.

## Supported versions

While the project is at 0.x, fixes go to `main` and the latest release only.

## Scope

In scope: the supervisor, the local HTTP API and inbox, pairing and sessions,
the agent tool bridge, git handling, the merge policy and its enforcement,
secret handling and notifications. Examples: an agent that can approve or merge
its own work, change the policy without a card, read the supervisor's database
or tokens through its tools, or push to the target branch undetected; reaching
the inbox without pairing; card text leaking into notifications.

Out of scope: problems in Claude Code, GitHub, Tailscale or other tools the
autopilot drives (please report those to their vendors), and attacks that
already require running code as your user account, which the current threat
model does not cover.

## Threat model in short

The autopilot defends against confused or careless agents and against
prompt-injected attempts that go through git, `gh` or Claude Code's file tools —
not against code running with your user's privileges. Builders run shell
commands and your checks run code they wrote, all as your OS user, so OS-level
isolation (a separate user account or a VM) is the boundary for stronger
guarantees. Details:
[docs/architecture.md](docs/architecture.md#security-boundaries).

What the project commits to:

- The inbox listens on `127.0.0.1` unless you configure otherwise, needs a
  session from a single-use pairing link, and requires a CSRF header for every
  write. `autopilot run` warns when it serves the inbox over plain HTTP on a
  non-loopback address, unless `publicUrl` is an `https://` address; use
  Tailscale Serve (HTTPS) to reach it from your phone.
- Worker environments have API-key variables removed, so runs use your Claude
  subscription and never fall back to paid API billing.
- Builders are denied the tools to push, merge or approve; only the supervisor
  integrates, after checks, an independent review and the policy pass on the
  exact commit.
- Notifications carry only the project name and a count, never card text.
- No telemetry: the supervisor itself contacts only Claude Code, your git
  remotes, GitHub through `gh`, the push service of your phone's browser (Apple,
  Google, Mozilla or Microsoft) and your ntfy server if configured. Agents can
  reach the network through Claude Code's tools (the planner may use WebSearch
  and WebFetch; builders and checks can download packages).
