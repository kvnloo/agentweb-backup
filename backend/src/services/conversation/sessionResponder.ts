/**
 * Transport-agnostic session response pipeline (ENG-272).
 *
 * Extracted verbatim from `handleSlackSessionResponse` in `routes/slack.ts`.
 * Everything here is product logic that is true of any customer conversation
 * channel: title the session, track it as GTM work, bind it to its thread,
 * mint an iShare link, generate the response, deliver it, and recover
 * legibly when generation fails.
 *
 * Everything transport-specific — how to post, how to fetch a file, how to render
 * text — arrives through the injected adapter. Progress indicators (Slack's assistant
 * thread status, a Teams typing activity) stay with the caller: they are claimed before
 * this pipeline runs and released after it, and Slack ref-counts them per thread.
 *
 * Extraction rule: this file must not import a transport SDK, and must not
 * reference Slack or Teams by name outside of comments.
 */

import type { ConversationChannelAdapter, ConversationRef, InboundAttachment } from './channelPort';
import { isModelUnavailableError, type ModelUnavailableError } from '../agentMode/modelUnavailable';

export interface SessionResponseParams {
  session: any;
  user: any;
  ref: ConversationRef;
  /** The customer's message, unprefixed — used for the session title. */
  rawMessage: string;
  /** The message actually sent to the agent, typically prefixed with the sender's name. */
  userMessage: string;
  adminEmail?: string;
  isAdminChannel?: boolean;
  files?: InboundAttachment[];
}

/**
 * Title, track, bind, generate, deliver. Never throws — delivery failures are
 * reported into the thread and persisted onto the session instead.
 */
export async function handleSessionResponse(
  params: SessionResponseParams,
  adapter: ConversationChannelAdapter
): Promise<void> {
  const { session, user, ref, rawMessage, userMessage, adminEmail, isAdminChannel, files } = params;
  const { chatbotDb } = await import('../chatbotService');
  const { ensureGtmWorkItemForSlackSession } = await import('../gtmPlanService');

  // Set session title based on raw message (without username prefix)
  const sessionTitle = rawMessage.length > 50
    ? rawMessage.substring(0, 47) + '...'
    : rawMessage;
  await chatbotDb.updateSessionTitle(session.sessionId, sessionTitle);

  // Track this session as a GTM Tracker work item
  let gtmTrackerLink: string | null = null;
  try {
    const gtmResult = await ensureGtmWorkItemForSlackSession({
      userId: user.userId,
      sessionId: session.sessionId,
      rawMessage,
      adminEmail,
    });
    if (gtmResult) {
      await chatbotDb.updateSessionGtmWorkItem(session.sessionId, gtmResult);
      gtmTrackerLink = adapter.gtmTrackerLink(gtmResult.planId, gtmResult.phaseId, isAdminChannel);
      console.log(`📊 Session ${session.sessionId} tracked in GTM plan ${gtmResult.planId}`);
    }
  } catch (gtmError) {
    console.error('⚠️ Non-blocking: Failed to track session in GTM Tracker:', gtmError);
  }

  // Bind the session to this thread so later replies resume it
  await adapter.persistThreadBinding(ref, session.sessionId, user.userId);

  // Create interactive share link so user can optionally continue in the portal
  const ishareLink = await chatbotDb.createOrReuseInteractiveShare(session.sessionId);
  console.log('🔗 iShare link created for session:', ishareLink);

  // Everything from here on lives inside the try: the caller may have claimed a
  // transport-side progress indicator before calling us, so an import, model-resolution
  // or attachment failure must surface as a reply rather than escaping and leaking it.
  // ENG-669: kept from the import below so the error path can word a model refusal without re-importing.
  let describeModelRefusal: ((error: ModelUnavailableError) => string) | undefined;
  try {
    const { generateSessionResponse, modelUnavailableBody } = await import('../../controllers/agentModeController');
    describeModelRefusal = (error) => modelUnavailableBody(error).error;
    const { agentModeService } = await import('../agentModeService');
    const { cronJobRegistry } = await import('../../utils/cronJobRegistry');

    const llmModel = session.llmModel || await agentModeService.getDefaultModel();
    if (!session.llmModel) {
      await chatbotDb.updateSessionLlmModel(session.sessionId, llmModel, undefined, 'system');
    }

    // Download and persist any files attached to the inbound message
    const attachments = await adapter.fetchAttachments(files, user.userId);

    // ENG-1189: this turn's tool calls self-call back into this process via
    // mcpFetch — tracked so a deploy mid-run waits for it instead of
    // abandoning it against a closed listener. The job name is derived from the
    // transport so the Slack path keeps its historical 'slackAgentTurn' key.
    const response = await cronJobRegistry.track(`${ref.transport}AgentTurn`, generateSessionResponse(
      session.sessionId,
      userMessage,
      user.userId,
      llmModel,
      attachments
    ));

    // Post the response to the thread
    if (response.content) {
      await adapter.postReply(ref, adapter.renderOutbound(response));
    } else {
      // Generation succeeded but produced no text content — log and post a fallback so the
      // user gets feedback instead of silence. This can happen when the LLM returns only tool
      // calls with no final summary text, or when the content variable was never populated.
      console.error(`❌ Session ${session.sessionId}: generateSessionResponse succeeded but response.content is empty`);
      await adapter.postReply(ref, 'I completed the task but was unable to format a response. Please check the portal for results or try again.');
    }

    // Post iShare link and GTM Tracker link as a separate follow-up message
    await adapter.postContextLinks(ref, { ishareLink, gtmTrackerLink });
  } catch (genError) {
    console.error('❌ Error generating agent response for session:', genError);

    // Persist partial token usage from messages accumulated before the error
    if ((genError as any)?.partialUsageMessages?.length) {
      try {
        await chatbotDb.addMessagesToSession(session.sessionId, (genError as any).partialUsageMessages);
        console.log(`Session: Persisted partial usage from ${(genError as any).partialUsageMessages.length} messages for failed session ${session.sessionId}`);
      } catch (usageErr) {
        console.error('Failed to persist partial usage for session:', usageErr);
      }
    }

    // CodeRabbit, PR #2393: when generation failed *because* the transport is failing,
    // this reply usually fails too. Unguarded, the rejection escaped and skipped the
    // persistence below, so iShare viewers saw an orphaned user message — and the
    // "never throws" contract above would have been a lie for every future transport.
    // ENG-669: the session's model is outside the owner's plan: say so (nothing ran on another model).
    const modelRefusal = isModelUnavailableError(genError) && describeModelRefusal ? describeModelRefusal(genError) : undefined;
    try {
      await adapter.postReply(ref, modelRefusal ?? 'Sorry, I encountered an error while processing your request. Please try again.');
    } catch (replyError) {
      console.error('❌ Failed to post the error reply:', replyError);
    }

    // Save error message to session so ishare viewers see the failure rather than an orphaned user message
    try {
      await chatbotDb.addMessageToSession(session.sessionId, {
        role: 'assistant',
        content: modelRefusal ?? 'Sorry, I encountered an error processing your request. Please try again.',
        timestamp: new Date().toISOString(),
        metadata: { timestamp: new Date().toISOString(), isErrorMessage: true },
      });
    } catch (saveError) {
      console.error('❌ Error saving error message to session:', saveError);
    }
  }
}
