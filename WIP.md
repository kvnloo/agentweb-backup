# WIP: Emma ClickUp Folder Write

**Date:** 2026-04-27  
**Branch:** `rui/investigate-emma-clickup-folder`  
**Status:** Code merged. Blocked on ClickUp permission config for production account.

---

## Context

User (agentwebintegration@xcures.com) reconnected ClickUp in AgentWeb to test write
permissions. They created a folder named "AgentWeb" with full permissions for the
integration account. Emma could not find the folder or write to it.

Failing session: `1c821370-7918-4819-b7a9-6beb1449f413`

---

## Root Cause (Code)

`listKnowledgeBaseFiles` never queried ClickUp's space/folder hierarchy. It only
listed workspace-level docs and tasks. Emma had no visibility into folders at all.

`write_clickup_doc` always created docs at workspace root with no parent support.

---

## What Was Implemented

### `backend/src/services/clickupService.ts`
- Added `listSpaces(accessToken, workspaceId)` — `GET /api/v2/team/{id}/space`
- Added `listFolders(accessToken, spaceId)` — `GET /api/v2/space/{id}/folder`
- Added `createPageInDoc(accessToken, workspaceId, docId, name, content)` — `POST /api/v3/workspaces/{id}/docs/{docId}/pages`
- Updated `createDoc` (simplified, workspace root only)

### `backend/src/services/agentModeService.ts`
- `listKnowledgeBaseFiles`: now also lists ClickUp spaces → folders, exposing them as
  `clickup-folder:{folderId}` entries (reference only — task folders cannot be doc parents)
- `writeClickUpDoc`: new optional `parentDocId` param; when provided, calls
  `createPageInDoc` instead of `createDoc`
- Updated system prompt: guides Emma to use `docId` from doc entries as `parent_doc_id`,
  and clarifies that `clickup-folder:` entries are task hierarchy (not writable targets)

### `backend/src/emma/tools.ts`
- `write_clickup_doc` tool: replaced `folder_id` param with `parent_doc_id` (doc ID)
- `list_knowledge_base_files` description: updated to explain `docId` as `parent_doc_id`

---

## Key Architectural Finding

ClickUp has two completely separate systems:

1. **Task hierarchy**: Workspace → Spaces → Folders → Lists → Tasks  
   Accessible via `/api/v2`. The integration token for `agentwebintegration@xcures.com`
   returns **0 spaces** (read-only token, no task hierarchy access).

2. **Docs system**: Docs live in a separate namespace. Parent types in the v3 API:
   - `type 4` = Space (the space the doc lives under, NOT a task folder)
   - `type 5` = List
   - `type 6` = Task
   - Creating a doc WITH a parent requires `create_view` permission on that space.
   - Creating a PAGE inside a doc requires `edit_view` on the doc's parent space.
   - Creating a doc at workspace root requires `can_create_workspace_doc`.

**Correct write pattern**: Create a container doc first, then use
`POST /docs/{docId}/pages` to nest content inside it. This is what `parent_doc_id`
now triggers in `write_clickup_doc`.

---

## Browser Test Results (ruiwangwarm@gmail.com — verified working)

Turn 1: Emma found task-hierarchy "Clients" folder, explained it's not a writable doc
parent, created doc at workspace root, offered to create a "Clients" doc first.

Turn 2: Emma created "Clients" doc (ID: `2ky4hdwn-1173`), then created "AgentWeb Test
Doc 2" as a page nested inside it (ID: `2ky4hdwn-553`) using `parent_doc_id`.

---

## Remaining Blocker: agentwebintegration@xcures.com

**Workspace:** xCures Workspace (ID: `9009113464`)  
**AgentWeb space ID:** `90141744509` (type-4 parent of "Product Capabilities" doc)

Current token state:
| Operation | Result | Missing permission |
|---|---|---|
| List docs | ✅ | — |
| Create doc at workspace root | ❌ 404 | `can_create_workspace_doc` |
| Create page inside doc | ❌ 404 | `edit_view` on space `90141744509` |
| List spaces | ❌ Empty | No space access |

### To fix (ClickUp side):
1. Go to xCures ClickUp workspace → Settings → Members
2. Find `agentwebintegration@xcures.com` → grant **Editor** access on the "AgentWeb"
   space (space ID `90141744509`), not just viewer
3. In AgentWeb: Settings → Integrations → disconnect and **re-connect ClickUp** to
   refresh the OAuth token with new permissions

### To verify after fix:
Run the API probe script:
```bash
cd /home/ec2-user/agentweb/backend
node -r dotenv/config -e "
require('ts-node').register({ project: './tsconfig.json', transpileOnly: true });
const { decryptPassword } = require('./src/utils/crypto');
const axios = require('axios');
// ... (get ENCRYPTED from DynamoDB for agentwebintegration@xcures.com userId f958eb3e-...)
// Tests: createDoc at root, createPageInDoc in 8cfrabr-46514, listSpaces
"
```
Then browser test with `agentwebintegration@xcures.com` (password in 1Password), asking
Emma: *"Write a doc to the AgentWeb folder"*.

---

## Files Changed
- `backend/src/services/clickupService.ts`
- `backend/src/services/agentModeService.ts`
- `backend/src/emma/tools.ts`
- `backend/src/__tests__/agentModeService.clickupKnowledgeBase.test.ts`
