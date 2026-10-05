/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo/htmlCreation/htmlUpdate/
 * knowledgeBase/blog.moduleIsolation.test.ts.
 *
 * `chatbotService.ts` is the known transitive trap (ENG-1816 F1's
 * `lesson-lazy-require-aws-sdk-modules`): it top-level-imports
 * `agentModeService.ts` back (circular) and constructs a real
 * `AWS.DynamoDB.DocumentClient` at module load. All five work-plan methods
 * use `chatbotDb` heavily, so each one lazy-`require`s it at the top of its
 * own function body rather than importing it at module scope — proven below
 * to NOT happen.
 *
 * `predefinedWorkPlanResolver.ts` (applyPredefinedWorkPlan,
 * findPersistedWorkPlanRecommendation, recommendPredefinedWorkPlan),
 * `resendService.ts`/`emailService.ts`/`../../config`ts (sendForReview) were
 * all ALREADY lazily imported in the original class methods — preserved that
 * way here, and guarded below since a future regression (someone "fixing" a
 * lazy import back to static) would otherwise be silent.
 */

describe('emma/impl/workPlans.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/predefinedWorkPlanResolver');
    jest.dontMock('../../../services/resendService');
    jest.dontMock('../../../services/emailService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/workPlans.ts');
      });
      expect(() => require('../workPlans')).not.toThrow();
    });
  });

  it('does not import services/chatbotService.ts at module scope (the transitive agentModeService.ts trap)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('services/chatbotService.ts must be lazily required inside each function body, not loaded at module scope');
      });
      expect(() => require('../workPlans')).not.toThrow();
    });
  });

  it('does not import services/predefinedWorkPlanResolver.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/predefinedWorkPlanResolver', () => {
        throw new Error('services/predefinedWorkPlanResolver.ts must be lazily imported inside each function body, not loaded at module scope');
      });
      expect(() => require('../workPlans')).not.toThrow();
    });
  });

  it('does not import services/resendService.ts or services/emailService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/resendService', () => {
        throw new Error('services/resendService.ts must be lazily imported inside sendForReview, not loaded at module scope');
      });
      jest.doMock('../../../services/emailService', () => {
        throw new Error('services/emailService.ts must be lazily imported inside sendForReview, not loaded at module scope');
      });
      expect(() => require('../workPlans')).not.toThrow();
    });
  });
});
