import { emmaToolRegistry } from '../../emma/registry';
import { mcpToolRegistry } from './registry';
import { evaluationStore } from '../../services/evaluationStore';
import { EvaluationDenied, isEvaluationUser, requireActiveEvaluation, requireEvaluationAdmin, requireEvaluationReviewer, evaluationView } from '../../services/evaluationPolicy';
import { runEvaluation } from '../../services/evaluationService';

mcpToolRegistry.register({
  name: 'evaluation_workspace',
  requiresUserAccount: true,
  definition: {
    name: 'evaluation_workspace',
    description: 'Evaluation workspace: query frozen approved campaigns; simulate campaigns, ad sets, ads, creatives, budgets, schedules, pause, activate, and publish; reset disposable state; analyze and generate creatives. Simulation complete — not sent to Meta. Explicitly assigned reviewers can inspect results. Administrators can provision and revoke. No Meta connector or production access.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['inspect', 'analyze', 'generate_creative', 'upload_artifact', 'provision', 'revoke', 'simulate', 'review'] },
        command: { type: 'object', additionalProperties: false, properties: {
          operation: { type: 'string', enum: ['query', 'inspect', 'create', 'update', 'pause', 'activate', 'publish', 'reset'] },
          kind: { type: 'string', enum: ['campaign', 'adset', 'ad', 'creative'] },
          source: { type: 'string', enum: ['approved', 'current'] }, id: { type: 'string' },
          fields: { type: 'object', description: 'name; campaign objective AWARENESS/TRAFFIC/LEADS/SALES; budget (integer USD cents) with budgetType daily/lifetime; startTime/endTime UTC ISO; adset parentId and targeting text; ad parentId and creativeId; creative text, own artifactId, or upload {mime,base64} <=24 KB. Only returned simulated IDs. No URLs/credentials.' },
        }, required: ['operation'] },
        artifact_id: { type: 'string', description: 'Review an explicitly assigned evaluation artifact; returns private base64 bytes.' },
        prompt: { type: 'string' }, text: { type: 'string' },
        evaluation_user_id: { type: 'string' },
        provision: { type: 'object', description: 'Admin provisioning request with email, displayName, password, generationBudget, expiresAt (epoch milliseconds), approved sanitized materials (title, text, approved=true), optional reviewerUserIds, and simulationPacket {approved:true,objects:[{key,kind,name,...fields,parentKey?,creativeKey?,metrics?}]}. Packet keys are local labels, never Meta IDs; maximum 30 objects / 50 KB.' },
      }, required: ['action'],
    },
  },
  execute: async (args, context) => {
    const userId = context?.userId;
    if (typeof userId !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new EvaluationDenied();
    let result: unknown;
    if (isEvaluationUser(userId)) {
      await requireActiveEvaluation(userId);
      if (args.evaluation_user_id || args.provision || Object.keys(args).some(k => !['action', 'prompt', 'text', 'command'].includes(k))) throw new EvaluationDenied();
      if (args.action === 'simulate') result = await evaluationStore.simulate(userId, args.command);
      else if (args.action === 'inspect') result = evaluationView(await requireActiveEvaluation(userId));
      else if (args.action === 'upload_artifact' && typeof args.text === 'string') {
        result = await evaluationStore.saveArtifact(userId, Buffer.from(args.text), 'text/plain');
      } else result = await runEvaluation(userId, { action: args.action, prompt: args.prompt });
      await requireActiveEvaluation(userId);
    } else if (args.action === 'review') {
      if (Object.keys(args).some(k => !['action', 'evaluation_user_id', 'artifact_id'].includes(k))) throw new EvaluationDenied();
      await requireEvaluationReviewer(userId, context);
      if (args.artifact_id !== undefined) {
        await evaluationStore.requireReview(userId, args.evaluation_user_id);
        const artifact = await evaluationStore.getArtifact(args.evaluation_user_id, args.artifact_id);
        result = { mime: artifact.mime, base64: artifact.content.toString('base64') };
      } else result = await evaluationStore.review(userId, args.evaluation_user_id);
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
