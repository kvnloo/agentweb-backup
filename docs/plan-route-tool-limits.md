# Tool limits on the Claude plan route

Read this if you add or change a tool, a tool's description or its input schema.

A chat on the customer's own Claude plan runs `claude -p` on the login worker. The worker reaches Emma's tools through the tool relay, which has its own limits. The limits below apply to every tool, even if the tool works fine on AgentWeb's models.

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

The log line is `relay_manifest_cut` (open set) or `new_tool_unloadable` / `new_tools_refused` (during a turn). They carry counts only, never names.

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
| Text sent to the model | 1,000,000 bytes, then cut with a note | `MAX_CONTENT_BYTES`, `relayToolDispatcher.ts` |
| Images | 4 images of `image/png`, `jpeg`, `webp` or `gif`; 2,500,000 base64 characters each and 6,000,000 in all | `IMAGE_LIMITS`, `toolImage`, `protocol.ts` |
| Text saved in the chat's tool record | 64 KiB | `MAX_RECORD_CONTENT_BYTES`, `backend/src/services/funding/toolBridge.ts` |

A result over a limit is never an error: the text is cut, or the extra images are dropped, and the text says so. The tool has already run.

## What checks this

`backend/src/services/funding/__tests__/relayManifest.registry.test.ts` builds the manifest from the real registry and fails, naming the tool and the limit, if a tool does not fit. It covers two cases: the open set of a fresh chat, and every registered tool at once (the worst case, all skills installed in one turn).

CI runs it on every backend PR, as the step "Plan route tool limits" of the **Backend build** job. To run it yourself, from `backend/`:

```bash
npx jest src/services/funding/__tests__/relayManifest.registry.test.ts
```

Do not rely on the pre-push hook for this. A change to `emma/tools.ts` relates more suites than the hook's cap, so the hook falls back to name-matched suites and skips this test.

## What the check does NOT cover

These are only caught at run time, by the stops and notes above:

- **Per-user MCP tools.** A user's own connected tool can have any name, schema or size, and a user can connect any number of them.
- **Admin changes to the foundation set** (`PUT /api/agent-mode/foundation-tools`). The test uses the default set in the code, so an override that grows the open set is not checked. The whole-registry case still bounds it for tools in the registry.
- **Call inputs and results.** Their size depends on the data, so no test of the registry can see them.
