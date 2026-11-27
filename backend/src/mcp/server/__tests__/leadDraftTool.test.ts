/**
 * ENG-2840 (W2-10): the MCP tool `update_email_draft_for_lead` (leadDraftTool.ts). What it sends to its route, what is refused before
 * anything is called, the fixed-field answer, error handling and the per-caller guard. No network: the self-call is a double; the route
 * has its own tests (src/__tests__/emmaLeadDraftRoutes.test.ts).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { LEAD_DRAFT_GUARD, LEAD_DRAFT_TIMEOUT_MS } from '../leadDraftTool';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true, authMethod: 'api_key' });
const call = (args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool('update_email_draft_for_lead') as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const VALID = { list_id: 'list-1', lead_id: 'lead-1', instruction: 'Follow up on their demo request' };

beforeEach(() => {
  mockFetch.mockReset();
  LEAD_DRAFT_GUARD.reset();
});

it('is registered for user accounts, not read-only, and says it overwrites, spends and sends nothing', () => {
  const tool = mcpToolRegistry.getTool('update_email_draft_for_lead') as any;
  expect(tool.requiresUserAccount).toBe(true);
  expect(tool.readOnly).toBeUndefined();
  expect(tool.definition.description).toMatch(/replacing the draft it had/);
  expect(tool.definition.description).toMatch(/Sends nothing/);
  expect(tool.definition.description).toMatch(/up to four model calls/);
  expect(tool.definition.description).toMatch(/Any other argument is refused by name/);
});

it('sends the checked arguments to its route as the caller, with its wait', async () => {
  mockFetch.mockResolvedValue({ success: true, email: { subject: 'Hi', format: 'text', text: 'Body' }, linkedin_note: null });
  const r = await call({ ...VALID, email_format: 'text' });
  expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({
    method: 'POST',
    path: '/api/emma/lead-email-draft',
    body: { ...VALID, email_format: 'text' },
    timeoutMs: LEAD_DRAFT_TIMEOUT_MS,
  }));
  expect(parse(r)).toStrictEqual({ saved: true, email: { subject: 'Hi', format: 'text', text: 'Body' }, linkedin_note: null });
});

it.each([
  [{ ...VALID, userId: 'victim' }, /is not an input/],
  [{ ...VALID, session_id: 's' }, /is not an input/],
  [{ list_id: 'list-1', lead_id: 'lead-1' }, /instruction is required/],
  [{ ...VALID, email_format: 'pdf' }, /email_format/],
  [undefined, /list_id is required/],
])('refuses %j before calling anything', async (args, message) => {
  await expect(call(args)).rejects.toThrow(message);
  await expect(call(args)).rejects.toThrow(/Nothing was changed/);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('reports a skipped run as not saved', async () => {
  mockFetch.mockResolvedValue({ success: true, email: null, linkedin_note: null, skipped: true, reason: 'nothing_generated' });
  expect(parse(await call(VALID))).toStrictEqual({ saved: false, email: null, linkedin_note: null, skipped: true, reason: 'nothing_generated' });
});

it('turns a route refusal into an error with the route\'s words', async () => {
  mockFetch.mockResolvedValue({ success: false, message: 'This lead is marked do-not-contact, so no draft is written.' });
  await expect(call(VALID)).rejects.toThrow('update_email_draft_for_lead: This lead is marked do-not-contact, so no draft is written.');
});

it('passes a 4xx through, and says a 5xx or no answer may or may not have saved', async () => {
  mockFetch.mockRejectedValueOnce(new Error('API error (404): Lead list not found'));
  await expect(call(VALID)).rejects.toThrow('API error (404): Lead list not found');
  mockFetch.mockRejectedValueOnce(new Error('API error (502): upstream'));
  await expect(call(VALID)).rejects.toThrow(/HTTP 502\). The draft may or may not have been saved/);
  mockFetch.mockRejectedValueOnce(new Error('socket hang up'));
  await expect(call(VALID)).rejects.toThrow(/could not be reached .* may or may not have been saved/);
});

it('allows one call at a time per caller', async () => {
  let release: (v: unknown) => void = () => undefined;
  mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = call(VALID, 'user-9');
  await expect(call(VALID, 'user-9')).rejects.toThrow(/another call of yours to this tool is still running/);
  release({ success: true, email: null, linkedin_note: null });
  await first;
});
