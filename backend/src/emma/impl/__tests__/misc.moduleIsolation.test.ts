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
    // ENG-2103 (F2 follow-up): getUnassociatedTools/getUnassociatedToolNames
    // are new real exports, moved in from AgentModeService.
    expect(typeof misc.getUnassociatedTools).toBe('function');
    expect(typeof misc.getUnassociatedToolNames).toBe('function');
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

/**
 * ENG-2103 (F2 follow-up) — same rationale as adsApis.moduleIsolation.test.ts's
 * (round 1's) "self-import makes internal calls spy-observable" block.
 * `getUnassociatedToolNames` calls sibling `getUnassociatedTools`, both now in
 * this module — a bare in-module call to a sibling `export function` does NOT
 * go through the exports-namespace object (TS/CommonJS compiles it to a
 * direct local reference), so without the `import * as self from './misc'`
 * indirection, an external `jest.spyOn(miscImpl, 'getUnassociatedTools')`
 * would silently stop being exercised whenever `getUnassociatedToolNames` is
 * called instead. This test proves the indirection actually works, not just
 * that it compiles — verified directly by temporarily removing the `self.`
 * prefix from `getUnassociatedToolNames`'s internal call and confirming this
 * exact test fails (with the real filter logic running instead of the mock),
 * then restoring it and confirming the test passes again.
 */
describe('emma/impl/misc.ts self-import makes internal calls spy-observable', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('a jest.spyOn on the module namespace intercepts getUnassociatedToolNames\'s own internal getUnassociatedTools call', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const miscImpl = require('../misc');

    const spy = jest.spyOn(miscImpl, 'getUnassociatedTools').mockReturnValue([
      { name: 'mocked_tool', description: 'mocked description' },
    ]);

    // Args deliberately shaped so that if the REAL getUnassociatedTools ran
    // instead of the mock, it would return an empty array (no tools at all
    // from getAllTools) — making the mocked-vs-real distinction unambiguous.
    const names = miscImpl.getUnassociatedToolNames(
      [] /* publishedSkills */,
      new Set<string>() /* foundationTools */,
      () => [] /* getAllTools */,
    );

    expect(spy).toHaveBeenCalledWith([], new Set<string>(), expect.any(Function));
    expect(names).toEqual(['mocked_tool']);
  });
});
