/**
 * ENG-2828 — Meta as ZomaProvider #1. A thin adapter over the existing Meta toolkit
 * modules; it re-implements nothing.
 *
 * tools/list must stay pure and cheap (route tests and the manifest path never load the db
 * or Stripe), so the account-lookup and setup-status paths load their modules lazily. That
 * also keeps the gateway → registry → provider → gateway edge from becoming an import cycle.
 */
import { getMetaToolkitManifest, META_TOOLKIT_V1_TOOL_NAMES } from './metaToolkitManifest';
import { GUARDED_WRITE_ACTIONS, GUARDED_WRITE_ENTITIES, isGuardedWriteRequest } from './metaToolkitWriteSurface';
import type { ZomaProvider } from './zomaProvider';

export const metaZomaProvider: ZomaProvider = {
  platform: 'meta',
  get toolNames() {
    return META_TOOLKIT_V1_TOOL_NAMES;
  },
  meteringPlatform: 'meta',
  listTools: () => getMetaToolkitManifest(),
  async resolveAccount(userId, requestedAccountId) {
    const { resolveMetaToolkitAdAccount } = await import('./metaToolkitGateway');
    return resolveMetaToolkitAdAccount(userId, requestedAccountId);
  },
  async getSetupStatus(userId) {
    const { getZomaReadiness } = await import('./zomaOnboarding');
    const readiness = await getZomaReadiness(userId);
    return {
      platform: 'meta',
      connected: readiness.meta.ready,
      connectLink: readiness.meta.link,
      writesEnabled: readiness.writes_enabled,
    };
  },
  guardedWrites: {
    entities: GUARDED_WRITE_ENTITIES,
    actions: GUARDED_WRITE_ACTIONS,
    isGuardedWrite: isGuardedWriteRequest,
  },
};
