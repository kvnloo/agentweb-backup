# Tool limits on the Claude plan route

Read this if you add or change a tool, a tool's description or its input schema.

A chat on the customer's own Claude plan runs `claude -p` on the login worker. The worker reaches Emma's tools through the tool relay, which has its own limits. The limits below apply to every tool, even if the tool works fine on AgentWeb's models.

**Deploy order: deploy the worker (protocol 4) FIRST, then the backend. Roll back the backend FIRST, then the worker.** The backend deploys itself on a push to main; the worker is deployed separately. A worker below protocol 4 gets `host_unavailable` on EVERY plan turn from the new backend (the HTTP bridge is a zero-tool stub in production, so the backend refuses to use it, and the `CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE` flag is ignored in production). Rolling the worker back first leaves the backend sending `tools` to a worker that refuses them; the first refused turn fails as `host_unavailable` and the cached protocol is dropped at once, but until the backend is rolled back every plan turn is refused.

## What you do NOT have to do

Nothing is registered twice. A tool added to the normal registry (`backend/src/emma/tools.ts`, copied into the Agent Mode registry by `registerTools` in `agentModeService.ts`) reaches the plan route by itself:

- **Its definition:** the run's tool list comes from `agentModeService.resolveRunToolAccess`, the same skill-gated list an AgentWeb turn uses (`emmaToolBridgeExecutor.ts`, `resolveTools`).
- **Its execution:** a call goes through `ToolBridge.callTool` and then `executePreparedTools`, the same dispatcher an AgentWeb turn uses.
- **When the model sees it:** a turn starts with the session's open set (foundation tools, installed skills, `install_skills`). A tool that becomes available during a turn (a skill install) is sent to the worker in the answer of the call that made it available.

## The limits

Each number lives in the constant named here, so check there if this page looks out of date. `protocol.ts` is `backend/src/loginHost/protocol.ts`; `bounds.ts` is `backend/src/loginHost/relay/bounds.ts`; `relayToolDispatcher.ts` is `backend/src/services/funding/relayToolDispatcher.ts`.

### The tool definition

| Limit | Value | Constant and file |
|---|---|---|
| Name characters | `A-Z a-z 0-9 _ -`, no leading `-` | `TOOL_NAME`, `protocol.ts` |
| Name length | 53 characters: the model's limit of 64 minus the 11-character prefix `mcp__emma__` | `TOOL_NAME_MAX_CHARS`, `MODEL_TOOL_NAME_MAX_CHARS`, `protocol.ts` |
| Duplicate names | Names that differ only in case count as duplicates | `toolManifest`, `protocol.ts`; `buildRelayManifest`, `relayManifest.ts` |
| Reserved prefix | `aw_relay_`, in any case | `RELAY_RESERVED_PREFIX`, `protocol.ts` |
| Description | 48 KiB in UTF-8 | `TOOL_LIMITS.maxDescriptionBytes`, `protocol.ts` |
| Input schema | 32 KiB as JSON, and `type` must be `"object"` (a missing schema becomes an empty object schema) | `TOOL_LIMITS.maxSchemaBytes`, `protocol.ts`; `toToolDef`, `relayManifest.ts` |
| All tools of one turn | 600 tools and 1 MiB of JSON, counting tools added during the turn | `TOOL_LIMITS.maxTools`, `TOOL_LIMITS.maxTotalBytes`, `protocol.ts` |

**What happens if a definition breaks a limit:**

- **In the turn's open set:** the turn is refused with the stop `tools_too_large_for_plan` and nothing runs. The user sees: "A tool connected to your account can't be used with your Claude plan. Disconnect it in Settings, or continue on AgentWeb credits." A foundation tool that breaks a limit therefore blocks plan chats for every user who has it, on every turn.
- **Added during a turn:** the tool stays invisible to the model for that turn, and the result text carries `UNLOADABLE_NOTE` ("a tool that just became available could not be loaded on your Claude plan"). The turn continues.

The log line is `relay_manifest_cut` (open set) or `new_tool_unloadable` / `new_tools_refused` (during a turn). They carry the counts per reason AND the NAMES of the tools that did not fit (at most 25 per reason), each with its name length, schema bytes and description bytes, so an operator can find the tool; never a description, a schema or an input. A name is made safe for a log line before it is logged (`toolNote`, `relayManifest.ts`, using `safeText`, `logSafe.ts`): control characters (line breaks, ANSI escapes, NUL, the Unicode line and paragraph separators) become spaces and the name is cut to 64 characters; the real length is kept as a number. **Known gap:** bidirectional-control and zero-width characters are NOT stripped today, so a hostile name could still reorder or hide characters when the line is displayed (it cannot add a line or grow the line). It is on the deferred register.

### One call's input

| Limit | Value | Constant and file |
|---|---|---|
| One input | 256 KiB (estimated by `approxJsonBytes`) | `CALL_INPUT_MAX_BYTES`, `relayToolDispatcher.ts` |
| Inputs over 16 KiB, added up per turn | 2 MiB; inputs of 16 KiB or less are exempt | `CALL_INPUT_BUDGET_BYTES`, `SMALL_INPUT_BYTES`, `relayToolDispatcher.ts` |
| Calls per turn | 400 | `DEFAULT_MAX_CALLS`, `relayToolDispatcher.ts` |
| Nesting | 32 levels | `MAX_FORWARDED_DEPTH`, `bounds.ts` |
| One call frame from the CLI | 1 MiB | `RELAY_FRAME_LIMITS.shimToHostBytes`, `protocol.ts` |

**What happens if a call breaks a limit:**

- **Over the size limit or the per-turn total:** the call is refused and the tool does not run. The model reads `ARGS_TOO_LARGE_MESSAGE` and can retry with less. A tool that legitimately needs more than 256 KiB must raise the constant in the same change, with a reason.
- **Over 400 calls in a turn:** the worker is treated as misbehaving. Further calls are not run and the turn is interrupted.
- **Too deep or too large a frame:** the worker refuses it before the backend sees it. The tool does not run, and the worker drops the relay connection, so the turn's later tool calls can fail too.

### One call's result

| Limit | Value | Constant and file |
|---|---|---|
| Text sent to the model | 300,000 bytes (note included), then cut with a note. Same cap as in-process Emma (300,000 characters; bytes here, so non-ASCII text is cut earlier, never later) | `RELAY_RESULT_MAX_BYTES`, `backend/src/loginHost/protocol.ts`; applied in `bound()`, `relayToolDispatcher.ts` |
| Images | 4 images of `image/png`, `jpeg`, `webp` or `gif`; 2,500,000 base64 characters each and 6,000,000 in all | `IMAGE_LIMITS`, `toolImage`, `protocol.ts` |
| Text saved in the chat's tool record | 64 KiB | `MAX_RECORD_CONTENT_BYTES`, `backend/src/services/funding/toolBridge.ts` |
| Records of one turn kept in the chat | 512 records / 4 MiB, exactly as before the relay; past that, old big reads are shrunk, then dropped, and writes always keep a record (a hard ceiling of 2,048 records / 6 MiB bounds it) | `MAX_LEDGER_RECORDS`, `MAX_LEDGER_BYTES`, `MAX_LEDGER_RECORDS_HARD`, `toolBridge.ts` |

`install_skills` is special: its answer also carries the instructions of the skills it just installed (up to 60,000 characters), as Emma's next model call would see them. They are not part of the saved record.

A result over a limit is never an error: the text is cut, or the extra images are dropped, and the text says so. The tool has already run.

**Parity with in-process Emma (verified in the code).** A relay call runs through the same `toolDispatch` as Emma's own loop (`emmaToolBridgeExecutor.ts` passes it the same two limits), so a result is cut by Emma's rules first and only then by the relay's:

| Step | Limit | Where |
|---|---|---|
| A result over 8,000 characters is uploaded in full (the model can fetch it with `search_tool_response`) and the model gets a header plus the first 20,000 characters | `TOOL_RESPONSE_S3_THRESHOLD` = `CONTEXT_TRIM_TOOL_CONTENT_LIMIT` = 8,000 (`agentModeService.ts`); the preview cap `S3_IN_MEMORY_CAP` = 20,000, applied where the result is offloaded in `executePreparedTools` (`agentMode/core/toolDispatch.ts`, the `S3_IN_MEMORY_CAP` constant) | in-process and relay |
| If that upload fails twice, the whole text is kept for this turn, up to 300,000 characters, and cut with a "Content truncated for storage" notice beyond | `MAX_TOOL_CONTENT_SIZE` = 300,000 (`agentModeService.ts`), applied by `executePreparedTools` (`agentMode/core/toolDispatch.ts`, the `maxToolContentSize` cut) | in-process and relay |
| The relay's own cap on what it posts to the worker | `RELAY_RESULT_MAX_BYTES` = 300,000 bytes | relay only; it can only bite on text that Emma's rules left whole (non-ASCII, or the upload-failed case) |

The relay cap is deliberately NOT larger than Emma's: a result of 1,000,000 bytes is about 250,000 tokens and fails the whole turn when it does not fit the model's context.

### What the backend accepts back from the login worker

These bound what a worker can send the API server (a compromised or buggy worker must not stall everyone else's requests). A tool author does not hit them with an honest tool: results are cut well below them (see "One call's result"). They are enforced in the backend, in `backend/src/services/funding/`:

| Limit | Value | Constant and file |
|---|---|---|
| Ordinary JSON reply (host.info, connection.status, turn.renew, turn.interrupt, turn.toolResult, login.*) and an error body | 64 KiB (every honest reply is a few hundred bytes; no route has an override) | `JSON_REPLY_BYTES`, `loginHostClient.ts` |
| One `text` line of the turn event stream | 64 KiB; a longer one is dropped unread (nobody reads `text`: the answer is `result`) | `LINE_CAPS.text`, `loginHostClient.ts` |
| The final `result` line (the answer) | 1 MiB (the model writes at most 32,000 tokens, about 128-256 KB, and a chat message persists at most 350,000 bytes); over it the stream ends as `line_too_long` and the turn's outcome is unknown (what ran is kept, nothing is silently cut). One `result` is read per stream | `LINE_CAPS.result`, `loginHostClient.ts` |
| A `tool-use` line (the stream's announcement of a call) on a relay turn | 128 KiB; over it, or with more than 20,000 `[`/`{` outside strings, it becomes a name-only announcement | `LINE_CAPS.relayToolUse`, `MAX_TOOL_STRUCTURES`, `loginHostClient.ts` |
| A `tool-call` line (the call to run) on a relay turn | 320 KiB, same structure budget; over it, the call is answered with the "arguments too large" text and never runs (the dispatcher's own limit is 256 KiB of input) | `LINE_CAPS.relayToolCall`, `loginHostClient.ts` |
| A `tool-use` line on a legacy (bridgeToken) turn, only with the legacy flag outside production | 1.5 MiB, unchanged | `LINE_CAPS.tool`, `loginHostClient.ts` |
| Any other line | 64 KB; a line of an event type this client does not know is dropped, a known one over its cap ends the stream. A big `result` line may carry no structure outside its strings | `LINE_CAPS.other`, `loginHostClient.ts` |
| Work per stretch of the stream | the event loop is handed back every 64 lines (20,000 tiny events used to be one 128 ms block) | `YIELD_EVERY_LINES`, `loginHostClient.ts` |
| One request to the worker, reply body included | 60 s ABSOLUTE (not idle): a reply dripped one byte at a time ends there; an answer post is also aborted when the turn is closed | `requestTimeoutMs`, `loginHostClient.ts`; `RelayToolDispatcher.close()` |
| Events and bytes in one turn stream | 20,000 events and 64 MiB | `MAX_STREAM_LINES`, `MAX_STREAM_BYTES`, `loginHostClient.ts` |
| Empty lines in one turn stream | 256 (the host never writes one); past that the stream fails as `too_many_empty_lines` | `MAX_EMPTY_LINES`, `ndjsonLines.ts` |

## What the Claude CLI does on top of these limits

The limits above are ours. The CLI that talks to the model has its own, and they apply to the tools it gets over MCP (which is how the relay hands it Emma's tools). Left alone, the CLI would quietly change what the plan route offers, so the login host sets three of its environment variables for RELAY turns, and its tool shim declares a per-tool result size (the last row). `relayCliEnv` in `backend/src/loginHost/protocol.ts` owns the values; each one is derived from a limit in that file, never a second copy of a number:

| CLI behaviour | CLI default | What the host sets for a relay turn | Value today |
|---|---|---|---|
| Shortens an MCP tool description (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`) | 4,096 characters, with an ellipsis | `TOOL_LIMITS.maxDescriptionBytes`, the longest description the host accepts anyway | 49,152 |
| Truncates an MCP tool's output (`MAX_MCP_OUTPUT_TOKENS`) | 25,000 tokens (about 100 KB) | half of `RELAY_RESULT_MAX_BYTES` (two bytes a token) plus `IMAGE_LIMITS.maxImages` times 1,600 tokens for images. Not the 8 MiB frame cap: that would remove the CLI's protection of the model's context | 156,400 (= 150,000 + 4 x 1,600) |
| Ends a stdio tool call (`MCP_TOOL_TIMEOUT`, milliseconds) | the CLI's own | the turn's remaining deadline, at least 1,000 and at most 2^31-1, so the host's clock is the one that ends a call | per turn |
| Saves a tool result above a PER-TOOL threshold to a file and gives the model only a ~2 KB preview ("Output too large ... Full output saved to: ...") | a few tens of KB (a 150 KB result was a preview, live, with `MAX_MCP_OUTPUT_TOKENS` = 156,400) | the relay shim lists EVERY tool with `_meta: {"anthropic/maxResultSizeChars": N}`, N = `RELAY_RESULT_MAX_BYTES` (`MAX_RESULT_CHARS` in `backend/src/loginHost/deploy/aw-relay-shim.js`; a host test keeps the two equal). `MAX_MCP_OUTPUT_TOKENS` alone is NOT enough: this is a second, separate limit | 300,000 |

A turn on the legacy HTTP bridge sets none of them and keeps the CLI's defaults. The backend cuts a result's text at `RELAY_RESULT_MAX_BYTES` (300,000 bytes, about 150,000 tokens at two bytes a token), which is exactly what the CLI's output limit is derived from, so the CLI's own cut should never be the one that applies; and it refuses a description over 48 KiB at the manifest, so the CLI's own cuts should never be the ones that apply on the plan route.

**Verified live on the test worker (2026-11-02; host `da28e86be`, pinned CLI 2.1.294, Haiku and Sonnet, results per model): YES for the three CLI limits above.** A 12,000-character tool description reached the model whole (C15; the CLI's default would have cut it near 4,096), a ~150 KB tool result reached the model whole (C16; it FAILED on both models before the shim declared `_meta` `anthropic/maxResultSizeChars`, the CLI saved it to a file and gave the model a short preview, and passed on both with it), and a ~90 s silent tool returned (C17). A CLI upgrade can change any of these: the live cases `--desc`, `--output` and `--time` in `claudeRelayLive.ts` re-check them. Production has not been exercised yet (that is the deploy step).

## Who can add tools, and what that means for the plan route

- **Built-in tools** (`backend/src/emma/tools.ts` and the registry): added by developers and **checked by CI** (`relayManifest.registry.test.ts`, below).
- **MCP-server tools:** only an admin can add an MCP server (`/api/admin/mcp-servers` is mounted behind `authenticateToken` and `isAdmin`; customers cannot add one). These tools are **not covered by CI**. Before an admin adds an MCP server to production, the operator must check that its tools fit the limits: a name of at most 53 characters of `A-Za-z0-9_-` (no leading `-`), an input schema of at most 32 KiB with `type: "object"`, a description of at most 48 KiB, no two names that differ only in case, and in all at most 600 tools and 1 MiB of definitions for a turn. ONE bad tool refuses every plan turn whose tool list contains it (all of them, if it is always listed), for every plan user, with `tools_too_large_for_plan`. The server log line `relay_manifest_cut` names the tools that did not fit (up to 25 per reason, with their name length, schema bytes and description bytes) so the offender can be found.
- **What the logs say (server-side only):** a refused manifest (cut, empty, schema problem, tool list lookup failure) is one structured line with the reason, the counts per reason, the named tools and their sizes, the tools offered, the manifest bytes, the open-set size, and the session and run ids. Every relay turn that starts logs one INFO line, `relay_turn_start`, with the same sizes and the worker protocol (so capacity trends show before anything is cut). A tool that arrives late (a skill install) and cannot be offered is logged the same way. Every name goes through `safeText` (control characters turned into spaces, at most 64 characters, the real length kept as a number; bidirectional and zero-width characters are NOT stripped today: a known gap, see "What happens if a definition breaks a limit"). Never logged: descriptions, schemas, inputs, arguments, results, tokens, user text.

## What checks this

`backend/src/services/funding/__tests__/relayManifest.registry.test.ts` builds the manifest from the real registry and fails, naming the tool and the limit, if a tool does not fit. It covers two cases: the open set of a fresh chat, and every registered tool at once (the worst case, all skills installed in one turn).

CI runs it on every backend PR, as the step "Plan route tool limits" of the **Backend build** job. To run it yourself, from `backend/`:

```bash
npx jest src/services/funding/__tests__/relayManifest.registry.test.ts
```

Do not rely on the pre-push hook for this. A change to `emma/tools.ts` relates more suites than the hook's cap, so the hook falls back to name-matched suites and skips this test.

## What the check does NOT cover

These are only caught at run time, by the stops and notes above:

- **Tools of MCP servers.** `relayManifest.registry.test.ts` calls `registerTools()` without MCP, so the tools of global MCP servers (named `${prefix}_${name}`) are NOT checked. One global MCP tool that does not conform makes the run's tool list uncarriable and stops every turn whose list contains it with `tools_too_large_for_plan`.
- **Admin changes to the foundation set** (`PUT /api/agent-mode/foundation-tools`). The test uses the default set in the code, so an override that grows the open set is not checked. The whole-registry case still bounds it for tools in the registry.
- **Call inputs and results.** Their size depends on the data, so no test of the registry can see them.

## Security: what stays open

**A compromised worker can mark customers' logins dead (bounded).** A worker can claim a login is dead, and the status it is asked about comes from the same worker, so it is a consistency check, not evidence. The backend marks a connection only when the claim and the status agree, or the claim repeats on two consecutive turns, at most once per 5 minutes per connection, and never for more than 5 different connections in 10 minutes (then it logs `mark_breaker_open` and only shows the stop). Per API instance.

**A confirmation can be replayed by a compromised worker (design residual R1).** A halt (a tool that needs the user's confirmation) is lifted by any new user turn, and the confirmation token sits in the persisted preview. A compromised login worker could confirm a previously previewed write on a later turn, whatever the user typed. Only approval cards that bind a confirmation to a user action close this. Until they ship, the plan route stays allow-listed to one internal user, and after the first confirmation-needed call the turn runs no further tools.

**A kill switch or a flag-off does not stop a RUNNING turn.** `ClaudeRunRegistry.cancelOwner` has no caller; a Stop, a revoke or a shutdown stops a turn (and so does a tripped limit). When the plan route is switched off while a turn runs, the bridge's liveness check refuses a WRITE at once (it is read fresh for writes), READS go on until the turn ends, for up to about 65 s (the flags are cached for 60 s and a positive read check for 5 s), and the CLI keeps running to its deadline.
