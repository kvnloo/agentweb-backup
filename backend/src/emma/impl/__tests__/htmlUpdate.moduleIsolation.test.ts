/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo/htmlCreation
 * .moduleIsolation.test.ts.
 *
 * This cluster needed no NEW lazy-import fix (crypto and the round-1 shared
 * emma/impl/shared/contentReplacements.ts are both pure, zero-import
 * modules), so the first test below is the usual baseline. The second test
 * is this round's own distinguishing finding: updateHtmlFile/updateHtmlFileCss
 * call fetchFileContent/uploadUpdatedFile via a same-module self-import
 * (`import * as self from './htmlUpdate'`), specifically so that
 * `jest.spyOn(htmlUpdateImpl, 'fetchFileContent')` from an external test file
 * is actually observed — a bare in-module call to a sibling `export function`
 * does NOT go through the exports-namespace object (TS/CommonJS compiles it
 * to a direct reference to the local function), so without this indirection
 * updateHtmlFile.test.ts's and updateHtmlFile.cssSelector.test.ts's spies
 * would silently stop being exercised. This test proves that indirection
 * actually works, not just that it compiles.
 */

describe('emma/impl/htmlUpdate.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/htmlUpdate.ts');
      });
      expect(() => require('../htmlUpdate')).not.toThrow();
    });
  });
});

describe('emma/impl/htmlUpdate.ts self-import makes internal calls spy-observable', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('a jest.spyOn on the module namespace intercepts updateHtmlFile’s own internal fetchFileContent call', async () => {
    // Who may write which S3 key is a boundary here (covered with the real policy in updateHtmlFile.storageAccess.test.ts).
    jest.doMock('../toolStorageAccess', () => ({
      TOOL_FILE_READ_ONLY_MESSAGE: 'read-only',
      TOOL_FILE_REFUSAL_MESSAGE: 'refused',
      TOOL_FILE_UNAVAILABLE_MESSAGE: 'unavailable',
      createToolFileAccess: () => ({ isOurBucket: () => true, check: async () => 'allow', checkWrite: async () => 'allow' }),
    }));
    const htmlUpdateImpl = require('../htmlUpdate');
    const fetchSpy = jest
      .spyOn(htmlUpdateImpl, 'fetchFileContent')
      .mockResolvedValue('<html>mocked</html>');
    jest.spyOn(htmlUpdateImpl, 'uploadUpdatedFile').mockResolvedValue({ url: 'https://s3/mock.html' });

    await htmlUpdateImpl.updateHtmlFile(
      'https://s3/original.html',
      'part',
      [{ old_content: 'mocked', new_content: 'x' }],
      'u1',
      's1'
    );

    // If the self-import indirection were missing, updateHtmlFile would call
    // the REAL fetchFileContent (a real `fetch()` against a fake URL) instead
    // of this mock, and this assertion would fail.
    expect(fetchSpy).toHaveBeenCalledWith('https://s3/original.html', 'u1');
  });
});
