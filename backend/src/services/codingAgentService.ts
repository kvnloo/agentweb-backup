/**
 * Coding Agent Service
 *
 * A sub-agent that Emma delegates to for code editing tasks.
 * Runs its own agentic loop with diff-based editing tools,
 * reads files before editing, checks deployment after changes,
 * and iterates on build errors.
 */

import { mcpFetch } from '../mcp/server/httpClient';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CodingAgentContext {
  pageId: string;
  userId: string;
  sessionId: string;
  llmModel: string;
  socketEmit?: (room: string, event: string, payload: any) => void;
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

type CallLLMFn = (model: string, messages: any[], options?: any) => Promise<any>;

const DEFAULT_MAX_ITERATIONS = 30;

// ─── System Prompt ──────────────────────────────────────────────────────────

const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent specialized in editing landing page code. You have direct access to files in a GitHub repository that auto-deploys to Vercel.

## Rules
1. ALWAYS read a file before editing it. Understand the code first.
2. Make small, incremental edits. Each edit_file call should have 1-5 search/replace blocks.
3. The "search" string must match the existing code EXACTLY (including whitespace and indentation).
4. After making edits, use check_deployment to verify the build succeeds.
5. If the build fails, read the error, fix it, and check again.
6. When finished, call report_to_user with a summary of all changes made.
7. Do NOT make changes the user did not ask for. Stay focused on the task.
8. For large changes, break them into multiple edit_file calls.
9. If you need to add a new file or completely rewrite a file, use edit_file with a search that covers the entire file content (read it first to get the exact content).

## Workflow
1. list_files to see the project structure
2. read_file to understand the current code
3. edit_file with precise search/replace diffs
4. check_deployment to verify the build
5. If build fails: read error → fix → check again
6. report_to_user when done`;

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

// ─── Tool Definitions (OpenAI function calling format) ──────────────────────

function getToolDefinitions() {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'list_files',
        description: 'List all files in the landing page repository. Returns file paths and sizes.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    },
    {
      type: 'function' as const,
      function: {
        name: 'read_file',
        description: 'Read the contents of a file from the repository.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the file (e.g., "app/page.tsx", "app/globals.css")'
            }
          },
          required: ['file_path']
        }
      }
    },
    {
      type: 'function' as const,
      function: {
        name: 'edit_file',
        description: 'Edit a file using search-and-replace diffs. Each edit specifies an exact string to find and its replacement. The search string must match the existing code exactly (including whitespace). Use read_file first to see the current content.',
        parameters: {
          type: 'object',
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
      }
    },
    {
      type: 'function' as const,
      function: {
        name: 'check_deployment',
        description: 'Check the Vercel deployment status. Use this after editing files to verify the build succeeded.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    },
    {
      type: 'function' as const,
      function: {
        name: 'report_to_user',
        description: 'Return a final report to the user. This ends the coding session. Include a summary of all changes made, files modified, and deployment status.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Summary message to show the user'
            },
            status: {
              type: 'string',
              enum: ['success', 'error', 'partial'],
              description: 'Overall status of the coding task'
            }
          },
          required: ['message', 'status']
        }
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

  switch (toolName) {
    case 'list_files': {
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/files`,
        context: { userId: context.userId }
      });
      const files = data.files || [];
      return files.map((f: any) => `${f.path} (${f.size} bytes)`).join('\n') || 'No files found.';
    }

    case 'read_file': {
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-content`,
        queryParams: { path: args.file_path },
        context: { userId: context.userId }
      });
      return data.content || '';
    }

    case 'edit_file': {
      if (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0) {
        return 'Error: edits array is required and must not be empty.';
      }

      // Step 1: Read current file content
      const fileData = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-content`,
        queryParams: { path: args.file_path },
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
          commit_message: args.commit_message || `Edit ${args.file_path}`
        },
        context: { userId: context.userId }
      });

      let response = `Applied ${appliedCount}/${args.edits.length} edits to ${args.file_path}.`;
      if (writeResult.deployed_url) {
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

    case 'check_deployment': {
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

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─── Main Agent Loop ────────────────────────────────────────────────────────

export async function runCodingAgent(
  taskDescription: string,
  context: CodingAgentContext,
  callLLM: CallLLMFn,
  maxIterations: number = DEFAULT_MAX_ITERATIONS
): Promise<{ success: boolean; message: string; iterations: number }> {

  const messages: any[] = [
    { role: 'system', content: CODING_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: taskDescription }
  ];

  const tools = getToolDefinitions();
  let iteration = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Emit progress
      if (context.socketEmit) {
        context.socketEmit(context.sessionId, 'coding-agent-progress', {
          type: 'iteration',
          iteration,
          totalMax: maxIterations
        });
      }

      // Call LLM
      const response = await callLLM(context.llmModel, messages, {
        tools,
        tool_choice: 'auto',
        max_completion_tokens: 16384,
        temperature: 0.1
      });

      const responseMessage = response.choices?.[0]?.message;
      if (!responseMessage) {
        return { success: false, message: 'No response from LLM.', iterations: iteration };
      }

      // Add assistant message to history
      messages.push(responseMessage);

      // If no tool calls, the LLM is done — return its text
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        return {
          success: true,
          message: responseMessage.content || 'Coding agent completed without a report.',
          iterations: iteration
        };
      }

      // Execute tool calls
      for (const toolCall of responseMessage.tool_calls) {
        const fnName = toolCall.function.name;
        let fnArgs: any;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          fnArgs = {};
        }

        // Check for terminal tool
        if (fnName === 'report_to_user') {
          const status = fnArgs.status || 'success';
          return {
            success: status !== 'error',
            message: fnArgs.message || 'Done.',
            iterations: iteration
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

        // Add tool result to message history
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }
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
