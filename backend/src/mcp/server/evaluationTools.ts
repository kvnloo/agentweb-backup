import { emmaToolRegistry } from '../../emma/registry';
import { mcpToolRegistry } from './registry';
import { evaluationStore } from '../../services/evaluationStore';
import { EvaluationDenied, isEvaluationUser, requireActiveEvaluation } from '../../services/evaluationPolicy';
import { runEvaluation } from '../../services/evaluationService';
import { userDb } from '../../services/db';

mcpToolRegistry.register({
  name: 'evaluation_workspace',
  requiresUserAccount: true,
  definition: {
    name: 'evaluation_workspace',
    description: 'Use an isolated evaluation workspace: inspect approved case material, analyze strategy, generate a creative, or upload a text artifact. Administrators can provision and revoke evaluations. No production or connector actions are available.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['inspect', 'analyze', 'generate_creative', 'upload_artifact', 'provision', 'revoke'] },
        prompt: { type: 'string' }, text: { type: 'string' },
        evaluation_user_id: { type: 'string' },
        provision: { type: 'object', description: 'Admin provisioning request with email, displayName, password, generationBudget, expiresAt (epoch milliseconds), and approved sanitized materials (title, text, approved=true).' },
      }, required: ['action'],
    },
  },
  execute: async (args, context) => {
    const userId = context?.userId;
    if (typeof userId !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new EvaluationDenied();
    let result: unknown;
    if (isEvaluationUser(userId)) {
      await requireActiveEvaluation(userId);
      if (args.evaluation_user_id || args.provision || Object.keys(args).some(k => !['action', 'prompt', 'text'].includes(k))) throw new EvaluationDenied();
      if (args.action === 'inspect') result = await requireActiveEvaluation(userId);
      else if (args.action === 'upload_artifact' && typeof args.text === 'string') {
        result = await evaluationStore.saveArtifact(userId, Buffer.from(args.text), 'text/plain');
      } else result = await runEvaluation(userId, { action: args.action, prompt: args.prompt });
      await requireActiveEvaluation(userId);
    } else {
      const admin = await userDb.getUserByIdConsistent(userId);
      if (!admin?.isAdmin || admin.isActive !== true || context?.delegateInfo || context?.isDelegatedAdmin || context?.isDelegatedAccess) throw new EvaluationDenied();
      if (args.action === 'provision') result = await evaluationStore.provision(userId, args.provision);
      else if (args.action === 'revoke') result = await evaluationStore.revoke(userId, args.evaluation_user_id);
      else throw new EvaluationDenied();
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});

emmaToolRegistry.register(mcpToolRegistry.getTool('evaluation_workspace')!);
