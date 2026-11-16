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

  const { runVerifiedChat, isSessionBusyError } = await import('../controllers/agentModeController');
  const { cronJobRegistry } = await import('../utils/cronJobRegistry');
  try {
    // ENG-1189: this run's tool calls self-call back into this process via
    // mcpFetch — tracked so a deploy mid-run waits for it instead of
    // abandoning it against a closed listener.
    await cronJobRegistry.track('humanEvalVerifiedChat', runVerifiedChat({
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
    }));
  } catch (error) {
    // ENG-1719: on ordinary lock contention this used to propagate up to the caller's bare
    // `.catch(err => console.warn(...))`, which never reaches the reviewer — but the ack
    // reply already told them "the revised result will post back to this thread when
    // ready," so silence here reads as the bot having forgotten. Tell them explicitly
    // instead of leaving that promise unfulfilled with no explanation.
    if (isSessionBusyError(error)) {
      // Reachable only via a Slack thread reply, so a real posted message must already
      // exist — but the type is optional now (ENG-1854, posting can be skipped), so guard
      // explicitly rather than asserting.
      if (!candidate.slackChannel) return;
      const { postSlackMessage } = await import('./slackService');
      await postSlackMessage(
        candidate.slackChannel,
        ':hourglass_flowing_sand: This session was busy with another generation in progress, ' +
        'so the auto-revision couldn\'t run just now. Please retry the feedback in a moment.',
        candidate.slackMessageTs,
      ).catch((slackErr: any) =>
        console.warn('[human-eval] failed to post session-busy notice:', slackErr?.message || slackErr),
      );
      return;
    }
    // ENG-669 PR-C: the chat's model was refused (runVerifiedChat saved the refusal to the chat). The ack promised a
    // post-back, so post the refusal and what to do instead of dropping it.
    const { isModelUnavailableError } = await import('./agentMode/modelUnavailable');
    if (isModelUnavailableError(error)) {
      if (!candidate.slackChannel) return;
      const { postSlackMessage } = await import('./slackService');
      const { modelRefusalReviewerNotice } = await import('../utils/modelRefusalReviewerNotice');
      await postSlackMessage(candidate.slackChannel, await modelRefusalReviewerNotice(error), candidate.slackMessageTs)
        .catch((slackErr: any) =>
          console.warn('[human-eval] failed to post model-refusal notice:', slackErr?.message || slackErr),
        );
      return;
    }
    throw error;
  }
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
    // The rerun reviews the same underlying use case as the original candidate.
    category: candidate.category,
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
