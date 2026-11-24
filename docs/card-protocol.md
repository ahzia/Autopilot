# Card protocol

**Status: Experimental, version 0: may change before 1.0.**

A *card* is a question that StayOn Autopilot needs you to answer: a product
choice, a review of one exact commit, a permission, or a way forward when work
is stuck. The protocol has two sides. On the **agent side**, Claude Code
workers raise cards by calling tools of a small MCP server that every run gets;
the server forwards each call to the supervisor over a loopback-only HTTP
route. On the **inbox side**, a client such as the bundled phone inbox reads
and answers cards through the supervisor's local JSON API, using a paired
session. Every answer names the card revision it answers and carries an
idempotency key, and it reaches the waiting work through a durable outbox.

Conventions: times are Unix epoch milliseconds. Ids look like `D-1` (card),
`T-1` (task) and `R-1` (run). JSON examples use placeholder values.

## 1. Concepts and lifecycle

### 1.1 Kinds

| Kind | Raised by | Used for | Effect of the answer |
|---|---|---|---|
| `choice` | agents, the planner | Product, design or scope questions | Delivered to the task as a note; a parked task resumes |
| `review` | supervisor | Judging one exact commit before it merges | `approve` merges that commit; any other answer requests changes (section 5) |
| `authorization` | supervisor | One exact operation on one exact artifact (today: applying a changed project policy file, or starting a project that was added while Autopilot runs) | The chosen option is carried out |
| `diagnostic` | supervisor | Work cannot progress: a task is blocked or stuck, a sign-in is needed, a merge was refused, the planner keeps failing | The option says how to go on, for example `retry`, `resume` or `cancel` |
| `info` | nobody yet | Reserved for cards that need no answer | None |

Agent cards are always stored as `choice`, whatever kind the agent asked for.
Only the supervisor's own cards can approve a merge, apply a policy, resume
paused work or cancel a task.

### 1.2 Statuses

| Status | Meaning |
|---|---|
| `pending` | Waiting for an answer. A deferred card is still `pending`. |
| `answered` | Has an `answer`. Final. |
| `superseded` | Closed without an answer: the task was retried; (review cards) the task went back for repair, merged or was approved on GitHub; or (policy and repository-setup cards) the policy file changed again, Autopilot restarted, or the repository became ready. |
| `cancelled` | Closed without an answer: the task was cancelled. |

Only a pending card changes status. Cards never expire: no answer means
pending, never permission. When a task is retried or cancelled, a card that
another task raised or still waits on stays open for that task.

### 1.3 Blocking and non-blocking

- **Blocking** (`blocking: true`, the default for agents): every task in
  `blockedTaskIds` waits. When the asking run ends, its task is parked in state
  `waiting_decision` until no pending blocking card lists it. Other tasks keep
  running.
- **Non-blocking** (`blocking: false`): work goes on with the recommended
  option. The card names its task in `taskId` and has an empty
  `blockedTaskIds`. The answer reaches the task as a note (section 3.7).

### 1.4 Revisions

Every card has a `revision`, starting at 1. An answer must name the revision it
answers; any other revision gets `409 stale_revision` and the current card. No
code path revises cards today, so every card stays at revision 1; when a
card's subject changes, the supervisor closes it and raises a new one. Clients
must still send the revision they showed.

### 1.5 Deduplication

When a request carries a `dedupeKey` that a **pending** card of the same
project already has, no new card is created. If the request is blocking and
comes from a task, that task is added to the card's `blockedTaskIds` and the
card becomes blocking even if it was not. The new question text, options and
recommendation are discarded, not compared, and no notification is sent.
Answered and closed cards never absorb requests, so a key can be asked again
later. Agent keys are stored as `agent:<key>`, so agent questions merge only
with each other. A non-blocking request that merges into another task's card
is not recorded on the card, so its task gets no note when the card is answered.

### 1.6 Options, recommendation and comments

| Option field | Meaning |
|---|---|
| `id`, `label` | Stable id (unique within the card) and the text you tap |
| `tradeoff` | Optional one-sentence consequence |
| `consequential` | Needs an explicit tap. Only clients enforce this; the server accepts it like any other option. |
| `requiresComment` | The server refuses this option without a comment. |

A card without options is a free-text card: the answer is a comment. The
card-level `recommendation` holds the recommended option id (or `null`) and
`recommendationReason` explains it. `allowComment` says whether comments are
accepted; every card raised today accepts them. Comments are trimmed, a
whitespace-only comment counts as none, and at most 4000 characters are kept.
A comment-only answer is accepted on any card except an `authorization` card
that has options. Agents can set `id`, `label` and `tradeoff` only.

### 1.7 Deferring ("Later")

Deferring sets `deferredUntil` to now plus 1 to 168 hours. It is not a status:
the card stays pending, keeps its revision and can be answered at any time. The
list shows it last, marked `deferred: true`, until the time passes. No endpoint
clears a deferral early. Deferring does not affect the task or the agent.

## 2. The card object

`GET /api/decisions` and task details return cards in this shape. The last four
fields are added by the API; the rest is the stored card.

```json
{
  "id": "D-1", "projectId": "my-app", "taskId": "T-1", "blockedTaskIds": ["T-1"],
  "kind": "choice", "revision": 1, "status": "pending",
  "question": "Where should session data be stored?",
  "why": "The sync feature depends on this choice.",
  "options": [
    { "id": "local_only", "label": "Keep data on the device", "tradeoff": "No sync between devices." },
    { "id": "server", "label": "Store it on the server" }
  ],
  "recommendation": "local_only",
  "recommendationReason": "Simplest option, and easy to change later.",
  "allowComment": true, "blocking": true, "priority": "normal",
  "blockedSummary": "T-1 waits for this answer.",
  "continuesSummary": "Other tasks keep running.",
  "links": [{ "label": "Preview", "url": "https://example.com/preview" }],
  "artifactRef": null, "createdBy": "agent", "createdByRun": "R-1",
  "dedupeKey": "agent:storage:sessions", "deferredUntil": null, "answer": null,
  "createdAt": 1767225600000, "updatedAt": 1767225600000,
  "taskTitle": "Add session storage", "taskState": "building",
  "projectName": "my-app", "deferred": false
}
```

| Field | Notes |
|---|---|
| `taskId` | Task that raised the card; `null` for project-level cards (planner questions, some supervisor cards) |
| `priority` | `low`, `normal`, `high` or `urgent` |
| `question`, `why` | At most 1000 and 4000 characters (500 and 2000 for agent cards). On GitHub review cards `why` normally ends with an approval code (section 5). |
| `recommendationReason`, `blockedSummary`, `continuesSummary` | At most 2000, 1000 and 1000 characters |
| `links` | `{label, url}`; `url` is absolute http(s) or an inbox path such as `/#task=T-1`; at most 12 (10 for agent cards) |
| `artifactRef` | Exact commit sha (review cards) or content hash (authorization cards), else `null` |
| `createdBy` | `agent`, `planner` or `supervisor`; `reviewer` is reserved and never written |
| `dedupeKey` | As stored: agent keys start with `agent:` |
| `taskTitle`, `taskState`, `projectName` | From the card's task and project, or `null` |

The answer object:

```json
{ "optionId": "server", "comment": "We need sync next month.", "actor": "founder", "revision": 1, "at": 1767229200000 }
```

`optionId` is `null` for a comment-only answer (or `""` if the client sent an
empty string), `comment` is `null` when there is none, and `actor` is always
`"founder"` for answers given through the inbox API (`"founder (cli)"` for
answers given with `autopilot answer`). All text fields are plain text: render
them as text, never as HTML.

## 3. Agent side

### 3.1 The MCP server

Every worker run starts Claude Code with an MCP config holding one stdio server
under the key `autopilot`. The config, which includes the run's token, is
written to a private file (mode 0600) and passed with
`--mcp-config <file> --strict-mcp-config`, so the token never appears on a
command line. The server is marked `alwaysLoad`, so tool search never defers
its tools. The model sees them as `mcp__autopilot__<tool>`:

| Tool as the model sees it | Builder | Reviewer | Planner | Purpose |
|---|---|---|---|---|
| `mcp__autopilot__request_decision` | yes | | | Raise a card |
| `mcp__autopilot__check_decision` | yes | | | Read a card's status and answer |
| `mcp__autopilot__get_task_context` | yes | yes | | Task brief, notes and the task's cards |
| `mcp__autopilot__propose_task` | yes | yes | | Propose a follow-up task |
| `mcp__autopilot__report_progress` | yes | yes | yes | Post a short progress note |

Planners ask through the `questions` field of their structured result instead:
at most two per plan, always non-blocking, not tied to a task.

The server gets `AUTOPILOT_API_URL` (always `http://127.0.0.1:<port>`),
`AUTOPILOT_RUN_TOKEN` and `AUTOPILOT_ROLE`, and speaks newline-delimited
JSON-RPC 2.0 on stdin and stdout:

- It implements `initialize`, `ping`, `tools/list` and `tools/call` (others get
  `-32601`, batches `-32600`). `initialize` returns `serverInfo`
  `{"name": "stayon-autopilot", "version": "0.1.0"}`; it echoes protocol
  version `2025-06-18`, `2025-03-26` or `2024-11-05` and answers any other
  request with `2025-06-18`.
- `tools/list` returns the role's tools with bare names and JSON schemas (all
  five if `AUTOPILOT_ROLE` is missing or unknown; the HTTP API still enforces
  the role). Calling a tool not listed for the role gives JSON-RPC error
  `-32602` and is not forwarded.
- HTTP 200 becomes text content holding the JSON body. Any other status becomes
  `isError: true` with the body's `message` (else its `error`, else
  `HTTP <status>`): the model sees the message, not the status code.
- No answer within 10 seconds, or no connection, gives `isError: true` with
  "The autopilot supervisor is unreachable (...). Finish your current step,
  commit your work, and end your run; do not keep retrying autopilot tools."

### 3.2 request_decision

| Argument | Rules |
|---|---|
| `question` | Required, at most 500 characters |
| `why` | At most 2000 |
| `options` | Omit (or `null` or `[]`) for a free-text card; otherwise 2 to 6 objects `{id, label, tradeoff?}`: `id` matches `^[a-z0-9_-]{1,40}$` and is unique, `label` is one line of at most 120, `tradeoff` at most 500 |
| `recommendation` | Required with options and must be one of their ids; refused without options |
| `recommendationReason` | At most 2000 |
| `blocking` | Default `true` |
| `priority` | `low`, `normal` (default), `high` or `urgent`; `urgent` needs `blocking: true` |
| `kind` | `choice` (default) or `review`; checked, but the card is always stored as `choice` |
| `dedupeKey` | Matches `^[a-z0-9:_-]{1,80}$`; stored as `agent:<key>` |
| `links` | At most 10 `{label, url}`: `label` one line of at most 120; `url` an absolute http(s) URL of at most 2000, without user name or password |
| `blockedSummary`, `continuesSummary` | At most 1000 each |

Text is trimmed before it is checked, and an empty optional string counts as
absent. Control characters other than tab, carriage return and line feed are
refused, and labels and URLs must be one line. The server ignores unknown
arguments, although the published schema forbids them. An agent cannot set the
card's task (it is the run's task), `artifactRef`, `allowComment`,
`consequential` or `requiresComment`.

A run may have at most **5 pending cards** that it created; a request that
merges into an open card with the same key does not count. Over the limit the
call fails with `429 limit_reached`. When the project's pending cards
(including the new one) reach the setting `inbox.maxPendingDecisions`
(default 8), the result adds `backlogWarning`, but the card is still created.

```json
{
  "decisionId": "D-1", "deduped": false, "status": "pending", "blocking": true,
  "instructions": "Recorded as D-1. Do NOT wait for the answer. Finish and commit any work that does not depend on it, then end your run with status needs_decision; you will be resumed with the answer."
}
```

Non-blocking requests get "Recorded. Continue with your recommended option,
keep it easy to change, and note the assumption in your summary."
`deduped: true` means the request merged into the card `decisionId`.
`blocking` repeats the request, not the card's own flag.

### 3.3 check_decision and get_task_context

`check_decision` takes `{"decisionId": "D-1"}` (pattern `^D-[0-9]{1,9}$`;
lower case is accepted). It can read any card of the run's project, including
other tasks' and supervisor cards; another project's card is `404 not_found`.

```json
{ "id": "D-1", "status": "answered", "revision": 1,
  "answer": { "optionId": "server", "optionLabel": "Store it on the server", "comment": null, "revision": 1, "at": 1767229200000 } }
```

`answer` is `null` until the card is answered; `optionLabel` is `null` for a
comment-only answer. The tool description tells the model not to poll: answers
to blocking cards arrive when the run is resumed.

`get_task_context` takes no arguments. Besides the task brief, the last 20
notes and the project charter, it returns `decisions`: up to 50 cards of any
status that the task raised or waits on, oldest first, as
`{id, kind, status, blocking, question, options, recommendation, answer}`.
The agent tools never return `why`. A run without a task gets `404 not_found`.

### 3.4 Errors

Failure bodies are `{"error": "<code>", "message": "<text>"}`. Checks run in
this order: token, lease, tool name, role, arguments.

| HTTP | `error` | When |
|---|---|---|
| 401 | `unauthorized` | Unknown token, or the run has ended |
| 409 | `lease_lost` | The task lease expired or went to another run; the message tells the agent to stop |
| 404 | `unknown_tool` | Not one of the five tools |
| 403 | `forbidden` | The tool is not available to the run's role |
| 400 | `invalid` | Argument check failed (`Invalid arguments for <tool>: ...`) |
| 429 | `limit_reached` | Open-card limit (5 per run) or proposal limit (3 per run) |
| 404 | `not_found` | Unknown card, another project's card, or a run without a task |
| 500 | `internal` | Unexpected error |

### 3.5 The HTTP route behind the tools

```http
POST /agent/tools/request_decision HTTP/1.1
Host: 127.0.0.1:<port>
Authorization: Bearer <run token>
Content-Type: application/json

{"question":"Where should session data be stored?","blocking":false}
```

1. Only direct loopback connections (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`)
   without the proxy headers `Forwarded`, `X-Forwarded-For`,
   `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` or
   `Tailscale-User-Login` are served. Anything else under `/agent` gets
   `403 {"error":"agent tools are only reachable from this machine"}`.
2. The path must be `/agent/tools/<name>` (else 404) and the method POST (else
   405). `Authorization: Bearer <token>` (8 to 1024 non-space characters) is
   required, else `401 {"error":"missing bearer token"}`.
3. The body is a JSON object of at most 64 KiB; an empty body counts as `{}`.
   `Content-Type` is optional, but when present it must be JSON.

These transport errors carry `error` but no `message`. Each run (resumes
included) gets a new random 256-bit token, stored only as a SHA-256 hash and
valid only while the run is running. There is no other rate limit.

### 3.6 Yield and resume (blocking cards)

1. The builder calls `request_decision`, commits the work that does not depend
   on the answer, and ends its run with the result `status: "needs_decision"`.
   The run is recorded as `yielded`; its token stops working.
2. The supervisor commits leftovers on the task branch (skipping new files
   that look like secrets), saves the builder's summary as a task note and, while a
   pending blocking card lists the task, parks it in `waiting_decision`
   (reason `waiting on D-1`). A builder that returned `completed` is parked too.
   If the run ended with `needs_decision` but no blocking card is pending, the
   task goes straight back to `ready` when the run raised any card itself
   ("answered while R-1 was finishing"). Otherwise, and always for `blocked`,
   the supervisor raises its own blocking `diagnostic` card (options `retry`
   and `cancel`) and parks the task on it.
3. You answer. The task that asked and every task in `blockedTaskIds` get the
   note `Founder answered D-1 ("<question>"): <option label> — comment: "<comment>"`
   (the label reads `comment only` when you chose no option). A parked task
   returns to `ready` once no pending blocking card lists it.
4. The next builder run resumes the same Claude Code session
   (`--resume <session id>`) with a new run id, token and MCP config. Its
   prompt starts with `You are being RESUMED on this task. Why: decision D-1 answered`
   and lists the task's open and answered cards, such as
   `- D-1 [choice] <question> -> ANSWERED: <label> — founder comment: "<comment>"`
   or `-> PENDING (recommended: <label>)`. The system prompt tells the builder
   to call `get_task_context` first.

Surprising cases: a run that raised only non-blocking cards and returned
`needs_decision` is resumed at once. A run that failed is handled as a failure
first, so its task returns to `ready` (or `exhausted`) and can be dispatched
again while its blocking card is still pending.

### 3.7 Non-blocking cards

The builder continues with its recommendation and notes the assumption. When
you answer, the asking task gets the note above. If you chose another option
than the recommendation, and the task is neither cancelled nor parked, the
supervisor creates a task `Apply founder decision D-1: <label>` (priority 2,
state `ready`, same owned paths). While the asking task is not yet integrated,
the new task depends on it and may finish without changes. Comment-only
answers, answers that match the recommendation and free-text cards only add the
note. A late answer, after the task merged, still creates the follow-up task.
Surprising: this rule ignores `blocking`, so a blocking card answered with
another option while its run is still finishing also creates one.

## 4. Inbox side

### 4.1 Pairing and sessions

`autopilot run` (at start) and `autopilot pair` print a pairing link such as
`https://autopilot.example.com/#code=<pairing code>`, based on the configured
public URL, else `http://<host>:<port>`. The code sits in the URL fragment, so
the browser never sends it in a request line. It is 32 random URL-safe
characters, valid for 10 minutes, usable once, and stored only as a hash.

`POST /api/pair` with `{"code": "<pairing code>"}` returns:

- `200 {"authenticated": true, "csrf": "<csrf token>"}` with
  `Set-Cookie: ap_session=<session token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  plus `; Secure` when the request came over HTTPS (directly, or with
  `X-Forwarded-Proto: https`). A session the request already carried is
  replaced.
- `401 {"error":"invalid, used or expired pairing code"}` for any bad code.
- `429 {"error":"too many pairing attempts; wait a minute"}` with
  `Retry-After` after 10 attempts per minute (all clients, any outcome).

A session lasts 30 days from pairing; use does not extend it.
`GET /api/me` always returns 200 with `{"authenticated": true, "csrf": "..."}`
or `{"authenticated": false}`; since the cookie is HttpOnly, this is how a
client gets the CSRF token back after a reload. `POST /api/logout` returns
`200 {"authenticated": false}` and clears the cookie; with a valid session it
needs the CSRF header and deletes the session. No endpoint lists sessions or
signs out another device.

### 4.2 Request rules

Every `/api` request is checked in this order:

1. No route for the path: `404 {"error":"not found"}`. Wrong method (HEAD and
   OPTIONS included): `405 {"error":"method not allowed"}` with `Allow`.
2. Session route without a valid cookie: `401 {"error":"not signed in"}`.
3. Non-GET requests only:
   - **Origin.** If present, its host and port must equal the `Host` header or
     the first `X-Forwarded-Host` value; `Origin: null` fails, no `Origin`
     passes. Else `403 {"error":"origin not allowed"}`.
   - **CSRF** (session routes). `X-CSRF-Token` must equal the session's CSRF
     token (the `csrf` value from `/api/pair` or `/api/me`), else
     `403 {"error":"csrf","message":"missing or invalid X-CSRF-Token header"}`.
   - **Pairing limit** (`POST /api/pair` only): `429` (4.1).
   - **Body.** No body counts as `{}`. Otherwise `Content-Type` must be
     `application/json` or `application/*+json` (else 415), the body at most
     64 KiB (else `413 {"error":"body too large","limit":65536}`), valid JSON
     (else `400 {"error":"malformed JSON"}`) and an object (else 400).

The server sends no CORS headers. Errors are `{"error": "<text>"}`: 500
`{"error":"internal error"}` when unexpected, 400 with the reason when the
supervisor refuses an action (such as retrying a task in the wrong state).
Card answers use their own shape (4.5).

### 4.3 Endpoints

`{id}` is 1 to 64 of `A-Z a-z 0-9 _ -`. Session routes can also return the
errors of 4.2.

| Method and path | Auth | Request | Success, other statuses |
|---|---|---|---|
| `POST /api/pair` | public | `{code}` | `200 {authenticated, csrf}` and cookie; 401, 429 |
| `GET /api/me` | public | | `200 {authenticated, csrf?}` |
| `POST /api/logout` | public | | `200 {authenticated: false}`; 403 |
| `GET /api/overview` | session | | `200 {now, pausedAll, usagePausedUntil, pendingDecisions, projects, activeRuns}` |
| `GET /api/decisions` | session | `?status=&project=` | `200 {decisions}`; 400 (4.4) |
| `POST /api/decisions/{id}/respond` | session | `{revision, optionId, comment, idempotencyKey}` | `200 {status, decision}`; 400, 404, 409 (4.5) |
| `POST /api/decisions/{id}/defer` | session | `{hours}` | `200 {decision}`; 400, 404, 409 (4.6) |
| `GET /api/tasks` | session | `?project=` | `200 {tasks}` |
| `POST /api/tasks` | session | `{projectId, title, objective, acceptanceCriteria?}` | `200 {task}`; 400 |
| `GET /api/tasks/{id}` | session | | `200 {task, runs, checks, review, decisions, events}`; 404 |
| `POST /api/tasks/{id}/retry` | session | | `200 {task}`; 400, 404 |
| `POST /api/tasks/{id}/cancel` | session | | `200 {task}`; 400, 404 |
| `GET /api/tasks/{id}/diff` | session | | `200 {baseCommit, headCommit, files, patch, truncated}`; 404 |
| `GET /api/digest` | session | `?hours=&project=` | `200 {since, hours, truncated, integrated, failures, answered, usage, counts}` |
| `POST /api/pause` | session | `{scope, paused, reason?}` | `200 {ok, scope, paused}`; 400, 404 |
| `GET /api/push/key` | session | | `200 {publicKey, subscriptions}` |
| `POST /api/push/subscribe` | session | browser `PushSubscription` JSON | `200 {subscribed: true, subscriptions}`; 400 |
| `POST /api/push/unsubscribe` | session | `{endpoint}` | `200 {subscribed: false}` |
| `POST /api/push/test` | session | | `200 {sent}`; 409 when no device subscribed |

There is no single-card endpoint: use the list, or the `decisions` of
`GET /api/tasks/{id}` (up to 50 cards). `retry` closes the task's pending cards
as `superseded`, `cancel` as `cancelled` (shared cards stay open, see 1.2). `POST /api/pause` takes `scope`
`"all"` or a project id. Push endpoints must be https on (subdomains of)
`push.apple.com`, `fcm.googleapis.com`, `android.googleapis.com`,
`push.services.mozilla.com` or `notify.windows.com`.

### 4.4 Listing cards

`GET /api/decisions?status=<status>&project=<project id>` returns
`{"decisions": [<card>, ...]}`.

- `pending` (default): every pending card (up to 1000), cards that are not
  deferred first, then `urgent`, `high`, `normal`, `low`, then oldest first.
- `answered`: the 50 most recently answered cards.
- `all`: the pending list, then the 50 most recently closed cards.
- Anything else: `400 {"error":"status must be pending, answered or all"}`.

### 4.5 Answering a card

```http
POST /api/decisions/D-1/respond HTTP/1.1
Cookie: ap_session=<session token>
X-CSRF-Token: <csrf token>
Content-Type: application/json

{"revision": 1, "optionId": "server", "comment": "We need sync next month.", "idempotencyKey": "<random uuid>"}
```

`revision` (integer) and `idempotencyKey` (string) are required. `optionId`
and `comment` are strings, or `null` or omitted. The server checks in this
order, saving in one transaction:

1. Body types. Reasons: `revision must be an integer`,
   `optionId must be a string`, `comment must be a string`,
   `idempotency key missing`.
2. Key: under 8 characters is `idempotency key missing` (only the first 200
   count); used for another card, `idempotency key reused for another decision`;
   used for this card, `duplicate` with the stored card, whatever the body.
3. Card: `not_found`, `not_pending`, then `stale_revision`.
4. Answer: `comments are not accepted on this card`,
   `choose an option or write a comment`, `unknown option <id>`,
   `"<label>" needs a comment`, `authorization cards need an explicit option`.
5. Saved: the answer, the new status and an outbox event, together.

| Outcome | HTTP | Body |
|---|---|---|
| Saved | 200 | `{"status":"saved","decision":<card>}` |
| Duplicate | 200 | `{"status":"duplicate","decision":<card>}` |
| Stale revision | 409 | `{"status":"stale_revision","currentRevision":1,"decision":<card>}` |
| Not pending | 409 | `{"status":"not_pending","decisionStatus":"answered","decision":<card>}` |
| Invalid | 400 | `{"status":"invalid","reason":"<reason>"}` |
| Unknown card | 404 | `{"status":"not_found","error":"decision not found"}` |

Use a new random key for each distinct answer and the same key to retry it
after a network error (a saved first attempt then returns `duplicate`). A
refused attempt does not use up its key. After `stale_revision`, show the
returned card and ask again; after `not_pending` or `not_found`, drop the card.

### 4.6 Deferring a card

`POST /api/decisions/{id}/defer` with `{"hours": 4}` (1 to 168, fractions
allowed) returns `200 {"decision": <card>}` with the new `deferredUntil`.
Errors: `400 {"error":"hours must be a number between 1 and 168"}`,
`404 {"error":"decision not found"}`, and for a card that is not pending
`409 {"status":"not_pending","decisionStatus":"answered","decision":<card>}`.

### 4.7 What happens after an answer

A `saved` answer wakes the supervisor, which works through its outbox in order
(up to 100 items per pass). For each answer it writes the note shown in 3.6 to
every task on the card, then acts on the card:

- project-level supervisor cards apply their option, for example `resume`
  after a sign-in problem or after the target branch was moved, or applying a
  policy file;
- `review` cards: see section 5;
- `diagnostic` cards: `cancel` cancels the card's own task; `retry_checks`,
  `retry_review` and `retry_merge` send a parked task back to that step; any
  other option restarts a parked or exhausted task with its attempt counters
  reset, if nothing else blocks it;
- everything else, including all agent cards: a parked task with no other
  pending blocking card returns to `ready` (see 3.7 for other options).

If the task's state does not allow the action, the event `decision.not_applied`
is logged. Other failures are retried up to 20 times; the answer stays saved.

### 4.8 Notes for client authors

The bundled inbox polls every 15 seconds while visible, refreshes the CSRF
token through `GET /api/me` after a `403 csrf`, swipes to the recommendation
only when it is neither `consequential` nor `requiresComment` (and the card is
not `authorization`), and shows `why` in full.

## 5. Review cards and GitHub approvals

The supervisor raises a review card when the merge policy needs you, when the
automated reviewer asks for a human judgement, or when the automated review
failed three times. The card is bound to one commit: `kind: "review"`,
`createdBy: "supervisor"`, `blocking: true`, `artifactRef` = the task's full
head commit sha, `dedupeKey` = `review:<task id>:<first 12 characters of sha>`.
Its options are `approve` ("Merge this revision", `consequential`) and
`changes` ("Request changes", `requiresComment`). `recommendation` is
`approve` only when the latest automated review approved this commit. `links`
holds the pull request (if any), then `/#task=<task id>`.

The answer takes effect only while the task is parked in `waiting_decision` and
no run holds it; otherwise only the note is written.

- `approve` while the task head still equals `artifactRef`: your approval is
  recorded for that commit, which then merges (`merge_ready`).
- `approve` after the branch moved: the approval is not transferred. The task
  goes back to `checking` ("branch changed after the card was created;
  re-verifying"), and a new card is raised if still needed.
- Any other answer (`changes`, or a comment only) records a "request changes"
  review against `artifactRef` and sends the task back for repair with your
  comment (or, when its repair budget is spent, marks it `exhausted` and raises
  a `diagnostic` card). That commit can never be merged afterwards.

Pending review cards are superseded when the task goes back for repair, merges
or is approved on GitHub (answering one then returns `409 not_pending`).

**`/approve CODE` on GitHub.** GitHub does not let a pull request's author
approve it, and Autopilot opens pull requests under your account. So in GitHub
mode the review card's `why` ends with
`On GitHub you can also comment: /approve <CODE>`, where `CODE` is 6 random
characters (`A-Z`, `0-9`) issued for one task and one head commit.
Surprising: this line is added before `why` is cut to 4000 characters, so a
very long reviewer text can push it off the card. A pull request comment
approves when:

- its author is in the project's `feedback.trustedActors` (case-insensitive;
  the list is empty by default, so nothing counts until you add your account);
- its text starts with `/approve CODE` or `/autopilot approve CODE`
  (case-insensitive);
- `CODE` matches the code issued for the task's current head commit, so older
  codes stop working once the branch moves.

A native GitHub "Approve" review from a trusted account also counts, unless it
was given on an older commit. Wrong codes are ignored (event
`feedback.approval_rejected`). A valid approval while the task is in `waiting_decision`, `review_ready`
or `merge_ready` records your approval for the head commit, supersedes the
pending review cards and, if no other blocking card is pending, moves a parked
task to `merge_ready`. In other states it is used up without effect. The code
appears only in `why`: notifications never contain it, and agent tools never
return `why`. Codes do not expire and are not deleted after use.

## 6. Notifications

Creating a new card queues a notification in the same transaction; a request
merged into an existing card queues none. On each pass the supervisor groups
queued notifications by project, skips cards that are no longer pending, and
sends one notification per project:

| Field | Value |
|---|---|
| Title | `<project name>: a decision needs you`, or `<project name>: <N> decisions need you`, where N counts the new cards in this pass, not all pending cards |
| Body | `Open the Autopilot inbox to answer.` |
| URL | The project's `inbox.publicUrl`, when set |
| Priority | `urgent` if a card in the batch is urgent, else `high` if one is high, else `normal` |

**Web Push.** Each subscribed browser receives this JSON, encrypted for its
subscription (`aes128gcm`, RFC 8291) and signed with the server's VAPID key,
with `TTL: 86400` and `Urgency: high` (urgent and high) or `normal`:

```json
{ "title": "my-app: 2 decisions need you", "body": "Open the Autopilot inbox to answer.", "url": "https://autopilot.example.com/", "tag": "autopilot-decisions" }
```

`url` is `/` when the project sets no `inbox.publicUrl` (the `publicUrl` from
`server.json` is not used here). Subscriptions answering 404 or 410 are
removed. `POST /api/push/test` returns the number of subscriptions as `sent`,
not confirmed deliveries.

**ntfy.** When a project sets both `inbox.ntfyUrl` and `inbox.ntfyTopic`, the
same notification is posted to `<ntfyUrl>/<topic>` as plain text, with headers
`Title`, `Priority` (5 urgent, 4 high, 3 normal), `Tags: robot` and, when an
inbox URL is known (the project's `inbox.publicUrl`, else the `publicUrl` from
`server.json`), `Click`. The push test does not use ntfy.

**Never included:** the question, `why`, options, recommendation, comments,
card or task ids, task titles, diffs or approval codes; only the project name
and a count. An ntfy server receives the title, body and inbox URL in plain
text. Delivery is best effort: a failed notification is not retried.

## 7. Guarantees and known limits

- An answer is saved in one transaction with its outbox event: a lost
  notification or a restart never loses a saved answer.
- Answers name a revision and are idempotent per key; a repeated key returns
  the stored result, even with a different body.
- Cards never expire. No answer means pending, never permission.
- A review approval applies only to the exact commit the card showed.
- Agent cards cannot act as merge approvals, authorizations or diagnostics.
- Agent tools take only direct loopback calls with a live run's token.
- Notifications carry only the project name and a count.
- Revisions are not used yet; `consequential` is enforced by clients only.
- Card text is not passed through secret redaction, unlike notes and diffs.
- The server never builds the `#decision=D-1` links the bundled inbox accepts.
- An answer whose delivery fails 20 times is dropped from the outbox; only the
  supervisor log shows the errors.
- Sessions cannot be listed or revoked remotely, the pairing limit is shared
  by all clients, and there is no allow-list of host names.
- Task details show local paths and Claude session ids to every paired device.
- Kind `info` and `createdBy: "reviewer"` are reserved and never produced.
