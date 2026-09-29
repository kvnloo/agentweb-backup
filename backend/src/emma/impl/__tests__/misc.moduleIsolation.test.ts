/**
 * ENG-2103 F2 — skills/admin + file ops + misc tool cluster (cluster 22, the
 * last mechanical cluster). Same rationale as every prior
 * *.moduleIsolation.test.ts in this series: prove something real about the
 * extraction, not just that the code moved.
 *
 * `misc.ts` has no DB/AWS-client-construction concern to guard beyond the
 * already-established `s3Utils.ts` pattern (a real `AWS.S3` client at module
 * load, same as every other cluster that statically imports from it, e.g.
 * `searchResearch.ts`'s `getS3ObjectAsString`) — `crmSenderService`,
 * `sendAsSender`, and `emailProviderService` (all DB-touching) stay lazy
 * `await import(...)`s inside `sendEmailFromConfiguredSender`, exactly as in
 * the original code.
 */

describe('emma/impl/misc.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/misc.ts');
      });
      expect(() => require('../misc')).not.toThrow();
    });
  });

  it('does not import chatbotService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService.ts must not be imported at module scope by emma/impl/misc.ts');
      });
      expect(() => require('../misc')).not.toThrow();
    });
  });

  it('exposes the cluster entry points', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const misc = require('../misc');
    expect(typeof misc.getAdminToolNames).toBe('function');
    expect(typeof misc.saveFile).toBe('function');
    expect(typeof misc.readFileContent).toBe('function');
    expect(typeof misc.sendEmailFromConfiguredSender).toBe('function');
  });

  it('getAdminToolNames returns a fresh array (not a shared mutable reference)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const misc = require('../misc');
    const first = misc.getAdminToolNames();
    first.push('mutated');
    const second = misc.getAdminToolNames();
    expect(second).not.toContain('mutated');
    expect(second.length).toBeGreaterThan(0);
  });
});
