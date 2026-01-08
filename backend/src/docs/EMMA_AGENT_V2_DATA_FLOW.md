# Emma Agent v2 - Data Flow Documentation

> **Last Updated:** January 2026  
> **Author:** AgentWeb Development Team  
> **Version:** 2.0

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [High-Level Data Flow](#high-level-data-flow)
4. [Detailed Component Breakdown](#detailed-component-breakdown)
5. [Request Lifecycle](#request-lifecycle)
6. [Tool Execution Flow](#tool-execution-flow)
7. [File and Function Reference](#file-and-function-reference)

---

## Overview

Emma Agent v2 is a modular AI agent system that uses:
- **Intent-based tool loading** to reduce token usage by 50-85%
- **Strategy pattern** for tool execution
- **Worker process isolation** to prevent blocking the main event loop
- **DB-driven subscription filtering** for tool access control

### Key Architectural Improvements over V1

| Feature | V1 (Legacy) | V2 (New) |
|---------|-------------|----------|
| Tool Loading | All tools sent to LLM | Intent-based filtering |
| Tool Execution | Large switch statement | Strategy pattern with handlers |
| LLM Access | Scattered across services | Centralized `LLMClientFactory` |
| Tool Definitions | Hardcoded in service | Modular definitions by category |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Customer Portal)                         │
│                                                                              │
│  User types message → POST /api/agent-mode/generate                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ROUTES LAYER                                    │
│                                                                              │
│  📁 routes/agentMode.ts                                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ router.post('/generate', asyncHandler(agentModeController.generateResponse)) │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CONTROLLER LAYER                                  │
│                                                                              │
│  📁 controllers/agentModeController.ts                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ generateResponse() → generateSessionResponse()                          │ │
│  │       │                                                                 │ │
│  │       └── Calls generateMarketingResponseWorkerService.runInWorker()    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             WORKER PROCESS                                   │
│                                                                              │
│  📁 workers/generateMarketingResponseWorker.ts                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Runs in separate process (fork)                                       │ │
│  │ • Initializes AgentModeServiceV2 based on USE_AGENT_V2 flag             │ │
│  │ • Calls service.generateMarketingResponse()                             │ │
│  │ • Sends progress updates back to parent process                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             SERVICE LAYER (V2)                               │
│                                                                              │
│  📁 services/AgentModeServiceV2.ts                                           │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ generateMarketingResponse()                                             │ │
│  │    │                                                                    │ │
│  │    ├── 1. Get system prompt (PromptTemplateService)                     │ │
│  │    ├── 2. Get available templates (legacy delegation)                   │ │
│  │    ├── 3. Select tools by intent (ToolSelector.selectToolsForUser)      │ │
│  │    ├── 4. Build context messages                                        │ │
│  │    ├── 5. Main LLM Loop (up to 20 iterations):                          │ │
│  │    │      ├── Call LLM (LLMClientFactory.callLLM)                        │ │
│  │    │      ├── If tool_calls in response:                                │ │
│  │    │      │     └── Execute tools (ToolExecutor.execute)                │ │
│  │    │      └── Continue until no more tool_calls                         │ │
│  │    └── 6. Return response with content, toolCalls, sources              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│   TOOL REGISTRY     │   │   TOOL SELECTOR     │   │   TOOL EXECUTOR     │
│                     │   │                     │   │                     │
│ 📁 tools/          │   │ 📁 tools/           │   │ 📁 tools/           │
│ ToolRegistry.ts    │   │ ToolSelector.ts     │   │ ToolExecutor.ts     │
│                     │   │                     │   │                     │
│ • stores all tools  │   │ • intent detection  │   │ • strategy pattern  │
│ • category indexing │   │ • DB subscription   │   │ • handler execution │
│ • OpenAI format     │   │ • token savings     │   │ • timeout handling  │
└─────────────────────┘   └─────────────────────┘   └─────────────────────┘
          │                           │                           │
          └───────────────────────────┼───────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TOOL DEFINITIONS & HANDLERS                         │
│                                                                              │
│  📁 tools/definitions/             📁 tools/handlers/                        │
│  ├── coreTools.ts                  ├── index.ts                              │
│  ├── contentTools.ts               └── (handler configs)                     │
│  ├── researchTools.ts                                                        │
│  ├── crmTools.ts                   📁 services/ (Migrated Services)          │
│  ├── gtmTools.ts                   ├── core/FileService.ts                   │
│  ├── analyticsTools.ts             ├── research/WebSearchService.ts          │
│  ├── automationTools.ts            ├── research/KnowledgeBaseService.ts      │
│  ├── bookTools.ts                  ├── crm/BrandService.ts                   │
│  └── templateTools.ts              ├── content/BlogService.ts                │
│                                    └── ... (more services)                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LLM CLIENT FACTORY                                │
│                                                                              │
│  📁 services/llm/LLMClientFactory.ts                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Azure OpenAI (gpt-5-chat-2, gpt-5.2-chat)                             │ │
│  │ • Gemini (gemini-3-pro-preview, gemini-3-flash-preview)                  │ │
│  │ • Lazy client initialization                                            │ │
│  │ • Model configuration management                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## High-Level Data Flow

### When User Sends a Message

```
1. USER MESSAGE
   │
   ▼
2. POST /api/agent-mode/generate
   📁 routes/agentMode.ts (line 117-118)
   │
   ▼
3. agentModeController.generateResponse()
   📁 controllers/agentModeController.ts (line 1169-1259)
   │
   ├── Validates sessionId and userMessage
   ├── Gets session from database
   ├── Determines LLM model to use
   │
   ▼
4. generateSessionResponse()
   📁 controllers/agentModeController.ts (line 874-1003)
   │
   ├── Gets session from chatbotDb
   ├── Processes attachments (if any)
   ├── If first message: adds system prompt to session
   ├── Generates session title (if first message)
   ├── Saves user message to database
   │
   ▼
5. generateMarketingResponseWorkerService.runInWorker()
   📁 services/generateMarketingResponseWorkerService.ts (line 27-132)
   │
   ├── Forks new child process
   ├── Sends message params to worker
   ├── Handles progress callbacks
   │
   ▼
6. WORKER PROCESS
   📁 workers/generateMarketingResponseWorker.ts (line 47-93)
   │
   ├── Initializes AgentModeServiceV2 (if USE_AGENT_V2=true)
   ├── Calls service.generateMarketingResponse()
   │
   ▼
7. AgentModeServiceV2.generateMarketingResponse()
   📁 services/AgentModeServiceV2.ts (line 259-446)
   │
   ├── Gets system prompt
   ├── Gets available templates
   ├── Selects tools by intent (ToolSelector)
   ├── Builds context messages
   │
   ▼
8. LLM LOOP (max 20 iterations)
   📁 services/AgentModeServiceV2.ts (line 337-420)
   │
   ├── Calls LLM with filtered tools
   ├── If response has tool_calls:
   │   ├── Parses arguments
   │   ├── Executes tool (ToolExecutor)
   │   ├── Adds tool result to messages
   │   └── Continues loop
   ├── If no tool_calls: exits loop
   │
   ▼
9. RESPONSE
   │
   ├── Returns content, toolCalls, sources
   ├── Worker sends result to parent
   ├── Controller saves messages to database
   │
   ▼
10. JSON RESPONSE TO FRONTEND
```

---

## Detailed Component Breakdown

### 1. Routes Layer

**File:** `routes/agentMode.ts`

| Route | Method | Handler | Description |
|-------|--------|---------|-------------|
| `/generate` | POST | `generateResponse` | Main message generation endpoint |
| `/sessions` | GET | `getSessions` | Get user's chat sessions |
| `/sessions` | POST | `createSession` | Create new chat session |
| `/session/:sessionId` | GET | `getSession` | Get specific session |
| `/function-calls` | GET | `getAvailableFunctionCalls` | Get available tools |
| `/session/:sessionId/progress` | GET | `getProgress` | SSE progress updates |

### 2. Controller Layer

**File:** `controllers/agentModeController.ts`

#### Key Functions:

| Function | Lines | Purpose |
|----------|-------|---------|
| `ensureToolsRegistered()` | 21-35 | Thread-safe tool registration lock |
| `generateSessionResponse()` | 874-1003 | Core response generation orchestration |
| `generateResponse()` | 1169-1259 | HTTP endpoint handler |
| `setupSSEConnectionForSession()` | 803-866 | SSE connection setup |
| `getAvailableFunctionCalls()` | 1137-1167 | Returns tools filtered by subscription |

### 3. Worker Service

**File:** `services/generateMarketingResponseWorkerService.ts`

```typescript
class GenerateMarketingResponseWorkerService {
  async runInWorker(
    params: GenerateMarketingResponseParams,
    onProgress?: ProgressCallback
  ): Promise<GenerateMarketingResponseResult>
}
```

**Purpose:** 
- Runs `generateMarketingResponse` in a separate process
- Prevents blocking the main event loop
- Enables health checks during long operations
- 45-minute timeout for deep research operations

### 4. Worker Process

**File:** `workers/generateMarketingResponseWorker.ts`

**Initialization Flow:**
1. Load environment variables
2. Check `USE_AGENT_V2` flag (defaults to `true`)
3. Initialize appropriate service (V1 or V2)
4. Listen for messages from parent process

**Message Handling:**
```typescript
process.on('message', async (message: any) => {
  if (message.type === 'generateMarketingResponse') {
    const result = await service.generateMarketingResponse(...);
    process.send!({ type: 'success', result });
  }
});
```

### 5. AgentModeServiceV2

**File:** `services/AgentModeServiceV2.ts`

#### Initialization Flow:

```
AgentModeServiceV2.initialize()
    │
    ├── 1. Register all tool definitions
    │     └── registerAllTools(toolRegistry)
    │
    ├── 2. Create tool selector
    │     └── createToolSelector(toolRegistry)
    │
    └── 3. Register tool handlers
          ├── serviceRegistry.registerLegacy(legacyService)
          ├── serviceRegistry.register(fileService, ...)
          ├── createHandlers(serviceProvider, allHandlerConfigs)
          └── getSpecialHandlers(legacyService)
```

#### Key Methods:

| Method | Purpose |
|--------|---------|
| `initialize()` | Registers tools and handlers |
| `getAvailableTools()` | Returns intent-filtered tools in OpenAI format |
| `executeTool()` | Executes a tool via ToolExecutor |
| `generateMarketingResponse()` | Main LLM orchestration loop |
| `callLLM()` | Calls LLM via LLMClientFactory |

---

## Tool Execution Flow

### When Emma Decides to Call a Tool

```
1. LLM RESPONSE WITH TOOL CALL
   {
     "tool_calls": [{
       "id": "call_abc123",
       "function": {
         "name": "search_web",
         "arguments": "{\"query\": \"AI marketing trends\"}"
       }
     }]
   }
   │
   ▼
2. Parse Tool Call
   📁 services/AgentModeServiceV2.ts (line 374-382)
   │
   functionName = toolCall.function.name
   args = JSON.parse(toolCall.function.arguments)
   │
   ▼
3. Execute Tool
   📁 services/AgentModeServiceV2.ts (line 391-397)
   │
   result = await this.executeTool(functionName, args, userId, sessionId, llmModel, mockMode)
   │
   ▼
4. AgentModeServiceV2.executeTool()
   📁 services/AgentModeServiceV2.ts (line 224-253)
   │
   ├── Creates ToolContext { userId, sessionId, llmModel, mockMode }
   ├── Calls toolExecutor.execute(toolName, args, context)
   │
   ▼
5. ToolExecutor.execute()
   📁 tools/ToolExecutor.ts (line 139-206)
   │
   ├── Gets handler from handlers map
   ├── If mockMode: returns mock result
   ├── Executes handler with timeout (5 min default)
   ├── Formats result
   ├── Emits metrics
   │
   ▼
6. Tool Handler Execution
   📁 tools/handlers/ (various files)
   │
   ├── Handler receives (args, context)
   ├── Calls underlying service method
   ├── Returns result
   │
   ▼
7. Add Result to Messages
   📁 services/AgentModeServiceV2.ts (line 402-408)
   │
   messages.push({
     role: 'tool',
     tool_call_id: toolCall.id,
     content: JSON.stringify(minimalResult)
   })
   │
   ▼
8. Continue LLM Loop
   (Next iteration uses tool result in context)
```

---

## File and Function Reference

### Core Files Map

```
backend/src/
├── routes/
│   └── agentMode.ts                          # Route definitions
│
├── controllers/
│   └── agentModeController.ts                # Request handlers
│       ├── generateResponse()                 # Main endpoint (line 1169)
│       ├── generateSessionResponse()          # Core orchestration (line 874)
│       └── getAvailableFunctionCalls()        # Tool listing (line 1137)
│
├── services/
│   ├── AgentModeServiceV2.ts                 # V2 service (main entry)
│   │   ├── initialize()                       # Setup (line 65)
│   │   ├── getAvailableTools()               # Intent-based tools (line 168)
│   │   ├── executeTool()                      # Tool execution (line 224)
│   │   └── generateMarketingResponse()        # LLM loop (line 259)
│   │
│   ├── generateMarketingResponseWorkerService.ts  # Worker spawner
│   │   └── runInWorker()                      # Fork worker (line 27)
│   │
│   ├── llm/
│   │   ├── LLMClientFactory.ts               # LLM clients
│   │   │   ├── getClient()                    # Get client (line 186)
│   │   │   └── callLLM()                      # Make call (line 211)
│   │   ├── PromptTemplateService.ts          # Prompts
│   │   └── PromptBuilder.ts                  # Build prompts
│   │
│   ├── chatbotService.ts                     # Session management
│   └── agentModeService.ts                   # Legacy V1 service
│
├── workers/
│   └── generateMarketingResponseWorker.ts    # Worker process
│       ├── initializeV2()                     # V2 init (line 30)
│       ├── getService()                       # Get active service (line 39)
│       └── process.on('message')              # Handle messages (line 47)
│
├── tools/
│   ├── index.ts                              # Exports all tools
│   ├── ToolRegistry.ts                       # Tool storage
│   │   ├── register()                         # Add tool (line 29)
│   │   ├── getByCategory()                    # Filter by category (line 72)
│   │   └── toOpenAIFormat()                   # Convert format (line 128)
│   │
│   ├── ToolSelector.ts                       # Intent-based selection
│   │   ├── selectTools()                      # Basic selection (line 75)
│   │   └── selectToolsForUser()               # With subscription (line 133)
│   │
│   ├── ToolExecutor.ts                       # Execute tools
│   │   ├── register()                         # Add handler (line 71)
│   │   └── execute()                          # Run tool (line 139)
│   │
│   ├── definitions/                          # Tool definitions by category
│   │   ├── coreTools.ts
│   │   ├── contentTools.ts
│   │   ├── researchTools.ts
│   │   ├── crmTools.ts
│   │   ├── gtmTools.ts
│   │   ├── analyticsTools.ts
│   │   ├── automationTools.ts
│   │   ├── bookTools.ts
│   │   └── templateTools.ts
│   │
│   ├── handlers/                             # Tool handlers
│   │   └── index.ts                          # Handler configs
│   │
│   ├── types/                                # Type definitions
│   │   └── ToolCategories.ts                 # Category detection
│   │
│   ├── ServiceRegistry.ts                    # Service DI container
│   ├── HandlerFactory.ts                     # Handler creation
│   └── SubscriptionToolFilter.ts             # DB-based filtering
│
└── middleware/
    └── auth.ts                               # Authentication
```

### Key Function Call Chain

```
User Request Flow:
─────────────────
router.post('/generate')
  └─> agentModeController.generateResponse()
        └─> generateSessionResponse()
              ├─> chatbotDb.getChatSession()
              ├─> chatbotDb.addMessageToSession()
              └─> generateMarketingResponseWorkerService.runInWorker()
                    └─> [WORKER PROCESS]
                          └─> agentModeServiceV2.generateMarketingResponse()
                                ├─> promptTemplateService.getEmmaSystemPrompt()
                                ├─> toolSelector.selectToolsForUser()
                                └─> LLM Loop:
                                      ├─> llmClientFactory.callLLM()
                                      └─> toolExecutor.execute() (if tool_calls)

Tool Execution Flow:
────────────────────
toolExecutor.execute(toolName, args, context)
  └─> handler.execute(args, context)
        └─> serviceMethod(args) 
              [e.g., webSearchService.search()]
```

---

## Configuration & Feature Flags

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_AGENT_V2` | `true` | Enable V2 modular architecture |
| `AZURE_OPENAI_DEPLOYMENT_AGENT_MODE` | `gpt-5-chat-2` | Default Azure model |
| `NODE_ENV` | `development` | Environment mode |

### Switching Between V1 and V2

```bash
# Use V2 (default, recommended)
USE_AGENT_V2=true npm run dev

# Fall back to V1 (legacy)
USE_AGENT_V2=false npm run dev
```

---

## Summary

Emma Agent v2 follows a clean separation of concerns:

1. **Routes** → Define HTTP endpoints
2. **Controllers** → Handle HTTP requests, orchestrate flow
3. **Worker Service** → Offload heavy computation to worker process
4. **AgentModeServiceV2** → Main AI logic and LLM orchestration
5. **ToolSelector** → Intent-based tool filtering
6. **ToolExecutor** → Strategy pattern for tool execution
7. **LLMClientFactory** → Unified LLM access

This architecture enables:
- ✅ Non-blocking request handling
- ✅ 50-85% token savings via intent-based tool loading
- ✅ Easy addition of new tools via modular definitions
- ✅ DB-driven subscription control
- ✅ Fallback to legacy service if needed
