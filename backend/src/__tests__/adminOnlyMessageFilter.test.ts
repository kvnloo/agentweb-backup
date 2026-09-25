import { filterMessagesForClient } from '../utils/adminOnlyMessageFilter';

/**
 * ENG-2163. Admin/support tools run in a session delegated into a customer's account leak
 * internal AgentWeb data (PR digests, Linear issues, internal notes) into the customer's own
 * view via the assistant's NARRATION of those tools. Modeled on prod session
 * e278986c-… (get_pr_digest / read_linear_issues / manage_user_notes in a customer account).
 */
const ADMIN = ['get_pr_digest', 'read_linear_issues', 'manage_user_notes'];

// A customer turn (safe) followed by an admin-tainted turn.
const CONVO = () => [
  { role: 'user', content: 'pull my leads' },
  { role: 'assistant', content: 'Here are your leads.', metadata: { toolCalls: [{ name: 'search_leads' }] } },
  { role: 'user', content: 'now check infra' },
  // admin-tool call + result + narration, all in this second turn
  { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'get_pr_digest' } }] },
  { role: 'tool', name: 'get_pr_digest', tool_call_id: 't1', content: '{"totalPRs":203,...internal...}' },
  { role: 'assistant', content: 'I reviewed 203 internal PRs; here is the internal roadmap summary…' },
];

describe('filterMessagesForClient — ENG-2163 admin-tainted turn redaction', () => {
  it('CUSTOMER view: drops the admin-tool result AND the assistant narration of that turn', () => {
    const out = filterMessagesForClient(CONVO(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    const texts = out.filter(m => m.role === 'assistant').map(m => m.content);
    expect(texts).toContain('Here are your leads.');                    // safe turn kept
    expect(texts).not.toContain('I reviewed 203 internal PRs; here is the internal roadmap summary…'); // leaked narration gone
    expect(out.some(m => m.role === 'tool')).toBe(false);               // tool results gone (all viewers)
  });

  it('ADMIN view: keeps the assistant narration of the admin turn', () => {
    const out = filterMessagesForClient(CONVO(), { viewerIsAdmin: true, adminToolNames: ADMIN });
    const texts = out.filter(m => m.role === 'assistant').map(m => m.content);
    expect(texts).toContain('I reviewed 203 internal PRs; here is the internal roadmap summary…');
    expect(out.some(m => m.role === 'tool')).toBe(false);               // tool results still stripped for admins too (unchanged base behavior)
  });

  it('fails CLOSED: default (no viewerIsAdmin) hides admin narration', () => {
    const out = filterMessagesForClient(CONVO(), { adminToolNames: ADMIN });
    const texts = out.filter(m => m.role === 'assistant').map(m => m.content);
    expect(texts).not.toContain('I reviewed 203 internal PRs; here is the internal roadmap summary…');
  });

  it('a normal (no admin tool) session is unchanged for a customer', () => {
    const convo = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'assistant', content: 'draft ready', metadata: { toolCalls: [{ name: 'add_leads_to_list' }] } },
    ];
    const out = filterMessagesForClient(convo, { viewerIsAdmin: false, adminToolNames: ADMIN });
    expect(out.map(m => m.content)).toEqual(['hi', 'hello', 'draft ready']);
  });

  it('does not taint a later clean turn that follows an admin turn', () => {
    const convo = [
      { role: 'user', content: 'check infra' },
      { role: 'tool', name: 'get_pr_digest', tool_call_id: 't1', content: 'internal' },
      { role: 'assistant', content: 'internal summary' },
      { role: 'user', content: 'write my ad copy' },
      { role: 'assistant', content: 'here is your ad copy' },
    ];
    const out = filterMessagesForClient(convo, { viewerIsAdmin: false, adminToolNames: ADMIN });
    const texts = out.filter(m => m.role === 'assistant').map(m => m.content);
    expect(texts).toContain('here is your ad copy');       // clean later turn kept
    expect(texts).not.toContain('internal summary');       // admin turn dropped
  });

  it('empty admin-tool set (e.g. mocked module) = pure base behavior, no tainting', () => {
    const out = filterMessagesForClient(CONVO(), { viewerIsAdmin: false, adminToolNames: [] });
    const texts = out.filter(m => m.role === 'assistant').map(m => m.content);
    expect(texts).toContain('I reviewed 203 internal PRs; here is the internal roadmap summary…');
  });
});
