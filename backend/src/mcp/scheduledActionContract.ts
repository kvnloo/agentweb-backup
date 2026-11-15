/**
 * ENG-2956 (ENG-2847.10) — typed deterministic scheduled-action contract.
 *
 * A scheduled action is a single direct-backend tool call with fixed args —
 * never a prompt that starts or resumes the Emma agent (scheduled-chat prompt
 * execution stays prohibited for external deterministic callers).
 *
 * Pure: no persistence, scheduler wiring, or execution. Wiring typed actions
 * into a scheduler is data-plane work tracked as a separate Requires: Me child.
 */

import { isAgentExecutionTool } from './server/agentExecutionTools';

export interface ScheduledAction {
  tool: string;
  args: Record<string, unknown>;
}

/** The subset of a registered tool's metadata the validator needs. */
export interface ScheduledActionToolInfo {
  /** Hidden and refused for external MCP callers (McpToolHandler.internalOnly). */
  internalOnly?: boolean;
  /** Opt-in key scope; absent means callable by a default `aw_` key. */
  requiredScope?: string;
  /** Admin-only tool (e.g. adminLookupTools); never schedulable by a customer key. */
  adminOnly?: boolean;
}

/** Lookup over registered tools; returns undefined for unknown names. */
export interface ScheduledActionToolRegistry {
  getTool(name: string): ScheduledActionToolInfo | undefined;
}

export type ScheduledActionRejection =
  | 'invalid_shape'
  | 'unknown_tool'
  | 'agent_execution_tool'
  | 'internal_only_tool'
  | 'admin_tool'
  | 'scope_required_tool'
  | 'identity_override';

export type ScheduledActionValidation =
  | { ok: true }
  | { ok: false; reason: ScheduledActionRejection; detail: string };

/** Arg keys that would let a scheduled action act on a different account. */
export const IDENTITY_OVERRIDE_ARG_KEYS: readonly string[] = Object.freeze([
  'client_id',
  'clientId',
  'user_id',
  'userId',
]);

function reject(reason: ScheduledActionRejection, detail: string): ScheduledActionValidation {
  return { ok: false, reason, detail };
}

/** Validates a scheduled action against the registry. Never throws. */
export function validateScheduledAction(
  action: unknown,
  registry: ScheduledActionToolRegistry,
): ScheduledActionValidation {
  try {
    if (!action || typeof action !== 'object') return reject('invalid_shape', 'action must be an object');
    const { tool, args } = action as Partial<ScheduledAction>;
    if (typeof tool !== 'string' || tool.trim() === '') return reject('invalid_shape', 'tool must be a non-empty string');
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return reject('invalid_shape', 'args must be a plain object');
    }

    // Checked before registry lookup: an agent-execution tool is never
    // schedulable, regardless of how it is registered.
    if (isAgentExecutionTool(tool)) {
      return reject('agent_execution_tool', `${tool} executes or resumes the Emma agent`);
    }

    const info = registry.getTool(tool);
    if (!info) return reject('unknown_tool', `${tool} is not a registered tool`);
    if (info.internalOnly) return reject('internal_only_tool', `${tool} is internal-only`);
    if (info.adminOnly) return reject('admin_tool', `${tool} is admin-only`);
    if (info.requiredScope) {
      return reject('scope_required_tool', `${tool} requires scope ${info.requiredScope}; not default aw_-callable`);
    }

    const override = IDENTITY_OVERRIDE_ARG_KEYS.find((k) => Object.prototype.hasOwnProperty.call(args, k));
    if (override) return reject('identity_override', `args may not set ${override}`);

    return { ok: true };
  } catch (err) {
    return reject('invalid_shape', `validation failed: ${(err as Error)?.message ?? String(err)}`);
  }
}
