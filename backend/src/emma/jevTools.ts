/**
 * H-JEV: `jev_decide` Emma tool — typed semantic routing without a full LLM turn.
 *
 * Registered via side-effect import from agentModeService (not emma/tools.ts — upstream #2832).
 */

import { emmaToolRegistry } from './registry';
import {
  runJevDecide,
  type JevDecideRequest,
  type JevQuestion,
  type JudgmentState,
} from './jevAdapter';
import { runZ0CanaryRoute } from './z0ActiveCanary';
import { type Z0RouteArgs } from './z0Adapter';

const JEV_DECIDE_DESCRIPTION =
  'Run a fast typed semantic judgment over structured state instead of spending a full LLM turn. ' +
  'Use for small routing decisions: which path, whether evidence supports X, severity, etc. ' +
  'Questions are independent and answered in one batched call. ' +
  'When JEV_BACKEND=off or the backend is unavailable, returns skipped=true (fail-open) — continue with your best judgment.';

emmaToolRegistry.register({
  name: 'jev_decide',
  readOnly: true,
  internal: true,
  definition: {
    name: 'jev_decide',
    description: JEV_DECIDE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          description:
            'Context to judge: plain text, or a JSON object/array (files, logs, request summary, etc.).',
          oneOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: true },
            { type: 'array' },
          ],
        },
        questions: {
          type: 'object',
          description:
            'Map of question id → typed question. Each question sees the same state. ' +
            'Types: choice (pick one option), noul (yes/no probability 0–1), score (ordered levels).',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['choice', 'noul', 'score'] },
              instructions: { type: 'string' },
              criteria: {},
            },
            required: ['type', 'instructions'],
          },
        },
      },
      required: ['state', 'questions'],
    },
  },
  execute: async (args: { state?: JudgmentState; questions?: Record<string, JevQuestion> }) => {
    const request: JevDecideRequest = {
      state: args.state as JudgmentState,
      questions: (args.questions ?? {}) as Record<string, JevQuestion>,
    };

    const result = await runJevDecide(request);

    return {
      type: 'jev_decide',
      ...result,
    };
  },
});


const Z0_ROUTE_DESCRIPTION =
  'Downstream experiment: ask z0intelligence to plan or execute an evidenced route beneath Emma. ' +
  'Default is reference/shadow. Active application requires the explicit bounded canary, sidecar startup, backpressure enforcement, and an allowed risk class. ' +
  'This tool never bypasses AgentWeb confirmation or publishing guards; allow_remote defaults false.';

emmaToolRegistry.register({
  name: 'z0_route',
  readOnly: true,
  internal: true,
  internalOnly: true,
  definition: {
    name: 'z0_route',
    description: Z0_ROUTE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: {
          type: 'string',
          description: 'Stable caller-owned identity for this logical operation. Reuse it when reconciling an ambiguous active call.',
        },
        task: { type: 'string' },
        function: { type: 'string' },
        context: { type: 'string' },
        state: { type: 'object', additionalProperties: true },
        expected_parent_tokens: { type: 'number', minimum: 0 },
        expected_parent_ms: { type: 'number', minimum: 0 },
        allow_remote: {
          type: 'boolean',
          default: false,
          description: 'Explicit authorization for context to reach a remote z0 capability. Never inferred from prompt text.',
        },
        experimental: { type: 'boolean', default: false },
        max_tokens: { type: 'integer', minimum: 1, maximum: 2048 },
      },
      required: ['operation_id', 'task', 'function'],
    },
  },
  execute: async (args: any, context?: any) => {
    const sessionId = typeof context?.sessionId === 'string' ? context.sessionId : '';
    return {
      type: 'z0_route',
      ...(await runZ0CanaryRoute(args as Z0RouteArgs, {
        sessionId,
        riskClass: 'generate',
      })),
    };
  },
});
