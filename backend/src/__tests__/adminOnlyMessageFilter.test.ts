import { filterMessagesForClient, redactAdminActivity } from '../utils/adminOnlyMessageFilter';

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


describe('redactAdminActivity — ENG-2163 scoped redaction for raw serve paths (chatbot / summary)', () => {
  // Unlike filterMessagesForClient, this must NOT strip normal tool/assistant messages — only
  // admin content — so it can be applied to endpoints that historically return raw messages.
  const ADMIN = ['get_pr_digest', 'read_linear_issues', 'manage_user_notes'];
  const convo = () => [
    { role: 'user', content: 'pull my leads' },
    { role: 'tool', name: 'search_leads', content: '{normal tool result}' },
    { role: 'assistant', content: 'Here are your leads.' },
    { role: 'user', content: 'check infra' },
    { role: 'tool', name: 'get_pr_digest', content: '{internal 203 PRs}' },
    { role: 'assistant', content: 'I reviewed 203 internal PRs; roadmap...' },
  ];

  it('CUSTOMER: drops the admin tool RESULT and the admin narration, keeps normal tool + assistant', () => {
    const out = redactAdminActivity(convo(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    const kinds = out.map((m: any) => m.role + ':' + (m.name || m.content?.slice(0, 12)));
    expect(out.some((m: any) => m.role === 'tool' && m.name === 'get_pr_digest')).toBe(false); // admin tool result gone
    expect(out.some((m: any) => m.role === 'tool' && m.name === 'search_leads')).toBe(true);     // normal tool result KEPT (no base strip)
    expect(out.some((m: any) => m.content === 'I reviewed 203 internal PRs; roadmap...')).toBe(false); // narration gone
    expect(out.some((m: any) => m.content === 'Here are your leads.')).toBe(true);               // safe assistant kept
  });

  it('ADMIN: no-op, returns input unchanged', () => {
    const input = convo();
    const out = redactAdminActivity(input, { viewerIsAdmin: true, adminToolNames: ADMIN });
    expect(out).toBe(input);
  });

  it('no admin tools present: returns input unchanged (no accidental stripping)', () => {
    const input = [
      { role: 'user', content: 'hi' },
      { role: 'tool', name: 'search_leads', content: '{}' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = redactAdminActivity(input, { viewerIsAdmin: false, adminToolNames: ADMIN });
    // Contents unchanged (a filtered copy is fine here; reference identity is only guaranteed
    // for the admin-viewer and empty-tool-set early returns, covered by the other cases).
    expect(out).toEqual(input);
  });

  it('empty admin-tool set (mocked module): no redaction', () => {
    const input = convo();
    expect(redactAdminActivity(input, { viewerIsAdmin: false, adminToolNames: [] })).toBe(input);
  });
});


describe('ENG-2163 re-review: CHATBOT persisted shape (admin activity in assistant.metadata.toolCalls, NO tool-role message)', () => {
  // The Emma chatbot persists ONLY the final assistant message; admin tool name+result live in
  // metadata.toolCalls, and there is NO role:'tool' message. The first fix keyed only off
  // tool-role messages, so it was a no-op here (the real leak). These fixtures use that shape.
  const ADMIN = ['get_pr_digest', 'read_linear_issues', 'manage_user_notes'];
  const chatbotConvo = () => [
    { role: 'user', content: 'pull my leads' },
    { role: 'assistant', content: 'Here are your leads.', metadata: { toolCalls: [{ id: 'a', name: 'search_leads', result: { ok: true } }] } },
    { role: 'user', content: 'check infra' },
    { role: 'assistant', content: 'I reviewed 203 internal PRs; roadmap...', metadata: { toolCalls: [{ id: 'b', name: 'get_pr_digest', result: { totalPRs: 203, internal: 'secret' } }] } },
  ];

  it('redactAdminActivity CUSTOMER: drops the assistant carrying admin metadata.toolCalls + its narration', () => {
    const out = redactAdminActivity(chatbotConvo(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    const assistantContents = out.filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
    expect(assistantContents).toContain('Here are your leads.');                       // safe turn kept
    expect(assistantContents).not.toContain('I reviewed 203 internal PRs; roadmap...'); // admin narration gone
    // and the raw admin result is not present anywhere in the output
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('get_pr_digest');
  });

  it('redactAdminActivity ADMIN: keeps it', () => {
    const out = redactAdminActivity(chatbotConvo(), { viewerIsAdmin: true, adminToolNames: ADMIN });
    expect(JSON.stringify(out)).toContain('get_pr_digest');
  });

  it('filterMessagesForClient CUSTOMER (agent-mode filter also honors the metadata.toolCalls taint)', () => {
    const out = filterMessagesForClient(chatbotConvo(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    const assistantContents = out.filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
    expect(assistantContents).not.toContain('I reviewed 203 internal PRs; roadmap...');
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});


describe('ENG-2163 F1 (final review): the admin user-prompt in a tainted turn is also redacted', () => {
  const ADMIN = ['get_pr_digest', 'read_linear_issues', 'manage_user_notes'];
  // Delegated flow: the admin's typed prompt persists as role:'user' in the customer's session.
  const convo = () => [
    { role: 'user', content: 'pull my leads' },
    { role: 'assistant', content: 'Here are your leads.' },
    { role: 'user', content: 'run get_pr_digest and read_linear_issues for this internal audit' },
    { role: 'assistant', content: 'Done.', metadata: { toolCalls: [{ id: 'b', name: 'get_pr_digest', result: { s: 1 } }] } },
  ];
  const ADMIN_PROMPT = 'run get_pr_digest and read_linear_issues for this internal audit';

  it('redactAdminActivity CUSTOMER: drops the admin user prompt + narration; keeps the safe turn', () => {
    const out = redactAdminActivity(convo(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    const text = JSON.stringify(out);
    expect(text).not.toContain(ADMIN_PROMPT);      // admin request text gone
    expect(text).not.toContain('get_pr_digest');   // admin activity gone
    expect(text).toContain('pull my leads');        // safe user turn kept
    expect(text).toContain('Here are your leads.');
  });

  it('filterMessagesForClient CUSTOMER: same — admin user prompt dropped', () => {
    const out = filterMessagesForClient(convo(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    expect(JSON.stringify(out)).not.toContain(ADMIN_PROMPT);
  });

  it('ADMIN viewer: admin prompt retained (both functions)', () => {
    expect(JSON.stringify(redactAdminActivity(convo(), { viewerIsAdmin: true, adminToolNames: ADMIN }))).toContain(ADMIN_PROMPT);
    expect(JSON.stringify(filterMessagesForClient(convo(), { viewerIsAdmin: true, adminToolNames: ADMIN }))).toContain(ADMIN_PROMPT);
  });

  it('non-admin turn user prompts are NOT dropped (no over-hiding)', () => {
    const out = redactAdminActivity(convo(), { viewerIsAdmin: false, adminToolNames: ADMIN });
    expect(JSON.stringify(out)).toContain('pull my leads');
  });
});

describe('ENG-112 omitBranchOrigin', () => {
  const rows = () => [
    { role: 'system', content: 'SYS', metadata: { timestamp: 't', systemPromptVersion: 'v1', branchOrigin: { sourceSessionId: 'src', sourceTitle: 'Secret title', sourceMessageIndex: 4, branchedAt: 'x' } } },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo', metadata: { timestamp: 't' } },
  ];
  it('keeps branchOrigin by default (the owner view)', () => {
    expect(filterMessagesForClient(rows())[0].metadata.branchOrigin.sourceSessionId).toBe('src');
  });
  it('drops ONLY the branchOrigin key for a non-owner viewer, without mutating the input', () => {
    const input = rows();
    const out = filterMessagesForClient(input, { omitBranchOrigin: true });
    expect(out[0].metadata).toEqual({ timestamp: 't', systemPromptVersion: 'v1' });
    expect(JSON.stringify(out)).not.toContain('Secret title');
    expect(out).toHaveLength(3);
    expect((input[0].metadata as any).branchOrigin.sourceSessionId).toBe('src');
  });
});

describe('ENG-113 saved Compare alternatives are owner-only', () => {
  const alts = [{ model: 'm2', name: 'M2', provider: 'p', content: 'SECRET-UNCHOSEN', latencyMs: 1 }];
  const rows = () => [
    { role: 'system', content: 'SYS', metadata: { timestamp: 't' } },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'chosen', llm: 'm1', metadata: { timestamp: 't', compareId: 'c1', compareAlternatives: alts } },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'chosen2', llm: 'm1', metadata: { timestamp: 't', compareId: 'c2', compareAlternativesOmitted: 'size' } },
  ];
  it('the owner view (default) keeps them', () => {
    expect(filterMessagesForClient(rows())[2].metadata.compareAlternatives).toEqual(alts);
  });
  it('a non-owner view drops compareAlternatives (and only it), without mutating the input', () => {
    const input = rows();
    const out = filterMessagesForClient(input, { omitBranchOrigin: true });
    expect(out[2].metadata).toEqual({ timestamp: 't', compareId: 'c1' });
    expect(out[4].metadata).toEqual({ timestamp: 't', compareId: 'c2', compareAlternativesOmitted: 'size' });
    expect(JSON.stringify(out)).not.toContain('SECRET-UNCHOSEN');
    expect(out.map((m: any) => m.content)).toEqual(['SYS', 'hi', 'chosen', 'again', 'chosen2']);
    expect((input[2].metadata as any).compareAlternatives).toEqual(alts);
  });
  it('an admin viewer flag does not leak them to a non-owner view', () => {
    const out = filterMessagesForClient(rows(), { omitBranchOrigin: true, viewerIsAdmin: true });
    expect(JSON.stringify(out)).not.toContain('SECRET-UNCHOSEN');
  });
});
