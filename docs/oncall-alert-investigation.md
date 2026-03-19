# Oncall Alert Investigation: `chatbotService_1.chatbotDb.addMessageToSession is not a function`

## Summary
Frequent oncall alert emails are being sent to `ruiw@agentweb.pro` with the error:
```
URGENT: Oncall Alert
Work Plan Session Failed: test-session-123
A predefined work plan session failed during fire-and-forget response generation.
Error: chatbotService_1.chatbotDb.addMessageToSession is not a function
```

## Root Cause
**Circular dependency issue** between `emailService.ts` and `chatbotService.ts` caused by dynamic `require()` statements.

## Technical Analysis

### Error Location
- **File**: `backend/src/controllers/agentModeController.ts`
- **Lines**: 4527-4571 (fire-and-forget handler for work plan sessions with `startingMessage`)
- **Trigger**: When a work plan session is created with a `startingMessage` parameter, the system fires off a background task to generate the first AI response

### The Call Chain
1. User creates a work plan session with `startingMessage` → `agentModeController.createSessionWithPlan()`
2. Fire-and-forget: `generateSessionResponse()` is called asynchronously (line 4529-4571)
3. If an error occurs, the handler tries to:
   - Save an error message to the session using `chatbotDb.addMessageToSession()` (line 4548)
   - Create an interactive share link via `sendAgentModeOncallAlert()` (line 4557)
4. Inside `sendAgentModeOncallAlert()` → `chatbotDb.createOrReuseInteractiveShare()` is called
5. Inside `createOrReuseInteractiveShare()` → potentially calls email service functions
6. **The circular dependency breaks here**: `chatbotDb.addMessageToSession` becomes undefined

### The Circular Dependency
```
chatbotService.ts (exports chatbotDb)
  ↓ imports
emailService.ts (exports emailService)
  ↓ requires at runtime (lines 948, 1134)
chatbotService.ts (incomplete export due to circular ref)
  ↓ chatbotDb.addMessageToSession = undefined
ERROR: chatbotService_1.chatbotDb.addMessageToSession is not a function
```

### Evidence in Code

**Problem Code in `emailService.ts`:**
```typescript
// Line 948 - Dynamic require inside async function
const { chatbotDb } = require('./chatbotService');

// Line 1134 - Dynamic require inside async function
const { chatbotDb } = require('./chatbotService');
```

**Why this causes issues:**
1. `chatbotService.ts` imports `emailService` at the top (line 10):
   ```typescript
   import { emailService } from '../services/emailService';
   ```
2. During module initialization, `emailService` is loaded first
3. When `emailService.ts` later uses `require('./chatbotService')` at runtime, it creates a circular dependency
4. Due to the circular reference, `chatbotDb` may be incompletely initialized when accessed
5. The transpiled code shows `chatbotService_1.chatbotDb` (CommonJS pattern), indicating dynamic loading issues

### Where Dynamic Requires Are Used
1. **`emailService.ts:948`** - In `sendScheduledChatResultEmail()` when creating interactive shares for scheduled chat sessions
2. **`emailService.ts:1134`** - In `sendScheduledChatDailyDigest()` when creating interactive shares for daily digest

### Why This Sends Oncall Alerts
The error occurs in the fire-and-forget error handler (line 4548), which itself is trying to handle errors gracefully. When `chatbotDb.addMessageToSession()` fails due to the circular dependency:
1. The error is caught in the `saveErr` handler (line 4549-4551)
2. The oncall alert is still sent (line 4557-4570) with the error details
3. This results in the oncall alert email to `ruiw@agentweb.pro`

## Solution

### Fix: Replace Dynamic Requires with Top-Level Imports

**Change in `emailService.ts`:**
```typescript
// At the top of the file, add:
import { chatbotDb } from './chatbotService';

// Remove the require() statements at lines 948 and 1134:
// ❌ const { chatbotDb } = require('./chatbotService');
// ✅ Just use chatbotDb directly (already imported)
```

This ensures:
1. Proper module initialization order
2. No circular dependency issues
3. `chatbotDb` is fully initialized before use

### Testing the Fix
1. Deploy the fix to staging/test environment
2. Trigger a work plan session with `startingMessage`
3. Monitor logs for:
   - No more `chatbotService_1.chatbotDb.addMessageToSession is not a function` errors
   - No oncall alerts sent
   - Successful interactive share creation

## Prevention
- **Avoid dynamic `require()` in TypeScript/ES modules** - Always use top-level `import` statements
- **Watch for circular dependencies** - Use static analysis tools like `madge` to detect circular imports
- **Test fire-and-forget handlers** - Ensure error handling paths are covered by tests

## Related Files
- `backend/src/services/emailService.ts` (contains the problematic requires)
- `backend/src/services/chatbotService.ts` (exports chatbotDb)
- `backend/src/controllers/agentModeController.ts` (fire-and-forget handler that triggers the error)
- `backend/src/utils/agentModeAlerts.ts` (sends oncall alerts)

## Session ID Pattern
The error messages reference sessions like `test-session-123`, which are **test/mock session IDs** used during development or CI testing. This suggests the issue may be triggered by:
- Automated tests
- Development environment testing
- Staging environment with test data
