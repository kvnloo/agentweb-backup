/**
 * ENG-2103 (F2) — shared CRM sender-config reader.
 *
 * Extracted verbatim from `AgentModeService.prototype.getCrmSenders`. Shared
 * far more widely than any single tool cluster: `emma/impl/leads.ts`'s
 * `sendEmailToLead` (this extraction), `AgentModeService.prototype.getSenderForLead`
 * (used by the deferred, `this.callLLM`-coupled `updateEmailDraftForLead` —
 * see that method's own flag in emma/impl/leads.ts's header comment), and
 * `routes/webhooks.ts` (a real production caller found by grepping the whole
 * backend, not just tools.ts or this cluster) all call
 * `agentModeService.getCrmSenders(...)` directly. `AgentModeService`'s own
 * copy now delegates here so all three keep sharing one implementation.
 */

export async function getCrmSenders(userId: string): Promise<{
  success: boolean;
  senders: Array<{
    id: string;
    email: string;
    fromName: string;
    notes?: string;
    senderType?: 'gmail' | 'outlook';
    gmailAccountId?: string;
    senderProvider?: 'resend' | 'gmail' | 'outlook';
    connectedAccountId?: string;
  }>;
  defaultSenderId: string | null;
  error?: string;
}> {
  try {
    const { loadSenderConfig, serializeSender } = await import('../../../services/crmSenderService');
    const config = await loadSenderConfig(userId);

    // Emit both shapes: legacy keys for callers that still branch on senderType,
    // and the neutral ones for provider-aware code.
    return {
      success: true,
      senders: config.senders.map((s) => ({
        ...serializeSender(s),
        senderProvider: s.senderProvider,
        connectedAccountId: s.connectedAccountId,
      })),
      defaultSenderId: config.defaultSenderId
    };
  } catch (error) {
    console.error('AgentMode: Error getting CRM senders:', error);
    return {
      success: false,
      senders: [],
      defaultSenderId: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
