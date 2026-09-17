import { pickGmailToolForAction } from '../emailBridge';

describe('reviewed Gmail contracts', () => {
  it.each(['send', 'reply', 'delete', 'search', 'list', 'get'])(
    'refuses %s when no vendor identity/schema has been reviewed', (action) => {
      expect(pickGmailToolForAction([
        { name: 'google_gmail_search_messages' },
        { name: 'google_gmail_list_messages' },
        { name: 'google_gmail_get_message' },
        { name: 'google_gmail_send_message' },
      ], action as any)).toBeNull();
    });
  it('refuses a destructive tool disguised as a read', () => {
    expect(pickGmailToolForAction([{ name: 'gmail_search_and_delete_all' }], 'search')).toBeNull();
  });
  it('refuses empty discovery', () => {
    expect(pickGmailToolForAction([], 'search')).toBeNull();
  });
});


describe('exact contract pinning with a reviewed fixture', () => {
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  const fixture = { name: 'fixture_reviewed_search', inputSchema: schema };
  const contracts = { search: { ...fixture, mapArgs: () => ({ query: 'fixture' }) } };
  it('accepts only the exact identity and schema', () => {
    expect(pickGmailToolForAction([fixture], 'search', contracts)).toBe(fixture);
  });
  it.each([
    [{ ...fixture, name: 'fixture_reviewed_search_and_delete' }],
    [{ name: fixture.name }],
    [{ ...fixture, inputSchema: { ...schema, additionalProperties: true } }],
    [{ ...fixture, inputSchema: { ...schema, required: ['query', 'send'] } }],
    [fixture, fixture],
  ])('fails closed for incompatible or ambiguous descriptors %#', (...tools) => {
    expect(pickGmailToolForAction(tools as any, 'search', contracts)).toBeNull();
  });
});
