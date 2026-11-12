import {
  validateScheduledAction,
  ScheduledActionToolRegistry,
  ScheduledActionToolInfo,
} from '../mcp/scheduledActionContract';
import { AGENT_EXECUTION_TOOLS } from '../mcp/server/agentExecutionTools';

const tools: Record<string, ScheduledActionToolInfo> = {
  list_tasks: {},
  emma_send_message: {},
  send_email: { internalOnly: true },
  get_user_by_id: { adminOnly: true },
  read_inbox: { requiredScope: 'email:read' },
};
const registry: ScheduledActionToolRegistry = { getTool: (n) => tools[n] };

describe('validateScheduledAction (ENG-2956)', () => {
  it('accepts a registered default-callable direct-backend tool', () => {
    expect(validateScheduledAction({ tool: 'list_tasks', args: { limit: 5 } }, registry)).toEqual({ ok: true });
  });

  it.each(AGENT_EXECUTION_TOOLS)('rejects agent-execution tool %s', (tool) => {
    const r = validateScheduledAction({ tool, args: {} }, registry);
    expect(r).toMatchObject({ ok: false, reason: 'agent_execution_tool' });
  });

  it('rejects unknown, internalOnly, admin and scope-gated tools', () => {
    expect(validateScheduledAction({ tool: 'nope', args: {} }, registry)).toMatchObject({ ok: false, reason: 'unknown_tool' });
    expect(validateScheduledAction({ tool: 'send_email', args: {} }, registry)).toMatchObject({ ok: false, reason: 'internal_only_tool' });
    expect(validateScheduledAction({ tool: 'get_user_by_id', args: {} }, registry)).toMatchObject({ ok: false, reason: 'admin_tool' });
    expect(validateScheduledAction({ tool: 'read_inbox', args: {} }, registry)).toMatchObject({ ok: false, reason: 'scope_required_tool' });
  });

  it.each(['client_id', 'clientId', 'userId', 'user_id'])('rejects identity override arg %s', (key) => {
    expect(validateScheduledAction({ tool: 'list_tasks', args: { [key]: 'other' } }, registry)).toMatchObject({
      ok: false,
      reason: 'identity_override',
    });
  });

  it('never throws on malformed input or a throwing registry', () => {
    expect(validateScheduledAction(null, registry)).toMatchObject({ ok: false, reason: 'invalid_shape' });
    expect(validateScheduledAction({ tool: 'list_tasks', args: [] }, registry)).toMatchObject({ ok: false, reason: 'invalid_shape' });
    const boom: ScheduledActionToolRegistry = { getTool: () => { throw new Error('x'); } };
    expect(validateScheduledAction({ tool: 'list_tasks', args: {} }, boom)).toMatchObject({ ok: false });
  });
});
