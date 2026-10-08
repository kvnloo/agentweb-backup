# ENG-964 — manage_crm_sequence behind A1+A2 activation boundary

Commit: `c201cc9fa` on `swarm/eng-964-crm-sequence-activation` (not pushed).
Author/committer: `harshmoney123 <19524701+harshmoney123@users.noreply.github.com>`.

## Red → green
- **Red:** `eng964manageCrmSequence.test.ts`: 20 failed / 20 total. The tool was not registered and the gateway returned `admin` for `manage_*`.
- **Green (targeted):**
  | Suite | Result |
  |---|---|
  | eng964manageCrmSequence.test.ts | 21/21 (the extra test pins "preview itself refused in a scheduled session") |
  | eng962listCrmSequences.test.ts | 7/7 |
  | eng962.sequenceReads.test.ts | 3/3 |
  | agentToolGatewayService.test.ts + sandboxToolClasses.invariant + hardeningGaps | pass (224 total across the first 6 suites) |
  | mcp.publicToolInventory.test.ts | 4/4, after a reviewed regen. The diff is pure additions for `manage_crm_sequence`, plus a one-line description fix on `list_crm_sequences` |
  | Sweep: every suite importing apiTools / EXTERNAL_SEND_TOOLS / SANDBOX_TOOL_CLASSES / hardeningGaps / toolWriteClassification | 44 suites, 934/934 |
- `npm run typecheck` (tsc --noEmit, 6 GB heap): exit 0.

## AC → test map
1. Unattended, scheduled and external-MCP activation is refused even with `confirm:true` and a fully approved preview. Unreadable session fails closed. → AC1 block (4 tests + the preview-refused test)
2. No preview → `no_preview` → AC2
3. Only `confirm:true` after preview (card unanswered) → `awaiting_approval`. An answer with `answeredBy:'model'` is also refused. → AC3 (2 tests)
4. Human picked "Keep as draft" → `not_affirmative` → AC4
5. Token = sha256 of content, audience and cadence. A subject, body, audience or delay change → `stale_preview`. Same content with new stepIds/updatedAt gives the same token. → AC5 (5 tests)
6. Success path: PUT `{status:'active'}` exactly once. A mismatched `preview_token` argument is refused. → AC6 (2 tests)
7. `create` POSTs with no `status` and no `enrollmentTrigger`, then PUTs `{autoEnrollListIds}`. The assertion uses the stored field that `getSequencesByAutoEnrollList` / `describeSequenceAudience` read. `update` never forwards `status`, and an active sequence must be paused first. `pause` is always allowed. → AC7 (3 tests)
8. `evaluateAgentToolPolicy('manage_crm_sequence').effect === 'external_send'` → AC8

## Files changed (committed)
- `backend/src/services/crmSequenceActivationGate.ts` (new, pure): token hash, A1 `checkAttendedSession`, card builder, A2 `checkActivationApproval`
- `backend/src/mcp/server/apiTools.ts`: registers `manage_crm_sequence`; `list_crm_sequences` description/comment now point at it
- `backend/src/services/agentToolGatewayService.ts`: adds the tool to `EXTERNAL_SEND_TOOLS`
- `backend/src/services/evaluationPolicy.ts`: adds the tool to the sandbox `sends` class (required by the ENG-1907 invariant)
- `backend/src/utils/hardeningGaps.ts`: adds the tool to `SEND_TOOLS` (required by the drift guard)
- `backend/src/__tests__/eng964manageCrmSequence.test.ts` (new)
- `backend/src/__tests__/__fixtures__/mcp-public-tool-inventory.json` (regenerated, reviewed)

## Deviations / judgment calls — please review
- **Approval channel: approval deck, not `pendingUserQuestion`.** The task asked for the askUserQuestion / pendingUserQuestion channel. On `main` that slot is retired: ENG-1635/1644 PR2, "nothing writes session.pendingUserQuestion anymore", stale records were nulled by `eng1635-null-stale-pending-user-questions.ts`. A gate reading it could never pass, so activation would be permanently impossible. I used its live successor instead, the approval deck. It is the same lineage: it reuses `AskUserQuestionOption`, has the same `'user'|'delegation'`-only `answeredBy` invariant, and uses the same deck-of-one halt shape (`questionDeckPayload`, `type:'ask_user_question'`) and `findAnsweredDeckItemByKind` lookup that the Meta objective gate uses today. I built no new primitive. The gate also requires `answeredBy === 'user'`, so a delegation does not count. If you really want the dead slot, swap `checkActivationApproval` for `checkQuestionGate` — but nothing would ever satisfy it.
- **The preview halt only renders as a card in Emma.** It does so through the iteration-end seam (`partitionApprovalHalts`), which reads the raw result object. So this tool returns raw objects, and `mcpServerCore` wraps them for external clients. `manage_crm_sequence` is **not** added to Emma's in-app bridge (`bridgedToolNames` in `emma/tools.ts`), matching `list_crm_sequences`. In-app reachability is therefore via skill/work-plan tool inclusion only. Bridging it is a product-surface decision and is left out.
- **External MCP:** the tool is not `internalOnly`. External clients can create, update and pause drafts. Only `preview_activation` and `activate` are refused for them, which is AC1's scope.
- **TOCTOU window:** the token is recomputed from a fresh GET right before the PUT `{status:'active'}`. The PUT route has no conditional write, so an edit landing in the few milliseconds between them would not be caught. Closing that needs a conditional update in `dripSequenceDb.updateSequence`. That is not a schema change, but it is a persistence-contract change, so I left it out. Worth a follow-up issue.
- **Create is two calls:** POST, then PUT for `autoEnrollListIds`, because the POST route ignores that field and the PUT route is the writer that refuses session lists (ENG-2311). If the PUT fails, the draft exists with no audience and sends nothing. The error names the sequence_id.

## Not done
- Not pushed; no PR; no Linear state changes (per instructions).
- No dev/pending fragment, and `docs/user-release.ts` was not touched (external-copy gate).
- No schema, migration, index or persisted-union changes were needed (ENG-963 untouched).
- Environment: `backend/node_modules` was a symlink to `~/code/agentweb/backend/node_modules`, which is **empty** on this box. I replaced it with a local `npm ci --ignore-scripts` in this worktree (gitignored). The shared checkout's empty node_modules will break any other worktree that symlinks into it.
