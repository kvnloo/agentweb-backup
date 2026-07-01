// .linear-autofix/linear.mjs — minimal Linear GraphQL client.
import { config } from './config.mjs';

const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { id name type }
  team { id key }
  labels { nodes { id name } }
  comments { nodes { id body createdAt user { name } } }
`;

async function gql(query, variables = {}) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY is not set');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Linear API error: ' + JSON.stringify(json.errors));
  return json.data;
}

// Accepts a human identifier ("LIN-123") or a raw issue UUID.
export async function resolveIssue(ref) {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(ref.trim());
  if (m) {
    const data = await gql(
      `query($tk:String!,$n:Float!){ issues(filter:{ team:{key:{eq:$tk}}, number:{eq:$n} }, first:1){ nodes{ ${ISSUE_FIELDS} } } }`,
      { tk: m[1].toUpperCase(), n: Number(m[2]) },
    );
    const node = data.issues.nodes[0];
    if (!node) throw new Error(`Issue ${ref} not found`);
    return node;
  }
  const data = await gql(`query($id:String!){ issue(id:$id){ ${ISSUE_FIELDS} } }`, { id: ref });
  if (!data.issue) throw new Error(`Issue ${ref} not found`);
  return data.issue;
}

// Issues with the bug label, in a not-yet-started state, optionally scoped to one team and
// to a set of assignees (unassigned bugs are never picked up when assigneeEmails is set).
export async function listNewBugs() {
  const filter = {
    labels: { name: { eq: config.bugLabel } },
    state: { type: { in: config.pickupStateTypes } },
  };
  if (config.teamKey) filter.team = { key: { eq: config.teamKey } };
  if (config.assigneeEmails?.length) filter.assignee = { email: { in: config.assigneeEmails } };
  const data = await gql(
    `query($filter: IssueFilter!){ issues(filter:$filter, first:50){ nodes{ ${ISSUE_FIELDS} } } }`,
    { filter },
  );
  return data.issues.nodes;
}

export async function addComment(issueId, body) {
  const data = await gql(
    `mutation($input: CommentCreateInput!){ commentCreate(input:$input){ success } }`,
    { input: { issueId, body } },
  );
  return data.commentCreate.success;
}

// Look up a workflow state id by name within a team; optionally fall back to the first
// state of a given type (e.g. 'started') if the named one doesn't exist.
export async function findStateId(teamId, name, fallbackType) {
  const data = await gql(`query($id:String!){ team(id:$id){ states{ nodes{ id name type } } } }`, { id: teamId });
  const states = data.team.states.nodes;
  let s = states.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!s && fallbackType) s = states.find((x) => x.type === fallbackType);
  return s ? s.id : null;
}

export async function moveIssue(issueId, stateId) {
  const data = await gql(
    `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`,
    { id: issueId, input: { stateId } },
  );
  return data.issueUpdate.success;
}

// Bug-labeled issues stranded in the pickup In-Progress state with no activity for `hours` —
// the signature of a crashed autofix run (a finished run always comments/moves/labels).
export async function listStaleInProgress(hours) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const filter = {
    labels: { name: { eq: config.bugLabel } },
    state: { name: { eqIgnoreCase: config.inProgressState } },
    updatedAt: { lt: cutoff },
  };
  if (config.teamKey) filter.team = { key: { eq: config.teamKey } };
  const data = await gql(
    `query($filter: IssueFilter!){ issues(filter:$filter, first:50){ nodes{ ${ISSUE_FIELDS} } } }`,
    { filter },
  );
  return data.issues.nodes;
}

const AUTOFIX_LABEL_COLORS = {
  'autofix:green': '#1F883D',
  'autofix:needs-manual-test': '#B08800',
  'autofix:needs-rework': '#CF222E',
  'autofix:cannot-fix': '#57606A',
};

// Replace any previous autofix:* label on the issue with `name` (find-or-create, team-scoped;
// an existing workspace-level label with the same name is reused).
export async function setAutofixLabel(issue, name) {
  if (!name) return;
  const teamId = issue.team.id;
  const found = await gql(
    `query($name:String!){ issueLabels(filter:{ name:{ eqIgnoreCase:$name } }, first:10){ nodes{ id name team{ id } } } }`,
    { name },
  );
  let label = (found.issueLabels?.nodes || []).find((l) => !l.team || l.team.id === teamId);
  if (!label) {
    const created = await gql(
      `mutation($input: IssueLabelCreateInput!){ issueLabelCreate(input:$input){ issueLabel{ id name } } }`,
      { input: { name, teamId, color: AUTOFIX_LABEL_COLORS[name] || '#57606A' } },
    );
    label = created.issueLabelCreate.issueLabel;
  }
  const keep = (issue.labels?.nodes || [])
    .filter((l) => l.id && !l.name.toLowerCase().startsWith('autofix:'))
    .map((l) => l.id);
  await gql(
    `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`,
    { id: issue.id, input: { labelIds: [...keep, label.id] } },
  );
}
