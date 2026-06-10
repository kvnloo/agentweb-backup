export type AgentToolEffect =
  | 'read'
  | 'session_state'
  | 'internal_write'
  | 'external_send'
  | 'external_publish'
  | 'admin'
  | 'destructive'
  | 'unknown';

export type AgentToolRisk = 'low' | 'medium' | 'high';
export type AgentToolPolicySeverity = 'info' | 'warning' | 'critical';

export interface AgentToolPolicyFlag {
  code: string;
  severity: AgentToolPolicySeverity;
  message: string;
}

export interface AgentToolPolicyDecision {
  toolName: string;
  mode: 'observe' | 'enforce';
  allowed: boolean;
  effect: AgentToolEffect;
  risk: AgentToolRisk;
  flags: AgentToolPolicyFlag[];
}

export interface AgentToolPolicyInput {
  toolName: string;
  args?: unknown;
  isAdmin?: boolean;
  isSharedSession?: boolean;
  enforce?: boolean;
}

export interface AgentToolGatewayExecutionInput extends AgentToolPolicyInput {
  policyDecision?: AgentToolPolicyDecision;
  execute: () => Promise<unknown>;
  now?: () => number;
}

export type AgentToolGatewayExecutionOutcome =
  | {
      status: 'success';
      result: unknown;
      policyDecision: AgentToolPolicyDecision;
      durationMs: number;
    }
  | {
      status: 'error';
      error: unknown;
      policyDecision: AgentToolPolicyDecision;
      durationMs: number;
    };

export class AgentToolPolicyBlockedError extends Error {
  constructor(readonly policyDecision: AgentToolPolicyDecision) {
    super(`Tool "${policyDecision.toolName}" was blocked by Agent Tool Gateway policy.`);
    this.name = 'AgentToolPolicyBlockedError';
  }
}

const SIDE_EFFECTING_PREFIXES = [
  'add_',
  'create_',
  'delete_',
  'freeze_',
  'launch_',
  'manage_',
  'publish_',
  'send_',
  'set_',
  'update_',
];

const EXTERNAL_SEND_TOOLS = new Set([
  'send_email',
  'linkedin_outreach',
]);

const EXTERNAL_PUBLISH_TOOLS = new Set([
  'publish_blog_article',
  'publish_landing_page_changes',
]);

const SESSION_STATE_TOOLS = new Set([
  'install_skills',
  'set_work_plan_status',
  'save_memory',
]);

const INTERNAL_WRITE_TOOLS = new Set([
  'save_file',
  'create_gtm_plan',
  'create_task_from_prompt',
  'create_work_plan',
]);

const READ_PREFIXES = [
  'ask_',
  'assess_',
  'describe_',
  'find_',
  'get_',
  'list_',
  'read_',
  'search_',
];

export function evaluateAgentToolPolicy(input: AgentToolPolicyInput): AgentToolPolicyDecision {
  const toolName = input.toolName || 'unknown';
  const effect = classifyToolEffect(toolName, input.args);
  const flags: AgentToolPolicyFlag[] = [];

  if (effect !== 'read') {
    flags.push({
      code: 'side_effecting_tool',
      severity: effect === 'session_state' ? 'info' : 'warning',
      message: `${toolName} can change state; record why it was selected and verify the outcome.`,
    });
  }

  if (effect === 'external_send' || effect === 'external_publish' || effect === 'destructive') {
    flags.push({
      code: 'confirmation_recommended',
      severity: 'critical',
      message: `${toolName} can affect external systems or delete data; require explicit user confirmation before enforcing this tool.`,
    });
  }

  if (input.isSharedSession && effect !== 'read' && effect !== 'session_state') {
    flags.push({
      code: 'shared_session_side_effect',
      severity: 'critical',
      message: `${toolName} is side-effecting inside a shared session.`,
    });
  }

  if (toolName === 'create_gtm_plan' && looksLikeTaskRequest(input.args)) {
    flags.push({
      code: 'possible_task_tool_mismatch',
      severity: 'warning',
      message: 'create_gtm_plan was selected for wording that looks like a task or follow-up. Prefer create_task_from_prompt when the user asked for a tracked task.',
    });
  }

  const risk = computeRisk(effect, flags);
  const enforce = input.enforce === true;

  return {
    toolName,
    mode: enforce ? 'enforce' : 'observe',
    allowed: !enforce || !flags.some((flag) => flag.severity === 'critical'),
    effect,
    risk,
    flags,
  };
}

export function summarizeAgentToolPolicyFlags(
  decisions: Array<AgentToolPolicyDecision | undefined>,
): string | undefined {
  const entries = decisions
    .filter((decision): decision is AgentToolPolicyDecision => Boolean(decision))
    .flatMap((decision) =>
      decision.flags.map((flag) => `${decision.toolName}:${flag.code}:${flag.severity}`)
    );

  return entries.length > 0 ? entries.join(',') : undefined;
}

export function summarizeAgentToolPolicyModes(
  decisions: Array<AgentToolPolicyDecision | undefined>,
): string | undefined {
  const entries = decisions
    .filter((decision): decision is AgentToolPolicyDecision => Boolean(decision))
    .map((decision) => `${decision.toolName}:${decision.effect}:${decision.risk}:${decision.mode}`);

  return entries.length > 0 ? entries.join(',') : undefined;
}

export async function executeAgentToolThroughGateway(
  input: AgentToolGatewayExecutionInput,
): Promise<AgentToolGatewayExecutionOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const policyDecision = input.policyDecision ?? evaluateAgentToolPolicy(input);

  if (!policyDecision.allowed) {
    return {
      status: 'error',
      error: new AgentToolPolicyBlockedError(policyDecision),
      policyDecision,
      durationMs: Math.max(0, now() - startedAt),
    };
  }

  try {
    const result = await input.execute();
    return {
      status: 'success',
      result,
      policyDecision,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    return {
      status: 'error',
      error,
      policyDecision,
      durationMs: Math.max(0, now() - startedAt),
    };
  }
}

function classifyToolEffect(toolName: string, args: unknown): AgentToolEffect {
  if (toolName.startsWith('delete_') || toolName === 'freeze_user_account') return 'destructive';
  if (EXTERNAL_SEND_TOOLS.has(toolName)) return 'external_send';
  if (EXTERNAL_PUBLISH_TOOLS.has(toolName)) return 'external_publish';
  if (toolName.startsWith('manage_')) return 'admin';
  if (SESSION_STATE_TOOLS.has(toolName)) return 'session_state';
  if (INTERNAL_WRITE_TOOLS.has(toolName)) return 'internal_write';

  if (toolName === 'linkedin_outreach') {
    const action = stringField(args, 'action').toLowerCase();
    if (action.includes('send') || action.includes('message') || action.includes('invite')) {
      return 'external_send';
    }
    return 'read';
  }

  if (READ_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return 'read';
  if (SIDE_EFFECTING_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return 'internal_write';
  return 'unknown';
}

function computeRisk(effect: AgentToolEffect, flags: AgentToolPolicyFlag[]): AgentToolRisk {
  if (flags.some((flag) => flag.severity === 'critical')) return 'high';
  if (effect === 'external_send' || effect === 'external_publish' || effect === 'destructive') return 'high';
  if (flags.some((flag) => flag.severity === 'warning')) return 'medium';
  if (effect === 'internal_write' || effect === 'admin' || effect === 'unknown') return 'medium';
  return 'low';
}

function looksLikeTaskRequest(args: unknown): boolean {
  const haystack = safeStringify(args).toLowerCase();
  if (!haystack) return false;
  const taskWords = ['task', 'follow-up', 'follow up', 'todo', 'to-do', 'review'];
  const gtmWords = ['campaign', 'gtm', 'go-to-market', 'phase', 'work item', 'plan'];
  return taskWords.some((word) => haystack.includes(word)) &&
    !gtmWords.some((word) => haystack.includes(word));
}

function stringField(value: unknown, field: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}
