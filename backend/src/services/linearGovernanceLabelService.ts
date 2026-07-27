import { getLinearCredentials } from './linearService';

const LINEAR_API = 'https://api.linear.app/graphql';
const TEAM_KEY = 'ENG';
const MAX_DESCRIPTION_LENGTH = 1_000;

const GOVERNANCE_LABELS = new Set([
  'Route: Claude',
  'Route: Emma',
  'Requires: Me',
  'Needs PM',
  'Ready: Argusoft',
  'Auto',
  'Noise',
  'Blocked',
]);

export interface GovernanceLabel {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

export interface GovernanceLabelAudit {
  actor: string;
  action: 'planned' | 'verified';
  before: GovernanceLabel;
  after: GovernanceLabel;
  reason: string;
  timestamp: string;
  dryRun: boolean;
  verified: boolean;
}

export interface ManageGovernanceLabelInput {
  labelName: string;
  name?: string;
  description?: string;
  color?: string;
  reason: string;
  actor: string;
  dryRun?: boolean;
}

type Graphql = (query: string, variables?: Record<string, unknown>) => Promise<any>;
type AuditWriter = (event: GovernanceLabelAudit) => Promise<void>;

async function graphql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const { apiKey } = await getLinearCredentials();
  const response = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(body?.errors || response.status)}`);
  }
  return body.data;
}

async function structuredAudit(event: GovernanceLabelAudit): Promise<void> {
  console.info('[linear-governance-label-audit]', JSON.stringify(event));
}

function validate(input: ManageGovernanceLabelInput): void {
  if (!GOVERNANCE_LABELS.has(input.labelName)) {
    throw new Error(`Label "${input.labelName}" is not an allowlisted governance label`);
  }
  if (!input.reason?.trim()) throw new Error('A mutation/readback reason is required');
  if (input.name !== undefined && !GOVERNANCE_LABELS.has(input.name)) {
    throw new Error(`New label name "${input.name}" is not an allowlisted governance label`);
  }
  if (input.description !== undefined && input.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Label description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color)) {
    throw new Error('Label color must be a six-digit hex value');
  }
}

export async function manageLinearGovernanceLabel(
  input: ManageGovernanceLabelInput,
  dependencies: { graphql?: Graphql; audit?: AuditWriter; now?: () => string } = {},
): Promise<{ before: GovernanceLabel; after: GovernanceLabel; dryRun: boolean; changed: boolean; verified: boolean }> {
  validate(input);
  const query = dependencies.graphql || graphql;
  const audit = dependencies.audit || structuredAudit;
  const now = dependencies.now || (() => new Date().toISOString());
  const data = await query(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes { labels(first: 250) { nodes { id name description color } pageInfo { hasNextPage } } }
      }
    }`,
    { key: TEAM_KEY },
  );
  const labels: GovernanceLabel[] = data?.teams?.nodes?.[0]?.labels?.nodes || [];
  if (data?.teams?.nodes?.[0]?.labels?.pageInfo?.hasNextPage) {
    throw new Error('Linear governance label catalog is truncated');
  }
  const before = labels.find(label => label.name === input.labelName);
  if (!before) throw new Error(`Linear governance label "${input.labelName}" was not found`);
  const after: GovernanceLabel = {
    ...before,
    name: input.name ?? before.name,
    description: input.description ?? before.description,
    color: input.color ?? before.color,
  };
  if (after.name !== before.name && labels.some(
    label => label.id !== before.id && label.name.toLowerCase() === after.name.toLowerCase(),
  )) {
    throw new Error(`Linear label "${after.name}" already exists`);
  }
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const dryRun = input.dryRun === true;
  const planned: GovernanceLabelAudit = {
    actor: input.actor,
    action: 'planned',
    before,
    after,
    reason: input.reason.trim(),
    timestamp: now(),
    dryRun,
    verified: !changed || dryRun,
  };
  await audit(planned);
  if (changed && !dryRun) {
    const updated = await query(
      `mutation($id: String!, $input: IssueLabelUpdateInput!) {
        issueLabelUpdate(id: $id, input: $input) { success }
      }`,
      {
        id: before.id,
        input: {
          ...(after.name !== before.name ? { name: after.name } : {}),
          ...(after.description !== before.description ? { description: after.description } : {}),
          ...(after.color !== before.color ? { color: after.color } : {}),
        },
      },
    );
    if (updated?.issueLabelUpdate?.success !== true) throw new Error('Linear governance label update failed');
  }
  const readback = dryRun || !changed
    ? after
    : (await query(
      `query($id: String!) { issueLabel(id: $id) { id name description color } }`,
      { id: before.id },
    ))?.issueLabel;
  const verified = JSON.stringify(readback) === JSON.stringify(after);
  if (!verified) throw new Error('Linear governance label readback did not match the requested definition');
  await audit({ ...planned, action: 'verified', timestamp: now(), verified: true });
  return { before, after: readback, dryRun, changed, verified };
}
