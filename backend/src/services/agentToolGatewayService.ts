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

export interface AgentToolContractValidationInput {
  toolName: string;
  args: unknown;
  inputSchema?: any;
  effect?: AgentToolEffect;
}

export interface AgentToolContractIssue {
  code: 'missing_required' | 'unknown_property' | 'type_mismatch' | 'invalid_args';
  path: string;
  message: string;
}

export type AgentToolContractValidationResult =
  | {
      status: 'valid';
      args: unknown;
      issues: AgentToolContractIssue[];
      repairs: string[];
    }
  | {
      status: 'repaired';
      args: unknown;
      issues: AgentToolContractIssue[];
      repairs: string[];
    }
  | {
      status: 'invalid';
      args: unknown;
      issues: AgentToolContractIssue[];
      repairs: string[];
      modelMessage: string;
    };

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

export class AgentToolContractValidationError extends Error {
  constructor(readonly validation: Extract<AgentToolContractValidationResult, { status: 'invalid' }>) {
    super(validation.modelMessage);
    this.name = 'AgentToolContractValidationError';
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

export function validateAndRepairToolArgs(
  input: AgentToolContractValidationInput,
): AgentToolContractValidationResult {
  const schema = input.inputSchema;
  const issues: AgentToolContractIssue[] = [];
  const repairs: string[] = [];

  if (!schema || schema.type !== 'object') {
    return { status: 'valid', args: input.args, issues, repairs };
  }

  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
    return {
      status: 'invalid',
      args: input.args,
      issues: [{
        code: 'invalid_args',
        path: '$',
        message: `Tool "${input.toolName}" arguments must be a JSON object.`,
      }],
      repairs,
      modelMessage: buildSchemaRetryMessage(input.toolName, [{
        code: 'invalid_args',
        path: '$',
        message: `Tool "${input.toolName}" arguments must be a JSON object.`,
      }]),
    };
  }

  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, any>
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const allowAdditional = schema.additionalProperties !== false;
  const repairedArgs: Record<string, unknown> = { ...(input.args as Record<string, unknown>) };
  const propertyNames = Object.keys(properties);
  const lowRiskRepairAllowed = (input.effect ?? classifyToolEffect(input.toolName, input.args)) === 'read';

  for (const key of Object.keys(repairedArgs)) {
    if (properties[key]) continue;

    const aliasTarget = findAliasTarget({
      key,
      value: repairedArgs[key],
      properties,
      required,
      existingArgs: repairedArgs,
      allowExplicitAliasRepair: true,
      allowSemanticUrlRepair: lowRiskRepairAllowed,
    });

    if (aliasTarget) {
      repairedArgs[aliasTarget] = repairedArgs[key];
      delete repairedArgs[key];
      repairs.push(`${key}->${aliasTarget}`);
      continue;
    }

    if (!allowAdditional) {
      issues.push({
        code: 'unknown_property',
        path: `$.${key}`,
        message: `Unknown argument "${key}". Allowed arguments: ${propertyNames.join(', ') || '(none)'}.`,
      });
    }
  }

  const missingRequiredUrlTargetCount = required.filter((name: string) =>
    isMissingRequiredValue(repairedArgs[name], properties[name]) &&
    (name === 'url' || name.endsWith('_url') || name.endsWith('Url'))
  ).length;

  for (const name of required) {
    if (!isMissingRequiredValue(repairedArgs[name], properties[name])) continue;
    const aliasSource = findKnownAliasSource({
      target: name,
      properties,
      existingArgs: repairedArgs,
      allowExplicitAliasRepair: true,
      allowSemanticUrlRepair: lowRiskRepairAllowed && (
        !(name === 'url' || name.endsWith('_url') || name.endsWith('Url')) ||
        missingRequiredUrlTargetCount === 1
      ),
    });

    if (aliasSource) {
      repairedArgs[name] = repairedArgs[aliasSource];
      delete repairedArgs[aliasSource];
      repairs.push(`${aliasSource}->${name}`);
    }
  }

  for (const name of required) {
    if (isMissingRequiredValue(repairedArgs[name], properties[name])) {
      issues.push({
        code: 'missing_required',
        path: `$.${name}`,
        message: `Missing required argument "${name}".`,
      });
    }
  }

  for (const [name, propSchema] of Object.entries(properties)) {
    if (repairedArgs[name] === undefined || repairedArgs[name] === null) continue;
    const typeIssue = validateJsonSchemaType(name, repairedArgs[name], propSchema);
    if (typeIssue) issues.push(typeIssue);
    issues.push(...validateJsonSchemaConstraints(name, repairedArgs[name], propSchema));
  }

  if (issues.length > 0) {
    return {
      status: 'invalid',
      args: repairedArgs,
      issues,
      repairs,
      modelMessage: buildSchemaRetryMessage(input.toolName, issues),
    };
  }

  return {
    status: repairs.length > 0 ? 'repaired' : 'valid',
    args: repairedArgs,
    issues,
    repairs,
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

export function buildSchemaRetryMessage(toolName: string, issues: AgentToolContractIssue[]): string {
  const details = issues.map((issue) => issue.message).join(' ');
  return `Tool "${toolName}" arguments failed schema validation before execution. ${details} Retry the same tool with arguments that exactly match the tool schema.`;
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

function findAliasTarget(input: {
  key: string;
  value: unknown;
  properties: Record<string, any>;
  required: string[];
  existingArgs: Record<string, unknown>;
  allowExplicitAliasRepair: boolean;
  allowSemanticUrlRepair: boolean;
}): string | null {
  const propertyNames = Object.keys(input.properties);
  const normalizedKey = normalizeArgName(input.key);
  const normalizedMatch = propertyNames.find((name) => normalizeArgName(name) === normalizedKey);
  if (normalizedMatch && input.existingArgs[normalizedMatch] === undefined) {
    return normalizedMatch;
  }

  if (input.allowExplicitAliasRepair) {
    const explicitMatch = propertyNames.find((name) =>
      getSchemaAliases(input.properties[name]).some((alias) => normalizeArgName(alias) === normalizedKey)
    );
    if (explicitMatch && input.existingArgs[explicitMatch] === undefined) return explicitMatch;
  }

  if (!input.allowSemanticUrlRepair || typeof input.value !== 'string') return null;
  if (!looksLikeUrl(input.value)) return null;

  const urlLikeKeys = new Set(['url', 'link', 'href', 'uri']);
  if (!urlLikeKeys.has(normalizedKey)) return null;

  const missingRequiredUrlFields = input.required.filter((name) =>
    input.existingArgs[name] === undefined &&
    (name === 'url' || name.endsWith('_url') || name.endsWith('Url'))
  );

  if (missingRequiredUrlFields.length === 1) return missingRequiredUrlFields[0];
  return null;
}

function findKnownAliasSource(input: {
  target: string;
  properties: Record<string, any>;
  existingArgs: Record<string, unknown>;
  allowExplicitAliasRepair: boolean;
  allowSemanticUrlRepair: boolean;
}): string | null {
  const targetNormalized = normalizeArgName(input.target);
  for (const key of Object.keys(input.existingArgs)) {
    if (key === input.target) continue;
    if (!input.properties[key]) continue;
    if (normalizeArgName(key) === targetNormalized) return key;
  }

  if (input.allowExplicitAliasRepair) {
    const targetAliases = getSchemaAliases(input.properties[input.target]).map(normalizeArgName);
    for (const key of Object.keys(input.existingArgs)) {
      if (key === input.target) continue;
      if (targetAliases.includes(normalizeArgName(key))) return key;
    }
  }

  if (!input.allowSemanticUrlRepair) return null;
  if (!(input.target === 'url' || input.target.endsWith('_url') || input.target.endsWith('Url'))) return null;

  const urlLikeKeys = new Set(['url', 'link', 'href', 'uri']);
  for (const key of Object.keys(input.existingArgs)) {
    if (!urlLikeKeys.has(normalizeArgName(key))) continue;
    const value = input.existingArgs[key];
    if (typeof value === 'string' && looksLikeUrl(value)) return key;
  }

  return null;
}

function validateJsonSchemaType(name: string, value: unknown, schema: any): AgentToolContractIssue | null {
  const expected = schema?.type;
  if (!expected) return null;
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  const valid = expectedTypes.some((type) => {
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (type === 'null') return value === null;
    return true;
  });

  if (valid) return null;
  return {
    code: 'type_mismatch',
    path: `$.${name}`,
    message: `Argument "${name}" has the wrong type. Expected ${expectedTypes.join(' or ')}.`,
  };
}

function validateJsonSchemaConstraints(name: string, value: unknown, schema: any): AgentToolContractIssue[] {
  const issues: AgentToolContractIssue[] = [];

  if (Array.isArray(value)) {
    if (typeof schema?.minItems === 'number' && value.length < schema.minItems) {
      issues.push({
        code: 'invalid_args',
        path: `$.${name}`,
        message: `Argument "${name}" must contain at least ${schema.minItems} item(s).`,
      });
    }

    if (schema?.items) {
      value.forEach((item, index) => {
        const typeIssue = validateJsonSchemaType(`${name}[${index}]`, item, schema.items);
        if (typeIssue) issues.push(typeIssue);
      });
    }
  }

  return issues;
}

function isMissingRequiredValue(value: unknown, schema: any): boolean {
  if (value === undefined) return true;
  if (value === null) return !schemaAllowsType(schema, 'null');
  return value === '';
}

function schemaAllowsType(schema: any, type: string): boolean {
  const expected = schema?.type;
  if (!expected) return false;
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  return expectedTypes.includes(type);
}

function getSchemaAliases(schema: any): string[] {
  const aliases = schema?.['x-aliases'] ?? schema?.aliases;
  return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [];
}

function normalizeArgName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}
