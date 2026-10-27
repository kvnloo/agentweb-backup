import { AgentModeService } from '../services/agentModeService';
import { normalizeSkillIdArg } from '../services/agentMode/skillIdArg';

// Mock all dependencies
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

// Mock skillService - define mock implementations inside factory
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(),
    getSkillsByIds: jest.fn(),
    getSkillsAvailableToUser: jest.fn(),
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
  },
}));

// Mock chatbotService - define mock implementations inside factory
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addAssociatedSkills: jest.fn(),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  },
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

// Mock subscriptionService
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue([]),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools) => tools),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
    refresh: jest.fn(), // Added refresh mock
  })),
}));

// Mock ToolRegistry
jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
  })),
}));

// Import the mocked modules to access the mock functions
import { skillService } from '../services/skillService';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { retryabilityLine, isFastTripErrorClass } from '../services/agentMode/core/errorRetryability';
import { classifyToolFailureType } from '../utils/toolFailureType';
import { NON_DISPATCHABLE_FAILURE_TYPES } from '../loops/instances/agent-mode/failureRuleSet';
import { chatbotDb } from '../services/chatbotService';


describe('AgentModeService - Skills', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    // Mock settings service for default behavior
    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };

    // By default, getSkillsAvailableToUser returns same as getPublishedSkills
    (skillService.getSkillsAvailableToUser as jest.Mock).mockImplementation(async () => {
      return (skillService.getPublishedSkills as jest.Mock)();
    });
  });

  describe('installSkills', () => {
    it('should install published skills by ID', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Skill 2', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', 'skill-2'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toEqual(['Skill 1', 'Skill 2']);
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1', 'skill-2']);
    });

    /*
     * ENG-1795. This test previously asserted the SUBSCRIPTION message for an id it names
     * "invalid" — the conflation, written down as an expectation. An unknown id is an ID
     * failure; reporting it as a plan limitation sends a paying customer to sales for
     * something sales cannot fix.
     */
    /*
     * ENG-2612: production rows show the model passing the catalog display line
     * ("<uuid>- Skill Name") as the id. The UUID is recovered; nothing else changes.
     */
    describe('skill id with copied name suffix (ENG-2612)', () => {
      const uuid = '7f3464da-faab-487c-9690-5fc87c609752';

      it('installs the UUID when the model appends "- <Skill Name>"', async () => {
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([
          { skillId: uuid, name: 'Meta B2B Ad Generation', description: 'Desc', toolNames: ['t'], isPublished: true },
        ]);
        (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

        const result = await agentModeService.installSkills(
          [`${uuid}- Meta B2B Ad Generation - Image and Copy`, uuid],
          'user-123',
          'session-123'
        );

        expect(result.success).toBe(true);
        expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', [uuid]);
      });

      it('normalizeSkillIdArg leaves exact, virtual and non-UUID ids untouched', () => {
        expect(normalizeSkillIdArg(uuid)).toBe(uuid);
        expect(normalizeSkillIdArg(`${uuid}- X (Twitter) Management`)).toBe(uuid);
        expect(normalizeSkillIdArg(`${uuid} - Luma: pull guests`)).toBe(uuid);
        expect(normalizeSkillIdArg('__other_skills__')).toBe('__other_skills__');
        expect(normalizeSkillIdArg('no-such-skill-xyz')).toBe('no-such-skill-xyz');
        expect(normalizeSkillIdArg('7e7b65a0eb-50c6-489b-959c-e4d3a1a23091- Luma')).toBe(
          '7e7b65a0eb-50c6-489b-959c-e4d3a1a23091- Luma'
        );
      });

      it('a suffixed UUID the user cannot see is still refused as unresolved', async () => {
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
        const result = await agentModeService.installSkills([`${uuid}- Hidden`], 'user-123', 'session-123');
        expect(result.message).toContain('Could not resolve these skill IDs to any known skill');
        expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
      });
    });

    it('should return error for invalid skill IDs', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.installSkills(
        ['invalid-skill-1'],
        'user-123',
        'session-123'
      );

      expect(result.message).toContain('Could not resolve these skill IDs to any known skill');
      expect(result.message).toContain('invalid-skill-1');
      expect(result.unresolvedSkillIds).toEqual(['invalid-skill-1']);
      // The whole point: no billing claim reaches the customer for a lookup failure.
      expect(result.message).not.toMatch(/not available with your current subscription/i);
      expect(result.message).not.toMatch(/not on their plan/i);
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });

    /*
     * ENG-1795 — the branch that had NO coverage at all.
     *
     * `getAllowedSkills` is mocked to `['*']` suite-wide, so every pre-existing test that
     * asserted "not available with your current subscription" was run against a user entitled
     * to everything. The message was pinned in five places and the condition it describes was
     * never once constructed. These two tests build the real thing: a published skill that
     * exists and is deliberately NOT in the account's allowedSkills.
     */
    describe('refusal cause is reported accurately (ENG-1795)', () => {
      const { getAllowedSkills } = require('../services/subscriptionService');
      const gatedSkill = {
        skillId: 'premium-ads', name: 'Premium Ads', description: 'Paid tier only',
        toolNames: ['run_premium_ad'], isPublished: true, visibility: 'public',
      };

      const realUserDb = require('../services/db').userDb;
      afterEach(() => {
        (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
        // The admin-check mocks below mutate the db module in place. Without this they leak
        // into every later test and silently change which bucket __admin_tools__ lands in.
        require('../services/db').userDb = realUserDb;
      });

      it('reports a genuinely un-entitled skill as a subscription limit', async () => {
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([gatedSkill]);
        (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([gatedSkill]);
        (getAllowedSkills as jest.Mock).mockResolvedValue(['some-other-skill']);

        const result = await agentModeService.installSkills(['premium-ads'], 'user-123', 'session-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('not available with your current subscription');
        expect(result.message).toContain('premium-ads');
        expect(result.unentitledSkillIds).toEqual(['premium-ads']);
        // This branch is the one where the plan claim is TRUE — it must survive the split.
        expect(result.message).toMatch(/not on their plan/i);
        expect(result.message).not.toMatch(/could not resolve/i);
        expect(classifyToolErrorClass(new Error(result.message))).toBe('subscription_blocked');
      });

      it('keeps the causes separate when one call mixes them', async () => {
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([gatedSkill]);
        (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([gatedSkill]);
        (getAllowedSkills as jest.Mock).mockResolvedValue(['some-other-skill']);

        const result = await agentModeService.installSkills(
          ['premium-ads', 'no-such-skill'], 'user-123', 'session-123'
        );

        expect(result.unentitledSkillIds).toEqual(['premium-ads']);
        expect(result.unresolvedSkillIds).toEqual(['no-such-skill']);
        /*
         * The ids must not be pooled under one verdict. A mixed refusal classified
         * `subscription_blocked` would put `no-such-skill` back under a billing verdict —
         * the exact conflation this change removes — so the unknown id wins the classification.
         */
        expect(classifyToolErrorClass(new Error(result.message))).toBe('invalid_args');
      });

      it('makes no billing claim when the catalog lookup itself fails', async () => {
        /*
         * The FIRST getPublishedSkills call must succeed: installSkills builds the display
         * catalog (via getSkillsAvailableToUser, which the suite delegates to getPublishedSkills)
         * before any rejection exists to classify. Rejecting from the start instead trips
         * installSkills' own outer try/catch and returns "An error occurred while installing
         * skills." — which passes every assertion below identically on unfixed code, and
         * therefore proves nothing. Only the SECOND call, inside classifySkillRejections,
         * exercises the branch under test.
         */
        (skillService.getPublishedSkills as jest.Mock)
          .mockResolvedValueOnce([])
          .mockRejectedValue(new Error('dynamo down'));

        const result = await agentModeService.installSkills(['premium-ads'], 'user-123', 'session-123');

        /*
         * An unproven absence must never be reported as an entitlement failure. If we cannot
         * read the catalog we cannot know why the id was rejected, so the one thing we must
         * not do is assert the customer's plan is at fault.
         */
        expect(result.success).toBe(false);
        expect(result.message).toContain('These skills are currently unavailable to install');
        expect(result.message).not.toMatch(/not available with your current subscription/i);
        expect(result.message).not.toMatch(/not on their plan/i);
        expect(result.unentitledSkillIds).toBeUndefined();
        expect(result.unavailableSkillIds).toEqual(['premium-ads']);
        // Proves the classifier's catch ran, rather than installSkills' outer handler.
        expect(result.message).not.toMatch(/an error occurred while installing skills/i);
      });

      it('routes an unavailable refusal to a class that FORBIDS substitution', async () => {
        /*
         * The class is not cosmetic — toolDispatch appends `retryabilityLine(class)` directly
         * beneath this message. `empty_result`, the intuitive pick, says "the call succeeded
         * but returned nothing … broaden the query or try a different source": it contradicts
         * the refusal's own no-substitution sentence, and telling a model to try another
         * source beneath a refusal is exactly how ENG-1625 produced a fabricated audit table.
         * `tool_unavailable` ends "Do NOT present another tool's output as this tool's result".
         */
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

        const result = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');

        const cls = classifyToolErrorClass(new Error(result.message));
        expect(cls).toBe('skill_install_refused');

        /*
         * The class is not cosmetic — toolDispatch appends `retryabilityLine(cls)` directly
         * beneath this message, so its text is read by the model as the verdict. Assert the
         * PROPERTIES that matter rather than the wording, so a future rephrase does not have
         * to touch this test but a semantic regression does:
         */
        const line = retryabilityLine(cls);
        expect(line).toMatch(/do not substitute another tool's output/i);   // the ENG-1625 guard
        expect(line).not.toMatch(/the call succeeded/i);                    // it did not
        expect(line).not.toMatch(/try a different source/i);                // that IS substitution
        expect(line).not.toMatch(/install the required skill via install_skills/i); // circular here
        expect(line).not.toMatch(/not available in this session/i);         // install_skills ran

        /*
         * The guarantee is DISPATCHABILITY, not the literal string 'bug' — `bug` is already the
         * default for an unrecognised class, so asserting it alone passes whether or not the
         * mapping exists. What must hold is that this class stays OUT of
         * NON_DISPATCHABLE_FAILURE_TYPES: `unavailable` IS the ENG-1237 catalog bug, and the
         * previous class (`model_uninstalled_tool`) silently dropped it from the investigate set.
         */
        const ft = classifyToolFailureType(cls);
        expect(ft).toBe('bug');
        expect(NON_DISPATCHABLE_FAILURE_TYPES.has(ft)).toBe(false);
        expect(isFastTripErrorClass(cls)).toBe(true);
      });

      it('does not let a hallucinated skill ID hijack the error class', async () => {
        /*
         * Rejected ids are interpolated into the classified sentence, and on the unresolved
         * path they are strings the MODEL invented. Before the markers were matched first,
         * an id containing "403"/"500"/"404" was picked up by the embedded-status patterns —
         * "500" yielded `upstream_5xx`, which is RETRYABLE, so a permanent refusal advertised
         * itself as worth retrying.
         */
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

        for (const badId of ['UTM Audit 404 Report', '500', 'ads 403 manager', 'install_skills_helper']) {
          const result = await agentModeService.installSkills([badId], 'user-123', 'session-123');
          expect(classifyToolErrorClass(new Error(result.message))).toBe('invalid_args');
        }
      });

      it('does NOT claim a role restriction when the admin check itself fails', async () => {
        /*
         * `getSkillsForDisplay` adds the admin bundle inside a try/catch that swallows a
         * `getUserById` failure, so during a DynamoDB blip a REAL admin is refused exactly like
         * a non-admin. Asserting a role restriction there tells them "not a temporary fault"
         * when it is exactly that, and `by_design` hides the outage from triage.
         */
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
        const mockDb = require('../services/db');
        mockDb.userDb = { getUserById: jest.fn().mockRejectedValue(new Error('dynamo down')) };

        const result = await agentModeService.installSkills(['__admin_tools__'], 'user-123', 'session-123');

        expect(result.forbiddenSkillIds).toBeUndefined();
        expect(result.unavailableSkillIds).toEqual(['__admin_tools__']);
        expect(result.message).not.toMatch(/requires admin access/i);
        expect(result.message).not.toMatch(/not a temporary fault/i);
        // ...and it must stay visible to triage rather than being filed as working-as-designed.
        const cls = classifyToolErrorClass(new Error(result.message));
        expect(classifyToolFailureType(cls, result.message)).toBe('bug');
      });

      it('a genuine admin installs the bundle rather than being refused at all', async () => {
        // The counterpart to the case above: when the lookup SUCCEEDS and the user is an admin,
        // getSkillsForDisplay puts the bundle in their catalog, so there is no refusal to
        // classify. This pins that the refusal path is reached only when something is wrong.
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
        const mockDb = require('../services/db');
        mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', isAdmin: true }) };

        const result = await agentModeService.installSkills(['__admin_tools__'], 'user-123', 'session-123');

        expect(result.success).toBe(true);
        expect(result.forbiddenSkillIds).toBeUndefined();
        expect(result.unavailableSkillIds).toBeUndefined();
      });

      it('keeps admin tools a role restriction even when the catalog read fails', async () => {
        // Confirmed non-admin — the only state in which a role restriction may be asserted.
        require('../services/db').userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', isAdmin: false }) };
        /*
         * The admin bucket is decided by a static id comparison that needs no catalog at all.
         * Left below the try/catch, a catalog failure dropped it into the `unavailable`
         * fallback — which asserts "this account is permitted to use it" and "support can look
         * into it", the two false claims the forbidden bucket exists to remove. A failed lookup
         * must not silently undo a decision that never depended on the lookup.
         */
        (skillService.getPublishedSkills as jest.Mock)
          .mockResolvedValueOnce([])
          .mockRejectedValue(new Error('dynamo down'));

        const result = await agentModeService.installSkills(['__admin_tools__'], 'user-123', 'session-123');

        expect(result.forbiddenSkillIds).toEqual(['__admin_tools__']);
        expect(result.message).toMatch(/requires admin access/i);
        expect(result.message).not.toMatch(/permitted to use it/i);
        expect(result.message).not.toMatch(/support can look into it/i);
      });

      it('PARTIAL install: the no-substitution instruction is present there too', async () => {
        /*
         * It matters MORE here than on the full-refusal branch. There, the dispatcher's
         * downgrade attaches an error class whose retryability line carries its own stop
         * signal. Here `success: true` means no class is ever assigned, so this sentence is the
         * only thing between "the one skill the gated tool needed was the one refused" and the
         * model presenting another tool's output as that tool's result.
         */
        const realSkill = {
          skillId: 'crm-skill', name: 'CRM', description: 'CRM tools',
          toolNames: ['search_leads'], isPublished: true, visibility: 'public',
        };
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([realSkill]);
        (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([realSkill]);

        const result = await agentModeService.installSkills(
          ['crm-skill', 'no-such-id'], 'user-123', 'session-123'
        );

        expect(result.success).toBe(true);
        expect(result.message).toMatch(/do not substitute/i);
      });

      it('does not let an un-entitled skill ID hijack the error class either', async () => {
        /*
         * The entitlement sentence was the one quarter left unguarded: it was matched by a
         * pattern below the embedded-status regex, so a published skillId beginning with a
         * "500"-shaped token classified `upstream_5xx` — which is RETRYABLE, appending "Wait
         * briefly, then retry ONCE" beneath a permanent billing refusal.
         */
        const gated = {
          skillId: '500-error-playbook', name: 'Playbook', description: 'x',
          toolNames: ['t'], isPublished: true, visibility: 'public',
        };
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([gated]);
        (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([gated]);
        (getAllowedSkills as jest.Mock).mockResolvedValue(['something-else']);

        const result = await agentModeService.installSkills(['500-error-playbook'], 'user-123', 'session-123');

        expect(result.unentitledSkillIds).toEqual(['500-error-playbook']);
        expect(classifyToolErrorClass(new Error(result.message))).toBe('subscription_blocked');
      });

      it('classifies a role refusal as by_design, not as a bug to investigate', async () => {
        /*
         * `forbidden` and `unavailable` share an error class, but they are opposite kinds of
         * event. An admin-only bundle refused to a non-admin is a ROLE boundary working as
         * designed — routing it to `bug` seeds an "investigate the handler + propose a
         * robustness fix" proposal in failure triage for behaviour that is correct.
         *
         * `unavailable` must stay `bug`: it IS the ENG-1237 catalog defect.
         */
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

        const forbidden = await agentModeService.installSkills(['__admin_tools__'], 'user-123', 'session-123');
        const fCls = classifyToolErrorClass(new Error(forbidden.message));
        expect(classifyToolFailureType(fCls, forbidden.message)).toBe('by_design');
        expect(NON_DISPATCHABLE_FAILURE_TYPES.has(classifyToolFailureType(fCls, forbidden.message))).toBe(true);

        const unavailable = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');
        const uCls = classifyToolErrorClass(new Error(unavailable.message));
        expect(classifyToolFailureType(uCls, unavailable.message)).toBe('bug');
      });

      it('a MIXED refusal stays investigable — the catalog half is a real defect', async () => {
        /*
         * Built from REAL `installSkills` output, not a hand-written approximation.
         *
         * `classifyToolFailureType` distinguishes the two buckets by matching prose that
         * `describeRejections` generates — "requires admin access" present, "permitted to use
         * it" absent. A literal fixture pins the classifier against ITSELF and not against the
         * producer, so rewording the unavailable sentence would silently flip a real mixed
         * refusal from `bug` to `by_design` — dropping the ENG-1237 catalog half out of the
         * investigate set — with no test failing. Deriving the fixture is what makes a reword
         * break here instead of in production.
         */
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

        const mixed = await agentModeService.installSkills(
          ['__admin_tools__', '__other_skills__'], 'user-123', 'session-123'
        );

        // Both causes really are present in one message — otherwise this proves nothing.
        expect(mixed.forbiddenSkillIds).toEqual(['__admin_tools__']);
        expect(mixed.unavailableSkillIds).toEqual(['__other_skills__']);

        const cls = classifyToolErrorClass(new Error(mixed.message));
        expect(classifyToolFailureType(cls, mixed.message)).toBe('bug');

        // And an absent message must never be read as "working as designed".
        expect(classifyToolFailureType('skill_install_refused', undefined)).toBe('bug');
      });

      it('describes admin tools as a role restriction, not a billing or support matter', async () => {
        // Confirmed non-admin — the only state in which a role restriction may be asserted.
        require('../services/db').userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', isAdmin: false }) };
        /*
         * __admin_tools__ is gated on isAdmin/delegation. Bucketing it as "unavailable" told a
         * non-admin "this account is permitted to use it … support can look into it" — both
         * false, and the same species of error as the billing claim: it routes the user to a
         * team that cannot help, and confirms the id is real and theirs to use.
         */
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

        const result = await agentModeService.installSkills(['__admin_tools__'], 'user-123', 'session-123');

        expect(result.forbiddenSkillIds).toEqual(['__admin_tools__']);
        expect(result.message).toMatch(/requires admin access/i);
        expect(result.message).not.toMatch(/permitted to use it/i);
        expect(result.message).not.toMatch(/support can look into it/i);
        expect(result.message).not.toMatch(/not available with your current subscription/i);
      });

      it('PARTIAL install: a hallucinated ID is not reported as a billing limit', async () => {
        /*
         * The path the original split missed. It returns `success: true` because something
         * installed, so toolResultError yields null and NO classifier runs — this prose is
         * the only thing the model reads. It used to append a flat "N skill(s) were not
         * available with your subscription" over every rejected id regardless of cause, so a
         * made-up id reached a paying customer as a billing statement. `message` is in
         * extractMinimalToolResult's allowlist, so it persisted into the ledger too.
         */
        const realSkill = {
          skillId: 'crm-skill', name: 'CRM', description: 'CRM tools',
          toolNames: ['search_leads'], isPublished: true, visibility: 'public',
        };
        (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([realSkill]);
        (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([realSkill]);

        const result = await agentModeService.installSkills(
          ['crm-skill', 'no-such-id'], 'user-123', 'session-123'
        );

        expect(result.success).toBe(true);
        expect(result.installedSkills).toEqual(['CRM']);
        expect(result.message).not.toMatch(/were not available with your subscription/i);
        expect(result.message).toContain('Could not resolve these skill IDs to any known skill');
        expect(result.unresolvedSkillIds).toEqual(['no-such-id']);
      });
    });

    /*
     * Observed live (delegated session a1a6345a, Phoenix): the skill gate refused
     * `audit_ad_utm_coverage`, this install was refused by subscription, and the model then ran
     * an unrelated AD LIST and presented a confident "UTM Tagging Audit Summary — PASS, 6/6
     * tagged" table built from it, as though the audit had run. A downstream truthfulness guard
     * appended a correction, but BELOW the fabricated table.
     *
     * The model cannot be unit-tested into honesty, but the two inputs it reasons from can be
     * pinned: this refusal must read as a hard failure, and it must carry an explicit
     * instruction not to substitute another tool's output for the gated one.
     */
    it('reports a subscription refusal as a hard failure, not an ambiguous message', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');

      // `success` was previously left undefined here while the success path sets `success: true`,
      // so a refusal did not necessarily read as a failure at all.
      expect(result.success).toBe(false);
    });

    it('tells the model not to substitute another tool for the one that needed the skill', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');

      /*
       * The no-substitution instruction is the invariant here, and it must hold on EVERY
       * refusal branch — the Phoenix session's fabricated audit table did not depend on which
       * reason the install was refused for. ENG-1795 split one refusal into three; the clause
       * is appended once, outside the branch, so this assertion now covers all of them.
       */
      expect(result.message).toMatch(/do not substitute/i);
      // Was `/not on their plan/i`: this fixture is an entitled-but-empty `__other_skills__`,
      // which is not a plan limitation at all, so asserting that phrasing pinned the bug.
      expect(result.message).toMatch(/currently unavailable to install/i);
      expect(result.message).not.toMatch(/not on their plan/i);
    });

    /*
     * The outcome has to survive MINIMIZATION, not just be returned.
     *
     * The dispatcher does not store the result — it stores
     * `extractMinimalToolResult(result, 'install_skills')`, and that function's default branch
     * returns `{}`. So a refusal that reads perfectly here can still reach the ledger as an
     * empty object with no `success: false` at all, and anything downstream reading the ledger
     * to find out whether the install worked sees a shape indistinguishable from a clean one.
     *
     * That is not hypothetical: `extractMinimalToolResult`'s own ENG-1207 comment records
     * `reconcileUnconsumedCursors` being inert in production for exactly this reason while all
     * of its unit tests passed, because those tests built ledger entries by hand and so never
     * crossed this function. This test crosses it deliberately.
     */
    it('a refused install still reads as a failure AFTER ledger minimization', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const refusal = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');
      const ledgerResult = (agentModeService as any).extractMinimalToolResult(refusal, 'install_skills');

      expect(ledgerResult.success).toBe(false);
      // The refusal must still be readable in the ledger, not just in the returned object.
      // (ENG-1795: `__other_skills__` with an empty pool is the UNAVAILABLE branch, not the
      // subscription one — what this test guards is that a refusal survives minimization at
      // all, which is independent of which branch produced it.)
      expect(String(ledgerResult.message)).toMatch(/currently unavailable to install/i);
    });

    it('a PARTIAL install survives minimization as partial, not as a clean success', async () => {
      // success:true (something installed) + the refused ids. Without the ids the ledger says
      // only "the install succeeded", which is true and useless: the one skill the gated tool
      // needed may be exactly the one that was refused.
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ]);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const partial = await agentModeService.installSkills(
        ['skill-1', 'utm-audit'],
        'user-123',
        'session-123',
      );
      expect(partial.success).toBe(true);
      expect(partial.rejectedSkillIds).toEqual(['utm-audit']);

      const ledgerResult = (agentModeService as any).extractMinimalToolResult(partial, 'install_skills');
      expect(ledgerResult.success).toBe(true);
      expect(ledgerResult.rejectedSkillIds).toEqual(['utm-audit']);
    });

    /*
     * The real incident shape, and the one the earlier version of this fix quietly did not
     * cover: `installSkills` resolves rejected ids against `getSkillsForDisplay` ->
     * `getSkillsAvailableToUser`, which is ALREADY filtered to this user's subscription tier. A
     * skill rejected FOR being outside that tier was excluded from that map before
     * `rejectedSkillIds` was even computed, so resolving `rejectedToolNames` against it always
     * found nothing — the exact skill the notice most needs to name resolved to an empty array,
     * silently falling back to the unscoped (turn-global) path every time. `utm-audit` here is a
     * real, published skill (present in the FULL catalog, `getPublishedSkills`) that this user's
     * tier does not include (absent from `getSkillsAvailableToUser`) — the live incident's shape,
     * not a skill that simply does not exist.
     */
    it('resolves rejectedToolNames for a skill excluded by subscription tier, not just an unknown id', async () => {
      const fullCatalog = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        {
          skillId: 'utm-audit',
          name: 'UTM Audit',
          description: 'Desc',
          toolNames: ['audit_ad_utm_coverage'],
          isPublished: true,
        },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(fullCatalog);
      // Tier-filtered: only skill-1 is on this user's plan, matching how a subscription refusal
      // actually reaches installSkills in production.
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([fullCatalog[0]]);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const partial = await agentModeService.installSkills(
        ['skill-1', 'utm-audit'],
        'user-123',
        'session-123',
      );
      expect(partial.rejectedSkillIds).toEqual(['utm-audit']);
      expect(partial.rejectedToolNames).toEqual(['audit_ad_utm_coverage']);

      const ledgerResult = (agentModeService as any).extractMinimalToolResult(partial, 'install_skills');
      expect(ledgerResult.rejectedToolNames).toEqual(['audit_ad_utm_coverage']);
    });

    /*
     * Regression: a rejection mixing a real skill id with a virtual one (`__admin_tools__`,
     * `__other_skills__`) used to resolve rejectedToolNames from the real id ONLY — a non-empty
     * array that reads as a fully scoped rejection while silently dropping every admin/other
     * tool from it. A gated admin tool refused the same turn would then wrongly read as
     * available, since its name is absent from a rejectedToolNames that looks complete. The
     * field must be omitted entirely rather than partially populated, so the notice's per-tool
     * scoping falls back to its safe (unscoped) path instead of a falsely precise one.
     */
    it('omits rejectedToolNames entirely when one of the rejected ids cannot be resolved (mixed real + virtual id)', async () => {
      const fullCatalog = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        {
          skillId: 'utm-audit',
          name: 'UTM Audit',
          description: 'Desc',
          toolNames: ['audit_ad_utm_coverage'],
          isPublished: true,
        },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(fullCatalog);
      // Tier-filtered: only skill-1 is on this user's plan — utm-audit resolves via the full
      // catalog fallback, same as the subscription-tier test above.
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([fullCatalog[0]]);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      // Both utm-audit AND __admin_tools__ are rejected together in the SAME call. utm-audit
      // resolves fine (via the full-catalog fallback); __admin_tools__ never enters availableById
      // (non-admin, non-delegated caller) and never appears in getPublishedSkills (it is
      // synthesized, not a real published skill), so it cannot resolve in either catalog. The old
      // code read this as a fully-scoped rejection naming only utm-audit's tool — silently
      // dropping every admin tool from it.
      const partial = await agentModeService.installSkills(
        ['skill-1', 'utm-audit', '__admin_tools__'],
        'user-123',
        'session-123',
        false,
      );

      expect(partial.rejectedSkillIds).toEqual(['utm-audit', '__admin_tools__']);
      expect(partial.rejectedToolNames).toBeUndefined();

      const ledgerResult = (agentModeService as any).extractMinimalToolResult(partial, 'install_skills');
      expect(ledgerResult.rejectedToolNames).toBeUndefined();
    });

    it('should filter out unpublished skills', async () => {
      const skills = [
        { skillId: 'skill-1', name: 'Published', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        // 'skill-2' is not in published list (unpublished)
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(skills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', 'skill-2'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toEqual(['Published']);
      // Only skill-1 should be added
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1']);
    });

    it('should add skills to session associatedSkills', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      await agentModeService.installSkills(['skill-1'], 'user-123', 'session-123');

      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1']);
    });

    it('should return list of installed skill names', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Content Creation', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Analytics', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', 'skill-2'],
        'user-123',
        'session-123'
      );

      expect(result.installedSkills).toContain('Content Creation');
      expect(result.installedSkills).toContain('Analytics');
    });

    it('should handle errors gracefully', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockRejectedValue(new Error('DB Error'));

      const result = await agentModeService.installSkills(
        ['skill-1'],
        'user-123',
        'session-123'
      );

      expect(result.message).toContain('error occurred');
    });

    it('should install other_skills virtual skill', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      
      // Mock getUnassociatedTools behavior - we need to mock internal method or toolRegistry
      // Easier to spy on toolRegistry in beforeEach if we could, but here we can rely on 
      // the fact that getUnassociatedTools calls this.toolRegistry.getAllTools()
      
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } }, // associated
        { name: 'orphan_tool', definition: { function: { description: 'desc2' } } }, // unassociated
        { name: 'install_skills', definition: { function: { description: 'infra' } } } // infra
      ];
      
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['__other_skills__'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('other_skills');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['__other_skills__']);
    });

    it('should install mixed real skills and other_skills', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } }, 
        { name: 'orphan_tool', definition: { function: { description: 'desc2' } } }
      ];
      
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', '__other_skills__'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('Skill 1');
      expect(result.installedSkills).toContain('other_skills');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1', '__other_skills__']);
    });

    it('allows a restricted subscriber to install a sharing-enabled same-org private skill', async () => {
      const orgId = 'org-abc';
      const orgMemberUserId = 'member-user-456';
      const orgPrivateSkill = {
        skillId: 'org-private-skill-1',
        name: 'Org Private Skill',
        description: 'Private skill shared via org',
        toolNames: ['tool_org'],
        isPublished: false,
        ownerId: 'owner-user-123',
        orgId,
        visibility: 'private',
      };

      // getSkillsAvailableToUser returns org skill for the org member
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([orgPrivateSkill]);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: orgMemberUserId, orgId, orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({
        orgId, ownerUserId: 'owner-user-123',
        shareSettings: { skills: { enabled: true, editors: [] } },
      }) };
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['org-private-skill-1']);

      const result = await agentModeService.installSkills(
        ['org-private-skill-1'],
        orgMemberUserId,
        'session-abc'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('Org Private Skill');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-abc', ['org-private-skill-1']);
    });

    it('should reject a private org skill for a user outside that org', async () => {
      const orgId = 'org-abc';
      const outsiderUserId = 'outsider-user-789';
      const orgPrivateSkill = {
        skillId: 'org-private-skill-1',
        name: 'Org Private Skill',
        description: 'Private skill shared via org',
        toolNames: ['tool_org'],
        isPublished: false,
        ownerId: 'owner-user-123',
        orgId,
        visibility: 'private',
      };

      // getSkillsAvailableToUser does NOT return org skill for outsider
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);

      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: outsiderUserId, orgId: 'org-different', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({
        orgId: 'org-different', ownerUserId: 'other-owner',
        shareSettings: { skills: { enabled: true, editors: [] } },
      }) };

      // Pinned explicitly: without this the test inherits getPublishedSkills from an earlier
      // case and would flip buckets if that unrelated fixture ever changed.
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.installSkills(
        ['org-private-skill-1'],
        outsiderUserId,
        'session-xyz'
      );

      /*
       * ENG-1795: "could not resolve" is both more accurate AND less leaky here. The old
       * subscription wording implicitly confirmed to an outsider that `org-private-skill-1`
       * exists and is merely unpurchased; an unresolvable id reveals nothing about another
       * org's private catalog.
       */
      expect(result.message).toContain('Could not resolve these skill IDs to any known skill');
      expect(result.message).not.toMatch(/not available with your current subscription/i);
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });
    it('rejects a same-org private skill when skill sharing is disabled', async () => {
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1', shareSettings: { skills: { enabled: false, editors: [] } } }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
      const result = await agentModeService.installSkills(['org-private'], 'member-1', 'session-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
      // ENG-1795: sharing being switched off is a config state, not a billing one.
      expect(result.message).toContain('Could not resolve these skill IDs to any known skill');
      expect(result.message).not.toMatch(/not available with your current subscription/i);
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });

    it('installs __other_skills__ when only an unpublished org-shared skill claims the remaining tools (ENG-1237 production repro)', async () => {
      // Mirrors the harsha@agentweb.pro session: getSkillsAvailableToUser mixes a
      // published skill in with an unpublished org-shared draft skill (included for
      // install purposes only). Before the fix, the draft skill's toolNames silently
      // counted as "associated", leaving no unassociated tools, so __other_skills__
      // never appeared in getSkillsForDisplay and install_skills(['__other_skills__'])
      // rejected with "not available with your current subscription".
      const orgId = 'org-1';
      const userId = 'harsha-user-id';
      const publishedSkill = {
        skillId: 'crm-skill', name: 'CRM & Lead Management', description: 'CRM tools',
        toolNames: ['search_leads'], isPublished: true,
      };
      const unpublishedOrgSkill = {
        skillId: 'draft-landing-pages', name: 'Landing Pages (draft)', description: 'Landing page tools',
        toolNames: ['list_landing_pages'], isPublished: false, ownerId: 'other-owner', orgId, visibility: 'private',
      };

      const mockTools = [
        { name: 'search_leads', definition: { function: { description: 'search leads' } } },
        { name: 'list_landing_pages', definition: { function: { description: 'list landing pages' } } },
      ];

      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([publishedSkill, unpublishedOrgSkill]);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId, orgId, orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({
        orgId, ownerUserId: 'other-owner',
        shareSettings: { skills: { enabled: true, editors: [] } },
      }) };
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);

      const result = await agentModeService.installSkills(
        ['__other_skills__'],
        userId,
        'session-0e73690d'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('other_skills');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-0e73690d', ['__other_skills__']);
    });
  });

  describe('buildSkillContext', () => {
    it('should add install_skills to allowed tools by default', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('install_skills')).toBe(true);
    });

    it('should expose explicit You.com search tools in foundation tools without the compatibility alias', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('search_web')).toBe(false);
      expect(result.allowedToolNames.has('you_search_web')).toBe(true);
      expect(result.allowedToolNames.has('you_search_news')).toBe(true);
      expect(result.allowedToolNames.has('google_search_web')).toBe(false);
    });

    it('should add skill toolNames to allowed set', () => {
      const skills = [
        { skillId: 's1', name: 'Skill', toolNames: ['tool1', 'tool2'], description: '', isPublished: true },
      ];

      const result = (agentModeService as any).buildSkillContext(skills, ['*'], [], []);

      expect(result.allowedToolNames.has('tool1')).toBe(true);
      expect(result.allowedToolNames.has('tool2')).toBe(true);
    });

    it('grants get_ga4_key_events alongside get_website_analytics (ENG-896 digest gate)', () => {
      const digest = [{ skillId: 'digest', toolNames: ['get_website_analytics'] }];
      expect((agentModeService as any).buildSkillContext(digest, ['*'], [], []).allowedToolNames.has('get_ga4_key_events')).toBe(true);
      const other = [{ skillId: 'x', toolNames: ['tool1'] }];
      expect((agentModeService as any).buildSkillContext(other, ['*'], [], []).allowedToolNames.has('get_ga4_key_events')).toBe(false);
      // Not granted when the analytics skill is not allowed by subscription.
      expect((agentModeService as any).buildSkillContext(digest, ['other'], [], []).allowedToolNames.has('get_ga4_key_events')).toBe(false);
    });

    it('should filter tools by user subscription (skill-level)', () => {
      const skills = [
        { skillId: 's1', name: 'Skill A', toolNames: ['tool1', 'tool2'], description: '', isPublished: true },
        { skillId: 's2', name: 'Skill B', toolNames: ['tool3'], description: '', isPublished: true },
      ];
      // User only has access to skill s1 (not s2)
      const userAllowedSkillIds = ['s1'];

      const result = (agentModeService as any).buildSkillContext(skills, userAllowedSkillIds, [], []);

      expect(result.allowedToolNames.has('tool1')).toBe(true);
      expect(result.allowedToolNames.has('tool2')).toBe(true);
      expect(result.allowedToolNames.has('tool3')).toBe(false);
    });

    it('should build installed skill context message', () => {
      const skills = [
        { skillId: 's1', name: 'Content Creation', description: 'Create content', systemPrompt: 'Custom instructions', toolNames: ['tool1'], isPublished: true },
      ];

      const result = (agentModeService as any).buildSkillContext(skills, ['*'], [], []);

      expect(result.installedSkillContextMsg).toContain('Installed Skills:');
      expect(result.installedSkillContextMsg).toContain('Content Creation');
      expect(result.installedSkillContextMsg).toContain('Create content');
    });

    it('should return empty context message when no skills', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.installedSkillContextMsg).toBe('');
    });

    it('should add unassociated tools when __other_skills__ is associated', () => {
      const publishedSkills = [
          { skillId: 's1', name: 'S1', toolNames: ['t1'], isPublished: true }
      ];
      const mockTools = [
          { name: 't1', definition: {} },
          { name: 'orphan_tool', definition: {} }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildSkillContext([], ['*'], publishedSkills, ['__other_skills__']);

      expect(result.allowedToolNames.has('orphan_tool')).toBe(true);
    });

    it('should exclude infrastructure tools from unassociated tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
          { name: 'orphan_tool', definition: {} },
          { name: 'install_skills', definition: {} }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildSkillContext([], ['*'], publishedSkills, ['__other_skills__']);

      // orphan_tool should be included
      expect(result.allowedToolNames.has('orphan_tool')).toBe(true);
      // install_skills is always included (infrastructure but needed)
      expect(result.allowedToolNames.has('install_skills')).toBe(true);
    });

    // ENG-2299: a published skill belonging to a subscription tier this user can
    // never install must STILL claim its tool out of the shared __other_skills__
    // catch-all — exactly like any other published skill (ENG-1237's isPublished
    // check is the only axis that un-claims a tool). The caller's own tier
    // entitlement governs whether THEY can install that skill directly, not
    // whether its tool leaks into every other tier's catch-all; scoping the
    // catalog by the caller's own allowedSkillIds before computing "claimed"
    // tools would bypass that tier gate instead of fixing it.
    it('should still treat a tool as associated when only a subscription-unreachable published skill claims it', () => {
      const publishedSkills = [
        { skillId: 'reachable-skill', name: 'Reachable', toolNames: ['tool_mine'], isPublished: true },
        { skillId: 'other-tier-skill', name: 'Other Tier Skill', toolNames: ['tool_other_tier'], isPublished: true },
      ];
      const mockTools = [
        { name: 'tool_mine', definition: {} },
        { name: 'tool_other_tier', definition: {} },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      // This subscriber's tier allows 'reachable-skill' and __other_skills__, but
      // NOT 'other-tier-skill' — they can never install it to reach tool_other_tier.
      const userAllowedSkillIds = ['reachable-skill', '__other_skills__'];

      const result = (agentModeService as any).buildSkillContext([], userAllowedSkillIds, publishedSkills, ['__other_skills__']);

      // tool_mine is claimed by 'reachable-skill' (even if not installed), so it
      // must stay out of the catch-all.
      expect(result.allowedToolNames.has('tool_mine')).toBe(false);
      // tool_other_tier is claimed by a published skill this subscriber's tier
      // cannot install — it must stay claimed (hidden) rather than falling
      // through to this tier's __other_skills__ catch-all.
      expect(result.allowedToolNames.has('tool_other_tier')).toBe(false);
    });
  });

  describe('[install-refused] diagnostic (ENG-2299)', () => {
    it('logs the buckets and pool size when __other_skills__ is refused, without changing the result', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue([] as any);

      const result = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');

      expect(result.success).toBe(false);
      expect(result.unavailableSkillIds).toEqual(['__other_skills__']);
      const call = warn.mock.calls.find(([tag]) => tag === '[install-refused]');
      expect(JSON.parse(call![1] as string)).toMatchObject({
        sessionId: 'session-123',
        userId: 'user-123',
        unavailable: ['__other_skills__'],
        catalogSize: 0,
        otherSkillsPoolSize: 0,
      });
      warn.mockRestore();
    });

    it('also logs a partial install, flagged partial, when one requested id is rejected', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([
        { skillId: 'real-skill', name: 'Real', description: 'd', toolNames: ['t1'], isPublished: true },
      ]);
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue([] as any);

      const result = await agentModeService.installSkills(['real-skill', 'ghost'], 'user-123', 'session-123');

      expect(result.success).toBe(true);
      expect(result.rejectedSkillIds).toEqual(['ghost']);
      const call = warn.mock.calls.find(([tag]) => tag === '[install-refused]');
      expect(JSON.parse(call![1] as string)).toMatchObject({ partial: true, unresolved: ['ghost'], requested: ['real-skill', 'ghost'] });
      warn.mockRestore();
    });

    it('still returns the same refusal when the log cannot be built', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => { throw new Error('log sink down'); });
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.installSkills(['__other_skills__'], 'user-123', 'session-123');

      expect(result.success).toBe(false);
      expect(result.unavailableSkillIds).toEqual(['__other_skills__']);
      warn.mockRestore();
    });
  });

  describe('describeToolGateRefusal (ENG-2299)', () => {
    const published = [
      { skillId: 'ads', name: 'Ads', toolNames: ['call_ads'], isPublished: true },
      { skillId: 'draft', name: 'Draft', toolNames: ['call_draft'], isPublished: false },
    ];

    beforeEach(() => {
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue([
        { name: 'call_ads', definition: {} },
        { name: 'call_draft', definition: {} },
        { name: 'loose_tool', definition: {} },
      ] as any);
    });

    it('reports a claimed tool as not installed and not in the pool', () => {
      const d = agentModeService.describeToolGateRefusal('call_ads', published, [], ['ads', '__other_skills__']);
      expect(d.claimedBy).toEqual([{ skillId: 'ads', installed: false, tierAllows: true }]);
      expect(d.inOtherSkillsPool).toBe(false);
      expect(d.otherSkillsInstalled).toBe(false);
      expect(d.tierAllowsOtherSkills).toBe(true);
    });

    it('reports an unclaimed tool as in the pool, and ignores unpublished claimers', () => {
      const loose = agentModeService.describeToolGateRefusal('loose_tool', published, ['__other_skills__'], ['*']);
      expect(loose.inOtherSkillsPool).toBe(true);
      expect(loose.claimedBy).toEqual([]);
      expect(loose.otherSkillsInstalled).toBe(true);
      const draft = agentModeService.describeToolGateRefusal('call_draft', published, [], ['*']);
      expect(draft.claimedBy).toEqual([]);
      expect(draft.inOtherSkillsPool).toBe(true);
    });

    it('distinguishes an unresolved entitlement from a tier that allows nothing', () => {
      const unresolved = agentModeService.describeToolGateRefusal('call_ads', published, [], null);
      expect(unresolved.entitlementResolved).toBe(false);
      const empty = agentModeService.describeToolGateRefusal('call_ads', published, [], []);
      expect(empty.entitlementResolved).toBe(true);
      expect(unresolved.catalogSize).toBe(2);
    });

    it('marks a claiming skill the tier does not allow', () => {
      const d = agentModeService.describeToolGateRefusal('call_ads', published, ['ads'], ['other']);
      expect(d.claimedBy).toEqual([{ skillId: 'ads', installed: true, tierAllows: false }]);
      expect(d.tierAllowsOtherSkills).toBe(false);
    });
  });

  describe('getUnassociatedTools', () => {
    it('should return tools not associated with any published skill', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1', 'tool2'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'tool2', definition: { function: { description: 'desc2' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('orphan_tool');
      expect(result[0].description).toBe('orphan desc');
    });

    it('should NOT treat a tool as associated when only an unpublished (private/org-shared) skill claims it (ENG-1237)', () => {
      // loadAuthorizedSkillCatalog's org-sharing bypass mixes unpublished private/
      // org skills into the same list passed here — a draft skill nobody published
      // must not be able to silently steal a tool out of __other_skills__ for the
      // whole org.
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true },
        { skillId: 'draft1', name: 'Draft Skill', toolNames: ['tool1', 'orphan_tool'], isPublished: false }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('orphan_tool');
    });

    it('should exclude infrastructure tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'install_skills', definition: { function: { description: 'infra1' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('regular_tool');
    });

    it('should return empty array when all tools are associated', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1', 'tool2'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'tool2', definition: { function: { description: 'desc2' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(0);
    });

    it('should handle missing description gracefully', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'tool_no_desc', definition: {} }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('tool_no_desc');
      expect(result[0].description).toBe('tool_no_desc');
    });

    it('should exclude foundation and admin-only tools from unassociated tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'list_predefined_work_plans', definition: { function: { description: 'admin tool' } } },
        { name: 'manage_predefined_work_plan', definition: { function: { description: 'admin tool 2' } } },
        { name: 'list_skills', definition: { function: { description: 'admin tool 3' } } },
        { name: 'resolve_skill', definition: { function: { description: 'foundation resolver' } } },
        { name: 'manage_skill', definition: { function: { description: 'admin tool 5' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('regular_tool');
    });

    it('should exclude get_visual_context from unassociated tools (page-embedded Emma only)', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'get_visual_context', definition: { function: { description: 'page screenshot tool' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('regular_tool');
      expect(result.find((t: any) => t.name === 'get_visual_context')).toBeUndefined();
    });

    it('should exclude get_visual_context via getUnassociatedToolNames (resolveSkillsToToolNames path)', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'get_visual_context', definition: { function: { description: 'page screenshot tool' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const names = agentModeService.getUnassociatedToolNames(publishedSkills);

      expect(names).toContain('regular_tool');
      expect(names).not.toContain('get_visual_context');
    });
  });

  describe('buildAvailableSkillsMessage', () => {
    it('should list published skills not already associated', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'Skill 1', description: 'Desc 1', isPublished: true },
        { skillId: 's2', name: 'Skill 2', description: 'Desc 2', isPublished: true }
      ];
      const associatedSkillIds = ['s1'];

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, associatedSkillIds);

      expect(result).toContain('Available Skills:');
      expect(result).toContain('s2- Skill 2: Desc 2');
      expect(result).not.toContain('s1- Skill 1');
    });

    it('should include __other_skills__ when there are unassociated tools', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, []);

      expect(result).toContain('__other_skills__- other_skills:');
      expect(result).toContain('orphan_tool: orphan desc');
    });

    it('should not include __other_skills__ when already associated', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, ['__other_skills__']);

      expect(result).not.toContain('__other_skills__');
    });

    it('should return empty string when no available skills and no unassociated tools', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      // All skills associated, all tools associated
      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, ['s1']);

      expect(result).toBe('');
    });

    it('should return empty string when no published skills and only infrastructure tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'install_skills', definition: { function: { description: 'infra' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, []);

      expect(result).toBe('');
    });

    // ENG-2299: every call above omits userAllowedSkillIds, so it defaults to
    // ['*'] and the non-wildcard filter branch (`allowedSet.has(...)`) never
    // runs. Covers both branches directly, mirroring buildSkillContext's
    // corrected ENG-2299 test: a tier-excluded skill is hidden from the
    // directly-listed entries, but its tool still stays claimed (hidden) out of
    // __other_skills__ rather than falling through to this tier's catch-all.
    it('wildcard userAllowedSkillIds lists every published skill', () => {
      const publishedSkills = [
        { skillId: 'reachable-skill', name: 'Reachable', description: 'Desc', toolNames: ['tool_mine'], isPublished: true },
        { skillId: 'other-tier-skill', name: 'Other Tier Skill', description: 'Desc', toolNames: ['tool_other_tier'], isPublished: true },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue([] as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, [], ['*']);

      expect(result).toContain('reachable-skill- Reachable');
      expect(result).toContain('other-tier-skill- Other Tier Skill');
    });

    it('non-wildcard userAllowedSkillIds hides a tier-excluded skill from the list but keeps its tool out of __other_skills__', () => {
      const publishedSkills = [
        { skillId: 'reachable-skill', name: 'Reachable', description: 'Desc', toolNames: ['tool_mine'], isPublished: true },
        { skillId: 'other-tier-skill', name: 'Other Tier Skill', description: 'Desc', toolNames: ['tool_other_tier'], isPublished: true },
      ];
      const mockTools = [
        { name: 'tool_mine', definition: { function: { description: 'desc' } } },
        { name: 'tool_other_tier', definition: { function: { description: 'desc' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const userAllowedSkillIds = ['reachable-skill', '__other_skills__'];
      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, [], userAllowedSkillIds);

      // Listed directly: only the reachable skill.
      expect(result).toContain('reachable-skill- Reachable');
      expect(result).not.toContain('other-tier-skill- Other Tier Skill');
      // __other_skills__ catch-all: tool_other_tier stays claimed by the
      // tier-excluded skill, so it must not surface here either.
      expect(result).not.toContain('tool_other_tier');
    });
  });

  describe('getFilteredTools', () => {
    beforeEach(async () => {
      // Mock tools for getFilteredTools tests
      const mockTools = [
        { name: 'read_brand_guidelines', definition: { function: { name: 'read_brand_guidelines', description: 'desc' } } },
        { name: 'install_skills', definition: { function: { name: 'install_skills', description: 'infra' } } },
        { name: 'create_work_plan', definition: { function: { name: 'create_work_plan', description: 'Create work plan' } } },
        { name: 'you_search_web', definition: { function: { name: 'you_search_web', description: 'Search the web with You.com' } } },
        { name: 'you_search_news', definition: { function: { name: 'you_search_news', description: 'Search news with You.com' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      jest.spyOn(agentModeService['toolRegistry'], 'getTool').mockImplementation(
        (name: string) => mockTools.find((t) => t.name === name) as any
      );

      await agentModeService.initialize();
    });

    it('should return only install_skills if no skills associated', async () => {
      // Pass empty set as precomputed allowed names (simulating no associated skills)
      const result = await agentModeService.getFilteredTools('user-123', new Set(['install_skills']));

      // Should have at least install_skills
      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('install_skills');
    });

    it('should return skill tools when skills are associated', async () => {
      // Mock associated skills being passed as precomputed set
      const precomputedNames = new Set(['read_brand_guidelines', 'install_skills']);

      const result = await agentModeService.getFilteredTools('user-123', precomputedNames);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('read_brand_guidelines');
    });

    it('should return install_skills on error', async () => {
      // Force error by passing invalid type to force crash in logic if we want to test try/catch
      // Or better, mock this.toolRegistry.getAllTools to throw
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockImplementationOnce(() => {
        throw new Error('Registry Error');
      });

      const result = await agentModeService.getFilteredTools('user-123', new Set());

      // The catch-all error path stays the strictest toolset: install_skills and nothing else
      // (an unresolved entitlement is deliberately more generous — it keeps the foundation tools).
      expect(result.map((t: any) => t.function?.name || t.name)).toEqual(['install_skills']);
    });

    /*
     * ENG-1978: resolveSkillsToToolNames now returns null when the entitlement could not be
     * resolved (an unknown/malformed tier or a failed settings read), where it previously
     * returned ["*"] and silently granted every tool. getFilteredTools must fail closed: nothing a
     * tier would unlock (paid tools, tools of skills already installed in the session) is
     * returned. Foundation tools and install_skills ARE kept — every tier, Free included, gets
     * them unconditionally on the normal path, so an unresolved tier gets no more than that.
     */
    // filterFunctionCalls is an identity mock in this suite, so these assert the allow-list the
    // unresolved branch hands to it — that list IS the contract.
    const lastAllowList = (): string[] => {
      const { filterFunctionCalls } = require('../services/subscriptionService');
      const calls = (filterFunctionCalls as jest.Mock).mock.calls;
      return calls[calls.length - 1][1];
    };

    it('should fail closed to foundation tools + install_skills when the entitlement is unresolved', async () => {
      const { resolveSkillsToToolNames } = require('../services/subscriptionService');
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce(null);

      await agentModeService.getFilteredTools('user-123', undefined);

      const allowed = lastAllowList();
      expect(allowed).toEqual(expect.arrayContaining(['create_work_plan', 'you_search_web', 'install_skills']));
      expect(allowed).not.toContain('*');
      // Nothing a tier would unlock: no paid, non-foundation tool.
      expect(allowed).not.toContain('launch_retargeting_campaign');
    });

    it('should not carry session-installed skill tools over when the entitlement is unresolved', async () => {
      const { resolveSkillsToToolNames } = require('../services/subscriptionService');
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce(null);

      await agentModeService.getFilteredTools('user-123', new Set(['installed_skill_tool', 'create_work_plan']));

      const allowed = lastAllowList();
      expect(allowed).not.toContain('installed_skill_tool');
      expect(allowed).toContain('create_work_plan');
    });

    /*
     * A caller that already resolved the entitlement to null (unresolved) passes that null as the
     * third argument. It must be honoured, not treated as "not provided": re-fetching would read
     * the tier a second time per turn, double-report the telemetry, and could resolve differently
     * from the value the caller already used to build its own tool context.
     */
    it('should not re-fetch the entitlement when the caller passes an explicit null', async () => {
      const { getAllowedSkills, resolveSkillsToToolNames } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockClear();
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce(null);

      await agentModeService.getFilteredTools('user-123', undefined, null);

      expect(getAllowedSkills).not.toHaveBeenCalled();
      expect(resolveSkillsToToolNames).toHaveBeenLastCalledWith(null, 'user-123');
      expect(lastAllowList()).not.toContain('*');
    });

    it('should use precomputed allowed names when provided', async () => {
      const precomputedNames = new Set(['install_skills', 'read_brand_guidelines']);

      const result = await agentModeService.getFilteredTools(
        'user-123',
        precomputedNames
      );

      // Result should be filtered based on precomputed names
      expect(result).toBeDefined();
      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('read_brand_guidelines');
    });

    it('should include foundation tools for legacy sessions even when subscription is restrictive', async () => {
      // Legacy sessions pass undefined for precomputedAllowedSkillToolNames,
      // so all tools pass the context filter. But a restrictive subscription
      // would strip foundation tools. The fix ensures FOUNDATION_TOOLS are
      // always added to allowedFunctionCalls before the subscription filter.
      const { resolveSkillsToToolNames, filterFunctionCalls: mockFilterFn } = require('../services/subscriptionService');
      // Subscription only allows read_brand_guidelines (no foundation tools)
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce(['read_brand_guidelines']);
      // Use realistic filter: only pass tools whose name is in allowed list
      (mockFilterFn as jest.Mock).mockImplementationOnce((tools: any[], allowed: string[]) => {
        if (allowed.includes('*')) return tools;
        return tools.filter((t: any) => {
          const name = t.function?.name || t.name;
          return !name || allowed.includes(name);
        });
      });

      // Legacy session: no precomputed names (undefined)
      const result = await agentModeService.getFilteredTools('user-123', undefined);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      // Foundation tools should bypass subscription filter
      expect(toolNames).toContain('create_work_plan');
      expect(toolNames).toContain('install_skills');
      expect(toolNames).toContain('you_search_web');
      expect(toolNames).not.toContain('search_web');
      // Non-foundation tool allowed by subscription should also be present
      expect(toolNames).toContain('read_brand_guidelines');
    });

    it('should not expose a deprecated search tool when a legacy skill allows search_web', async () => {
      const { filterFunctionCalls: mockFilterFn } = require('../services/subscriptionService');
      (mockFilterFn as jest.Mock).mockImplementationOnce((tools: any[], allowed: string[]) => {
        if (allowed.includes('*')) return tools;
        return tools.filter((t: any) => {
          const name = t.function?.name || t.name;
          return !name || allowed.includes(name);
        });
      });

      const result = await agentModeService.getFilteredTools('user-123', new Set(['search_web']));

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).not.toContain('search_web');
      expect(toolNames).not.toContain('you_search_web');
    });
  });

  // ENG-508 / ENG-867: the "LinkedIn Profile Reader" skill grants exactly one tool,
  // linkedin_outreach. Prove that installing it makes that tool reach a session's
  // toolbox — even for a user whose subscription does NOT include it (the Founder
  // audit case) — and that WITHOUT the skill the tool is excluded, which is the
  // stale-headline pre-fix state. This exercises the real getFilteredTools gating.
  describe('LinkedIn Profile Reader skill grant (ENG-508)', () => {
    beforeEach(async () => {
      const mockTools = [
        { name: 'install_skills', definition: { function: { name: 'install_skills', description: 'infra' } } },
        { name: 'you_search_web', definition: { function: { name: 'you_search_web', description: 'Search the web' } } },
        { name: 'linkedin_outreach', definition: { function: { name: 'linkedin_outreach', description: 'LinkedIn outreach incl. get-profile' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      await agentModeService.initialize();

      // Realistic subscription filter: only the explicitly-allowed names survive.
      const { filterFunctionCalls: mockFilterFn } = require('../services/subscriptionService');
      (mockFilterFn as jest.Mock).mockImplementation((tools: any[], allowed: string[]) => {
        if (allowed.includes('*')) return tools;
        return tools.filter((t: any) => {
          const name = t.function?.name || t.name;
          return !name || allowed.includes(name);
        });
      });
    });

    it('exposes linkedin_outreach when the skill is installed, even under a subscription that omits it', async () => {
      const { resolveSkillsToToolNames } = require('../services/subscriptionService');
      // Subscription grants NOTHING extra — the tool must come solely from the
      // session-installed skill's toolNames (getFilteredTools session-tool bypass).
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce([]);

      // Precomputed allowed set = what buildSkillContext produces once the
      // "LinkedIn Profile Reader" skill (toolNames: ['linkedin_outreach']) is associated.
      const withSkill = new Set(['install_skills', 'linkedin_outreach']);
      const result = await agentModeService.getFilteredTools('user-123', withSkill, []);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('linkedin_outreach');
    });

    // The step the tests below this one used to ASSUME: buildSkillContext turning the
    // real skill RECORD into the allowed-tool set. It is gated on the skill being in
    // the user's subscription-allowed IDs, and every tier here uses an explicit list —
    // so a published-but-unenrolled skill silently contributes nothing.
    it('unions linkedin_outreach from the real skill record only when the tier allows the skillId', async () => {
      const { buildProfileReaderSkill } = require('../scripts/seed-eng508-linkedin-profile-reader-skill');
      const skill = buildProfileReaderSkill('profile-reader-id');
      expect(skill.toolNames).toEqual(['linkedin_outreach']);

      // ENROLLED: skillId present in the subscription-allowed list → tool is granted.
      const enrolled = (agentModeService as any).buildSkillContext(
        [skill],
        ['profile-reader-id'], // userAllowedSkillIds (explicit, non-wildcard tier)
        [],
        ['profile-reader-id']
      );
      expect(enrolled.allowedToolNames.has('linkedin_outreach')).toBe(true);

      // NOT ENROLLED: same published skill, but the tier's explicit list omits it →
      // its tools are dropped and the audit falls back to the stale search path.
      const unenrolled = (agentModeService as any).buildSkillContext(
        [skill],
        ['some-other-skill-id'],
        [],
        ['profile-reader-id']
      );
      expect(unenrolled.allowedToolNames.has('linkedin_outreach')).toBe(false);
    });

    it('excludes linkedin_outreach when the skill is NOT installed (pre-fix stale-headline state)', async () => {
      const { resolveSkillsToToolNames } = require('../services/subscriptionService');
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce([]);

      // No LinkedIn skill associated → the authenticated tool is unreachable and the
      // model can only fall back to you_search_web (the stale search cache).
      const withoutSkill = new Set(['install_skills', 'you_search_web']);
      const result = await agentModeService.getFilteredTools('user-123', withoutSkill, []);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).not.toContain('linkedin_outreach');
      expect(toolNames).toContain('you_search_web');
    });
  });

  describe('updateConversationContext', () => {
    it('should add/update Installed Skills message', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\ns1- Skill 1: Description',
        '' // availableSkillContextMsg
      );

      const installedMsg = messages.find(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsg).toBeDefined();
    });

    it('should remove old context messages before adding new', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Installed Skills:\nOLD CONTENT' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nNEW CONTENT',
        '' // availableSkillContextMsg
      );

      const installedMsgs = messages.filter(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsgs).toHaveLength(1);
      expect(installedMsgs[0].content).toContain('NEW CONTENT');
    });

    it('should not add installed skills message if empty', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        '',
        '' // availableSkillContextMsg
      );

      const installedMsg = messages.find(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsg).toBeUndefined();
    });

    it('should update Available Skills message', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nOLD LIST' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        '',
        'Available Skills:\nNEW LIST' // availableSkillContextMsg
      );

      const availableMsgs = messages.filter(m => m.content?.startsWith('Available Skills:'));
      expect(availableMsgs).toHaveLength(1);
      expect(availableMsgs[0].content).toContain('NEW LIST');
      // Should be placed after system prompt (index 1)
      expect(messages[1].content).toContain('NEW LIST');
    });

    it('should have net 0 change when both old and new context messages exist', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nOLD' },
        { role: 'assistant', content: 'Installed Skills:\nOLD' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
      ];
      const before = messages.length;

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nNEW',
        'Available Skills:\nNEW'
      );

      expect(messages.length).toBe(before);
    });

    it('should have net +1 when Installed Skills is added for the first time', () => {
      // Simulates the first install_skills call in a session that started with no installed skills
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nOLD' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'I will help' },
      ];
      const before = messages.length;

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nBrand Strategy',
        'Available Skills:\nNEW'
      );

      expect(messages.length).toBe(before + 1);
    });

    it('should have net -1 when Available Skills becomes empty (all skills installed)', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nSome skills' },
        { role: 'assistant', content: 'Installed Skills:\nOLD' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
      ];
      const before = messages.length;

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nNEW',
        '' // empty — all skills now installed
      );

      expect(messages.length).toBe(before - 1);
    });

    it('net -1 should not cause first response message to be dropped when initialMessageCount is adjusted', () => {
      // This test reproduces the production bug scenario:
      // 1. Session has both Available Skills and Installed Skills context
      // 2. LLM makes tool calls, assistant message pushed to array
      // 3. install_skills called, skillsUpdated = true
      // 4. updateConversationContext removes Available Skills (empty), net -1
      // 5. Without the fix, messages.slice(initialMessageCount) skips the first assistant message
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nMeta Ads, Landing Page' },
        { role: 'assistant', content: 'Installed Skills:\nBrand Strategy' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'previous response' },
        { role: 'user', content: 'yes.' },
      ];

      let initialMessageCount = messages.length; // 6

      // Simulate iteration 1: LLM returns assistant + tool_calls
      const firstAssistantMsg = { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'update_brand', arguments: '{}' } }] };
      messages.push(firstAssistantMsg);
      messages.push({ role: 'tool', tool_call_id: 'tc1', content: 'success' });

      // Simulate install_skills call
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tc2', function: { name: 'install_skills', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: 'tc2', content: 'installed' });

      // Simulate skillsUpdated: updateConversationContext with empty availableSkillContextMsg
      const preUpdateLen = messages.length;
      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nBrand Strategy + Other Skills',
        '' // all skills now installed
      );
      const delta = messages.length - preUpdateLen;
      initialMessageCount += delta; // THE FIX: adjust initialMessageCount

      // Simulate final assistant response
      messages.push({ role: 'assistant', content: 'Done!' });

      // Slice response messages (same as production code)
      const responseMessages = messages.slice(initialMessageCount).filter(
        (msg: any) => msg.role !== 'user'
      );

      // The first response message MUST be the assistant with tool_calls
      expect(responseMessages[0]).toBe(firstAssistantMsg);
      expect(responseMessages[0].role).toBe('assistant');
      expect(responseMessages[0].tool_calls).toBeDefined();
    });
  });

  describe('getFoundationToolNames', () => {
    beforeEach(() => {
      // Reset to defaults before each test
      (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
    });

    it('should return a Set containing default foundation tool names', () => {
      const foundationTools = agentModeService.getFoundationToolNames();

      expect(foundationTools).toBeInstanceOf(Set);
      expect(foundationTools.has('install_skills')).toBe(true);
      expect(foundationTools.has('list_available_skills')).toBe(true);
      expect(foundationTools.has('resolve_skill')).toBe(true);
      expect(foundationTools.has('read_brand_guidelines')).toBe(true);
      expect(foundationTools.has('update_brand_guidelines')).toBe(true);
      expect(foundationTools.has('search_knowledge_base')).toBe(true);
      expect(foundationTools.has('list_knowledge_base_files')).toBe(true);
      expect(foundationTools.has('read_knowledge_base_files')).toBe(true);
      expect(foundationTools.has('create_work_plan')).toBe(true);
      expect(foundationTools.has('modify_work_plan')).toBe(true);
      expect(foundationTools.has('set_work_plan_status')).toBe(true);
      expect(foundationTools.has('search_leads')).toBe(true);
      expect(foundationTools.has('get_lead_lists')).toBe(true);
      // get_registration_status is intentionally NOT a foundation tool — it
      // queries AW-Users (signup/premium status) for arbitrary emails, which is
      // an admin/founder funnel concern and an account-enumeration oracle if
      // exposed to every tenant. It lives in ADMIN_SKILL_TOOL_NAMES instead.
      expect(foundationTools.has('get_registration_status')).toBe(false);
      // S3 overflow retrieval tools must always be available so the LLM can read
      // large tool responses that were offloaded to S3 by the
      // TOOL_RESPONSE_S3_THRESHOLD overflow mechanism.
      expect(foundationTools.has('search_tool_response')).toBe(true);
      expect(foundationTools.has('read_tool_response')).toBe(true);
    });

    it('should not contain domain-specific tools', () => {
      const foundationTools = agentModeService.getFoundationToolNames();

      expect(foundationTools.has('generate_image')).toBe(false);
      expect(foundationTools.has('create_blog_article')).toBe(false);
      expect(foundationTools.has('create_social_media_posts')).toBe(false);
    });
  });

  describe('getAdminToolNames', () => {
    it('ENG-1870 makes the evaluation lifecycle available to Emma administrators', () => {
      expect(agentModeService.getAdminToolNames()).toContain('evaluation_workspace');
    });
    it('does not expose manage_user_guide (ENG-163: legacy Notion write tool removed)', () => {
      // The admin tool registry (ADMIN_SKILL_TOOL_NAMES) must no longer carry the
      // retired manage_user_guide Notion write tool.
      expect(agentModeService.getAdminToolNames()).not.toContain('manage_user_guide');
    });

    it('still exposes other admin tools', () => {
      const adminTools = agentModeService.getAdminToolNames();
      expect(adminTools).toContain('manage_user_notes');
      expect(adminTools).toContain('get_registration_status');
    });
  });

  describe('loadFoundationTools', () => {
    beforeEach(() => {
      (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
    });

    it('should load foundation tools from DB when setting exists', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue({
        settingName: 'foundation_tools',
        settingValue: JSON.stringify(['tool_a', 'tool_b', 'tool_c']),
      });

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      const mandatoryTools = (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS as string[];
      // ENG-404: the override is additive on top of DEFAULT_FOUNDATION_TOOLS, so
      // the active set is DEFAULT ∪ override ∪ MANDATORY — a stale override can
      // never strip a shipped default.
      expect(tools.size).toBe(
        new Set([...AgentModeService.DEFAULT_FOUNDATION_TOOLS, 'tool_a', 'tool_b', 'tool_c', ...mandatoryTools]).size
      );
      expect(tools.has('tool_a')).toBe(true);
      expect(tools.has('tool_b')).toBe(true);
      expect(tools.has('tool_c')).toBe(true);
      // A DEFAULT-only tool absent from the override must still be present.
      expect(tools.has('search_knowledge_base')).toBe(true);
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.has('list_available_skills')).toBe(true);
      expect(tools.has('resolve_skill')).toBe(true);
      expect(tools.has('you_search_web')).toBe(true);
      expect(tools.has('you_search_news')).toBe(true);
      expect(tools.has('google_search_web')).toBe(false);
      expect(tools.has('search_tool_response')).toBe(true);
      expect(tools.has('read_tool_response')).toBe(true);
      // Force-merged so a DB config can't strip the self-status tool (else Emma
      // falls back to assess_client_health, the admin lookup-by-email path).
      expect(tools.has('get_account_status')).toBe(true);
      // Coding agent is also force-merged so stale DB settings cannot make
      // landing-page edit flows fail before a recoverable run exists.
      expect(tools.has('coding_agent')).toBe(true);
    });

    it('force-merges get_account_status even when a DB config omits it', async () => {
      // Regression: get_account_status must always be reachable so Emma can
      // report the caller's own account; a stored foundation_tools list that
      // leaves it out previously made it "not available" → Emma fell back to
      // assess_client_health (admin lookup by email).
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue({
        settingName: 'foundation_tools',
        settingValue: JSON.stringify(['tool_a']), // intentionally omits get_account_status
      });

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('get_account_status')).toBe(true);
    });

    it('should fall back to defaults when no DB setting exists', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue(null);

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.size).toBe(AgentModeService.DEFAULT_FOUNDATION_TOOLS.length);
    });

    it('should fall back to defaults when DB returns invalid JSON', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue({
        settingName: 'foundation_tools',
        settingValue: 'not-valid-json',
      });

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.size).toBe(AgentModeService.DEFAULT_FOUNDATION_TOOLS.length);
    });

    it('should fall back to defaults when DB throws an error', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockRejectedValue(new Error('DynamoDB error'));

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('install_skills')).toBe(true);
    });
  });

  describe('updateFoundationTools', () => {
    beforeEach(() => {
      (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
    });

    it('should update foundation tools in DB and in-memory', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.setSetting = jest.fn().mockResolvedValue(undefined);

      const result = await agentModeService.updateFoundationTools(['tool_x', 'tool_y'], 'admin@test.com');
      // ENG-404: persisted set is DEFAULT ∪ override ∪ MANDATORY (additive).
      const expected = [
        ...new Set([
          ...AgentModeService.DEFAULT_FOUNDATION_TOOLS,
          'tool_x',
          'tool_y',
          ...(AgentModeService as any).MANDATORY_FOUNDATION_TOOLS,
        ]),
      ];

      expect(result).toEqual(expected);
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'foundation_tools',
        JSON.stringify(expected),
        expect.any(String),
        'admin@test.com'
      );
      const tools = agentModeService.getFoundationToolNames();
      expect(tools.size).toBe(new Set(expected).size);
      expect(tools.has('tool_x')).toBe(true);
      expect(tools.has('tool_y')).toBe(true);
      expect(tools.has('resolve_skill')).toBe(true);
      expect(tools.has('coding_agent')).toBe(true);
    });

    it('should deduplicate tool names', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.setSetting = jest.fn().mockResolvedValue(undefined);

      const result = await agentModeService.updateFoundationTools(['tool_a', 'tool_a', 'tool_b'], 'admin@test.com');

      // ENG-404: DEFAULT ∪ override ∪ MANDATORY, de-duplicated.
      expect(result).toEqual([
        ...new Set([
          ...AgentModeService.DEFAULT_FOUNDATION_TOOLS,
          'tool_a',
          'tool_b',
          ...(AgentModeService as any).MANDATORY_FOUNDATION_TOOLS,
        ]),
      ]);
    });
  });

  describe('getSkillsForDisplay', () => {
    it('returns a full authorized Skill snapshot without widening the display projection', async () => {
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([{ skillId: 'skill-1', name: 'Web Search', description: 'Search tools', toolNames: [], isPublished: true, welcomeMessage: 'Start here.' }]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
      await expect(agentModeService.getAuthorizedSkill('skill-1', 'user-1')).resolves.toEqual(expect.objectContaining({ welcomeMessage: 'Start here.' }));
    });
    it('fails closed when an upstream catalog returns another user\'s pending-review skill', async () => {
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([{ skillId: 'pending', name: 'Pending', description: 'd', toolNames: [], ownerId: 'owner-1', visibility: 'pending_review', isPublished: true }]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(result).toEqual([]);
    });
    it('admits an enabled same-org private skill when the restricted subscription includes it', async () => {
      const orgSkill = { skillId: 'org-skill', name: 'Org Skill', description: 'd', toolNames: ['read_tool'], ownerId: 'owner-1', orgId: 'org-1', visibility: 'private', isPublished: false };
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1', shareSettings: { skills: { enabled: true, editors: [] } } }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([orgSkill]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue([]);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', 'org-1');
      expect(result).toEqual([expect.objectContaining({ skillId: 'org-skill' })]);
    });
    it('does not admit another member\'s private skill when org skill sharing is disabled', async () => {
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1', shareSettings: { skills: { enabled: false, editors: [] } } }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
      expect(result).toEqual([]);
    });
    it.each(['user', 'org'])('preserves owned and public skills when the %s lookup fails transiently', async (failure) => {
      const catalog = [
        { skillId: 'own', name: 'Own', description: 'd', toolNames: [], ownerId: 'member-1' },
        { skillId: 'public', name: 'Public', description: 'd', toolNames: [], isPublished: true },
      ];
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: failure === 'user'
        ? jest.fn().mockRejectedValue(new Error('transient'))
        : jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockRejectedValue(new Error('transient')) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue(catalog);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
      expect(result.map(skill => skill.skillId)).toEqual(['own', 'public']);
    });
    it('should return published skills with installed status and toolNames', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Web Search', description: 'Search tools', toolNames: ['search_web'], isPublished: true, welcomeMessage: 'Do not expose.' },
        { skillId: 'skill-2', name: 'Image Gen', description: 'Image tools', toolNames: ['generate_image'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);

      const result = await agentModeService.getSkillsForDisplay(['skill-1'], 'user-1');

      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ skillId: 'skill-1', name: 'Web Search', installed: true, toolNames: ['search_web'] }),
        expect.objectContaining({ skillId: 'skill-2', name: 'Image Gen', installed: false, toolNames: ['generate_image'] }),
      ]));
      expect(result.find(skill => skill.skillId === 'skill-1')).not.toHaveProperty('welcomeMessage');
    });

    it('should filter skills by subscription when not wildcard', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Allowed Skill', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Blocked Skill', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['skill-1']);

      const result = await agentModeService.getSkillsForDisplay([], 'user-1');

      expect(result.some(s => s.skillId === 'skill-1')).toBe(true);
      expect(result.some(s => s.skillId === 'skill-2')).toBe(false);
    });

    it('should return no skills when no userId and public default is empty', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getPublicAllowedSkills } = require('../services/subscriptionService');
      (getPublicAllowedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.getSkillsForDisplay([]);

      expect(result).toHaveLength(0);
    });

    it('should return allowed skills when no userId and public config is set', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Skill 2', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getPublicAllowedSkills } = require('../services/subscriptionService');
      (getPublicAllowedSkills as jest.Mock).mockResolvedValue(['skill-1']);

      const result = await agentModeService.getSkillsForDisplay([]);

      expect(result.some(s => s.skillId === 'skill-1')).toBe(true);
      expect(result.some(s => s.skillId === 'skill-2')).toBe(false);
    });

    it('should include __other_skills__ virtual entry when allowed', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);

      // Mock the tool registry to have some tools
      const mockToolRegistry = (agentModeService as any).toolRegistry;
      mockToolRegistry.getAllTools.mockReturnValue([
        { name: 'orphan_tool', definition: { function: { description: 'An orphan tool' } } },
      ]);

      const result = await agentModeService.getSkillsForDisplay([], 'user-1');

      const otherSkill = result.find(s => s.skillId === '__other_skills__');
      expect(otherSkill).toBeDefined();
      expect(otherSkill!.name).toBe('Other Skills');
      expect(otherSkill!.toolNames).toContain('orphan_tool');
    });

    it('does not double-list a tool under Other Skills when an unpublished skill\'s own card already shows it (ENG-1237 follow-up)', async () => {
      // The ENG-1237 fix correctly stops an unpublished skill from removing its
      // tools from the installable __other_skills__ pool — but that skill's own
      // card in this same response already lists those toolNames. This is a
      // display-only dedup: `draft_tool` must still count toward whether
      // __other_skills__ appears at all and must still be installable through it,
      // it just shouldn't be repeated in the rendered toolNames list.
      const unpublishedOrgSkill = {
        skillId: 'draft-skill', name: 'Draft Skill', description: 'd',
        toolNames: ['draft_tool'], isPublished: false, ownerId: 'owner-1', orgId: 'org-1', visibility: 'private',
      };
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({
        orgId: 'org-1', ownerUserId: 'owner-1',
        shareSettings: { skills: { enabled: true, editors: [] } },
      }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([unpublishedOrgSkill]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);

      const mockToolRegistry = (agentModeService as any).toolRegistry;
      mockToolRegistry.getAllTools.mockReturnValue([
        { name: 'draft_tool', definition: { function: { description: 'Claimed by the draft skill' } } },
        { name: 'orphan_tool', definition: { function: { description: 'Claimed by nothing' } } },
      ]);

      const result = await agentModeService.getSkillsForDisplay([], 'member-1');

      const draftCard = result.find(s => s.skillId === 'draft-skill');
      const otherSkill = result.find(s => s.skillId === '__other_skills__');
      expect(draftCard!.toolNames).toContain('draft_tool');
      // Still installable/present because the real pool is non-empty (ENG-1237 behavior).
      expect(otherSkill).toBeDefined();
      expect(otherSkill!.toolNames).toContain('orphan_tool');
      // But not repeated — it's already shown on the draft skill's own card.
      expect(otherSkill!.toolNames).not.toContain('draft_tool');
    });
  });
});
