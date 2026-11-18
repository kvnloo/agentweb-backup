/**
 * ENG-2816 (step 3): a schedule's provenance is not model-writable, and lifting it is not reachable from any tool.
 *
 * The same shape of guard as schedulePublishApproval.mcpGuard.test.ts, and for the same reason: `manage_scheduled_chat` and its
 * siblings are MCP tools the MODEL calls, and they reach the schedule routes over a self-call. If a tool body could write
 * provenance, a visitor (or the model on its behalf) could clear its own mark; if a tool could call the adopt route, a visitor could
 * adopt what it wrote. Only a person in the portal may. The route refuses self-calls; this keeps the tools from ever being the ones
 * asking, and fails loudly if anyone adds the field or the route to the MCP surface, however it is spelled.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({}));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

const MCP_DIR = path.join(__dirname, '..', 'mcp', 'server');
const EMMA_TOOLS = path.join(__dirname, '..', 'emma', 'tools.ts');

/**
 * Every spelling the schedule field, its helpers, the route or an "adopt" flag could take on a tool surface. (The bare word
 * "provenance" is not scanned for: apiTools.ts uses it, unrelated, for chat-transcript model attribution.)
 */
const FORBIDDEN = [/provenanceAdd/, /provenanceRemove/, /scheduleProvenance/i, /adopt[-_ ]?visitor/i, /visitor[-_ ]?edits/i];

describe('the MCP surface never exposes schedule provenance or the adopt route (ENG-2816 step 3)', () => {
  const files = fs.readdirSync(MCP_DIR).filter((name) => name.endsWith('.ts')).map((name) => path.join(MCP_DIR, name)).concat(EMMA_TOOLS);

  it('reads real files (guards against a silently moved directory making the scan vacuous)', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(fs.readFileSync(path.join(MCP_DIR, 'apiTools.ts'), 'utf8')).toContain('manage_scheduled_chat');
  });

  it.each(FORBIDDEN.map((pattern) => [String(pattern), pattern] as const))('no MCP tool source mentions %s', (_label, pattern) => {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect({ file: path.basename(file), mentions: pattern.test(source) }).toEqual({ file: path.basename(file), mentions: false });
    }
  });

  it('manage_scheduled_chat never forwards a provenance or adopt argument into the request body, however it is spelled', async () => {
    const context = { userId: 'owner-1', agentUserId: 'owner-1' };
    mockMcpFetch.mockResolvedValue({ ok: true });
    const smuggled = {
      provenance: [], provenanceRemove: ['startingMessage'], provenanceAdd: [], adopt_visitor_edits: true, adoptVisitorEdits: true, adopt: true,
    };

    await mcpToolRegistry.getTool('manage_scheduled_chat')!.execute(
      { action: 'update', schedule_id: 's1', starting_message: 'new prompt', ...smuggled }, context);
    await mcpToolRegistry.getTool('manage_scheduled_chat')!.execute(
      { action: 'create', schedule_name: 'n', starting_message: 'm', schedule_frequency: 'daily', ...smuggled }, context);

    expect(mockMcpFetch).toHaveBeenCalledTimes(2);
    for (const call of mockMcpFetch.mock.calls) {
      const sent = JSON.stringify(call[0]);
      for (const pattern of FORBIDDEN) expect(sent).not.toMatch(pattern);
      // The body's own keys: none of the smuggled names, however spelled, and the bare field is not one of them either.
      const keys = Object.keys((call[0] as any).body);
      for (const smuggledKey of ['provenance', 'provenanceAdd', 'provenanceRemove', 'adopt_visitor_edits', 'adoptVisitorEdits', 'adopt']) {
        expect(keys).not.toContain(smuggledKey);
      }
    }
  });

  it('no MCP tool ever calls the adopt route', async () => {
    const context = { userId: 'owner-1', agentUserId: 'owner-1' };
    mockMcpFetch.mockClear();
    mockMcpFetch.mockResolvedValue({ ok: true });
    for (const name of ['manage_scheduled_chat', 'test_scheduled_chat', 'submit_scheduled_chat_variables', 'manage_schedule_template', 'create_schedule_from_template']) {
      const tool = mcpToolRegistry.getTool(name)!;
      for (const action of ['create', 'update', 'toggle', 'delete']) {
        await tool.execute({ action, schedule_id: 's1', template_id: 't1', schedule_name: 'n', starting_message: 'm', schedule_frequency: 'daily', name: 'n', variable_values: {} }, context).catch(() => undefined);
      }
    }
    for (const call of mockMcpFetch.mock.calls) {
      expect(String((call[0] as any).path)).not.toMatch(/adopt/i);
    }
  });
});
