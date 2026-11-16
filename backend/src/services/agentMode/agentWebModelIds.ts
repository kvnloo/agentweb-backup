/**
 * ENG-669: the AgentWeb Model's id and customer-facing name. A leaf module (no imports) so that modelAccess.ts,
 * modelUnavailable.ts and agentWebModelRouter.ts can all share the literals without an import cycle (modelAccess and the
 * router both import modelUnavailable).
 */

/** The selectable id of the AgentWeb Model (a router, never a registry key). Reserved in tier allowlists (PR-A). */
export const AGENTWEB_MODEL_ID = 'agentweb-model';

/** Shown in the picker, in refusals and in "AgentWeb Model · via X". Customers never see the raw id. */
export const AGENTWEB_MODEL_DISPLAY_NAME = 'AgentWeb Model';
