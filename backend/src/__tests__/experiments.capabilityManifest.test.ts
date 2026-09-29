import { chooseExecutionPath, countManualHandoffs } from '../experiments/capabilityManifestExperiment';

describe('A4 capability manifest experiment', () => {
  it('prefers direct MCP over browser scraping for safe reads', () => {
    expect(chooseExecutionPath({
      name: 'read_sandbox_campaigns',
      transports: ['direct_mcp', 'browser', 'manual'],
      risk: 'read',
    }, {
      available: ['direct_mcp', 'browser', 'manual'],
    })).toMatchObject({
      transport: 'direct_mcp',
      handoff: false,
    });
  });

  it('keeps irreversible or sensitive writes behind a human handoff', () => {
    expect(chooseExecutionPath({
      name: 'publish_campaign',
      transports: ['direct_mcp', 'api', 'browser', 'manual'],
      risk: 'sensitive_write',
    }, {
      available: ['direct_mcp', 'api', 'browser', 'manual'],
    })).toMatchObject({
      transport: 'manual',
      handoff: true,
    });
  });

  it('requires explicit user gesture for OAuth-like capabilities', () => {
    const decision = chooseExecutionPath({
      name: 'connect_account',
      transports: ['browser', 'manual'],
      risk: 'routine_write',
      requiresUserGesture: true,
    }, {
      available: ['browser', 'manual'],
      userGesturePresent: false,
    });

    expect(decision.reason).toBe('user_gesture_required');
  });

  it('makes handoff rate measurable', () => {
    const decisions = [
      chooseExecutionPath({ name: 'a', transports: ['direct_mcp'], risk: 'read' }, { available: ['direct_mcp'] }),
      chooseExecutionPath({ name: 'b', transports: ['manual'], risk: 'read' }, { available: ['manual'] }),
    ];
    expect(countManualHandoffs(decisions)).toBe(1);
  });
});
