/**
 * Browser Agent Service
 *
 * A sub-agent that Emma delegates to for web browsing tasks.
 * Uses the Anthropic SDK with AWS Bedrock for the agentic loop.
 * Operates Playwright MCP tools (navigate, click, snapshot, etc.)
 * to complete browser-based tasks autonomously.
 */

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserAgentContext {
  userId: string;
  sessionId: string;
  socketEmit?: (room: string, event: string, payload: any) => void;
  executeTool: (toolName: string, args: any) => Promise<any>;
}

const DEFAULT_MAX_ITERATIONS = 30;
const BROWSER_AGENT_MODEL = 'us.anthropic.claude-sonnet-4-6-v1';
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOOL_RESULT_CHARS = 20000;
const MAX_RETRIES = 2;

// ─── System Prompt ──────────────────────────────────────────────────────────

const BROWSER_AGENT_SYSTEM_PROMPT = `You are a browser automation agent. You navigate web pages, interact with elements, extract data, and complete web-based tasks.

## Principles
- After navigating to a page, ALWAYS take a snapshot to understand the page structure before interacting.
- Use snapshots (accessibility tree) as your primary way to understand pages. They are text-based and efficient. Only use screenshots when you need to verify visual layout.
- Click elements using their ref attribute from the snapshot (e.g., ref="e42").
- When filling forms, use fill_form for multiple fields at once rather than typing one field at a time.
- If a click or navigation doesn't produce the expected result, take another snapshot to see what changed.
- When you encounter errors (element not found, navigation failed), try alternative approaches before giving up.
- Do not loop more than 3 times on the same failing action — try a different approach or report the issue.
- When extracting data, be thorough and structured. Return data in a clear format.
- When done, call report_to_user with a summary of what you accomplished and any extracted data.

## Important
- Never invent or guess data. Only report what you actually see on the page.
- If a task requires login credentials that weren't provided, report that to the user.
- For multi-page tasks, navigate efficiently — don't revisit pages unnecessarily.`;

// ─── Tool Definitions ───────────────────────────────────────────────────────

function getToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: 'navigate',
      description: 'Navigate the browser to a URL.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL to navigate to' }
        },
        required: ['url']
      }
    },
    {
      name: 'snapshot',
      description: 'Take an accessibility snapshot of the current page. Returns the page structure as text with element refs you can use for clicking.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'click',
      description: 'Click an element on the page.',
      input_schema: {
        type: 'object' as const,
        properties: {
          element: { type: 'string', description: 'Human-readable element description' },
          ref: { type: 'string', description: 'Exact target element ref value from the page snapshot' }
        },
        required: ['element', 'ref']
      }
    },
    {
      name: 'type',
      description: 'Type text into an editable element.',
      input_schema: {
        type: 'object' as const,
        properties: {
          element: { type: 'string', description: 'Human-readable element description' },
          ref: { type: 'string', description: 'Exact target element ref value from the page snapshot' },
          text: { type: 'string', description: 'Text to type' },
          submit: { type: 'boolean', description: 'Whether to press Enter after typing (default: false)' }
        },
        required: ['element', 'ref', 'text']
      }
    },
    {
      name: 'fill_form',
      description: 'Fill out a form with multiple fields at once.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'Exact target element ref value from the page snapshot' },
                value: { type: 'string', description: 'Value to fill into the field' }
              },
              required: ['ref', 'value']
            },
            description: 'Array of form fields to fill'
          },
          submit: { type: 'boolean', description: 'Whether to submit the form after filling (default: false)' }
        },
        required: ['fields']
      }
    },
    {
      name: 'select_option',
      description: 'Select an option from a dropdown.',
      input_schema: {
        type: 'object' as const,
        properties: {
          element: { type: 'string', description: 'Human-readable element description' },
          ref: { type: 'string', description: 'Exact target element ref value from the page snapshot' },
          value: { type: 'string', description: 'Value to select' }
        },
        required: ['element', 'ref', 'value']
      }
    },
    {
      name: 'press_key',
      description: 'Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown).',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Key to press (e.g., "Enter", "Tab", "Escape")' }
        },
        required: ['key']
      }
    },
    {
      name: 'hover',
      description: 'Hover over an element.',
      input_schema: {
        type: 'object' as const,
        properties: {
          element: { type: 'string', description: 'Human-readable element description' },
          ref: { type: 'string', description: 'Exact target element ref value from the page snapshot' }
        },
        required: ['element', 'ref']
      }
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current page. Use sparingly — prefer snapshot for understanding page structure.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'wait',
      description: 'Wait for text to appear or disappear on the page.',
      input_schema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Text to wait for' },
          textGone: { type: 'string', description: 'Text to wait to disappear' },
          timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' }
        },
        required: []
      }
    },
    {
      name: 'go_back',
      description: 'Navigate back to the previous page.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'tabs',
      description: 'List open browser tabs.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'evaluate',
      description: 'Execute JavaScript in the browser page and return the result.',
      input_schema: {
        type: 'object' as const,
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' }
        },
        required: ['expression']
      }
    },
    {
      name: 'report_to_user',
      description: 'Return results to the user. Call this when the task is complete or when you cannot proceed further.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: 'Summary of what was accomplished' },
          data: { type: 'object', description: 'Structured data extracted from the browsing session (optional)' },
          status: { type: 'string', enum: ['success', 'partial', 'error'], description: 'Task completion status' }
        },
        required: ['message', 'status']
      }
    }
  ];
}

// ─── Tool Name Mapping ──────────────────────────────────────────────────────

const TOOL_MAP: Record<string, string> = {
  'navigate': 'browser_navigate',
  'snapshot': 'browser_snapshot',
  'click': 'browser_click',
  'type': 'browser_type',
  'fill_form': 'browser_fill_form',
  'select_option': 'browser_select_option',
  'press_key': 'browser_press_key',
  'hover': 'browser_hover',
  'screenshot': 'browser_take_screenshot',
  'wait': 'browser_wait_for',
  'go_back': 'browser_navigate_back',
  'tabs': 'browser_tabs',
  'evaluate': 'browser_evaluate',
};

// ─── Result Extraction ──────────────────────────────────────────────────────

function extractResultText(result: any): string {
  if (typeof result === 'string') return result;

  if (result?.raw?.content) {
    const contentArray = Array.isArray(result.raw.content) ? result.raw.content : [];
    return contentArray
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }

  if (result?.content) {
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  }

  return JSON.stringify(result);
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

async function executeBrowserTool(
  toolName: string,
  args: any,
  context: BrowserAgentContext
): Promise<string> {
  const playwrightToolName = TOOL_MAP[toolName];
  if (!playwrightToolName) {
    return `Unknown tool: ${toolName}`;
  }

  try {
    const result = await context.executeTool(playwrightToolName, args);
    return extractResultText(result);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ─── Context Management ─────────────────────────────────────────────────────

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const keepChars = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  return (
    content.substring(0, keepChars) +
    `\n\n... [TRUNCATED: ${content.length} chars total] ...\n\n` +
    content.substring(content.length - keepChars)
  );
}

function trimMessageHistory(messages: Anthropic.MessageParam[]): void {
  const toolResultLocations: { msgIdx: number; blockIdx: number }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          toolResultLocations.push({ msgIdx: i, blockIdx: j });
        }
      }
    }
  }

  const preserveCount = 3;
  const truncateLimit = 2000;
  if (toolResultLocations.length > preserveCount) {
    const toTruncate = toolResultLocations.slice(0, toolResultLocations.length - preserveCount);
    for (const loc of toTruncate) {
      const msg = messages[loc.msgIdx];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const block = msg.content[loc.blockIdx] as any;
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > truncateLimit) {
          block.content = block.content.substring(0, truncateLimit) + `\n... [trimmed from ${block.content.length} chars]`;
        }
      }
    }
  }
}

// ─── Bedrock Client ─────────────────────────────────────────────────────────

let bedrockClient: AnthropicBedrock | null = null;

function getBedrockClient(): AnthropicBedrock {
  if (!bedrockClient) {
    bedrockClient = new AnthropicBedrock({
      awsRegion: 'us-west-2',
    });
  }
  return bedrockClient;
}

// Exported for testing
export function _setBedrockClientForTest(client: AnthropicBedrock | null): void {
  bedrockClient = client;
}

async function callWithRetry(
  client: AnthropicBedrock,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (error) {
      if (error instanceof Anthropic.APIError && (error.status === 429 || (error.status && error.status >= 500))) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw error;
    }
  }
  throw lastError!;
}

// ─── Failure Summary ────────────────────────────────────────────────────────

function extractFailureSummary(
  messages: Anthropic.MessageParam[],
  maxIterations: number
): string {
  const toolsCalled: string[] = [];
  let lastAgentText = '';

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolsCalled.push(block.name);
        }
        if (block.type === 'text' && 'text' in block) {
          lastAgentText = block.text;
        }
      }
    }
  }

  const parts: string[] = [
    `Browser agent hit the iteration limit (${maxIterations}).`,
  ];

  if (toolsCalled.length > 0) {
    const counts: Record<string, number> = {};
    for (const t of toolsCalled) counts[t] = (counts[t] || 0) + 1;
    const summary = Object.entries(counts)
      .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
      .join(', ');
    parts.push(`Activity: ${summary}.`);
  }

  if (lastAgentText) {
    const truncated = lastAgentText.length > 300
      ? lastAgentText.substring(0, 300) + '...'
      : lastAgentText;
    parts.push(`Last agent note: "${truncated}"`);
  }

  return parts.join(' ');
}

// ─── Main Agent Loop ────────────────────────────────────────────────────────

async function runBrowserAgentInternal(
  taskDescription: string,
  context: BrowserAgentContext,
  maxIterations: number
): Promise<{ success: boolean; message: string; data?: any; iterations: number }> {

  const client = getBedrockClient();
  const tools = getToolDefinitions();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: taskDescription }
  ];

  let iteration = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Trim older messages every 5 iterations
      if (iteration > 1 && iteration % 5 === 0) {
        trimMessageHistory(messages);
      }

      // Emit progress
      if (context.socketEmit) {
        context.socketEmit(context.sessionId, 'browser-agent-progress', {
          type: 'iteration',
          iteration,
          totalMax: maxIterations
        });
      }

      const response = await callWithRetry(client, {
        model: BROWSER_AGENT_MODEL,
        max_tokens: 8192,
        system: BROWSER_AGENT_SYSTEM_PROMPT,
        tools,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      // If no tool use, the LLM is done
      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find(b => b.type === 'text');
        return {
          success: true,
          message: textBlock && 'text' in textBlock ? textBlock.text : 'Browser agent completed.',
          iterations: iteration
        };
      }

      // Execute tool calls
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        if (block.type !== 'tool_use') continue;

        const fnName = block.name;
        const fnArgs = block.input as any;

        // Terminal tool
        if (fnName === 'report_to_user') {
          return {
            success: fnArgs.status !== 'error',
            message: fnArgs.message || 'Done.',
            data: fnArgs.data,
            iterations: iteration
          };
        }

        // Execute the tool
        let toolResult: string;
        try {
          toolResult = await executeBrowserTool(fnName, fnArgs, context);

          if (context.socketEmit) {
            context.socketEmit(context.sessionId, 'browser-agent-progress', {
              type: 'tool_executed',
              iteration,
              tool: fnName,
              url: fnArgs.url
            });
          }
        } catch (error) {
          toolResult = `Error executing ${fnName}: ${error instanceof Error ? error.message : String(error)}`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncateToolResult(toolResult)
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Max iterations reached
    const summary = extractFailureSummary(messages, maxIterations);
    return {
      success: false,
      message: summary,
      iterations: iteration
    };

  } catch (error) {
    return {
      success: false,
      message: `Browser agent error: ${error instanceof Error ? error.message : String(error)}`,
      iterations: iteration
    };
  }
}

/**
 * Run the browser agent with a timeout wrapper.
 */
export async function runBrowserAgent(
  taskDescription: string,
  context: BrowserAgentContext,
  maxIterations: number = DEFAULT_MAX_ITERATIONS
): Promise<{ success: boolean; message: string; data?: any; iterations: number }> {

  const timeoutPromise = new Promise<{ success: boolean; message: string; data?: any; iterations: number }>((resolve) => {
    setTimeout(() => {
      resolve({
        success: false,
        message: 'Browser agent timed out after 5 minutes. The task may be partially complete.',
        iterations: -1
      });
    }, AGENT_TIMEOUT_MS);
  });

  return Promise.race([
    runBrowserAgentInternal(taskDescription, context, maxIterations),
    timeoutPromise
  ]);
}
