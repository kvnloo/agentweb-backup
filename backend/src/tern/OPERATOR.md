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
- Engine-uploaded artifacts use a path bearer: `agent-engine/task_utils.py`
  creates `task_results/<execution>/<random_token>/<filename>` and stores the
  identical bearer in `result_files[].token`. Both TSP and read-only JSON
  withhold these full URLs, even when they have no query string or when the
  token field was omitted; ordinary credential-free public HTTP(S) URLs remain
  clickable.
- Private artifacts retain a credential-free authenticated Partner Portal
  reference to the existing `/tasks/:taskId/executions/:executionId` route
  (`partner-portal/src/App.tsx`). Setting `AGENTWEB_PORTAL_URL` to the
  trusted portal **origin** enables native open/copy on that route. When unset,
  Tern shows the relative portal path for manual navigation. This does not
  create a new authorization policy or a TSP bearer proxy; the portal enforces
  its existing login/access gates.
- Each native Run/Stop confirmation has a new monotonic picker ID and captures
  task ID/name, execution ID (for Stop), action and surface epoch. Delayed
  select/activate/action events from an earlier picker or recovered surface are
  ignored, and native cancellation/eviction clears the pending intent. The
  current picker begins at Cancel; one confirmed current-generation intent
  yields at most one backend mutation.
- Browser log signed URLs and file access tokens remain withheld. Free-form
  result/error text is bounded and redacted on a best-effort basis; do not treat
  the terminal surface as a secrets vault. Emma's independent native URL
  guard also rejects the same engine path-capability shape.

## Emma composer keyboard and TSP input

In the opt-in tern:emma CLI, the program owns the composer text, UTF-16
caret and undo history in src/scripts/tern-emma-input.ts. The terminal
renders it, but does not own the text. Per Stencil's TSP input contract,
ordinary keyboard characters, navigation and bracketed paste arrive on
the PTY; a native edit event is for selection/caret changes and a native
send event is an externally submitted atomic prompt, not keyboard Enter.
All paths use the existing sendPrompt and backend routes.

- **Enter** sends one nonblank prompt when idle. While busy, typed draft
  text remains editable but pressing Enter cannot start a second turn.
- **Shift+Enter** inserts a literal newline; **Ctrl+J** is the raw
  terminal newline fallback. **Ctrl+Enter** submits a multiline draft.
  Bracketed paste preserves embedded newline characters and never sends.
- **Arrow keys, Home/End, word navigation, Backspace and Delete** update
  the client caret without splitting surrogate pairs. Native selection
  replacement uses the existing strict length-checked TSP edit resolver.
- **Ctrl+Z** (raw) and native undo share the same local history.
  **Ctrl+C** (including kitty CSI-u modifiers) restores terminal modes
  and exits cleanly. The existing session picker, approval deck and run
  inspector keep their distinct modal key handlers.
- **/resume**, **/sessions**, **/new** and **/runs** still go through the
  original client command dispatch. Native external send is ignored
  while another modal or a running turn prevents submission.

The regression suite at src/__tests__/tern.emmaInput.test.ts sends
actual raw terminal character/CSI/paste sequences to the same
EmmaInputController.handleRaw method used by the CLI, including mixed
TSP frames. This is not a substitute for native end-to-end proof.

For native acceptance, OMP must use its **owned** ungated Tern serve
window, real PTY/script wrapper and isolated loopback HTTP fixture:
launch npm run tern:emma -- --new with AGENTWEB_API_URL pointing to that
fixture and only a synthetic fixture token; type the ordinary keyboard
text "Run two native fixture tools", then Enter. Capture exactly one
message POST at the real loopback endpoint and its rendered reply.
Repeat with Unicode, bracketed paste, Shift+Enter, native selection
replacement followed by raw typing, busy-state Enter, /resume, Ctrl+C
and detach/re-attach. Record hello/ACK, frame trace and HTTP request
count. No personal host input, provider request or production login.
This connector-only worker has **not** executed that native proof.

## Launch

Use an AgentWeb customer token that already has access to the target tasks.
Keep secrets in the environment; never put them into command arguments.

From backend/ **inside a Tern pane**:

~~~sh
export AGENTWEB_TOKEN="<customer JWT>"
export AGENTWEB_API_URL="http://localhost:3001"
# Optional, for native Open on private artifact portal references:
export AGENTWEB_PORTAL_URL="http://localhost:3000"

npm run tern:emma
npm run tern:operator
npm run tern:operator -- --task "<task id>"
npm run tern:operator -- --task "<task id>" --execution "<execution id>"
~~~

Native operator controls: task selection + **Enter** to inspect; **s** requests
a task run; **x** requests stop for the selected currently running execution;
**r** refreshes; **Esc** returns to tasks/exits; **q** exits. Every Run/Stop opens
a modal whose initial selection is **Cancel** and whose title/subtitle name
the exact captured task/execution. Move to Confirm, then explicitly activate
it; delayed events from a closed or older native picker cannot confirm a newer
one. No action is retried after ambiguous network failures. Any server
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
  src/__tests__/tern.emmaInput.test.ts \
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
artifacts, no sensitive URLs or headers in captured frames; verify an engine
`task_results/<execution>/<token>/<filename>` fixture does not expose the
matching `result_files[].token` in JSON, native nodes or wire frames; follow
the authenticated portal reference. Open A confirmation, close it, open B,
then deliver A's delayed select/activate/confirm actions and verify B remains
Cancel with zero mutations. Confirm current-generation B once and verify
exactly one POST/PUT; disconnect/reopen the Tern window. Test
permission denial, stale/completed stop, and failed HTTP calls. Do not merge
without real host/backend evidence.

## Provenance

The Tern protocol and SDK are from **Stencil**; the Hermes Tern frontend in
kvnloo/hermes-tern and kvnloo/hermes-agent supplied the interaction model and
surface recovery guidance. The existing #99 experiment is credited and reused
byte-for-byte for its implementation files. can1357/oh-my-pi provides a
production example of TSP framing/UX. AgentWeb itself remains the source of
truth for sessions, approval policy, tasks and executions.
