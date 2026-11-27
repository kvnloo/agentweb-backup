/**
 * ENG-2840 (W2-7): `status_note` goes only with manage_leads "update". On any other action it is refused before anything is called, so an
 * agent never believes a note was kept when it was dropped.
 */
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockFetch = mcpFetch as jest.Mock;
const context = { userId: 'user-1', agentUserId: 'user-1', externalMcp: true };
const call = (args: unknown) => (mcpToolRegistry.getTool('manage_leads') as any).execute(args, context);

beforeEach(() => mockFetch.mockReset());

it.each([
  ['add', { leads: [{ email: 'a@example.com' }] }],
  ['list', {}],
  ['get', { lead_id: 'lead-1' }],
  ['delete', { lead_ids: ['lead-1'] }],
])('%s with status_note is refused, nothing called', async (action, extra) => {
  await expect(call({ action, list_id: 'list-1', status_note: 'why', ...extra })).rejects.toThrow(new RegExp(`manage_leads ${action}: status_note goes only with action "update"`));
  expect(mockFetch).not.toHaveBeenCalled();
});

it('an admin cross-account add with status_note is refused too (before its own early path)', async () => {
  await expect(call({ action: 'add', list_id: 'list-1', client_id: 'client@example.com', status_note: 'why', leads: [{ email: 'a@example.com' }] })).rejects.toThrow(/status_note goes only with action "update"/);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('a null status_note on another action is ignored as before', async () => {
  mockFetch.mockResolvedValueOnce({ leads: [], total: 0 });
  await expect(call({ action: 'list', list_id: 'list-1', status_note: null })).resolves.toBeDefined();
});
