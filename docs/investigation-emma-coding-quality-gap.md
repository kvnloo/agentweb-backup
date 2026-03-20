# Investigation: Why Emma's Coding Capability is Significantly Worse Than Claude Code

**Date:** 2026-03-19
**Branch:** `rui/investigate-emma-coding-quality-gap`
**Status:** Complete

## Executive Summary

Emma's coding quality gap vs Claude Code stems from **5 root causes**, in order of impact:

1. **No diff-based editing** — Emma must rewrite entire files, which exceeds output token limits for large files
2. **No local code execution** — Emma cannot compile, test, or verify code changes
3. **No filesystem access** — Emma operates through high-level API tools, not direct file I/O
4. **Output token constraints** — Large code content gets dropped from tool call arguments
5. **No iterative debugging loop** — Errors from tools are opaque and don't enable meaningful recovery

## Evidence: Example Sessions

### Session 1: Agent Mode — Landing Page Code Edit (ebfe6a3c)
- **Task:** Rewrite a 35KB+ `page.tsx` to match an HTML reference
- **Model:** `anthropic.claude-opus-4-6-v1` (same model as Claude Code)
- **Result:** Complete failure after 8 consecutive attempts

**What happened:**
1. Emma correctly analyzed the HTML reference and the deployed code (msgs 2-15) — analysis quality was excellent
2. Emma created a work plan and attempted `edit_landing_page_file` (msg 21)
3. **Every single call omitted the `content` parameter** — only metadata (page_id, file_path, commit_message) was sent
4. The tool returned the same error 8 times: `"file_path and content are required"`
5. By attempt 7, Emma had even dropped the commit_message, sending just page_id + file_path
6. After 8 failures, Emma gave up and suggested manual alternatives

**Root cause:** The model cannot generate 35KB of code as a JSON string inside a tool call argument. The output token budget is consumed by the `content` field before it can be completed, so the model either omits it entirely or truncates it.

### Session 2: Shared Session — Landing Page Builder (73a60b2b)
- **Task:** Build a landing page from scratch using a predefined work plan
- **Result:** Partially successful (page deployed but with quality issues)
- Called `deploy_landing_page` 4 times (retry loop on failures)
- Used `playwright_browser_*` tools to verify — but vision was `detail: 'low'`
- Final user request to review the page hit an error

## Root Cause Analysis

### Root Cause 1: No Diff-Based Editing (CRITICAL)

| Capability | Claude Code | Emma (Agent Mode) |
|---|---|---|
| Edit mechanism | `Edit` tool — sends only the diff (changed lines) | `edit_landing_page_file` — requires full file content |
| File size limit | Unlimited (diffs are small regardless of file size) | Effectively ~4-8KB (output token limit on tool args) |
| Granularity | Can make 1-line changes to 100KB files | Must rewrite entire file for any change |

**Impact:** This is the #1 bottleneck. Even Claude Opus 4.6 cannot generate 35KB of well-formed code inside a JSON-escaped string within a single tool call. Claude Code solves this with diff-based edits where only changed lines are transmitted.

### Root Cause 2: No Code Execution Environment (CRITICAL)

| Capability | Claude Code | Emma |
|---|---|---|
| Run code | Yes — Bash tool, npm test, npx tsc | No |
| Check compilation | Yes — immediate TypeScript errors | No |
| Run tests | Yes — sees failing tests, fixes, re-runs | No |
| Verify output | Yes — can view rendered pages, curl endpoints | Limited — `get_visual_context` with low detail |

**Impact:** Claude Code writes code in a tight loop: write → compile → fix errors → test → iterate. Emma writes code blindly — there is no signal about whether the generated code is correct, compilable, or functionally working.

### Root Cause 3: No Filesystem Access (HIGH)

| Capability | Claude Code | Emma |
|---|---|---|
| Read files | Direct file read (Read tool) — any file, any size | `read_landing_page_file` — API call, may truncate |
| Write files | Direct file write (Write/Edit tools) | `edit_landing_page_file` — API call with size limits |
| Search code | Grep/Glob across entire codebase | No codebase search |
| Navigate project | Full directory traversal | Limited to specific tool results |
| Multiple files | Can edit multiple files in sequence | One file per tool call |

**Impact:** Complex coding tasks require understanding the full project structure — imports, shared components, configuration. Emma can only see what specific tools return.

### Root Cause 4: Output Token Constraints (HIGH)

**Evidence from session `ebfe6a3c`:**
- Msg 21: Args = 318 chars (page_id + file_path + commit_message, NO content)
- Msg 23: Args = 292 chars (same pattern)
- Msg 25: Args = 164 chars (shorter commit msg, still no content)
- Msg 33: Args = 108 chars (gave up on commit msg too)

The model consistently avoids generating the large `content` parameter. This is likely because:
1. The model anticipates the content would exceed remaining output tokens
2. JSON encoding of large code (escaping newlines, quotes) amplifies size
3. The model has no mechanism to stream or chunk large content across multiple calls

### Root Cause 5: No Meaningful Error Recovery (MEDIUM)

When `edit_landing_page_file` fails, the error message is:
```
⚠️ Tool Error: edit_landing_page_file
Reason: API error (400): file_path and content are required
Next: Adjust the plan or ask the user for missing info.
```

The error tells Emma the `content` parameter is missing, but Emma has no way to fix this — it cannot chunk the content, use a different tool, or adjust its approach. Compare to Claude Code, which would:
1. See the error
2. Try a smaller edit
3. Or use a different approach (Write tool for new files, Edit for changes)

## Comparison Matrix: Emma vs Claude Code

| Dimension | Emma (Agent Mode) | Claude Code | Gap Severity |
|---|---|---|---|
| **Underlying Model** | Claude Opus 4.6, GPT-5, Gemini 3.1 | Claude Opus 4.6 | None (same model available) |
| **File Reading** | Via API tools (read_landing_page_file, read_file_content) | Direct filesystem (Read tool) | Medium |
| **File Writing** | Via API (edit_landing_page_file) — full file rewrite | Direct filesystem (Edit tool) — diff-based | Critical |
| **Code Execution** | None | Full Bash access (compile, test, run) | Critical |
| **Project Navigation** | Limited tool-based discovery | Full Glob/Grep across codebase | High |
| **Error Feedback** | Opaque API errors | Full compiler/runtime output | High |
| **Iteration Loops** | 20 max iterations, anti-loop detection | Unlimited practical iterations | Medium |
| **Context Window** | Shared with marketing tools, skills system, work plans | Dedicated to code task | Medium |
| **Output Size** | Limited by tool call arg size (~4-8KB effective) | Edit tool sends only diffs | Critical |
| **Multi-file Edits** | One file per tool call, no cross-file awareness | Unlimited files, full project context | High |
| **Testing** | No test execution | npm test, pytest, etc. | Critical |
| **Version Control** | No git access | Full git access | Medium |

## Recommendations

### P0: Enable Diff-Based File Editing (Highest Impact)

Modify the `edit_landing_page_file` tool to accept **patch/diff format** instead of requiring full file content:
```
Option A: Search-and-replace format
{
  "file_path": "page.tsx",
  "edits": [
    {"search": "old code block", "replace": "new code block"},
    {"search": "another section", "replace": "updated section"}
  ]
}

Option B: Line-range replacement
{
  "file_path": "page.tsx",
  "start_line": 150,
  "end_line": 200,
  "content": "only the 50 lines being changed"
}
```

This would allow Emma to edit large files by sending only the changed portions, staying well within output token limits.

### P0: Add Code Validation Feedback

After any file edit, automatically return:
- Build status (does it compile?)
- Deployment status (did Vercel build succeed?)
- Preview URL for visual verification
- Error logs if build failed

This gives Emma the feedback signal needed to iterate and fix issues.

### P1: Add Multi-Part Content Support

For cases where full file rewrites ARE needed (new files), support chunked content:
```
Tool call 1: create_file_start(path, content_part_1)
Tool call 2: create_file_append(path, content_part_2)
Tool call 3: create_file_commit(path, commit_message)
```

### P1: Improve System Prompt for Code Tasks

Current prompt focuses heavily on marketing workflows. For coding tasks, add:
- Instructions to break large changes into smaller edits
- Guidance on working within output token constraints
- Explicit instruction to verify changes before marking steps complete

### P2: Dedicated Code Mode

When a session involves code editing (landing pages, HTML templates), switch to a specialized prompt that:
- Focuses on code quality and correctness
- Emphasizes incremental changes over full rewrites
- Provides code-specific tools (linter, preview, diff)

### P2: Increase Context for Code Tasks

- Set `detail: 'high'` for visual context when reviewing code output
- Increase tool result preservation from 3 to 5-10 for code sessions
- Don't truncate code-related tool results at 8KB

## Files Referenced

| File | Purpose |
|---|---|
| `backend/src/services/chatbotService.ts` | Emma Chat service (system prompt, tools, context, iteration loop) |
| `backend/src/services/agentModeService.ts` | Agent Mode service (system prompt, tools, agentic loop) |
| `backend/src/emma/tools.ts` | Emma-specific tool registry |
| `backend/src/emma/registry.ts` | Tool registry for MCP and Emma tools |

## Key Takeaway

**The model is not the problem.** Emma uses the same Claude Opus 4.6 model as Claude Code. The gap is entirely in the **tool architecture** — Claude Code has direct filesystem access with diff-based editing, code execution, and compiler feedback. Emma has high-level API tools designed for marketing workflows that cannot handle the demands of serious code editing. The fix is not a model change but a tool infrastructure upgrade focused on diff-based editing and build feedback.
