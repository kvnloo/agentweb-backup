import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';

type AgentModeOncallAlertParams = {
  subject: string;
  message: string;
  sessionId?: string;
  context?: Record<string, any>;
};

function hasKey(obj: Record<string, any> | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

export async function sendAgentModeOncallAlert(
  params: AgentModeOncallAlertParams
): Promise<void> {
  const { subject, message, sessionId, context } = params;

  let ishareLink = '';
  if (sessionId) {
    try {
      ishareLink = await chatbotDb.createOrReuseInteractiveShare(sessionId);
    } catch (shareError) {
      console.error('Error creating ishare link for oncall alert:', shareError);
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      ishareLink = `${customerFrontendUrl}/agent-mode/${sessionId}`;
    }
  }

  const baseContext: Record<string, any> = { ...context };
  if (!hasKey(baseContext, 'Session ID')) {
    baseContext['Session ID'] = sessionId || 'unknown';
  }
  if (!hasKey(baseContext, 'iShare Link')) {
    baseContext['iShare Link'] = ishareLink || 'N/A';
  }

  await emailService.sendOncallAlert(subject, message, baseContext);
}
