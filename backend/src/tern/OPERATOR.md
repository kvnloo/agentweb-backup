# Native AgentWeb surfaces in Tern (downstream experiment)

Tracked by [Emma #98](https://github.com/kvnloo/agentweb/issues/98),
[operator #97](https://github.com/kvnloo/agentweb/issues/97), and
[critical path #100](https://github.com/kvnloo/agentweb/issues/100).
This branch reuses the existing work in
[experiment PR #99](https://github.com/kvnloo/agentweb/pull/99).

## Scope and authority

These are **explicitly opt-in local clients**, not changes to the AgentWeb
backend, partner portal, auth, or task execution policy. They reuse #99's direct
TSP v1 transport and keyed reconciler, informed by Tern's Stencil SDK and the
Hermes Tern frontend. No Tern-specific business state or credentials are
persisted. Starting/stopping work uses the existing authenticated AgentWeb
endpoints, whose authorization checks stay authoritative.

- **Emma**: transcript, native editor/send, tool cards, session picker,
  plan/approval deck, coding preview, and AgentRun trace (tern:emma).
- **Emma tool identity**: chatbot SSE emits a tool name, not a call ID. The
  adapter keys each live start by session + tool name + ordinal occurrence in
  the existing persisted `metadata.toolCalls` ledger. Repeated same-name calls
  correlate FIFO; completed/failed cards remain siblings under the native
  transcript root and patch in place on reconciliation and session rehydration.
  This is presentation identity, not a new backend/persistence ID. A start
  absent from the persisted ledger cannot be recovered after a restart.
- **Emma credential boundary**: every projected Emma surface (chat, tool
  detail, coding preview, session picker, plan, approval deck and AgentRuns)
  suppresses nested auth/token fields, bearer credentials and signed/userinfo
  URLs. Failed-tool details remain bounded and useful; normal HTTP(S) previews
  and links without credential-bearing parameters keep open/copy actions.
  The editable composer remains user-authored local input.
- **Operator**: tasks → executions → selected run; status, model, timestamps,
  result/error, elapsed duration, safe artifact links, actual browser execution
  activity and user requests, explicit gated Run/Stop, and a refresh action.
- The operator reads execution status every 10 seconds. An additive
  authenticated `GET /api/tasks/:id/executions/:executionId/activity` endpoint
  projects the existing browser-use log stored in S3 into at most 40 keyed
  event records. The agent engine currently uploads log changes about every
  30 seconds. No event feed exists for this execution path: Tern therefore
  applies incremental keyed patches from these polls, without generating
  synthetic "activity" events on every refresh.
- The backend checks task ownership/admin and execution-task binding before
  using its own configured S3 bucket and IAM to read only the expected log
  object (last 256 KiB). The original log URL, token, HTML, command arguments,
  message payloads and credential-bearing text never cross the activity API,
  TSP or JSON boundary. Only event kind, timestamp, severity and safe fixed
  summaries derived from persisted browser-use log lines are exposed.
- No extra browser logging, persisted operator state or execution policy is
  introduced. When the engine has not published a log yet, the timeline is
  empty rather than invented; failures to read activity are shown explicitly.
- Artifact URLs with query strings/fragments/embedded credentials are not
  sent across TSP. Browser log signed URLs and file access tokens remain
  withheld. Free-form result/error text is bounded and redacted on a best-effort
  basis; do not treat the terminal surface as a secrets vault.

## Launch

Use an AgentWeb customer token that already has access to the target tasks.
Keep secrets in the environment; never put them into command arguments.

From backend/ **inside a Tern pane**:

~~~sh
export AGENTWEB_TOKEN="<customer JWT>"
export AGENTWEB_API_URL="http://localhost:3001"

npm run tern:emma
npm run tern:operator
npm run tern:operator -- --task "<task id>"
npm run tern:operator -- --task "<task id>" --execution "<execution id>"
~~~

Native operator controls: task selection + **Enter** to inspect; **s** requests
a task run; **x** requests stop for the selected currently running execution;
**r** refreshes; **Esc** returns to tasks/exits; **q** exits. Every Run/Stop opens
a modal whose initial selection is **Cancel**. Move to Confirm, then explicitly
activate it; no action is retried after ambiguous network failures. Any server
refusal is surfaced as a generic HTTP status rather than reflecting private
response bodies into Tern.

For **read-only non-Tern/automation** usage:

~~~sh
npm run tern:operator -- --json
npm run tern:operator -- --task "<task id>" --json
~~~

Redirected/noninteractive stdout automatically emits the same allowlisted JSON
model; neither mode creates, stops or edits an execution. In an interactive
terminal without TSP, the native surface exits on failed negotiation. Opt-in is
required, so the ordinary AgentWeb portal and shell remain unchanged.

## Verification (not executed by this worker)

~~~sh
cd backend
npm ci
npm run build
npm run typecheck
node --max-old-space-size=4096 node_modules/.bin/jest --runInBand --forceExit \
  src/__tests__/tern.protocol.test.ts \
  src/__tests__/tern.textEdit.test.ts \
  src/__tests__/tern.reconcile.test.ts \
  src/__tests__/tern.renderEmma.test.ts \
  src/__tests__/tern.agentWebClient.test.ts \
  src/__tests__/tern.operatorModel.test.ts \
  src/__tests__/tern.operatorClient.test.ts \
  src/__tests__/tern.renderOperator.test.ts
~~~

Then dogfood in an authenticated isolated **real Tern host** with an AgentWeb
backend: resume regular/scheduled Emma sessions, stream tools, answer a deck,
inspect plans and AgentRuns; run the operator with a task whose execution
transitions running → completed and another running → failed, including
runs with no userInteractions; confirm S3-backed browser events and stable keyed
row patches, elapsed times, status,
artifacts, no sensitive URLs or headers in captured frames; disconnect/reopen
the Tern window; verify confirmations and that only one POST/PUT occurs. Test
permission denial, stale/completed stop, and failed HTTP calls. Do not merge
without real host/backend evidence.

## Provenance

The Tern protocol and SDK are from **Stencil**; the Hermes Tern frontend in
kvnloo/hermes-tern and kvnloo/hermes-agent supplied the interaction model and
surface recovery guidance. The existing #99 experiment is credited and reused
byte-for-byte for its implementation files. can1357/oh-my-pi provides a
production example of TSP framing/UX. AgentWeb itself remains the source of
truth for sessions, approval policy, tasks and executions.
