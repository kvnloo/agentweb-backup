import type { HumanEvalCandidate, HumanEvalFeedback } from './humanEvalService';

export async function runHumanEvalFeedbackAction(
  candidate: HumanEvalCandidate,
  feedback: HumanEvalFeedback,
): Promise<void> {
  if (process.env.HUMAN_EVAL_ACTIONS_DISABLED === 'true') return;
  if (!candidate.action) return;

  switch (candidate.action.type) {
    case 'agent_mode_image_revision':
      await reviseAgentModeImage(candidate, feedback);
      return;
    case 'landing_page_iteration_deploy':
      await iterateAndDeployLandingPage(candidate, feedback);
      return;
    case 'lead_enrichment_rerun':
      await rerunLeadEnrichment(candidate, feedback);
      return;
  }
}

async function reviseAgentModeImage(
  candidate: HumanEvalCandidate,
  feedback: HumanEvalFeedback,
): Promise<void> {
  const action = candidate.action;
  if (action?.type !== 'agent_mode_image_revision') return;

  const { runVerifiedChat } = await import('../controllers/agentModeController');
  await runVerifiedChat({
    sessionId: action.sessionId,
    userId: action.userId,
    startingMessage:
      `Please revise this image based on Matt's human eval feedback.\n\n` +
      `Original image: ${action.artifactUrl || candidate.artifactUrl || 'not provided'}\n` +
      `Original filename: ${action.filename || 'unknown'}\n\n` +
      `Feedback: ${feedback.text}\n\n` +
      `Use the original image as an input image/reference when possible. ` +
      `Call generate_image and produce a new revised image that directly addresses the feedback.`,
    requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
    keywords: [],
    attachments: [],
    maxAttempts: 5,
  });
}

async function iterateAndDeployLandingPage(
  candidate: HumanEvalCandidate,
  feedback: HumanEvalFeedback,
): Promise<void> {
  const action = candidate.action;
  if (action?.type !== 'landing_page_iteration_deploy') return;

  const { iterateLandingPage, deployLandingPage } = await import('./v0Service');
  await iterateLandingPage(
    action.landingPageId,
    action.userId,
    `Human eval feedback from Matt: ${feedback.text}\n\n` +
      `Update the landing page artifact to address this feedback. Keep the page production-ready.`,
  );
  await deployLandingPage(action.landingPageId, action.userId);
}

async function rerunLeadEnrichment(
  candidate: HumanEvalCandidate,
  feedback: HumanEvalFeedback,
): Promise<void> {
  const action = candidate.action;
  if (action?.type !== 'lead_enrichment_rerun') return;

  const { runEmmaEnrichment } = await import('../emma/enrichmentToolRunner');
  const { enqueueAutoHumanEval } = await import('./autoHumanEvalService');

  const outputFields = action.outputFields.map((field) => ({
    ...field,
    instruction:
      `${field.instruction}\n\n` +
      `Human eval correction from Fangfang: ${feedback.text}\n` +
      `Apply this correction directly and replace prior values where relevant.`,
    overwrite_policy: 'always_overwrite' as const,
  }));

  const summary = await runEmmaEnrichment({
    listId: action.listId,
    userId: action.userId,
    outputFields,
    mode: 'enrich',
    leadIds: action.leadIds ?? (action.leadId ? [action.leadId] : undefined),
  });

  if (summary.processedCount <= 0) return;

  await enqueueAutoHumanEval({
    reviewType: 'lead_enrichment',
    userId: action.userId,
    sessionId: candidate.sessionId,
    originalRequest:
      `${action.toolName} feedback rerun list=${action.listId}` +
      `${action.leadId ? ` lead=${action.leadId}` : ''}`,
    outputSummary:
      `Lead enrichment rerun from Fangfang feedback: processed ${summary.processedCount} lead(s), ` +
      `failed ${summary.failedCount}.`,
    sourceKey: `lead-enrichment-feedback:${candidate.candidateId}:${feedback.feedbackId}:${summary.runId}`,
    action,
  });
}
