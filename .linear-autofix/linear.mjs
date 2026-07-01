// .linear-autofix/linear.mjs — minimal Linear GraphQL client.
import { config } from './config.mjs';

const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `
  id identifier title description url
  state { id name type }
  team { id key }
  labels { nodes { name } }
  comments { nodes { body user { name } } }
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

// Issues with the bug label, in a not-yet-started state, optionally scoped to one team.
export async function listNewBugs() {
  const filter = {
    labels: { name: { eq: config.bugLabel } },
    state: { type: { in: config.pickupStateTypes } },
  };
  if (config.teamKey) filter.team = { key: { eq: config.teamKey } };
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
