/**
 * Public surface of the ENG-1685 Agentic Fabriq spike adapter. Import from
 * here (not individual files) outside this directory — the one exception
 * being toolDispatch.ts's flagged branch, which needs `isUserEligibleForAgenticFabriqSpike`
 * and `runEmailToolThroughAgenticFabriq` specifically.
 */
export {
  isAgenticFabriqSpikeEnabled,
  isUserEligibleForAgenticFabriqSpike,
  getAgenticFabriqSpikeAllowlist,
  getAgenticFabriqAppCredentials,
} from './config';
export { runEmailToolThroughAgenticFabriq, pickGmailToolForAction } from './emailBridge';
export { forUserFromRequest, forUserDangerouslyUsingRawUserId, forUserFromVerifiedWebhook } from './identity';
export { verifyAgenticFabriqWebhookSignature } from './webhookVerify';
export { agenticFabriqClient, AgenticFabriqClient } from './client';
export { agenticFabriqTokenCache, AgenticFabriqTokenCache } from './tokenCache';
export * from './errors';
export * from './types';
