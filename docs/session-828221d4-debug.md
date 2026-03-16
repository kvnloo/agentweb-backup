# Debug Analysis: Session 828221d4-69b0-47ec-b32e-f31c82f83a6e

## Issue Summary

Scheduled chat session terminated prematurely after only 8 seconds with no assistant response generated, despite successfully calling `read_brand_guidelines`.

## Session Details

**Production Session ID:** `828221d4-69b0-47ec-b32e-f31c82f83a6e`

**Timeline:**
- Created: 2026-03-16T10:00:01.969Z
- Updated: 2026-03-16T10:00:09.414Z
- **Duration: 8 seconds** (should take minutes for a content generation task)

**Session State:**
- `messageCount`: 2 (system prompt + user prompt only, NO assistant response)
- `calledFunctions`: `{ read_brand_guidelines: 1 }` ✓ Tool was called successfully
- `llmModel`: `gemini-3.1-pro-preview`
- `sessionType`: `scheduled`
- `error`: undefined (no error captured!)
- `errorStack`: undefined
- `workPlan`: undefined

**User Request:**
Write a thought leadership blog article for Zheng Xu (CEO of Ebots) about onshoring manufacturing with precision robotics. The prompt is very detailed (1000+ words) and requires searching brand guidelines, market strategy, knowledge base, and the web.

## Expected Behavior

For a scheduled chat with this prompt:
1. Create session ✓
2. Install required skills ✓
3. Call `read_brand_guidelines` ✓
4. Call other tools (search_knowledge_base, search_web, etc.) ✗ Never happened
5. Generate content ✗ Never happened
6. Return response ✗ Never happened

## What Actually Happened

1. Session created at 10:00:01 ✓
2. System prompt added ✓
3. User prompt added ✓
4. **First LLM call made** with tools available
5. LLM responded with `read_brand_guidelines` tool call ✓
6. Tool executed successfully ✓
7. **Second LLM call with tool result** → **FAILED SILENTLY** ✗
8. Session ended at 10:00:09 (8 seconds total)

## Root Cause Analysis

### Code Flow

```
runScheduledChat()
  └─> runVerifiedChat()
      └─> generateSessionResponse()
          └─> worker process (generateMarketingResponseWorker.ts)
              └─> agentModeService.generateMarketingResponse()
                  └─> Loop (max 20 iterations):
                      1. callLLM() with tools
                      2. Execute tool calls
                      3. callLLM() with tool results  ← FAILURE HERE
```

### Gemini Client Initialization

```typescript
// agentModeService.ts:671-674
if (model === 'gemini-3.1-pro-preview' || ...) {
  client = await this.getGeminiClient();
  this.llmModels[model].client = client;
}
```

The Gemini client is lazy-loaded on first use. Once cached, it's reused for all subsequent calls.

### Error Handling Gaps

1. **Worker process error handlers** (lines 109-127 in worker):
   - Catch `uncaughtException` and `unhandledRejection`
   - Send error to parent process
   - Exit with code 1

2. **callLLM retry logic** (lines 689-713):
   - 3 attempts with exponential backoff
   - Only retries on transient errors (503, 429, timeouts)
   - Other errors thrown immediately

3. **generateMarketingResponse** (line 727):
   - Top-level try/catch
   - BUT: If worker crashes, error might not propagate properly

### Likely Failure Scenarios

#### Scenario 1: Gemini API Error (MOST LIKELY)
- First LLM call succeeds
- Tool executes successfully
- **Second LLM call to Gemini API fails** with:
  - Rate limit (429) - retry logic should handle this
  - Invalid request (400) - thrown immediately, should be caught
  - Timeout - retry logic should handle this
  - **API internal error (500/503)** - retry logic attempts 3 times, then throws
  - **Model overload** - Gemini rejects the request

If all 3 retries fail, the error should propagate to the worker's message handler (line 97-105), which sends the error to the parent. But the parent might not save the error to the session record properly.

#### Scenario 2: Worker Process OOM
- Worker has 4GB memory limit
- Gemini response might cause memory spike
- Worker killed by OS
- Error handlers send generic "Worker process exited" error

#### Scenario 3: Tool Result Format Issue
- `read_brand_guidelines` returns large result
- Second LLM call includes this in the context
- Gemini rejects due to context length
- Error not properly logged

#### Scenario 4: MCP Tool Execution Deadlock
- Tool execution hangs indefinitely
- Worker timeout (45 min) not hit yet (only 8 seconds elapsed)
- Something else kills the worker

### Evidence Points to Scenario 1

**Why it's Scenario 1:**
1. Tool executed successfully (we have `calledFunctions`)
2. Session ended in 8 seconds (not 45 min timeout)
3. No error field in session record (error handling gap)
4. Gemini model is known to have intermittent issues

**Missing evidence:**
- No backend logs available to confirm Gemini API error
- No schedule record found (couldn't query runResults)
- No error email sent to user (would indicate subscription check failure)

## Proposed Fixes

### Fix 1: Better Error Logging in runScheduledChat

**File:** `backend/src/controllers/agentModeController.ts`

**Current code (line 1002-1010):**
```typescript
} catch (error) {
  console.error(`Error in runScheduledChat for ${schedule.scheduleName}:`, error);
  console.error('Full error details:', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    name: error instanceof Error ? error.name : 'Unknown'
  });
  throw error;
}
```

**Issue:** Error is logged but not saved to session record. The throw propagates up but session remains without error field.

**Proposed fix:** Catch error, save to session record, then return error result:

```typescript
} catch (error) {
  console.error(`Error in runScheduledChat for ${schedule.scheduleName}:`, error);

  // Save error to session record if session was created
  if (sessionId) {
    try {
      await chatbotDb.updateSessionError(sessionId,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error.stack : undefined
      );
    } catch (saveError) {
      console.error('Failed to save error to session:', saveError);
    }
  }

  // Return error result instead of throwing
  return {
    scheduleId: schedule.scheduleId,
    runId: require('uuid').v4(),
    status: 'failure' as const,
    passed: false,
    actualResponse: `Error during execution: ${error instanceof Error ? error.message : String(error)}`,
    actualFunctionCalls: [],
    keywordMatches: [],
    keywordMisses: schedule.keywords || [],
    functionCallMatches: [],
    functionCallMisses: schedule.requiredFunctionCalls || [],
    executionTime: 0,
    sessionId: sessionId || '',
    attempt: 0,
    createdAt: new Date().toISOString()
  };
}
```

### Fix 2: Add updateSessionError Method

**File:** `backend/src/services/chatbotService.ts`

Add method to save error details to session:

```typescript
async updateSessionError(sessionId: string, error: string, errorStack?: string) {
  const updateExpression = 'SET #error = :error, #errorStack = :errorStack, #updatedAt = :updatedAt';
  const expressionAttributeNames = {
    '#error': 'error',
    '#errorStack': 'errorStack',
    '#updatedAt': 'updatedAt'
  };
  const expressionAttributeValues = {
    ':error': error,
    ':errorStack': errorStack || null,
    ':updatedAt': new Date().toISOString()
  };

  await dynamodb.update({
    TableName: this.sessionsTableName,
    Key: { sessionId },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues
  }).promise();
}
```

### Fix 3: Better Error Handling in Worker

**File:** `backend/src/workers/generateMarketingResponseWorker.ts`

**Current code (line 97-105):**
```typescript
} catch (error) {
  // Send error back to parent process
  process.send!({
    type: 'error',
    requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
}
```

**Issue:** Error sent to parent but parent might not propagate to session.

**Add:** Log more context about which step failed:

```typescript
} catch (error) {
  console.error('[Worker] Error in generateMarketingResponse:', {
    requestId,
    sessionId: message.params?.sessionId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });

  process.send!({
    type: 'error',
    requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    context: {
      sessionId: message.params?.sessionId,
      llmModel: message.params?.llmModel,
    }
  });
}
```

### Fix 4: Gemini-Specific Error Handling

**File:** `backend/src/services/agentModeService.ts`

Add specific error handling for Gemini API failures in `callLLM`:

```typescript
} catch (error) {
  const isLastAttempt = attempt >= maxAttempts;

  // Log Gemini-specific errors with more context
  if (model.startsWith('gemini-')) {
    console.error(`AgentMode: Gemini API error on attempt ${attempt}/${maxAttempts}:`, {
      model,
      error: error instanceof Error ? error.message : String(error),
      isTransient: isTransientLLMError(error),
      willRetry: !isLastAttempt && isTransientLLMError(error)
    });
  }

  if (!isTransientLLMError(error) || isLastAttempt) {
    throw error;
  }
  // ... rest of retry logic
}
```

## Testing Plan

1. **Copy session to dev** ✓ (already done)
2. **Attempt to reproduce** in dev environment:
   - Log in as test user
   - Navigate to session URL
   - Check if error occurs with Gemini model
3. **Switch to different model** and retry
4. **Check backend logs** for Gemini API errors
5. **Implement fixes** and test again
6. **Monitor production** for similar issues

## Next Steps

1. ✓ Session copied to dev
2. Check if services are running in dev environment
3. Attempt to load the session in browser
4. Implement error logging fixes
5. Test with Gemini model
6. Test with Claude model as fallback
7. Document findings in dev.md
