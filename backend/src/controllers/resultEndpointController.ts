import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { settingsService } from '../services/settingsService';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { runVerifiedChat } from './agentModeController';

export interface WaitingContent {
  type: 'youtube' | 'url' | 'html';
  value: string;   // YouTube URL, iframe URL, or raw HTML
  title?: string;   // Optional heading above the content
}

export interface ResultEndpointConfig {
  name: string;
  resultTitle?: string;
  prompt: string;
  outputFormat: 'html' | 'image' | 'video';
  reviewerEmail: string;
  skipReview?: boolean;
  llmModel?: string;
  requiredSkills?: string[];
  waitingContent?: WaitingContent;
}

const SETTINGS_KEY = 'result-endpoints-config';

/**
 * Normalize a key for matching: lowercase, replace underscores with spaces.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/_/g, ' ');
}

/**
 * Substitute {{variable}} placeholders in the template with values from params.
 * Matching is normalized: URL-decoded param names match template variable names
 * even when one uses spaces and the other uses underscores.
 */
export function applyVariableValues(
  template: string,
  params: Record<string, string>
): string {
  // Build a normalized lookup from params
  const normalizedParams = new Map<string, string>();
  for (const [key, value] of Object.entries(params)) {
    normalizedParams.set(normalizeKey(key), value);
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (match, variableName: string) => {
    const normalized = normalizeKey(variableName.trim());
    const value = normalizedParams.get(normalized);
    if (value !== undefined) {
      return value;
    }
    return match; // Leave unmatched variables as-is
  });
}

export async function getResultEndpointConfigs(): Promise<ResultEndpointConfig[]> {
  const setting = await settingsService.getSetting(SETTINGS_KEY);
  if (!setting?.settingValue) {
    return [];
  }
  try {
    const raw = JSON.parse(setting.settingValue) as any[];
    // Normalize: accept legacy "testEmail" field as "reviewerEmail"
    return raw.map(c => ({
      ...c,
      reviewerEmail: c.reviewerEmail || c.testEmail,
    }));
  } catch {
    return [];
  }
}

export async function saveResultEndpointConfigs(
  configs: ResultEndpointConfig[],
  updatedBy: string
): Promise<void> {
  await settingsService.setSetting(
    SETTINGS_KEY,
    JSON.stringify(configs),
    'Result endpoint configurations',
    updatedBy
  );
}

export async function handleResult(req: Request, res: Response): Promise<void> {
  try {
    const { resultName } = req.params;

    // 1. Look up config
    const configs = await getResultEndpointConfigs();
    const config = configs.find(c => c.name === resultName);
    if (!config) {
      res.status(404).json({ error: `Result endpoint "${resultName}" not found` });
      return;
    }

    // 2. Extract special params and remaining args
    // Accept params from POST body (JSON) or query string
    const allParams: Record<string, string> = {};
    const source = req.method === 'POST' && req.body ? req.body : req.query;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        allParams[key] = value;
      }
    }

    const leadEmail = allParams.leadEmail;
    const leadId = allParams.leadId;
    const externalSessionId = allParams.sessionId;

    // Remove special params from args
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(allParams)) {
      if (key !== 'leadEmail' && key !== 'leadId' && key !== 'sessionId') {
        args[key] = value;
      }
    }

    // 3. Create anonymous session
    const anonUserId = `anon_${uuidv4()}`;
    const session = await chatbotDb.createChatSession(
      anonUserId,
      undefined, // pageContent
      'agent',   // portalType
      undefined, // pageIdentifier
      undefined, // selectedStartupId
      undefined, // workflowId
      undefined, // executionId
      undefined, // emailCampaignTaskId
      'result-endpoint' // sessionType
    );

    // 4. Store resultEndpointMetadata
    await chatbotDb.updateSessionResultEndpointMetadata(session.sessionId, {
      resultName: config.name,
      resultTitle: config.resultTitle || config.name,
      leadEmail,
      leadId,
      externalSessionId,
      reviewerEmail: config.reviewerEmail,
      skipReview: config.skipReview || false,
      outputFormat: config.outputFormat,
      args,
    });

    // 5. Enable interactive sharing
    const ishareUrl = await chatbotDb.createOrReuseInteractiveShare(session.sessionId);

    // 6. Set LLM model (use default)
    const llmModel = await agentModeService.getDefaultModel();
    await chatbotDb.updateSessionLlmModel(session.sessionId, llmModel);

    // 7. Substitute URL params into prompt template
    const resolvedPrompt = applyVariableValues(config.prompt, args);

    // 8. Set predefined work plan from the configured prompt
    const outputFormatInstructions: Record<string, string> = {
      html: 'Generate the content as a well-formatted HTML email. Use inline styles for email compatibility.',
      image: 'Generate the content as an image using the image generation tools available.',
      video: 'Generate the content as a video using the video generation tools available.',
    };

    const workPlan = {
      title: config.resultTitle || config.name,
      steps: [
        {
          stepCount: 1,
          title: `Generate ${config.outputFormat} content`,
          description: `${resolvedPrompt}\n\n${outputFormatInstructions[config.outputFormat] || outputFormatInstructions.html}`,
          status: 'pending' as const,
        },
        {
          stepCount: 2,
          title: `Send for review`,
          description: `Use the send_for_review tool to send the generated content for review. Pass the subject, content_url and/or content_html from the generated result.`,
          status: 'pending' as const,
          requiredFunctionCalls: ['send_for_review'],
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      autocomplete: true,
    };
    await chatbotDb.updateSessionWorkPlan(session.sessionId, workPlan);

    // 9. Build user starting message from URL parameter values
    const paramLines = Object.entries(args)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
    const startingMessage = paramLines
      ? `Here are my details:\n${paramLines}`
      : 'Please proceed with the work plan.';

    // 10. Return JSON with session info
    res.status(200).json({
      success: true,
      sessionId: session.sessionId,
      ishareUrl,
      configName: config.name,
      resultTitle: config.resultTitle || config.name,
    });

    // 11. Fire-and-forget runVerifiedChat
    const requiredFunctions = [
      { functionName: 'send_for_review', minCount: 1 },
    ];

    runVerifiedChat({
      sessionId: session.sessionId,
      userId: anonUserId,
      startingMessage,
      keywords: [],
      requiredFunctions,
      maxAttempts: 20,
      llmModel,
      // ENG-634: headless fire-and-forget run (no human present to reply) — enable
      // completion-gate halt protection so a free-text "shall I proceed?" auto-continues
      // best-effort instead of dead-ending with a non-deliverable.
      completionGate: true,
    }).then(result => {
      console.log(`Result endpoint "${resultName}" session ${session.sessionId} completed: success=${result.success}, attempts=${result.attempts}`);
    }).catch(error => {
      console.error(`Result endpoint "${resultName}" session ${session.sessionId} failed:`, error);
    });

  } catch (error) {
    console.error('Error handling result endpoint:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
