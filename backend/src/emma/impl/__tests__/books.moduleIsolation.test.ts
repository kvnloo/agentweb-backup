/**
 * ENG-2103 F2 pilot — proves the point of the extraction, not just that the
 * code moved.
 *
 * The F2 design draft's own "done when" (§5.3): "a new file that imports only
 * the extracted domain modules (not agentModeService.ts) can call at least one
 * representative tool per domain cluster and get the same result as calling it
 * through the class today." This test proves the "not agentModeService.ts" half
 * mechanically, the same way F1's transitive-import lesson
 * (lesson-lazy-require-aws-sdk-modules) was caught only by a broad test run, not
 * by tsc or a self-selected test subset — so this asserts it directly instead of
 * relying on a future author noticing.
 *
 * Each `jest.doMock` below makes the corresponding module throw the instant
 * anything requires it. Requiring emma/impl/books.ts at module scope (no
 * function called yet) must not throw any of them — every one of its real
 * DB/AWS-backed dependencies is lazily loaded inside the function bodies that
 * need them, not at the top of the file.
 */

describe('emma/impl/books.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/bookDb');
    jest.dontMock('../../../services/bookContentDb');
    jest.dontMock('../../../services/settingsService');
    jest.dontMock('../../../services/chatbotService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/books.ts');
      });
      expect(() => require('../books')).not.toThrow();
    });
  });

  it('does not construct bookDb/bookContentDb/settingsService/chatbotService (AWS clients) at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/bookDb', () => {
        throw new Error('bookDb must be lazily imported, not loaded at module scope');
      });
      jest.doMock('../../../services/bookContentDb', () => {
        throw new Error('bookContentDb must be lazily imported, not loaded at module scope');
      });
      jest.doMock('../../../services/settingsService', () => {
        throw new Error('settingsService must be lazily required, not loaded at module scope');
      });
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService must be lazily required, not loaded at module scope');
      });
      expect(() => require('../books')).not.toThrow();
    });
  });

  it('emma/impl/shared/toolUsageMetering.ts does not import chatbotService.ts (circular + AWS client) at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService must be lazily required from inside the returned callback, not at module scope');
      });
      expect(() => require('../shared/toolUsageMetering')).not.toThrow();
    });
  });
});
