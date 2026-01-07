# Adding New Tools to Emma

This guide explains how to add new tools (function calls) to Emma, the AI assistant.

## Architecture Overview

Emma's tool system has three main components:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Tool Architecture                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. Tool Definition (schema)     → What the LLM sees                 │
│     └── definitions/*.ts                                              │
│                                                                       │
│  2. Handler Config (routing)     → Maps tool name → service method   │
│     └── handlers/configs.ts                                           │
│                                                                       │
│  3. Service Method (logic)       → Actual implementation             │
│     └── agentModeService.ts                                           │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start: Adding a Simple Tool

### Step 1: Create the Tool Definition

Add your tool to the appropriate file in `src/tools/definitions/`:

| Category | File | Use For |
|----------|------|---------|
| `core` | `coreTools.ts` | Basic utilities (search, file ops) |
| `content` | `contentTools.ts` | Content creation (blogs, images, videos) |
| `research` | `researchTools.ts` | Research & analysis |
| `crm` | `crmTools.ts` | CRM & lead management |
| `gtm` | `gtmTools.ts` | Go-to-market planning |
| `analytics` | `analyticsTools.ts` | Metrics & analytics |
| `automation` | `automationTools.ts` | Task automation & workflows |
| `books` | `bookTools.ts` | Book/document creation |
| `templates` | `templateTools.ts` | Template management |

**Example: Adding a `send_email` tool to `coreTools.ts`:**

```typescript
// In src/tools/definitions/coreTools.ts

export const coreTools: ToolDefinition[] = [
  // ... existing tools ...

  {
    name: 'send_email',              // Unique identifier
    version: '1.0.0',                // Version tracking
    category: 'core',                // Must match file category
    schema: {
      description: 'Send an email to a recipient. Use this when the user wants to send an email.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Email address of the recipient'
          },
          subject: {
            type: 'string',
            description: 'Email subject line'
          },
          body: {
            type: 'string',
            description: 'Email body content (can include HTML)'
          },
          cc: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional CC recipients'
          }
        },
        required: ['to', 'subject', 'body']
      }
    }
  }
];
```

### Step 2: Add the Handler Config

Add a handler config to `src/tools/handlers/configs.ts`:

```typescript
// In src/tools/handlers/configs.ts

export const coreHandlerConfigs: SimpleHandlerConfig[] = [
  // ... existing configs ...

  {
    name: 'send_email',           // Must match tool definition name
    methodName: 'sendEmail',      // Method name in agentModeService
    argOrder: [                   // How to map args to method parameters
      'args.to',                  // From tool call arguments
      'args.subject',
      'args.body',
      'args.cc',
      'context.userId',           // From execution context
      'context.sessionId'
    ]
  }
];
```

**Argument Mapping:**
- `args.xxx` - Value from the tool call arguments
- `context.userId` - Current user's ID
- `context.sessionId` - Current session ID
- `context.llmModel` - Current LLM model being used
- `context.mockMode` - Whether running in mock mode

### Step 3: Implement the Service Method

Add the implementation in `src/services/agentModeService.ts`:

```typescript
// In src/services/agentModeService.ts

async sendEmail(
  to: string,
  subject: string,
  body: string,
  cc: string[] | undefined,
  userId: string,
  sessionId: string
): Promise<any> {
  try {
    // Your implementation here
    const result = await emailService.send({
      to,
      subject,
      body,
      cc: cc || []
    });

    return {
      success: true,
      messageId: result.id,
      formattedContent: `✅ Email sent successfully to ${to}`
    };
  } catch (error) {
    console.error('Failed to send email:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}
```

### Step 4: Update System Prompt (Optional)

If the tool needs special instructions, update the system prompt in `agentModeService.ts`:

```typescript
// In getMarketingSystemPrompt()

## Email Sending
- Use 'send_email' to send emails on behalf of the user
- Always confirm the email content with the user before sending
- Do not send emails without explicit user approval
```

---

## Tool Definition Schema

```typescript
interface ToolDefinition {
  /** Unique tool identifier (snake_case) */
  name: string;
  
  /** Semantic version for tracking changes */
  version: string;
  
  /** Category for intent-based loading */
  category: ToolCategory;
  
  /** Mark deprecated tools */
  deprecated?: boolean;
  deprecatedMessage?: string;
  
  /** OpenAI-compatible function schema */
  schema: {
    description: string;      // What the tool does (LLM reads this!)
    parameters: {
      type: 'object';
      properties: { ... };    // Parameter definitions
      required: string[];     // Required parameter names
    };
  };
}
```

---

## Handler Types

### Simple Handlers (Most Common)

For tools that map directly to a service method:

```typescript
{
  name: 'tool_name',
  methodName: 'serviceMethodName',
  argOrder: ['args.param1', 'args.param2', 'context.userId']
}
```

### Special Handlers (Complex Logic)

For tools needing custom logic, add to `src/tools/handlers/specialHandlers.ts`:

```typescript
// In src/tools/handlers/specialHandlers.ts

export function getSpecialHandlers(agentModeService: any): ToolHandler[] {
  return [
    // ... existing handlers ...

    {
      name: 'complex_tool',
      execute: async (args: any, context: ToolContext) => {
        // Custom logic here
        if (args.option === 'A') {
          return await agentModeService.methodA(args.data, context.userId);
        } else {
          return await agentModeService.methodB(args.data, context.sessionId);
        }
      }
    }
  ];
}
```

---

## Best Practices

### 1. Tool Naming
- Use `snake_case` for tool names
- Be descriptive: `create_blog_article` not `blog`
- Use verb prefixes: `get_`, `create_`, `update_`, `delete_`, `list_`

### 2. Descriptions
The LLM uses the description to decide when to call the tool:

```typescript
// ❌ Bad - vague
description: 'Handle emails'

// ✅ Good - specific and actionable
description: 'Send an email to a recipient. Use this when the user wants to send an email, forward a message, or communicate via email.'
```

### 3. Parameters
- Mark required parameters explicitly
- Provide helpful descriptions with examples
- Use enums for constrained values:

```typescript
properties: {
  priority: {
    type: 'string',
    enum: ['low', 'normal', 'high', 'urgent'],
    description: 'Email priority level',
    default: 'normal'
  }
}
```

### 4. Return Values
Always return a consistent structure:

```typescript
return {
  success: true,
  data: { ... },                    // Tool-specific data
  formattedContent: '✅ Success!'  // Human-readable message for LLM
};
```

### 5. Error Handling
Throw descriptive errors that help the LLM understand what went wrong:

```typescript
throw new Error(`Cannot send email: recipient "${to}" is not a valid email address`);
```

---

## Adding a New Category

If you need a new tool category:

### 1. Add the category type

```typescript
// In src/tools/types/ToolDefinition.ts

export type ToolCategory = 
  | 'core'
  | 'content'
  // ... existing ...
  | 'your_new_category';  // Add here
```

### 2. Create the definitions file

```typescript
// Create src/tools/definitions/yourCategoryTools.ts

import { ToolDefinition } from '../types';

export const yourCategoryTools: ToolDefinition[] = [
  // Your tools here
];
```

### 3. Register in the index

```typescript
// In src/tools/definitions/index.ts

import { yourCategoryTools } from './yourCategoryTools';

export { yourCategoryTools };

export const allToolDefinitions: ToolDefinition[] = [
  // ... existing ...
  ...yourCategoryTools
];
```

### 4. Add handler configs

```typescript
// In src/tools/handlers/configs.ts

export const yourCategoryHandlerConfigs: SimpleHandlerConfig[] = [
  // Your handler configs
];

export const allHandlerConfigs: SimpleHandlerConfig[] = [
  // ... existing ...
  ...yourCategoryHandlerConfigs
];
```

---

## Subscription-Based Access Control

Tool access is controlled via the database, not through tool definitions.

### How it works:

1. **User subscription stored in DB**: Each user has a `subscriptionType` field (e.g., "Basic", "Pro", "Enterprise")

2. **Subscription configs in settings**: The `subscription_types` setting defines which tools each tier can access:
   ```json
   [
     {
       "name": "Basic",
       "allowedFunctionCalls": ["search_web", "read_file_content", "save_file"]
     },
     {
       "name": "Pro", 
       "allowedFunctionCalls": ["*"]  // All tools
     }
   ]
   ```

3. **Runtime filtering**: `subscriptionService.getAllowedFunctionCalls(userId)` fetches the allowed tools dynamically

### To restrict a tool to specific tiers:

1. Go to the settings table in the database
2. Update the `subscription_types` setting
3. Add/remove tool names from `allowedFunctionCalls` for each tier

See `subscriptionService.ts` for implementation details.

---

## File Structure Reference

```
src/tools/
├── definitions/           # Tool schemas (what LLM sees)
│   ├── index.ts          # Barrel export & registration
│   ├── coreTools.ts
│   ├── contentTools.ts
│   ├── researchTools.ts
│   ├── crmTools.ts
│   ├── gtmTools.ts
│   ├── analyticsTools.ts
│   ├── automationTools.ts
│   ├── bookTools.ts
│   └── templateTools.ts
├── handlers/              # Tool execution mapping
│   ├── index.ts
│   ├── configs.ts        # Simple handler configs
│   └── specialHandlers.ts # Complex handlers
├── types/                 # TypeScript types
│   ├── index.ts
│   ├── ToolDefinition.ts
│   ├── ToolHandler.ts
│   └── ToolContext.ts
├── ToolRegistry.ts        # Tool registration
├── ToolSelector.ts        # Intent-based tool selection
├── ToolExecutor.ts        # Tool execution engine
├── HandlerFactory.ts      # Creates handlers from configs
└── index.ts               # Main barrel export
```

---

## Testing Your Tool

1. **Check registration:**
   ```bash
   npm run dev
   # Look for: "AgentServiceFactory: Registering X tool definitions..."
   ```

2. **Test in Emma chat:**
   Ask Emma to use your tool and verify it executes correctly.

3. **Check handler mapping:**
   Look for errors like "Handler not found for tool: your_tool_name"

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Handler not found" | Add handler config to `handlers/configs.ts` |
| Tool not showing in LLM | Check it's exported in `definitions/index.ts` |
| Arguments undefined | Verify `argOrder` matches actual parameter names |
| Tool filtered out | Check subscription settings for the user |
| Method not found | Ensure method exists in `agentModeService.ts` |
