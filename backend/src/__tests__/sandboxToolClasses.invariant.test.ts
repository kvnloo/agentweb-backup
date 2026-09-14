import { EXTERNAL_SEND_TOOLS, EXTERNAL_PUBLISH_TOOLS } from '../services/agentToolGatewayService';
import { classifySandboxTool, SANDBOX_TOOL_CLASSES } from '../services/evaluationPolicy';

/**
 * ENG-1907: the sandbox denylist is class-based with default-allow, so a tool the gateway
 * already knows reaches a third party (its external_send / external_publish sets) must
 * always land in a sandbox class. A new outbound tool added to the gateway's sets without a
 * matching sandbox class fails here, before it can execute for a sandbox principal.
 */
describe('every gateway-known outbound tool is sandbox-classified', () => {
  const outbound = [...EXTERNAL_SEND_TOOLS, ...EXTERNAL_PUBLISH_TOOLS].map(name => [name] as const);
  it.each(outbound)('%s', name => {
    expect(classifySandboxTool(name)).not.toBeNull();
  });
  it('the class table covers the eight agreed classes', () => {
    expect(Object.keys(SANDBOX_TOOL_CLASSES).sort()).toEqual(
      ['automation', 'browser', 'connectors', 'lifecycle', 'publish', 'sends', 'social', 'third_party_writes'],
    );
  });
});
