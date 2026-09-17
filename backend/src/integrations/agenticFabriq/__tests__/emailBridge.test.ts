import { pickGmailToolForAction } from '../emailBridge';

describe('reviewed Gmail contracts', () => {
  const listMessagesSchema = {
    type: 'object',
    properties: {
      max_results: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Maximum number of messages to return (1-100)' },
      connection_id: { type: 'string', description: 'Specific Gmail connection to use (optional)' },
    },
    additionalProperties: false,
  };
  const readMessageSchema = {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: "REQUIRED: The actual message ID from google_gmail_list_messages (e.g., '18d4f2e3a7b9c0d1'). Do NOT use '1' or other placeholders." },
      connection_id: { type: 'string', description: 'Specific Gmail connection to use (optional)' },
    },
    required: ['message_id'],
    additionalProperties: false,
  };
  const listThreadsSchema = {
    type: 'object',
    properties: {
      q: { type: 'string', description: "Gmail search query (e.g., 'is:unread', 'from:user@example.com')" },
      max_results: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Maximum number of threads to return (1-500)' },
      include_spam_trash: { type: 'boolean', description: 'Include threads from SPAM and TRASH (default: false)' },
      connection_id: { type: 'string', description: 'Specific Gmail connection to use (optional)' },
    },
    additionalProperties: false,
  };

  it.each([
    ['search', { name: 'google_gmail_list_threads', inputSchema: listThreadsSchema }],
    ['list', { name: 'google_gmail_list_messages', inputSchema: listMessagesSchema }],
    ['get', { name: 'google_gmail_read_message', inputSchema: readMessageSchema }],
  ])('accepts the exact live read-only %s contract', (action, descriptor) => {
    expect(pickGmailToolForAction([descriptor], action as any)).toBe(descriptor);
  });

  it.each(['send', 'reply', 'delete'])(
    'refuses unreviewed or write action %s', (action) => {
      expect(pickGmailToolForAction([{ name: 'google_gmail_send_message' }], action as any)).toBeNull();
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
