/**
 * Coding Agent Service
 *
 * A sub-agent that Emma delegates to for code editing tasks.
 * Uses the Anthropic SDK with AWS Bedrock for the agentic loop.
 * Runs with diff-based editing tools, reads files before editing,
 * checks deployment after changes, and iterates on build errors.
 */

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { mcpFetch } from '../mcp/server/httpClient';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CodingAgentContext {
  pageId: string;
  userId: string;
  sessionId: string;
  llmModel: string;
  /** Draft branch name for staging edits (e.g. "draft/abc12345"). If unset, edits go to main. */
  draftBranch?: string;
  socketEmit?: (room: string, event: string, payload: any) => void;
  executeMcpTool?: (toolName: string, args: any) => Promise<any>;
}

interface SearchReplaceEdit {
  search: string;
  replace: string;
}

interface ApplyResult {
  result: string;
  appliedCount: number;
  errors: string[];
}

const DEFAULT_MAX_ITERATIONS = 30;
const CODING_AGENT_MODEL = 'us.anthropic.claude-opus-4-6-v1';
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max for the entire agent run
const MAX_TOOL_RESULT_CHARS = 30000; // Truncate tool results to prevent context bloat
const MAX_RETRIES = 2;

// ─── System Prompt ──────────────────────────────────────────────────────────

const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent specialized in editing landing page code. You have direct access to files in a GitHub repository connected to Vercel. You also have browser tools to verify your changes visually.

## Staging Workflow
Your edits go to a draft branch (not main). This creates a Vercel preview deployment so the user can review before going live. The user will publish to production separately when satisfied.

## Rules
1. ALWAYS read a file before editing it. Understand the code first.
2. Make small, incremental edits. Each edit_file call should have 1-5 search/replace blocks.
3. The "search" string must match the existing code EXACTLY (including whitespace and indentation).
4. After making edits, use check_deployment to verify the preview build succeeds.
5. If the build fails, read the error, fix it, and check again.
6. After deployment succeeds, use browse_page to verify the changes look correct on the preview site.
7. When finished, call report_to_user with a summary of all changes made. Include the preview URL so the user can review.
8. Do NOT make changes the user did not ask for. Stay focused on the task.
9. For large changes, break them into multiple edit_file calls.
10. NEVER attempt to rewrite an entire file or replace more than a small section at once. Only make targeted edits to specific sections. If a file is too large to edit safely, report the limitation to the user.
11. For large files (>20KB), read the file to understand structure, then make focused edits to only the specific lines that need changing. Do NOT restructure or reorganize code beyond what was requested.
12. BEFORE making any edits, use list_commits to record the current commit SHA. This is your safety bookmark.
13. If your edits break the build and you cannot fix them within 2 attempts, use revert_file to restore the file to the pre-edit commit SHA. Do NOT keep trying broken fixes.

## Workflow
1. list_files to see the project structure
2. list_commits (optionally filtered by the file you plan to edit) to record the current commit SHA as a rollback point
3. read_file to understand the current code
4. edit_file with precise search/replace diffs
5. check_deployment to verify the preview build
6. If build fails: read error → fix → check again. If still failing after 2 fix attempts, revert_file to the pre-edit commit SHA.
7. browse_page to verify changes visually on the preview deployment
8. If something looks wrong: fix → redeploy → verify again. If unable to fix, revert_file.
9. report_to_user when done (include the preview URL and verification results)`;

// ─── Search/Replace Engine ──────────────────────────────────────────────────

export function applySearchReplace(content: string, edits: SearchReplaceEdit[]): ApplyResult {
  let result = content;
  let appliedCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    if (!edit.search) {
      errors.push(`Edit ${i + 1}: search string is empty`);
      continue;
    }

    // Try exact match first
    const firstIdx = result.indexOf(edit.search);
    if (firstIdx === -1) {
      // Try whitespace-normalized match (trim trailing spaces per line)
      const normalizeLines = (s: string) => s.split('\n').map(line => line.trimEnd()).join('\n');
      const normalizedContent = normalizeLines(result);
      const normalizedSearch = normalizeLines(edit.search);

      const normIdx = normalizedContent.indexOf(normalizedSearch);
      if (normIdx === -1) {
        // Show context to help the LLM correct the search string
        const preview = result.substring(0, 200);
        errors.push(
          `Edit ${i + 1}: search string not found in file. ` +
          `Search (first 100 chars): "${edit.search.substring(0, 100)}". ` +
          `File starts with: "${preview.substring(0, 100)}"`
        );
        continue;
      }

      // Find the actual range in the original content by mapping from normalized positions
      // Since normalization only trims trailing spaces, line count is preserved
      const normalizedLines = normalizedContent.split('\n');
      const searchLines = normalizedSearch.split('\n');

      // Find which line the match starts on
      let charCount = 0;
      let startLine = -1;
      for (let l = 0; l < normalizedLines.length; l++) {
        if (charCount === normIdx || charCount <= normIdx && normIdx < charCount + normalizedLines[l].length + 1) {
          startLine = l;
          break;
        }
        charCount += normalizedLines[l].length + 1; // +1 for \n
      }

      if (startLine === -1) {
        errors.push(`Edit ${i + 1}: whitespace-normalized match found but could not map back to original`);
        continue;
      }

      // Replace by original lines
      const originalLines = result.split('\n');
      const endLine = startLine + searchLines.length;
      const replacementLines = edit.replace.split('\n');
      originalLines.splice(startLine, searchLines.length, ...replacementLines);
      result = originalLines.join('\n');
      appliedCount++;
      continue;
    }

    // Check for ambiguous match (found more than once)
    const secondIdx = result.indexOf(edit.search, firstIdx + 1);
    if (secondIdx !== -1) {
      errors.push(
        `Edit ${i + 1}: search string found multiple times (at positions ${firstIdx} and ${secondIdx}). ` +
        `Make the search string more specific to match exactly one location.`
      );
      continue;
    }

    // Apply the replacement
    result = result.substring(0, firstIdx) + edit.replace + result.substring(firstIdx + edit.search.length);
    appliedCount++;
  }

  return { result, appliedCount, errors };
}

// ─── Tool Definitions (Anthropic native format) ─────────────────────────────

function getToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: 'list_files',
      description: 'List all files in the landing page repository. Returns file paths and sizes.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file from the repository.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file (e.g., "app/page.tsx", "app/globals.css")'
          }
        },
        required: ['file_path']
      }
    },
    {
      name: 'edit_file',
      description: 'Edit a file using search-and-replace diffs. Each edit specifies an exact string to find and its replacement. The search string must match the existing code exactly (including whitespace). Use read_file first to see the current content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file to edit'
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: {
                  type: 'string',
                  description: 'Exact string to find in the file (must match exactly once)'
                },
                replace: {
                  type: 'string',
                  description: 'Replacement string'
                }
              },
              required: ['search', 'replace']
            },
            description: 'Array of search/replace edits to apply sequentially'
          },
          commit_message: {
            type: 'string',
            description: 'Git commit message describing the changes'
          }
        },
        required: ['file_path', 'edits']
      }
    },
    {
      name: 'check_deployment',
      description: 'Check the Vercel deployment status. Use this after editing files to verify the build succeeded.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'report_to_user',
      description: 'Return a final report to the user. This ends the coding session. Include a summary of all changes made, files modified, and deployment status. IMPORTANT: Always include the preview_url if you obtained one from check_deployment.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'Summary message to show the user'
          },
          status: {
            type: 'string',
            enum: ['success', 'error', 'partial'],
            description: 'Overall status of the coding task'
          },
          preview_url: {
            type: 'string',
            description: 'The Vercel preview deployment URL for the user to review changes before publishing'
          }
        },
        required: ['message', 'status']
      }
    },
    {
      name: 'list_commits',
      description: 'List recent commits in the repository. Optionally filter by file path. Use this before making changes to record the current commit SHA, so you can revert if something goes wrong.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Optional file path to filter commits (e.g., "app/page.tsx"). If omitted, lists all recent commits.'
          }
        },
        required: []
      }
    },
    {
      name: 'revert_file',
      description: 'Revert a file to its state at a previous commit. Use this to undo changes that broke the build or damaged the page. Provide the commit SHA from list_commits.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file to revert (e.g., "app/page.tsx")'
          },
          commit_sha: {
            type: 'string',
            description: 'The commit SHA to revert to (from list_commits output)'
          },
          commit_message: {
            type: 'string',
            description: 'Git commit message for the revert (e.g., "Revert app/page.tsx to pre-edit state")'
          }
        },
        required: ['file_path', 'commit_sha']
      }
    },
    {
      name: 'browse_page',
      description: 'Navigate to a URL and get a text snapshot of the page content (accessibility tree). Use this to verify your edits are visible on the deployed site. Returns a structured description of all visible elements on the page.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to (e.g., the Vercel deployment URL)'
          }
        },
        required: ['url']
      }
    },
    {
      name: 'take_screenshot',
      description: 'Take a screenshot of the current browser page. Use after browse_page to capture a visual snapshot. Returns a description of the screenshot.',
      input_schema: {
        type: 'object' as const,
        properties: {
          full_page: {
            type: 'boolean',
            description: 'Whether to capture the full scrollable page (true) or just the visible viewport (false). Defaults to false.'
          }
        },
        required: []
      }
    }
  ];
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  args: any,
  context: CodingAgentContext
): Promise<string> {
  const basePath = `/api/landing-pages/v0/generated/${context.pageId}`;
  const branch = context.draftBranch || "main";
  const branchQuery: Record<string, string> = branch !== "main" ? { branch } : {};

  switch (toolName) {
    case 'list_files': {
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/files`,
        queryParams: branchQuery,
        context: { userId: context.userId }
      });
      const files = data.files || [];
      return files.map((f: any) => `${f.path} (${f.size} bytes)`).join('\n') || 'No files found.';
    }

    case 'read_file': {
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-content`,
        queryParams: { path: args.file_path, ...branchQuery },
        context: { userId: context.userId }
      });
      return data.content || '';
    }

    case 'edit_file': {
      if (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0) {
        return 'Error: edits array is required and must not be empty.';
      }

      // Step 1: Read current file content (from draft branch if applicable)
      const fileData = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-content`,
        queryParams: { path: args.file_path, ...branchQuery },
        context: { userId: context.userId }
      });

      const currentContent = fileData.content || '';

      // Step 2: Apply search/replace diffs
      const { result: newContent, appliedCount, errors } = applySearchReplace(currentContent, args.edits);

      if (appliedCount === 0) {
        return `Failed to apply edits. Errors:\n${errors.join('\n')}`;
      }

      // Step 3: Write back via GitHub API
      const writeResult = await mcpFetch({
        method: 'PUT',
        path: `${basePath}/github-edit`,
        body: {
          file_path: args.file_path,
          content: newContent,
          commit_message: args.commit_message || `Edit ${args.file_path}`,
          ...(branch !== "main" ? { branch } : {}),
        },
        context: { userId: context.userId }
      });

      let response = `Applied ${appliedCount}/${args.edits.length} edits to ${args.file_path}.`;
      if (writeResult.is_staging) {
        response += ` Changes pushed to draft branch ${branch}. A preview deployment is being created.`;
      } else if (writeResult.deployed_url) {
        response += ` Changes will auto-deploy to ${writeResult.deployed_url}.`;
      }
      if (writeResult.commit_url) {
        response += ` Commit: ${writeResult.commit_url}`;
      }
      if (errors.length > 0) {
        response += `\nWarnings (${errors.length} edits skipped):\n${errors.join('\n')}`;
      }
      return response;
    }

    case 'list_commits': {
      const queryParams: Record<string, string> = { ...branchQuery };
      if (args.file_path) queryParams.path = args.file_path;
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/commits`,
        queryParams,
        context: { userId: context.userId }
      });
      const commits = data.commits || [];
      if (commits.length === 0) return 'No commits found.';
      return commits.map((c: any) =>
        `${c.sha.substring(0, 7)} | ${c.date} | ${c.message.split('\n')[0]}`
      ).join('\n');
    }

    case 'revert_file': {
      if (!args.file_path || !args.commit_sha) {
        return 'Error: file_path and commit_sha are required.';
      }

      // Step 1: Read file content at the target commit
      const oldFileData = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-at-commit`,
        queryParams: { path: args.file_path, ref: args.commit_sha },
        context: { userId: context.userId }
      });

      if (!oldFileData.content) {
        return `Error: Could not read ${args.file_path} at commit ${args.commit_sha}. The file may not exist at that commit.`;
      }

      // Step 2: Write it back via the existing github-edit endpoint
      const writeResult = await mcpFetch({
        method: 'PUT',
        path: `${basePath}/github-edit`,
        body: {
          file_path: args.file_path,
          content: oldFileData.content,
          commit_message: args.commit_message || `Revert ${args.file_path} to commit ${args.commit_sha.substring(0, 7)}`,
          ...(branch !== "main" ? { branch } : {}),
        },
        context: { userId: context.userId }
      });

      let response = `Reverted ${args.file_path} to commit ${args.commit_sha.substring(0, 7)}.`;
      if (writeResult.deployed_url) {
        response += ` Changes will auto-deploy to ${writeResult.deployed_url}.`;
      }
      if (writeResult.commit_url) {
        response += ` Commit: ${writeResult.commit_url}`;
      }
      return response;
    }

    case 'check_deployment': {
      if (branch !== "main") {
        // For draft branches, check the preview deployment
        const data = await mcpFetch({
          method: 'GET',
          path: `${basePath}/preview-url`,
          queryParams: { branch },
          context: { userId: context.userId }
        });
        return JSON.stringify(data, null, 2);
      }
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/deployment-status`,
        context: { userId: context.userId }
      });
      return JSON.stringify(data, null, 2);
    }

    case 'report_to_user': {
      // This is handled in the main loop — just return the message
      return args.message || 'Done.';
    }

    case 'browse_page': {
      if (!context.executeMcpTool) {
        return 'Error: Browser tools are not available in this context.';
      }
      // Navigate to the URL
      await context.executeMcpTool('playwright_browser_navigate', { url: args.url });
      // Get accessibility snapshot (text representation of page)
      const snapshot = await context.executeMcpTool('playwright_browser_snapshot', {});
      return typeof snapshot?.content === 'string' ? snapshot.content : JSON.stringify(snapshot);
    }

    case 'take_screenshot': {
      if (!context.executeMcpTool) {
        return 'Error: Browser tools are not available in this context.';
      }
      const result = await context.executeMcpTool('playwright_browser_take_screenshot', {
        type: 'jpeg',
        fullPage: args.full_page || false
      });
      return typeof result?.content === 'string' ? result.content : 'Screenshot taken successfully.';
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─── Context Management ─────────────────────────────────────────────────────

/**
 * Truncate a tool result to prevent context window bloat.
 * Preserves the beginning and end of the content with a truncation notice.
 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const keepChars = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  return (
    content.substring(0, keepChars) +
    `\n\n... [TRUNCATED: ${content.length} chars total, showing first and last ${keepChars} chars] ...\n\n` +
    content.substring(content.length - keepChars)
  );
}

/**
 * Trim older tool results in the message history to keep context manageable.
 * Keeps the last 3 tool_result blocks at full size, truncates older ones to 2000 chars.
 * Works with Anthropic message format where tool results are in user messages.
 */
function trimMessageHistory(messages: Anthropic.MessageParam[]): void {
  // Find all user messages that contain tool_result blocks
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

  // Keep last 3 tool results intact, truncate older ones aggressively
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

// Exported for testing (allows mock injection)
export function _setBedrockClientForTest(client: AnthropicBedrock | null): void {
  bedrockClient = client;
}

/**
 * Call the Anthropic Messages API with retry logic for transient errors.
 */
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
        // Exponential backoff: 1s, 2s
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw error; // Non-retryable error
    }
  }
  throw lastError!;
}

// ─── Main Agent Loop ────────────────────────────────────────────────────────

async function runCodingAgentInternal(
  taskDescription: string,
  context: CodingAgentContext,
  maxIterations: number
): Promise<{ success: boolean; message: string; iterations: number; previewUrl?: string; branch?: string }> {

  const client = getBedrockClient();
  const tools = getToolDefinitions();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: taskDescription }
  ];

  let iteration = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Trim older messages every 5 iterations to prevent context bloat
      if (iteration > 1 && iteration % 5 === 0) {
        trimMessageHistory(messages);
      }

      // Emit progress
      if (context.socketEmit) {
        context.socketEmit(context.sessionId, 'coding-agent-progress', {
          type: 'iteration',
          iteration,
          totalMax: maxIterations
        });
      }

      // Call Anthropic Messages API
      const response = await callWithRetry(client, {
        model: CODING_AGENT_MODEL,
        max_tokens: 16384,
        system: CODING_AGENT_SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Add assistant message to history
      messages.push({ role: 'assistant', content: response.content });

      // If no tool use, the LLM is done — return its text
      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find(b => b.type === 'text');
        return {
          success: true,
          message: textBlock && 'text' in textBlock ? textBlock.text : 'Coding agent completed without a report.',
          iterations: iteration
        };
      }

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        if (block.type !== 'tool_use') continue;

        const fnName = block.name;
        const fnArgs = block.input as any;

        // Check for terminal tool
        if (fnName === 'report_to_user') {
          const status = fnArgs.status || 'success';
          return {
            success: status !== 'error',
            message: fnArgs.message || 'Done.',
            iterations: iteration,
            previewUrl: fnArgs.preview_url,
            branch: context.draftBranch,
          };
        }

        // Execute the tool
        let toolResult: string;
        try {
          toolResult = await executeTool(fnName, fnArgs, context);

          // Emit progress about tool execution
          if (context.socketEmit) {
            context.socketEmit(context.sessionId, 'coding-agent-progress', {
              type: 'tool_executed',
              iteration,
              tool: fnName,
              filePath: fnArgs.file_path
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

      // Add tool results as a user message
      messages.push({ role: 'user', content: toolResults });
    }

    // Max iterations reached
    return {
      success: false,
      message: `Coding agent reached maximum iterations (${maxIterations}). The task may be partially complete. Check the deployment for any changes that were made.`,
      iterations: iteration
    };

  } catch (error) {
    return {
      success: false,
      message: `Coding agent encountered an error: ${error instanceof Error ? error.message : String(error)}`,
      iterations: iteration
    };
  }
}

/**
 * Run the coding agent with a timeout wrapper.
 * Ensures the agent doesn't run indefinitely if tools hang.
 */
export async function runCodingAgent(
  taskDescription: string,
  context: CodingAgentContext,
  maxIterations: number = DEFAULT_MAX_ITERATIONS
): Promise<{ success: boolean; message: string; iterations: number; previewUrl?: string; branch?: string }> {

  const timeoutPromise = new Promise<{ success: boolean; message: string; iterations: number; previewUrl?: string; branch?: string }>((resolve) => {
    setTimeout(() => {
      resolve({
        success: false,
        message: 'Coding agent timed out after 10 minutes. The task may be partially complete — check the deployment for any changes that were made.',
        iterations: -1
      });
    }, AGENT_TIMEOUT_MS);
  });

  return Promise.race([
    runCodingAgentInternal(taskDescription, context, maxIterations),
    timeoutPromise
  ]);
}
