# Adding New Tools to Emma

This guide explains how to add new tools (function calls) to Emma, the AI assistant.

## Architecture Overview

Emma's tool system uses a **unified definition approach** where each tool contains:
- Schema (what the LLM sees)
- Handler config (how to execute)
- Intent keywords (for category detection)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Unified Tool Architecture                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. Tool Definition (unified)    → definitions/*Tools.ts              │
│     ├── schema                   → What the LLM sees                 │
│     ├── handler                  → How to execute                    │
│     └── intentKeywords           → For category detection            │
│                                                                       │
│  2. Category Config              → Intent patterns & keywords         │
│     └── definitions/*Tools.ts                                        │
│                                                                       │
│  3. Service Method (logic)       → Actual implementation             │
│     └── services/*Service.ts                                         │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start: Adding a Simple Tool

### Step 1: Add the Unified Tool Definition

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
    intentKeywords: ['email', 'send', 'message', 'mail'],  // For fuzzy matching
    
    // Schema - what the LLM sees
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
    },
    
    // Handler - how to execute
    handler: {
      serviceName: 'email',           // Optional: specific service to use
      methodName: 'sendEmail',        // Method name in the service
      contextArgs: ['userId', 'sessionId']  // Context fields to inject
      // OR use customArgOrder for complex mappings:
      // customArgOrder: ['args.to', 'args.subject', 'args.body', 'context.userId']
    }
  }
];
```

### Step 2: Implement the Service Method

Add the implementation in the appropriate service file:

```typescript
// In src/services/emailService.ts (or agentModeService.ts)

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
    const result = await emailClient.send({
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

### That's it! No need to update multiple files.

---

## Unified Tool Definition Schema

```typescript
interface ToolDefinition {
  /** Unique tool identifier (snake_case) */
  name: string;
  
  /** Semantic version for tracking changes */
  version: string;
  
  /** Category for intent-based loading */
  category: ToolCategory;
  
  /** Keywords for fuzzy intent matching (optional but recommended) */
  intentKeywords?: string[];
  
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
  
  /** Handler configuration for execution */
  handler: {
    serviceName?: string;     // Optional: specific service to use
    methodName: string;       // Required: method name to call
    contextArgs?: ContextArg[];  // Context fields to inject
    customArgOrder?: string[];   // Custom argument ordering
    specialHandler?: boolean;    // Uses special handler instead
  };
}

type ContextArg = 'userId' | 'sessionId' | 'llmModel';
```

---

## Handler Configuration Options

### Simple Handler (Most Common)

For tools that map directly to a service method with schema args + context:

```typescript
handler: {
  serviceName: 'blog',
  methodName: 'createBlogArticle',
  contextArgs: ['userId', 'sessionId']  // Added after schema args
}
```

**Argument order**: `[...schemaArgs, ...contextArgs]`

### Custom Argument Order

When the service method expects a specific argument order:

```typescript
handler: {
  serviceName: 'image',
  methodName: 'describeImage',
  customArgOrder: ['context.llmModel', 'args.image_url', 'args.prompt']
}
```

### Special Handlers (Complex Logic)

For tools needing custom logic, add to `src/tools/handlers/specialHandlers.ts`:

```typescript
handler: {
  methodName: 'createTaskFromTemplate',
  specialHandler: true  // Indicates this uses a special handler
}
```

Then implement in `specialHandlers.ts`:

```typescript
export function getSpecialHandlers(agentModeService: any): ToolHandler[] {
  return [
    {
      name: 'create_task_from_template',
      execute: async (args: any, context: ToolContext) => {
        // Custom logic here
        return await agentModeService.handleComplexTask(args, context);
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

### 3. Intent Keywords
Help the system detect when a user might need this tool:

```typescript
// Good: Specific keywords that indicate this tool's use case
intentKeywords: ['email', 'send', 'message', 'mail', 'forward', 'reply']
```

### 4. Parameters
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

### 5. Return Values
```typescript
return {
  success: true,
  data: { ... },
  formattedContent: '✅ Success!'  // Human-readable for LLM
};
```

---

## Adding a New Category

### 1. Add to TOOL_CATEGORY_NAMES (for type safety)

```typescript
// In src/tools/types/ToolDefinition.ts

export const TOOL_CATEGORY_NAMES = [
  'core',
  'content',
  // ... existing ...
  'your_new_category'  // Add here
] as const;
```

> **Why?** TypeScript needs compile-time type safety. This array defines valid category names.

### 2. Create the definitions file

```typescript
// Create src/tools/definitions/yourCategoryTools.ts

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

// Category configuration
export const yourCategory: CategoryConfig = {
  name: 'your_new_category',  // Must match TOOL_CATEGORY_NAMES
  intentPatterns: [
    /\b(keyword1|keyword2|keyword3)\b/i
  ],
  categoryKeywords: [
    'keyword1', 'keyword2', 'keyword3'
  ]
};

// Register the category config
registerCategoryConfig(yourCategory);

// Your tools
export const yourCategoryTools: ToolDefinition[] = [
  {
    name: 'your_tool_name',
    version: '1.0.0',
    category: 'your_new_category',
    intentKeywords: ['specific', 'keywords'],
    schema: { 
      description: 'What this tool does...',
      parameters: {
        type: 'object',
        properties: { /* ... */ },
        required: []
      }
    },
    handler: { 
      methodName: 'yourMethodName',
      contextArgs: ['userId']
    }
  }
];
```

### 3. Register in the index

```typescript
// In src/tools/definitions/index.ts

import { yourCategoryTools, yourCategory } from './yourCategoryTools';

export { yourCategoryTools, yourCategory };

export const allToolDefinitions: ToolDefinition[] = [
  // ... existing ...
  ...yourCategoryTools
];
```

---

## Subscription-Based Access Control

Tool access is controlled via the database, not through tool definitions.

1. **User subscription stored in DB**: Each user has a `subscriptionType` field
2. **Runtime filtering**: `subscriptionService.getAllowedFunctionCalls(userId)` fetches allowed tools

See `subscriptionService.ts` for implementation details.

---

## File Structure Reference

```
src/tools/
├── definitions/           # Tool definitions (SINGLE SOURCE OF TRUTH)
│   ├── index.ts          # Aggregation & exports
│   ├── utils.ts          # Derivation utilities
│   ├── coreTools.ts      # Core tools + category config
│   ├── contentTools.ts   # Content tools + category config
│   ├── researchTools.ts  # Research tools + category config
│   └── ...               # Other categories
├── handlers/              
│   ├── index.ts          # Exports allHandlerConfigs + getSpecialHandlers
│   └── specialHandlers.ts # Complex custom handlers
├── types/                 
│   ├── ToolDefinition.ts # TOOL_CATEGORY_NAMES + ToolCategory type
│   ├── CategoryConfig.ts # Category config type
│   ├── ToolCategories.ts # Uses derived category data
│   └── FuzzyMatcher.ts   # Uses derived keywords
├── ToolRegistry.ts        
├── ToolSelector.ts        
├── ToolExecutor.ts        
└── index.ts               
```

---

## Testing Your Tool

1. **Check compilation:**
   ```bash
   npx tsc --noEmit
   ```

2. **Check registration:**
   ```bash
   npm run dev
   # Look for: "AgentServiceFactory: Registering X tool definitions..."
   ```

3. **Test in Emma chat:**
   Ask Emma to use your tool and verify it executes correctly.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Tool not showing in LLM | Check it's exported in `definitions/index.ts` |
| "Method not found" | Ensure method exists in the target service |
| Arguments undefined | Check `contextArgs` or `customArgOrder` mapping |
| Tool filtered out | Check subscription settings for the user |
| Handler not executing | Check if `specialHandler: true` is set but handler not in specialHandlers.ts |

---

## Migration Notes

The tool system was consolidated on 2026-01-08. 

**Previously**, adding a tool required updating:
1. `definitions/*Tools.ts` - Tool schema
2. `handlers/configs.ts` - Handler mapping (now deleted)
3. `types/ToolCategories.ts` - Category mapping (now auto-derived)
4. `types/FuzzyMatcher.ts` - Keywords (now auto-derived)

**Now**, adding a tool requires only:
1. `definitions/*Tools.ts` - Add unified tool definition (schema + handler + keywords)

**For a new category**, also update:
1. `types/ToolDefinition.ts` - Add to `TOOL_CATEGORY_NAMES` array
