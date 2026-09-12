import { emmaToolRegistry } from '../../emma/registry';
import { mcpToolRegistry } from './registry';
import { evaluationStore } from '../../services/evaluationStore';
import { EvaluationDenied, isEvaluationUser, requireEvaluationAdmin, requireEvaluationReviewer } from '../../services/evaluationPolicy';

mcpToolRegistry.register({
  name: 'evaluation_workspace',
  requiresUserAccount: true,
  definition: {
    name: 'evaluation_workspace',
    description: 'Sandbox account lifecycle (administrators only). Provision a sandbox account for a hiring take-home or customer pilot: a real customer-portal account with a simulated Meta connection, seeded brand guidelines, the Sandbox subscription tier, and a policy record that denies outbound tool classes (connectors, sends, social, publish, third-party writes, browser, automation). Revoke it (invalidates every session, token, key and schedule) or review its status and audit trail as an assigned reviewer. Sandbox principals cannot call this tool.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['provision', 'revoke', 'review'] },
        evaluation_user_id: { type: 'string', description: 'The eval_ user id to revoke or review.' },
        provision: {
          type: 'object', additionalProperties: false,
          description: 'Provisioning request: email, displayName, password (12–72 chars, handed over privately), expiresAt (epoch ms, ≤30 days out), brandGuidelines {brandName, website?, description?}, optional reviewerUserIds (≤5), label (badge text, default "Sandbox"), datasetId/datasetVersion (pinned frozen dataset), deniedToolClasses (subset of the tool classes; lifecycle is always denied).',
          properties: {
            email: { type: 'string' }, displayName: { type: 'string' }, password: { type: 'string' }, expiresAt: { type: 'number' },
            brandGuidelines: { type: 'object', additionalProperties: false, properties: { brandName: { type: 'string' }, website: { type: 'string' }, description: { type: 'string' } }, required: ['brandName'] },
            reviewerUserIds: { type: 'array', items: { type: 'string' } },
            label: { type: 'string' }, datasetId: { type: 'string' }, datasetVersion: { type: 'number' },
            deniedToolClasses: { type: 'array', items: { type: 'string' } },
          },
          required: ['email', 'displayName', 'password', 'expiresAt', 'brandGuidelines'],
        },
      }, required: ['action'],
    },
  },
  execute: async (args, context) => {
    const userId = context?.userId;
    if (typeof userId !== 'string' || isEvaluationUser(userId) || !args || typeof args !== 'object' || Array.isArray(args)) throw new EvaluationDenied();
    let result: unknown;
    if (args.action === 'review') {
      if (Object.keys(args).some(k => !['action', 'evaluation_user_id'].includes(k))) throw new EvaluationDenied();
      await requireEvaluationReviewer(userId, context);
      result = await evaluationStore.review(userId, args.evaluation_user_id);
      await requireEvaluationReviewer(userId, context);
    } else {
      await requireEvaluationAdmin(userId, context);
      if (args.action === 'provision') result = await evaluationStore.provision(userId, args.provision);
      else if (args.action === 'revoke') result = await evaluationStore.revoke(userId, args.evaluation_user_id);
      else throw new EvaluationDenied();
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});

emmaToolRegistry.register(mcpToolRegistry.getTool('evaluation_workspace')!);
