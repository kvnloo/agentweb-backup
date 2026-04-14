/**
 * CRM Signal Hooks (B2)
 *
 * Thin fire-and-forget wrappers around contactSyncService so call sites
 * (signup, Emma sessions, Stripe webhook) don't have to know about the
 * sync payload shape or error-swallow semantics.
 *
 * Every hook:
 *  - Catches and logs errors (never throws — CRM sync must not break the caller)
 *  - Returns a promise callers can optionally await in tests
 *  - Uses dependency injection for unit testability
 */

import { syncContact as defaultSyncContact } from './contactSyncService';
import type { SyncInput, SyncResult } from './contactSyncService';

export interface SignalHookDeps {
  syncContact?: (input: SyncInput) => Promise<SyncResult>;
  logger?: Pick<typeof console, 'error' | 'warn'>;
}

export interface SignupHookInput {
  userId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  companyName?: string | null;
  signupSource?: string | null;
  isOAuthUser?: boolean;
  createdAt?: string;
}

export async function onUserSignup(
  input: SignupHookInput,
  deps: SignalHookDeps = {}
): Promise<SyncResult | null> {
  const sync = deps.syncContact || defaultSyncContact;
  const logger = deps.logger || console;

  if (!input.email || !input.userId) {
    logger.warn('[crmSignalHooks.onUserSignup] missing email/userId, skipping');
    return null;
  }

  try {
    const first =
      input.firstName ||
      (input.displayName ? input.displayName.split(' ')[0] : null) ||
      null;
    const last =
      input.lastName ||
      (input.displayName && input.displayName.split(' ').length > 1
        ? input.displayName.split(' ').slice(1).join(' ')
        : null) ||
      null;

    return await sync({
      source: 'signup',
      sourceRecordId: `user-${input.userId}`,
      identity: {
        email: input.email,
        firstName: first,
        lastName: last,
      },
      companyName: input.companyName || null,
      eventType: 'contact.created',
      payload: {
        signupDate: input.createdAt || new Date().toISOString(),
        signupSource: input.signupSource || (input.isOAuthUser ? 'oauth' : 'password'),
        userId: input.userId,
      },
    });
  } catch (err: any) {
    logger.error('[crmSignalHooks.onUserSignup] sync failed:', err?.message || err);
    return null;
  }
}

export interface EmmaSessionHookInput {
  sessionId: string;
  userId: string;
  email: string;
  portalType?: string | null;
  sessionType?: string | null;
  pageIdentifier?: string | null;
  createdAt?: string;
}

export async function onEmmaSessionStart(
  input: EmmaSessionHookInput,
  deps: SignalHookDeps = {}
): Promise<SyncResult | null> {
  const sync = deps.syncContact || defaultSyncContact;
  const logger = deps.logger || console;

  if (!input.email || !input.sessionId) {
    logger.warn('[crmSignalHooks.onEmmaSessionStart] missing email/sessionId, skipping');
    return null;
  }

  try {
    return await sync({
      source: 'emma_session',
      sourceRecordId: `emma-session-${input.sessionId}`,
      identity: { email: input.email },
      eventType: 'engagement.emma_session',
      payload: {
        sessionId: input.sessionId,
        userId: input.userId,
        portalType: input.portalType || null,
        sessionType: input.sessionType || null,
        pageIdentifier: input.pageIdentifier || null,
        startedAt: input.createdAt || new Date().toISOString(),
      },
    });
  } catch (err: any) {
    logger.error('[crmSignalHooks.onEmmaSessionStart] sync failed:', err?.message || err);
    return null;
  }
}
