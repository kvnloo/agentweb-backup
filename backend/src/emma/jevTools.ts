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
