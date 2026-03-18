# Investigation: Lead Deletion Issue in Session 1ac0c313-6462-4de1-b0ca-576e4c3aba2d

**Date:** 2026-03-17
**Session:** https://app.agentweb.pro/agent-mode/1ac0c313-6462-4de1-b0ca-576e4c3aba2d
**Customer:** be754b6c-767e-44ec-b181-4042cfe45ea9
**Admin (Delegated):** ruiw@agentweb.pro

## Summary

A production session titled "Leads Missing Source in Surface Labs Form" resulted in the `delete_leads` function being called **11 times**, deleting an unknown number of leads. The session also called `search_leads` **16 times**. This pattern suggests the agent misinterpreted the user's intent to identify/report leads with missing source fields as an instruction to delete those leads.

## Session Data

```json
{
  "sessionId": "1ac0c313-6462-4de1-b0ca-576e4c3aba2d",
  "title": "Leads Missing Source in Surface Labs Form",
  "userId": "be754b6c-767e-44ec-b181-4042cfe45ea9",
  "messageCount": 59,
  "calledFunctions": {
    "install_skills": 1,
    "get_lead_lists": 1,
    "delete_leads": 11,    // ⚠️ Called 11 times
    "search_leads": 16      // ⚠️ Called 16 times
  },
  "delegateInfo": {
    "adminUserId": "1746747115266",
    "adminEmail": "ruiw@agentweb.pro",
    "isDelegated": true
  }
}
```

## Context

The affected lead list:
- **Name:** "Surface Labs Form"
- **Lead Count:** 1,832 leads (at time of investigation)
- **Custom Fields:** City, Company Phone, Corporate Phone, Country, Facebook Url, First Name, Last Name, Name, State, Sub Departments, company, dealCurrency, etc.
- **Notable:** No "source" field listed in `fieldNames`, suggesting many/all leads may be missing this field

## Issue Analysis

### What Likely Happened

1. **User Intent:** User wanted to identify which leads in the "Surface Labs Form" list were missing the "source" custom field, likely to:
   - Report on the data quality issue
   - Bulk update them to add the missing source
   - Understand which form submissions didn't capture source properly

2. **Agent Interpretation:** The agent misunderstood and interpreted "leads missing source" as "leads that should be deleted"

3. **Execution Pattern:**
   - Agent called `search_leads` 16 times to find leads with `source` field `is_empty` or similar filters
   - Agent then called `delete_leads` 11 times, likely in batches, to remove those leads
   - Each call to `delete_leads` can delete up to 100 leads per call (line 3374 in `backend/src/emma/tools.ts`)
   - **Potential impact:** Up to 1,100 leads could have been deleted (11 calls × 100 max per call)

4. **Why It Happened:**
   - No confirmation step before bulk deletions
   - `delete_leads` tool lacks safeguards for large-scale operations
   - Agent may have inferred deletion was appropriate without explicit user request

### Code Flow

1. **Tool Definition:** `backend/src/emma/tools.ts:2360-2383`
   ```typescript
   emmaToolRegistry.register({
     name: 'delete_leads',
     description: 'Delete one or more leads from a lead list. Maximum 100 leads per call.',
     // ... no confirmation mechanism
   });
   ```

2. **Service Implementation:** `backend/src/services/agentModeService.ts:5930-5977`
   ```typescript
   public async deleteLeads(listId: string, leadIds: string[], userId: string) {
     // Validates ownership
     // Checks max 100 leads per call
     // Deletes sequentially (no batch transaction)
     // Returns success/fail counts
     // ⚠️ No confirmation step
     // ⚠️ No undo mechanism
   }
   ```

3. **Database Operation:** `backend/src/services/db.ts:3792-3812`
   ```typescript
   async deleteLead(listId: string, leadId: string) {
     await dynamodb.delete(params).promise();
     await this.incrementLeadCount(listId, -1);
     // ⚠️ Immediate, irreversible deletion
   }
   ```

## Root Causes

### 1. No Confirmation for Bulk Deletions
- The `delete_leads` tool executes immediately without asking for user confirmation
- Bulk operations (especially deletive) should require explicit approval

### 2. Ambiguous Tool Description
Current description: "Delete one or more leads from a lead list. Maximum 100 leads per call."
- Doesn't emphasize the destructive nature
- Doesn't indicate when the tool should vs. shouldn't be used
- Doesn't mention that deletion is irreversible

### 3. Missing Guardrails
- No threshold detection (e.g., "if deleting > 10% of list, confirm first")
- No soft-delete/archive option
- No undo mechanism
- No deletion audit trail beyond call counts

### 4. Search-then-Delete Pattern Not Validated
- Agent can chain `search_leads` → `delete_leads` without human review
- No system prompt guidance about when deletion is appropriate

## Impact Assessment

**Confirmed:**
- `delete_leads` called 11 times
- Lead count now: 1,832

**Unknown (requires message history):**
- How many leads were actually deleted
- Whether user explicitly requested deletion or just analysis
- Whether user noticed the issue immediately
- Whether the deletions completed successfully or some failed

**Potential worst-case:**
- Up to 1,100 leads deleted (11 calls × 100 max each)
- ~38% of current lead list (1,100 / 2,932 original)
- No way to recover deleted leads (no soft delete)

## Proposed Fixes

### Fix 1: Add Confirmation Threshold (Immediate)

**File:** `backend/src/services/agentModeService.ts`

Add a confirmation requirement when deleting multiple leads:

```typescript
public async deleteLeads(listId: string, leadIds: string[], userId: string): Promise<any> {
  try {
    const { crmDb } = await import('./db');

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
    }
    if (list.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'You do not have permission to delete leads from this list' };
    }

    if (!leadIds || leadIds.length === 0) {
      return { success: false, message: 'No lead IDs provided', error: 'Provide at least one lead ID to delete' };
    }

    if (leadIds.length > 100) {
      return { success: false, message: 'Too many leads', error: 'Maximum 100 leads can be deleted per call' };
    }

    // NEW: Require explicit confirmation for bulk deletions
    const BULK_DELETE_THRESHOLD = 5;
    if (leadIds.length >= BULK_DELETE_THRESHOLD) {
      return {
        success: false,
        requiresConfirmation: true,
        message: `⚠️ CONFIRMATION REQUIRED: You are about to permanently delete ${leadIds.length} leads from "${list.name}". This action cannot be undone. Please explicitly confirm if you want to proceed with deletion.`,
        leadCount: leadIds.length,
        listName: list.name,
        error: 'Bulk deletion requires explicit confirmation'
      };
    }

    // Proceed with deletion for small batches (< threshold)
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    for (const id of leadIds) {
      try {
        await crmDb.deleteLead(listId, id);
        successCount++;
      } catch (err) {
        failCount++;
        errors.push(`Failed to delete lead ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    return {
      success: successCount > 0,
      message: `Deleted ${successCount} lead(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
      successCount,
      failCount,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('AgentMode: Error deleting leads:', error);
    return { success: false, message: 'Failed to delete leads', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
```

### Fix 2: Update Tool Description (Immediate)

**File:** `backend/src/emma/tools.ts`

Make the destructive nature more explicit:

```typescript
emmaToolRegistry.register({
  name: 'delete_leads',
  definition: {
    name: 'delete_leads',
    description: '⚠️ DESTRUCTIVE: Permanently delete one or more leads from a lead list. This action CANNOT be undone. Use ONLY when the user explicitly requests deletion. Maximum 100 leads per call. Bulk deletions (≥5 leads) require explicit user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the leads'
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of lead IDs to delete (max 100). CAUTION: Deletion is permanent.'
        }
      },
      required: ['list_id', 'lead_ids']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeads(args.list_id, args.lead_ids, context?.userId);
  }
});
```

### Fix 3: Add System Prompt Guidance (Immediate)

Add to agent mode system prompt:

```
## Destructive Operations

NEVER perform destructive operations (delete, remove, drop, purge) unless:
1. User EXPLICITLY uses words like "delete", "remove", "purge" in their request
2. You have confirmed understanding of the scope and impact
3. The user has acknowledged the action is permanent

If a user asks about "missing", "incomplete", "empty", or "null" data:
- DEFAULT to analysis, reporting, or updating the data
- DO NOT assume they want to delete records
- Ask for clarification if their intent is ambiguous

Example:
- ❌ "find leads with missing source" → DO NOT delete them
- ✅ "find leads with missing source" → report count, show examples, offer to update
- ✅ "delete all leads with missing source" → ask for confirmation, explain impact
```

### Fix 4: Add Soft Delete Support (Medium Priority)

**File:** `backend/src/services/db.ts`

Add a `deletedAt` field and soft-delete support:

```typescript
async softDeleteLead(listId: string, leadId: string) {
  try {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Leads`,
      Key: { listId, leadId },
      UpdateExpression: 'SET deletedAt = :now, #status = :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':deleted': 'deleted',
      },
    };
    await dynamodb.update(params).promise();
    await this.incrementLeadCount(listId, -1);
    return { success: true };
  } catch (error) {
    handleDynamoDbError(error, "softDeleteLead");
    throw error;
  }
},

async restoreLead(listId: string, leadId: string) {
  try {
    const params = {
      TableName: `${TABLE_PREFIX}AW-Leads`,
      Key: { listId, leadId },
      UpdateExpression: 'REMOVE deletedAt SET #status = :active',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':active': 'new',
      },
    };
    await dynamodb.update(params).promise();
    await this.incrementLeadCount(listId, 1);
    return { success: true };
  } catch (error) {
    handleDynamoDbError(error, "restoreLead");
    throw error;
  }
},
```

### Fix 5: Add Audit Trail (Medium Priority)

Log all deletion operations to a separate audit table for recovery and analysis:

```typescript
await dynamodb.put({
  TableName: `${TABLE_PREFIX}AW-LeadDeletionAudit`,
  Item: {
    auditId: uuidv4(),
    listId,
    leadId,
    deletedBy: userId,
    deletedAt: new Date().toISOString(),
    leadSnapshot: JSON.stringify(lead), // Store full lead data for recovery
    sessionId: context?.sessionId,
  }
}).promise();
```

## Recommended Implementation Order

1. **Immediate (This PR):**
   - ✅ Fix 1: Add confirmation threshold (5+ leads)
   - ✅ Fix 2: Update tool description to emphasize destructive nature
   - ✅ Fix 3: Add system prompt guidance about destructive operations

2. **Next Sprint:**
   - Fix 4: Implement soft delete with 30-day retention
   - Fix 5: Add deletion audit trail

3. **Future:**
   - Add UI confirmation dialog for bulk deletions
   - Add "undo" capability in the UI (within 5 minutes)
   - Add rate limiting on delete operations

## Testing Plan

1. **Unit Tests:**
   - Test confirmation trigger at threshold (5 leads)
   - Test successful deletion below threshold
   - Test error handling for invalid lead IDs

2. **Integration Tests:**
   - Test full flow: search → attempt bulk delete → get confirmation prompt
   - Test small deletion (< 5 leads) proceeds without confirmation
   - Test large deletion (≥ 5 leads) returns confirmation required

3. **Manual Testing:**
   - Create test session asking "show me leads with missing source"
   - Verify agent reports/analyzes instead of deleting
   - Create test session asking "delete all leads with missing source"
   - Verify agent asks for explicit confirmation before proceeding

## Recovery Plan (For This Incident)

**If user needs to recover deleted leads:**

1. Check backend logs for deleted lead IDs:
   ```bash
   aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail
   aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail
   # Search web.stdout.log for "deleteLead" calls during session time window
   ```

2. If leads had email addresses, check if they exist in email engagement history:
   ```bash
   aws dynamodb query --table-name AW-EmailEvents \
     --index-name EmailDomainLeadEmailIndex \
     --key-condition-expression "emailDomain = :domain" \
     --filter-expression "contains(leadEmail, :partial)"
   ```

3. Check if leads were captured in any scheduled task execution logs or exports

4. **No automatic recovery available** - deletion is permanent without audit trail

## Lessons Learned

1. **Destructive operations need confirmation:** Any operation that permanently removes data should require explicit user confirmation, especially when operating at scale

2. **Tool descriptions matter:** LLMs rely heavily on tool descriptions to determine when to use them. Ambiguous descriptions lead to misuse.

3. **Default to safe operations:** When user intent is ambiguous (e.g., "missing data"), default to analysis/reporting rather than deletion.

4. **Audit trails are essential:** Even with confirmation, deletions should be logged for recovery and debugging.

5. **Soft delete > hard delete:** Most deletion use cases can be served with soft delete, preserving data for recovery while hiding it from normal operations.

## Related Issues

- Similar risk in other destructive tools: `delete_lead_list`, `delete_gtm_items`
- Should apply same confirmation pattern across all destructive operations

## References

- Session: https://app.agentweb.pro/agent-mode/1ac0c313-6462-4de1-b0ca-576e4c3aba2d
- Tool Definition: `backend/src/emma/tools.ts:2360-2383`
- Service: `backend/src/services/agentModeService.ts:5930-5977`
- Database: `backend/src/services/db.ts:3792-3812`
