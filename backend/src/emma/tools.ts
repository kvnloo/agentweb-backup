import { agentModeService } from '../services/agentModeService';
import { normalizeMetaCampaignIds } from '../utils/metaCampaignIds';
import { emmaToolRegistry } from './registry';
import { auditCampaigns } from '../services/adUtmAuditService';
import type { AdPlatform } from '../utils/adUtm';
import { metaAdReadPort, googleAdReadPort, linkedInAdReadPort } from '../services/adUtmAuditAdapters';
import { accountMemoryDb, orgMemoryDb, userDb } from '../services/db';
import { crmDb } from '../services/db';
import { askCrm, AskCrmLead } from '../services/askCrmService';
import { getAccountSummary } from '../services/accountSummaryService';
import { dealDb, DealAuthError, DealNotFoundError, DEAL_STAGES, type DealStage } from '../services/dealDb';
import { contactEventsDb, normalizeContactId } from '../services/contactEventsDb';
import { chatbotDb } from '../services/chatbotService';
import { incrementUserTokenUsage } from '../services/tokenUsageService';
import { getExecutionsWithAssets } from '../routes/tasks';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';
import { getUserFunnelStatusIssueTags, getUserFunnelStatusLabel } from '../utils/userFunnelStatus';
import { humanEvalService, HumanEvalReviewType } from '../services/humanEvalService';
import { enqueueAutoHumanEval } from '../services/autoHumanEvalService';
import { v4 as uuidv4 } from 'uuid';
import {
  buildPendingUserQuestion,
  renderQuestionPrompt,
  AskUserQuestionError,
  type AskUserQuestionOption,
} from '../services/agentMode/core/askUserQuestion';

// Register browser cookie persistence tools
import './browserCookieTools';

// Register email lookup / find tool (provider-agnostic)
import './emailLookupTool';

emmaToolRegistry.register({
  name: 'enqueue_human_eval',
  definition: {
    name: 'enqueue_human_eval',
    description:
      'Send a finished output to the AgentWeb human eval Slack channel. Use only for creative images, landing pages, or lead enrichment outputs. ' +
      'Matt reviews creative images and landing pages. Fangfang reviews lead enrichment. Reviewers reply in the Slack thread with free-form feedback.',
    inputSchema: {
      type: 'object',
      properties: {
        review_type: {
          type: 'string',
          enum: ['creative_image', 'landing_page', 'lead_enrichment'],
          description: 'The narrow v0 eval route. creative_image and landing_page go to Matt; lead_enrichment goes to Fangfang.'
        },
        output_summary: {
          type: 'string',
          description: 'Short description of the output and what the reviewer should inspect.'
        },
        artifact_url: {
          type: 'string',
          description: 'Optional URL to the image, landing page, HTML file, report, or lead enrichment artifact.'
        },
        chat_url: {
          type: 'string',
          description: 'Optional direct URL to the associated Agent Mode or iShare chat. If omitted, the current session link is used.'
        },
        original_request: {
          type: 'string',
          description: 'Optional original user ask or prompt that produced the output.'
        },
        agent_run_id: {
          type: 'string',
          description: 'Optional AgentRun ID if available.'
        }
      },
      required: ['review_type', 'output_summary']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    const sessionId = context?.sessionId;

    const candidate = await humanEvalService.createCandidate({
      reviewType: args.review_type as HumanEvalReviewType,
      outputSummary: args.output_summary,
      artifactUrl: args.artifact_url,
      chatUrl: args.chat_url,
      originalRequest: args.original_request,
      agentRunId: args.agent_run_id,
      userId,
      sessionId,
    });

    return {
      success: true,
      message: `Sent ${candidate.reviewType} output to ${candidate.reviewer} for human eval.`,
      candidateId: candidate.candidateId,
      reviewer: candidate.reviewer,
      slackChannel: candidate.slackChannel,
      slackMessageTs: candidate.slackMessageTs,
    };
  }
});

// ENG-396: AskUserQuestion — a structured, BLOCKING option-select prompt. Emma
// emits it to force a human choice on an immutable/irreversible parameter
// before building. It returns awaitingUserConfirmation:true so the agent loop
// HALTS (see collectConfirmationPrompt); the answer is persisted structurally
// on the session and only an inbound USER selection resolves it — the model
// cannot self-answer.
//
// META-SCOPED, NOT OBJECTIVE-SCOPED (2026-07-25): originally restricted to
// "Meta campaign objective only." That was narrower than intended — the
// restriction is meant to bound the DOMAIN (Meta Ads), not the specific field
// within it. Widened to any high-stakes/irreversible Meta Ads decision (e.g.
// objective, special ad category), still explicitly NOT general-purpose across
// other domains/platforms. Every part of the underlying mechanism (persistence,
// the real UI card, the answer channel, headless park, full-autonomy
// auto-take, delegation, archive, MCP wiring) is fully generic with zero
// Meta-specific logic and was proven working end-to-end live before this was
// widened — only the description below is what keeps this Meta-bounded, and
// that's a prompt-level restriction, not code-enforced.
//
// The Meta objective write gate (agentModeService.ts,
// resolveCampaignObjectiveGate) is UNCHANGED and independent of this — it
// still enforces the objective deterministically at CAMPAIGN CREATE
// regardless of whether Emma calls this tool voluntarily for anything else
// within Meta. This only widens Emma's OWN judgment-based use of the card
// within Meta; it does not add a new hard-enforced gate for other Meta
// entities — that requires its own dedicated gate, built the same way
// ENG-400 was, per irreversible action.
emmaToolRegistry.register({
  name: 'ask_user_question',
  definition: {
    name: 'ask_user_question',
    description: `Ask the user a structured, blocking multiple-choice question and STOP until they pick. SCOPE: Meta Ads only — do NOT use this for Google Ads, LinkedIn, or any other platform/domain decision, no matter how high-stakes. Within Meta Ads, use this ONLY for a decision that is high-stakes or IRREVERSIBLE and that the user (not you) must own — e.g. the immutable campaign objective, a special ad category with legal/compliance implications, or a similarly consequential Meta-specific choice. Do NOT use it for routine confirmations or reversible Meta choices — those are yours to make with your own best judgment (the existing target-confirmation flow on writes still applies where it already does).

Provide 2–4 options, each with a one-line \`consequence\`. EXACTLY ONE option must be marked recommended:true with a one-line \`why\` grounded in real signal from this session (e.g. "162 LEAD events fired on your pixel in the last 30d") — the recommendation is the point. Optionally set allow_emma_decide:true to offer a "Let Emma decide" delegation button (proceeds with the recommended option, logged).

After you call this the run BLOCKS: you will NOT be able to answer it yourself and no further action executes until the user selects. Do not restate the options as prose asking for a "yes/confirm" — emit this tool instead.

Ask only ONE question per turn. If several decisions are needed, ask the single most blocking/irreversible one now; the rest come up one at a time in later turns after each is answered. A second question emitted while one is still awaiting is rejected — never batch them.

If the user replies with a TYPED message instead of clicking an option, that open card is abandoned (it freezes as unanswered) — do NOT infer their choice from the prose, even if it looks like they named an option. If you still need the answer, simply emit a FRESH card to ask again. Only an explicit click counts as the answer.`,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask, e.g. "Which Meta campaign objective? It cannot be changed after launch."' },
        intro: { type: 'string', description: 'Optional one- or two-sentence lead-in shown ABOVE the question on the card (e.g. context you just gathered). A card may come with text — use this instead of separate prose. Do NOT restate the options here.' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: '2–4 options; exactly one with recommended:true and a one-line why.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional stable id; auto-generated from position if omitted.' },
              label: { type: 'string', description: 'Short button label, e.g. "Leads".' },
              consequence: { type: 'string', description: 'One-line consequence of choosing this option.' },
              recommended: { type: 'boolean', description: 'Set true on EXACTLY ONE option.' },
              why: { type: 'string', description: 'One-line justification. REQUIRED on the recommended option.' },
              payload: { type: 'object', description: 'The concrete machine parameters this option implies (applied verbatim by the consumer — no re-inference).' },
            },
            required: ['label', 'consequence'],
          },
        },
        immutable: { type: 'boolean', description: 'True if the parameter is irreversible (e.g. Meta objective). Immutable questions never auto-resolve in headless runs.' },
        allow_emma_decide: { type: 'boolean', description: 'Offer a "Let Emma decide" delegation button that takes the recommended option.' },
        kind: { type: 'string', description: 'Optional consumer tag (e.g. "meta_objective") identifying which class of decision this is, for a write gate to correlate against without inspecting question text.' },
      },
      required: ['question', 'options'],
    },
  },
  execute: async (args: any, context: any) => {
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return { success: false, message: 'ask_user_question requires an active session.' };
    }
    // Normalize incoming options: assign a stable id when the model omitted one.
    const options: AskUserQuestionOption[] = Array.isArray(args.options)
      ? args.options.map((o: any, i: number) => ({
          id: typeof o?.id === 'string' && o.id.trim() !== '' ? o.id : `option-${i + 1}`,
          label: o?.label,
          consequence: o?.consequence,
          recommended: o?.recommended === true,
          why: o?.why,
          payload: o?.payload,
        }))
      : [];

    let question;
    try {
      question = buildPendingUserQuestion({
        questionId: uuidv4(),
        question: args.question,
        intro: typeof args.intro === 'string' ? args.intro : undefined,
        options,
        immutable: args.immutable === true,
        allowEmmaDecide: args.allow_emma_decide === true,
        kind: typeof args.kind === 'string' ? args.kind : undefined,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof AskUserQuestionError) {
        // Surface the validation problem so the model can fix and re-emit.
        return { success: false, message: `Invalid ask_user_question: ${err.message}` };
      }
      throw err;
    }

    // Persist as the single active question. The guard enforces one live question
    // at a time: if a question is already awaiting, the write is refused (null) and
    // we tell the model to ask this one later — questions are asked ONE AT A TIME,
    // never batched, so a second call can't overwrite the pending one's slot.
    const posted = await chatbotDb.updateSessionAskUserQuestion(sessionId, question, {
      failIfAwaitingExists: true,
    });
    if (!posted) {
      return {
        success: false,
        message:
          'A question is already waiting for the user to answer. Only ONE question can be open at a time — do not ask another now. Wait until the current question is answered, then ask this one in a later turn (one question per turn).',
      };
    }

    const prompt = renderQuestionPrompt(question);
    // awaitingUserConfirmation halts the loop; type + options let the chat card
    // render and the frontend post back a structured selection. No field tells
    // the model how to answer — only a user selection can resolve it.
    return {
      success: true,
      awaitingUserConfirmation: true,
      type: 'ask_user_question',
      questionId: question.questionId,
      question: question.question,
      ...(question.intro ? { intro: question.intro } : {}),
      options: question.options,
      recommendedOptionId: question.recommendedOptionId,
      allowEmmaDecide: question.allowEmmaDecide,
      confirmationPrompt: prompt,
      summary: prompt,
    };
  },
});

function outputFieldNames(outputFields: unknown): string[] {
  if (!Array.isArray(outputFields)) return [];
  return outputFields
    .map((field: any) => typeof field?.name === 'string' ? field.name : '')
    .filter(Boolean);
}

function actionOutputFields(outputFields: unknown): Array<{ name: string; instruction: string; overwrite_policy?: 'fill_if_empty' | 'always_overwrite' }> {
  if (!Array.isArray(outputFields)) return [];
  return outputFields
    .map((field: any) => ({
      name: typeof field?.name === 'string' ? field.name : '',
      instruction: typeof field?.instruction === 'string' ? field.instruction : '',
      overwrite_policy: field?.overwrite_policy === 'always_overwrite' ? 'always_overwrite' as const : undefined,
    }))
    .filter((field) => field.name && field.instruction);
}

function enqueueLeadEnrichmentEval(input: {
  summary: any;
  userId?: string;
  sessionId?: string;
  listId: string;
  leadId?: string;
  leadIds?: string[];
  outputFields: unknown;
  toolName: 'enrich_leads_execute' | 'enrich_lead_custom';
}): void {
  const processedCount = Number(input.summary?.processedCount ?? 0);
  if (!input.userId || processedCount <= 0) return;

  const fields = outputFieldNames(input.outputFields);
  const runId = typeof input.summary?.runId === 'string' && input.summary.runId
    ? input.summary.runId
    : `${input.toolName}:${input.listId}:${input.leadId || 'all'}:${fields.join(',')}`;
  const target = input.leadId
    ? `list=${input.listId} lead=${input.leadId}`
    : `list=${input.listId}`;

  void enqueueAutoHumanEval({
    reviewType: 'lead_enrichment',
    userId: input.userId,
    sessionId: input.sessionId,
    originalRequest: `${input.toolName} ${target} fields=${fields.join(',') || '(none)'}`,
    outputSummary:
      `Lead enrichment completed: processed ${processedCount} lead(s), ` +
      `failed ${Number(input.summary?.failedCount ?? 0)}. Fields: ${fields.join(', ') || '(none)'}.`,
    sourceKey: `lead-enrichment:${runId}`,
    action: {
      type: 'lead_enrichment_rerun',
      userId: input.userId,
      listId: input.listId,
      leadId: input.leadId,
      leadIds: input.leadIds,
      outputFields: actionOutputFields(input.outputFields),
      toolName: input.toolName,
    },
  });
}

emmaToolRegistry.register({
  name: 'install_skills',
  definition: {
    name: 'install_skills',
    description: 'Install skills by their IDs. Pass ALL skill IDs you need in a single call — do not call this tool multiple times. This makes the tools associated with the skills available for use. Use __other_skills__ to install tools that are not part of any specific skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skillIds: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'Array of ALL skill IDs to install. Include every skill you need in one call.'
        }
      },
      required: ['skillIds']
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;

    if (!userId) {
      throw new Error("Authentication required: no user context");
    }

    // For external MCP clients: validate and update session state
    if (context?.updateInstalledSkills) {
      const requestedSkillIds = Array.isArray(args.skillIds)
        ? args.skillIds.filter((id: unknown): id is string => typeof id === 'string')
        : [];
      if (requestedSkillIds.length === 0) {
        return { message: "skillIds must be a non-empty array of skill IDs." };
      }

      const { skillService } = await import('../services/skillService');
      const { getAllowedSkills } = await import('../services/subscriptionService');

      const [publishedSkills, userAllowedSkillIds] = await Promise.all([
        skillService.getSkillsAvailableToUser(userId),
        getAllowedSkills(userId)
      ]);

      const isWildcard = userAllowedSkillIds.includes("*");
      const allowedSkillSet = new Set(userAllowedSkillIds);

      const validSkillIds = requestedSkillIds.filter((id: string) => {
        const skill = publishedSkills.find(s => s.skillId === id);
        const isOwnSkill = skill && (skill as any).ownerId === userId;
        return (id === '__other_skills__' || skill) &&
          (isOwnSkill || isWildcard || allowedSkillSet.has(id));
      });

      if (validSkillIds.length === 0) {
        return {
          message: "No valid skills found. The requested skills may not exist or are not included in your subscription."
        };
      }

      // Update MCP session's installed skills
      context.updateInstalledSkills(validSkillIds);

      const installedNames = validSkillIds.map((id: string) => {
        if (id === '__other_skills__') return 'other_skills';
        const skill = publishedSkills.find(s => s.skillId === id);
        return skill?.name || id;
      });

      return {
        success: true,
        message: `Successfully installed ${installedNames.length} skill(s). Use list_tools to see newly available tools.`,
        installedSkills: installedNames
      };
    }

    // For internal clients (agent mode): use chat session pattern
    if (!context?.sessionId) {
      throw new Error("Missing session context");
    }
    return await agentModeService.installSkills(args.skillIds, userId, context.sessionId, context.isDelegatedAccess === true);
  }
});

emmaToolRegistry.register({
  name: 'list_available_skills',
  definition: {
    name: 'list_available_skills',
    description: 'List all available skills with their descriptions and tool lists. Use this to discover what capabilities Emma offers before installing skills. Returns skill catalog with IDs, names, descriptions, and tool names.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;

    if (!userId) {
      throw new Error("Authentication required");
    }

    const { skillService } = await import('../services/skillService');
    const { getAllowedSkills } = await import('../services/subscriptionService');

    // Best-effort user + org lookup. Powers two things:
    //  (1) Org-shared skill fanout — only when `shareSettings.skills` is
    //      effectively enabled for this caller (plain members need
    //      enabled=true; editors and the org owner always get fanout).
    //  (2) The admin virtual-skill check below.
    // If any lookup fails, fall back to non-org behavior — published + own
    // skills still list.
    let currentUser: any = null;
    let userOrgId: string | undefined;
    try {
      const { userDb, orgDb } = await import('../services/db');
      const { isFeatureEffectivelyEnabled } = await import('../services/orgShareService');
      currentUser = await userDb.getUserById(userId);
      const candidateOrgId = currentUser?.orgId;
      if (candidateOrgId) {
        const org = await orgDb.getOrgById(candidateOrgId);
        const effectivelyEnabled = isFeatureEffectivelyEnabled(
          { userId, orgId: candidateOrgId, orgRole: currentUser?.orgRole },
          org,
          'skills',
        );
        if (effectivelyEnabled) userOrgId = candidateOrgId;
      }
    } catch {
      // best-effort: degrade to non-org behavior
    }

    const [publishedSkills, userAllowedSkillIds] = await Promise.all([
      skillService.getSkillsAvailableToUser(userId, userOrgId),
      getAllowedSkills(userId)
    ]);

    const isWildcard = userAllowedSkillIds.includes("*");
    const allowedSkillSet = new Set(userAllowedSkillIds);

    // Filter skills by user's subscription (user's own private skills always pass)
    const availableSkills = publishedSkills
      .filter(skill => isWildcard || allowedSkillSet.has(skill.skillId) || (skill as any).ownerId === userId)
      .map(skill => ({
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description,
        toolNames: skill.toolNames || [],
        toolCount: (skill.toolNames || []).length
      }));

    // Add __other_skills__ virtual skill
    if (isWildcard || allowedSkillSet.has('__other_skills__')) {
      const { agentModeService } = await import('../services/agentModeService');
      const unassociatedTools = agentModeService.getUnassociatedToolNames(publishedSkills);

      availableSkills.push({
        skillId: '__other_skills__',
        name: 'Other Tools',
        description: 'Additional tools not part of any specific skill bundle',
        toolNames: unassociatedTools,
        toolCount: unassociatedTools.length
      });
    }

    // Add __admin_tools__ virtual skill for admin users or admin delegated access.
    // Reuses currentUser from the lookup above; if that lookup failed, currentUser
    // is null and admin tools are skipped (unless delegated-admin context says otherwise).
    const hasAdminAccess = currentUser?.isAdmin === true || context?.isDelegatedAdmin === true;
    if (hasAdminAccess) {
      const { agentModeService } = await import('../services/agentModeService');
      const adminToolNamesList = agentModeService.getAdminToolNames();
      availableSkills.push({
        skillId: '__admin_tools__',
        name: 'Admin Tools',
        description: 'Admin-only tools: manage predefined work plans, skill definitions, chat history, and client health assessment. WARNING: These tools modify production configuration — use with extra care.',
        toolNames: adminToolNamesList,
        toolCount: adminToolNamesList.length
      });
    }

    return {
      skills: availableSkills,
      totalSkills: availableSkills.length,
      message: `Found ${availableSkills.length} available skill(s). Use install_skills(['skill-id']) to unlock their tools.`
    };
  }
});

emmaToolRegistry.register({
  name: 'linkedin_outreach',
  definition: {
    name: 'linkedin_outreach',
    description: `LinkedIn outreach tool via a connected Unipile account. To find the account_id, call list_connected_accounts(platform='unipile') tool.

Actions:
- search-people: Search LinkedIn for people by any combination of: keywords (free-text), title, company, location, industry, school. Free-text company/location/industry/school are auto-resolved to LinkedIn entity IDs by the backend. Alternatively pass search_url with a LinkedIn search URL copied from the browser. The backend handles Unipile's classic-search keyword requirement automatically — you can pass just structured filters (e.g. {title: "CTO", company: "Microsoft"}) without specifying keywords. Returns paginated results with provider_id for each person. OUT-OF-NETWORK RESULTS: LinkedIn anonymizes hits outside the connected account's network — they come back with no public_identifier/public_profile_url and a placeholder name ("LinkedIn Member", "LinkedIn User", or its localized equivalent). Those are not people you can contact or dedup: never write them to the CRM (via add_leads_to_list or otherwise) and never present them to the user as found leads. Skip them, or use import_leads_from_search, which drops them for you and reports the count as anonymizedSkipped.
- get-profile: Get detailed profile info (headline, About, location, network_distance, is_open_profile, etc.) for a LinkedIn user by profile_url or provider_id. This reads the LIVE profile from the connected/platform-wide Unipile account — it is the ONLY authoritative source for a person's current headline/About. NEVER take a headline, About, or other profile-identity field from a you_search_web snippet or a page-source scrape: search caches lag LinkedIn edits by many months and will report a stale headline as if current. When you specifically need the CURRENT profile — a founder/profile readiness audit, or a "what is my headline right now?" question — pass force_refresh=true to bypass the profile cache and read live. If no LinkedIn account can be resolved, get-profile fails with an explicit connect-LinkedIn error; surface that and prompt the user to connect LinkedIn rather than substituting search-snippet text.
- list-connections: List the user's 1st-degree LinkedIn connections. Returns paginated results.
- list-sent-invitations: List pending/sent connection requests with status. Returns paginated results.
- list-received-invitations: (exact action string: "list-received-invitations") List pending connection requests received from others. Returns paginated results with sender info.
- send-invite: Send a connection request. Requires profile_url or provider_id. message optional but recommended. IMPORTANT: the invite note limit is 200 characters on free LinkedIn accounts and 300 on Premium. Aim for 200 characters or fewer (target ~195) so the whole message — including your call-to-action — fits and reads well. The backend auto-trims an over-limit note to the account's limit on a word boundary before sending, so a send never fails on length; but a note you keep within the limit yourself stays complete and coherent. Also: do not send-invite to someone you are already connected with (network_distance FIRST_DEGREE) — use send-message instead; check with get-profile or list-connections if unsure. NOTE-QUOTA GATE: if send-invite returns requiresDecision/noteQuotaExceeded, the account's monthly personalized-note quota is spent and the note was NOT sent — do NOT retry automatically; ask the user whether to send WITHOUT the note or skip, and only re-call with on_note_quota="send_without_note" if they agree. CRM ATTRIBUTION: when you are running outreach for a CRM lead list, ALWAYS pass list_id with send-invite, plus the invitee's own first_name/last_name/company/title when you actually know them for THAT person (from search-people or get-profile) — never reuse the filters you searched with, or the lead is stamped with the wrong employer/title. The invite is then mirrored into that list — the person is created as a lead if absent, marked contacted, and logged with a linkedin.invite.sent engagement — so contact volume is attributed and follow-up cadence can fire. Also pass lead_id when you already know the CRM lead.
- send-message: Send a direct message. Requires profile_url or provider_id. message required. Only works for 1st-degree connections or open profiles. When sending to a CRM lead, always provide list_id and lead_id — the system enforces that update-conversation-history was called within the last 24 hours before allowing a send.
- send-inmail: Send a LinkedIn InMail to any profile regardless of connection degree (2nd/3rd-degree connections). Requires profile_url or provider_id, message (body), and subject. Requires a LinkedIn Premium account with available InMail credits. Use this when send-message is not possible due to connection degree restrictions. list_id and lead_id are optional but recommended for CRM persistence.
- get-company: Get a LinkedIn company profile by company_id (the company's LinkedIn identifier/slug).
- cancel-invitation: Cancel a pending invitation by invitation_id (obtain from list-sent-invitations).
- accept-invitation: (exact action string: "accept-invitation") Accept a received connection request. Requires invitation_id and shared_secret — both obtained from list-received-invitations.
- update-conversation-history: Fetch the full message history with a LinkedIn contact from Unipile and persist it to the lead's CRM engagement activities. Also updates the lead's sync timestamp so send-message is unblocked for the next 24 hours. Requires list_id and lead_id in addition to profile_url or provider_id.
- search-parameters: Resolve a free-text query (company name, location, industry, school, service) to LinkedIn entity IDs via Unipile's parameter search. Required: type (one of COMPANY, LOCATION, INDUSTRY, SCHOOL, SERVICE) and keywords. Optional limit. Returns ranked candidates with id/title/subtitle plus fromCache and source metadata. Use the returned id with the matching *_id field on search-people for precise structured filtering.

For target person identification (send-invite, send-message, get-profile, update-conversation-history), pass EITHER:
- profile_url: a full LinkedIn profile URL (e.g. https://www.linkedin.com/in/username/)
- provider_id: the Unipile provider_id directly if you already have it`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search-people', 'get-profile', 'list-connections', 'list-sent-invitations', 'list-received-invitations', 'send-invite', 'send-message', 'send-inmail', 'get-company', 'cancel-invitation', 'accept-invitation', 'update-conversation-history', 'search-parameters'],
          description: 'The outreach action to perform.'
        },
        account_id: {
          type: 'string',
          description: 'The Unipile account ID for the LinkedIn connection. Optional for search-people and get-profile — the system will automatically use a platform-wide account if the user has no personal account connected. For write actions (send-invite, send-message), must be the user\'s own account. Obtain via list_connected_accounts(platform=\'unipile\') tool.'
        },
        profile_url: {
          type: 'string',
          description: 'Full LinkedIn profile URL (e.g. https://www.linkedin.com/in/username/). For send-invite, send-message, update-conversation-history. Provide this OR provider_id.'
        },
        provider_id: {
          type: 'string',
          description: 'The Unipile provider_id for the target LinkedIn user. For send-invite, send-message, get-profile, update-conversation-history. Provide this OR profile_url.'
        },
        message: {
          type: 'string',
          description: 'Message content. Required for send-message and send-inmail; recommended for send-invite. For send-invite: aim for 200 characters or fewer (300 on Premium). The backend auto-trims an over-limit note on a word boundary before sending, so the send never fails on length — but a note you keep within the limit stays complete.'
        },
        on_note_quota: {
          type: 'string',
          enum: ['send_without_note'],
          description: 'For send-invite ONLY. Leave this UNSET on the first attempt. If a send-invite comes back with requiresDecision/noteQuotaExceeded, it means this account\'s monthly quota for personalized invitation notes is spent and the note could not be attached — do NOT decide on your own: ASK the user whether to send the connection request without the note or skip the person. Only if they choose to proceed, re-call send-invite with the SAME target and on_note_quota="send_without_note" to send it note-less. If they choose to skip, do not re-call.'
        },
        subject: {
          type: 'string',
          description: 'Subject line for send-inmail. Required for InMail messages.'
        },
        list_id: {
          type: 'string',
          description: 'CRM lead list ID. Required for update-conversation-history. Also required for send-message when enforcing the 24-hour sync gate. For send-invite: pass the list you are running outreach for so the invite is mirrored back into that CRM list (ENG-787 attribution).'
        },
        lead_id: {
          type: 'string',
          description: 'CRM lead ID. Required for update-conversation-history. Also required for send-message when enforcing the 24-hour sync gate. Optional for send-invite — pass it when you already know the CRM lead so the invite is attributed to it directly.'
        },
        first_name: {
          type: 'string',
          description: 'The target person\'s first name. Pass with send-invite (alongside list_id) so a lead created for CRM attribution carries their name.'
        },
        last_name: {
          type: 'string',
          description: 'The target person\'s last name. Pass with send-invite (alongside list_id) so a lead created for CRM attribution carries their name.'
        },
        keywords: {
          type: 'string',
          description: 'Optional free-text search keywords for search-people. Pass when you want a broad match across name/headline/bio. Omit when using structured filters alone — the backend will synthesize a keyword from your most-specific filter (title > company > location > industry > school) so the Unipile classic-search keyword requirement is satisfied transparently.'
        },
        search_url: {
          type: 'string',
          description: 'A LinkedIn search URL copied from the browser for search-people action. Alternative to keyword-based search.'
        },
        title: {
          type: 'string',
          description: 'For search-people: job title FILTER (e.g. "CTO"). For send-invite: the invitee\'s ACTUAL job title, as returned by search-people/get-profile for that specific person — it is written to the CRM lead. Never carry a search filter over into send-invite; omit it if you do not know the person\'s real title.'
        },
        company: {
          type: 'string',
          description: 'For search-people: company name FILTER — free text, auto-resolved to a LinkedIn company id if no company_id is provided. For send-invite: the invitee\'s ACTUAL employer, as returned by search-people/get-profile for that specific person — it is written to the CRM lead. Never carry a search filter over into send-invite; omit it if you do not know the person\'s real employer.'
        },
        company_id: {
          type: 'string',
          description: 'LinkedIn company identifier/slug. Used for get-company. Optional pre-resolved LinkedIn company entity ID for search-people — when provided, skips the resolver.'
        },
        location: {
          type: 'string',
          description: 'Location filter for search-people — free text, auto-resolved if no location_id is provided.'
        },
        location_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn location entity ID for search-people — when provided, skips the resolver.'
        },
        industry: {
          type: 'string',
          description: 'Industry filter for search-people — free text, auto-resolved if no industry_id is provided.'
        },
        industry_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn industry entity ID for search-people — when provided, skips the resolver.'
        },
        school: {
          type: 'string',
          description: 'School filter for search-people — free text, auto-resolved if no school_id is provided.'
        },
        school_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn school entity ID for search-people — when provided, skips the resolver.'
        },
        type: {
          type: 'string',
          enum: ['COMPANY', 'LOCATION', 'INDUSTRY', 'SCHOOL', 'SERVICE'],
          description: 'Entity type to resolve for search-parameters action.'
        },
        limit: {
          type: 'number',
          description: 'Max number of candidates to return for search-parameters. Optional; the resolver picks a sensible default.'
        },
        invitation_id: {
          type: 'string',
          description: 'Invitation ID for cancel-invitation or accept-invitation actions. Obtain from list-sent-invitations or list-received-invitations respectively.'
        },
        shared_secret: {
          type: 'string',
          description: 'LinkedIn shared_secret token required for accept-invitation. Returned by list-received-invitations alongside each invitation record.'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for search-people, list-connections, list-sent-invitations, list-received-invitations.'
        },
        force_refresh: {
          type: 'boolean',
          description: 'For get-profile ONLY. Set true to bypass the 30-day profile cache and read the CURRENT profile live from the connected Unipile account — use it for a founder/profile readiness audit or any "what is my headline/About right now?" read so a months-stale cached value is never returned as current. Omit (cache-first) for high-volume outreach where an occasionally-cached profile is acceptable and dedup/rate-limit matter.'
        }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error("Missing user context");
    }
    const targetActions = ['send-invite', 'send-message', 'send-inmail', 'get-profile', 'update-conversation-history'];
    if (targetActions.includes(args.action)) {
      if (!args.profile_url && !args.provider_id) {
        return { success: false, message: 'Either profile_url or provider_id is required.' };
      }
      if (args.profile_url && args.provider_id) {
        return { success: false, message: 'Provide only one of profile_url or provider_id, not both.' };
      }
    }
    return await agentModeService.linkedinOutreach(context.userId, args);
  }
});

emmaToolRegistry.register({
  name: 'twitter_manage_post',
  definition: {
    name: 'twitter_manage_post',
    description: `Manage X (Twitter) tweet interactions. ⚠️ NEVER use this tool to post a single new tweet — use post_on_connected_account for that. This tool is for: multi-tweet threads (2+ tweets), replies, quote-tweets, deletes, likes, retweets, and analytics. NOTE: X's public API does not support editing tweets — there is no edit action; to fix a mistake, delete_tweet and post a new one.

To find the account_id, call list_connected_accounts(platform='twitter'). account_id is optional when the user has exactly one X account connected.

Actions:
- reply: Reply to an existing tweet. Requires text and in_reply_to_tweet_id.
- post_thread: Post a NEW chain of 2 or more tweets in sequence. Requires tweets array with MINIMUM 2 entries — if you only have 1 tweet, use post_on_connected_account instead. Each entry auto-trimmed to 280 chars.
- quote_tweet: Quote-tweet a tweet with added commentary. Requires text and tweet_id.
- delete_tweet: Delete a tweet you authored. Requires tweet_id. CRITICAL: Always get explicit user approval before deleting.
- like: Like a tweet. Requires tweet_id.
- unlike: Remove a like from a tweet. Requires tweet_id.
- retweet: Retweet a tweet. Requires tweet_id.
- unretweet: Undo a retweet. Requires tweet_id.
- get_tweet_metrics: Fetch public engagement metrics (retweets, replies, likes, quotes, impressions, bookmarks) for one or more tweets. Requires tweet_ids array.
- list_replies: List replies to a tweet (searches last 7 days). Requires tweet_id. Optional max_results (default 10, max 100).
- get_retweeters: List users who retweeted a tweet. Requires tweet_id.
- get_liking_users: List users who liked a tweet. Requires tweet_id.
- get_quote_tweets: List quote tweets of a tweet. Requires tweet_id. Optional max_results.

For CRM logging of sent tweets, optionally pass list_id, lead_id and lead_email.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'reply', 'post_thread', 'quote_tweet',
            'delete_tweet',
            'like', 'unlike', 'retweet', 'unretweet',
            'get_tweet_metrics', 'list_replies',
            'get_retweeters', 'get_liking_users', 'get_quote_tweets',
          ],
          description: 'The X post action to perform.'
        },
        account_id: {
          type: 'string',
          description: "The connected X account ID. Optional when the user has exactly one X account connected. Obtain via list_connected_accounts(platform='twitter')."
        },
        text: {
          type: 'string',
          description: 'Tweet text. Required for reply, quote_tweet. Auto-trimmed to 280 chars on a word boundary.'
        },
        tweet_id: {
          type: 'string',
          description: 'Tweet ID. Required for delete_tweet, like, unlike, retweet, unretweet, quote_tweet, list_replies, get_retweeters, get_liking_users, get_quote_tweets.'
        },
        in_reply_to_tweet_id: {
          type: 'string',
          description: 'ID of the tweet being replied to. Required for reply.'
        },
        tweets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tweet texts for post_thread, posted as a chained thread in order.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return. Optional for list_replies and get_quote_tweets (default 10, max 100).'
        },
        tweet_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tweet IDs to fetch metrics for. Required for get_tweet_metrics.'
        },
        list_id: {
          type: 'string',
          description: 'CRM lead list ID. Optional — provide with lead_id and lead_email to log the sent tweet to CRM history.'
        },
        lead_id: {
          type: 'string',
          description: 'CRM lead ID. Optional — provide with list_id and lead_email for CRM logging.'
        },
        lead_email: {
          type: 'string',
          description: 'CRM lead email. Optional — provide with list_id and lead_id for CRM logging.'
        }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error("Missing user context");
    }
    return await agentModeService.twitterManagePost(context.userId, args, context);
  }
});

emmaToolRegistry.register({
  name: 'twitter_outreach',
  definition: {
    name: 'twitter_outreach',
    description: `Manage X (Twitter) people and outreach interactions using a connected X account. Use this for profile lookup, follows, DMs, user search, bookmarks, reading X Lists, and account management (block/mute).

To find the account_id, call list_connected_accounts(platform='twitter'). account_id is optional when the user has exactly one X account connected.

Actions:
- get_profile: Get an X user's public profile by handle. Requires handle.
- follow: Follow a user by handle. Requires handle. CRITICAL: Always get explicit user approval before following.
- unfollow: Unfollow a user by handle. Requires handle. CRITICAL: Always get explicit user approval before unfollowing.
- list_followers: List followers of the connected account (or another user if handle is provided).
- list_following: List accounts the connected account follows (or another user if handle is provided).
- search_tweets: Search recent tweets by query. Requires query. Optional max_results (default 10, max 100).
- get_user_tweets: Get recent tweets by a user. Requires handle. Optional max_results (default 10, max 100).
- send_dm: Send a direct message. Requires handle and text. DM text over 10000 chars is auto-trimmed. CRITICAL: Always get explicit user approval before sending.
- list_dms: List recent DM events for the connected account.
- get_dm_conversation: Get DM history with a specific user. Requires handle.
- bookmark: Bookmark a tweet. Requires tweet_id.
- get_bookmarks: Retrieve the authenticated user's bookmarked tweets.
- list_owned_lists: List the connected account's own X Lists (id + name). Use this to resolve an X List name (e.g. "Engagement 101") to a list id.
- get_list_members: List the members of an X List (returns member handles). Requires x_list_id, or pass list_name to resolve an owned list by name.
- get_list_tweets: Get recent tweets posted in an X List (each with author handle, text, and tweet id). Requires x_list_id, or pass list_name to resolve an owned list by name. Optional max_results (default 10, max 100).
- block: Block a user by handle. Requires handle. CRITICAL: Always get explicit user approval before blocking.
- unblock: Unblock a user by handle. Requires handle. CRITICAL: Always get explicit user approval before unblocking.
- mute: Mute a user by handle. Requires handle. CRITICAL: Always get explicit user approval before muting.
- unmute: Unmute a user by handle. Requires handle. CRITICAL: Always get explicit user approval before unmuting.

For CRM logging of sent DMs, optionally pass list_id, lead_id and lead_email.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'get_profile', 'follow', 'unfollow', 'list_followers', 'list_following',
            'search_tweets', 'get_user_tweets',
            'send_dm', 'list_dms', 'get_dm_conversation',
            'bookmark', 'get_bookmarks',
            'list_owned_lists', 'get_list_members', 'get_list_tweets',
            'block', 'unblock', 'mute', 'unmute',
          ],
          description: 'The X outreach action to perform.'
        },
        account_id: {
          type: 'string',
          description: "The connected X account ID. Optional when the user has exactly one X account connected. Obtain via list_connected_accounts(platform='twitter')."
        },
        text: {
          type: 'string',
          description: 'DM text. Required for send_dm. Auto-trimmed to 10000 chars on a word boundary.'
        },
        handle: {
          type: 'string',
          description: 'The @handle to look up or act on. Required for get_profile, follow, unfollow, send_dm, get_dm_conversation, get_user_tweets, block, unblock, mute, unmute. Optional for list_followers and list_following (defaults to own account).'
        },
        recipient_handle: {
          type: 'string',
          description: 'Alias for handle. Use when the context makes "recipient" clearer (e.g., send_dm).'
        },
        query: {
          type: 'string',
          description: 'Search query string. Required for search_tweets.'
        },
        tweet_id: {
          type: 'string',
          description: 'Tweet ID. Required for bookmark.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return. Optional for search_tweets, get_user_tweets, and get_list_tweets (default 10, max 100).'
        },
        x_list_id: {
          type: 'string',
          description: 'X List ID. Provide for get_list_members and get_list_tweets. Get it from list_owned_lists. (Distinct from list_id, which is a CRM lead list.) If omitted, pass list_name to resolve one of your own lists by name.'
        },
        list_name: {
          type: 'string',
          description: 'Name of one of your own X Lists (e.g. "Engagement 101"). Optional convenience for get_list_members / get_list_tweets — resolved to a list id via your owned lists. Ignored when x_list_id is provided.'
        },
        list_id: {
          type: 'string',
          description: 'CRM lead list ID. Optional — provide with lead_id and lead_email to log the sent DM to CRM history. NOTE: this is a CRM list, NOT an X List — for X Lists use x_list_id.'
        },
        lead_id: {
          type: 'string',
          description: 'CRM lead ID. Optional — provide with list_id and lead_email for CRM logging.'
        },
        lead_email: {
          type: 'string',
          description: 'CRM lead email. Optional — provide with list_id and lead_id for CRM logging.'
        }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error("Missing user context");
    }
    return await agentModeService.twitterOutreach(context.userId, args);
  }
});

emmaToolRegistry.register({
  name: 'list_meta_ads_campaigns',
  definition: {
    name: 'list_meta_ads_campaigns',
    description: 'List all Meta ad campaigns for the current user. Returns campaign names, IDs, statuses, and objectives. Works even without a Meta connected account (falls back to legacy adAccount config). Use this first to get campaign IDs, then call get_meta_ads_metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Optional Meta ad account ID from list_connected_accounts. Required only when multiple Meta ad accounts are available.'
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return args.account_id
      ? await agentModeService.listMetaAdsCampaignsNew(context?.userId, args.account_id)
      : await agentModeService.listMetaAdsCampaignsNew(context?.userId);
  }
});

// --- Tools from marketingTools.ts ---
emmaToolRegistry.register({
  name: "call_meta_marketing_api",
  definition: {
    name: "call_meta_marketing_api",
    description:
      `Manage Meta Ads entities via the Marketing API. Requires account_id from list_connected_accounts(platform='meta').

⚠️ MANDATORY TARGET CONFIRMATION (publish/change/delete actions):
  CAMPAIGN/AD_SET/AD with CREATE, UPDATE, DELETE, or COPY_AD are write actions that publish, change, or
  destroy live entities. For these, the API runs a two-phase confirmation:
    1. Call normally (without params.confirm). The API does NOT execute — it returns requiresConfirmation:true
       with a "target" object naming the exact campaign + ad set + asset that will be affected.
    2. Show the user that resolved target verbatim (campaign name + ID, ad set name + ID, ad name, and any
       content/budget/status changes) and get EXPLICIT approval before proceeding.
    3. Only after the user approves, re-call with the SAME arguments plus params.confirm=true to execute.
  If the user's request could map to MORE THAN ONE campaign, ad set, or asset, do NOT guess — list the
  candidates and ask the user to disambiguate BEFORE calling. Never publish an ad into a campaign/ad set the
  user did not explicitly name, and never regenerate/edit an asset set without confirming which assets.
  (LIST/SEARCH/UPLOAD_IMAGE/UPLOAD_VIDEO are read/upload-only and need no confirmation.)

⚠️ CAMPAIGN OBJECTIVE IS IMMUTABLE — cannot be changed after creation. There is NO "start with Traffic/LPV
  and switch to conversions later" on Meta; that is not a valid plan. Because of this, a CAMPAIGN CREATE
  with no objective the user explicitly chose is BLOCKED SERVER-SIDE before it reaches Meta: if you omit
  objective_quote (see below) and the objective hasn't already been confirmed by the user in this session,
  the call returns a blocking question instead of creating the campaign — do not try to work around this
  by guessing an objective or retrying.

  If the user asks you to confirm the objective (or any other setting) via a structured card BEFORE you
  build anything: you have NO way to render an interactive card yourself — do not fabricate one out of HTML,
  markdown tables, or styled text in your reply; a hand-written "card" you write is not real and answering
  it does nothing. Just attempt the CAMPAIGN CREATE call directly (with your real name/budget/targeting
  params, omitting objective if it isn't explicitly confirmed) — if the objective truly isn't settled, the
  call itself returns the real blocking question, which the platform renders as an actual clickable card.
  Do not stall in prose waiting to "ask first"; attempting the call is how the real card appears.

ACTION MATRIX (entity_type → supported actions):
  CAMPAIGN      → LIST, CREATE, UPDATE, DELETE
  AD_SET        → LIST, CREATE, UPDATE, DELETE
  AD_CREATIVE   → LIST, GET, CREATE, UPLOAD_IMAGE, UPLOAD_VIDEO
  AD            → LIST, CREATE, UPDATE, DELETE, COPY_AD, RETAG_UTM
  CUSTOM_AUDIENCE → LIST, CREATE, UPLOAD_USERS
  TARGETING     → SEARCH
  PAGE          → LIST
  DATASET       → LIST, GET_MATCH_QUALITY

AD_CREATIVE GET — read ONE creative back by id (params.creative_id), including asset_feed_spec.
  LIST is account-wide, capped, and omits asset_feed_spec, so it cannot tell you what a specific
  creative actually contains. Use GET to verify a creative you just built or swapped onto an ad, and
  to read a placement-customized creative (1:1 Feed + 9:16 Story/Reels) faithfully before cloning it.

READING CONFIG (LIST) — read what a campaign/ad set is actually set to optimize for (use to verify after a CREATE/UPDATE):
  AD_SET LIST returns optimization_goal, billing_event, destination_type, promoted_object (pixel_id + custom_event_type), bid_strategy, and budgets per ad set. Pass ad_set_id to read a single ad set; pass campaign_id to scope to one campaign's ad sets.
  CAMPAIGN LIST returns objective plus daily_budget / lifetime_budget / budget_remaining / spend_cap / bid_strategy. Pass campaign_id to read a single campaign. budget_remaining is only populated by Meta when the campaign itself carries the budget (CBO); for ad-set-budgeted campaigns it is absent — read the ad sets' budgets instead, do not infer 0.
  Optional params.fields (comma-separated) narrows the read to specific supported fields. Requesting an unsupported field returns a loud error — it is never silently dropped.

SPEND CAP (campaign hard money stop):
  params.spend_cap sets the campaign's lifetime hard stop, in CENTS (e.g. 300000 = $3,000). Writable on CAMPAIGN CREATE and CAMPAIGN UPDATE.
  Every spend_cap write is verified server-side by re-reading the campaign, and the result says which happened:
    spend_cap_verified:true  → the cap is really on the campaign (the value is echoed back as spend_cap). ONLY then may you tell the user a cap is in place.
    spend_cap_verified:false with error SPEND_CAP_UNCONFIRMED → the cap could not be confirmed. This does NOT mean it failed: Meta sometimes reports a campaign without the field for a few seconds after a write that did land. Never claim the cap is set, and never announce it as missing either — re-read with CAMPAIGN LIST (campaign_id + params.fields="id,name,spend_cap"). If it is still absent, apply it with CAMPAIGN UPDATE (on CREATE the campaign already exists — use the returned campaign id, do NOT create it again). The message says what was actually read.
  Never report a spend cap as set based on the write response alone.

DATASET USAGE:
  LIST              → Returns every pixel on the ad account with its id, name and last_fired_time. Meta unified pixels and datasets, so each pixel id IS its dataset id (returned as dataset_id).
  GET_MATCH_QUALITY → Returns Event Match Quality (EMQ) scores per event type for a specific dataset. Requires params.dataset_id.
  WORKFLOW: First LIST to discover pixel/dataset IDs, then GET_MATCH_QUALITY with the dataset_id.
  NOTE: Match quality data is only available if the advertiser has Conversions API (CAPI) set up.

REQUIRED IDs PER ACTION:
  CAMPAIGN UPDATE/DELETE  → campaign_id required
  AD_SET CREATE           → campaign_id required
  AD_SET UPDATE/DELETE    → ad_set_id required
  AD CREATE               → ad_set_id required
  AD UPDATE/DELETE        → ad_id required
  AD COPY_AD              → ad_id (source ad to copy) required
  AD RETAG_UTM            → ad_id required
  TARGETING SEARCH        → params.q and params.type required

AD RETAG_UTM (ENG-239 — retrofit UTMs onto ONE existing ad that's missing them):
  Only for ads that already exist and were found untagged, e.g. via audit_ad_utm_coverage. Never call this
  in a loop over multiple ads — it is a single-target action, one ad per call, always. Retagging swaps in a
  NEW creative for the ad, which RESETS THE AD'S LEARNING PHASE and can hurt performance on a live client
  campaign. You MUST tell the user this cost explicitly before calling — do not call it as a quiet "fix" in
  the middle of another task. The normal confirmation flow (see above) will also surface this same warning,
  but say it yourself first regardless.

REQUIRED PARAMS PER ENTITY + ACTION:
  CAMPAIGN CREATE:      name, objective, special_ad_categories (e.g. ["NONE"])
                        Optional: status, spend_cap (cents), advantage_campaign_budget + budget_amount (dollars).
                        Any OTHER param is REJECTED before the campaign is created, naming the field — nothing is ever accepted and silently dropped. Campaign-level budget goes through advantage_campaign_budget + budget_amount (never a bare daily_budget/lifetime_budget); scheduling (start_time/stop_time) comes from the AD SETS, because Meta accepts those on a campaign create and then ignores them; ad-set fields (bid_strategy, targeting, optimization_goal, billing_event) belong on AD_SET CREATE.
  AD_SET CREATE:        name, optimization_goal, billing_event, targeting (with geo_locations), daily_budget OR lifetime_budget (not both; lifetime_budget requires end_time)
                        Optional but WRITABLE on create: bid_strategy (LOWEST_COST_WITHOUT_CAP | LOWEST_COST_WITH_BID_CAP | COST_CAP) and bid_amount.
                        Omitting bid_strategy silently defaults to LOWEST_COST_WITHOUT_CAP — set it deliberately when the user expressed any cost target (ENG-838).
                        bid_amount is REQUIRED for LOWEST_COST_WITH_BID_CAP and COST_CAP, and must be OMITTED for LOWEST_COST_WITHOUT_CAP.
                        NOT SUPPORTED: dayparting / ad scheduling (adset_schedule, pacing_type). A request for scheduled delivery is REJECTED, not silently ignored — tell the user it must be set in Ads Manager after creation. start_time/end_time are the flight window, not dayparting.
                        After a successful create the ad set is READ BACK from Meta: the result carries readBack (the settings Meta actually stored), readBackVerified, and readBackMismatches. If a mismatch is reported the call returns success:false even though the ad set exists — tell the user which parameter Meta overrode and that the ad set is live with settings nobody chose (ENG-838).
  AD_CREATIVE CREATE:   name, page_id, body, title, link_url + exactly one creative type (see below)
  AD CREATE:            name, creative_id (plus ad_set_id top-level param)
  AD COPY_AD:           ad_id = source ad ID. Optional params: name (new ad name), adset_id (target ad set; defaults to source ad's set), link_url (override destination URL), body, title, status (default PAUSED). Automatically copies images — no manual upload needed.
  CUSTOM_AUDIENCE CREATE: name, subtype (CUSTOM or LOOKALIKE)
  TARGETING SEARCH:     q (search query), type (adinterest | adbehavior | addemographics | adgeolocation). For type=adgeolocation, results include a location key/region_id for use in ad set geo_locations; optionally pass location_types (e.g. ['city']).

COPY_AD WORKFLOW (clone an existing ad with optional overrides):
  1. Use AD LIST to find the source ad and get its ad_id
  2. Call AD COPY_AD with the source ad_id and any overrides (e.g. link_url for new landing page)
  3. The system automatically: reads source creative → copies images (re-uploading from CDN if needed) → creates new creative → creates new ad
  4. Returns new_ad_id and new_creative_id
  NOTE: AD LIST now includes creative.object_story_spec so you can inspect image/video/URL details before copying.

CHANGING AN AD'S CREATIVE/IMAGE (AD UPDATE):
  Meta ads cannot mutate a creative in place — you must point the ad at a different creative.
  - To swap to a creative you already built: AD UPDATE with params.creative_id (the system nests it correctly; a top-level creative_id is silently dropped by Meta and the old image keeps showing).
  - To change copy/destination/image content: AD UPDATE with link_url / body / title / image_hash / image_url — the system auto-builds a new creative from the old one (preserving existing UTM/url_tags unless you override them) and swaps it in.
  Either way the change is reflected on the SAME ad_id; deleting and recreating the ad is NOT required.
  VERIFICATION: after ANY creative swap the system re-fetches the ad to confirm the new creative actually attached, and for link_url/destination changes that the live URL matches what you requested. Behavior depends on which path:
    - params.creative_id (direct swap): a single read-back. If it returns error SWAP_NOT_REFLECTED the change did NOT take effect (usually transient Meta propagation) — retry the AD UPDATE with the same params.creative_id (the creative already exists, don't rebuild it).
    - auto-built swap (link_url / body / title / image_hash / image_url): the system re-attaches and re-verifies up to 3 times before giving up. Outcomes:
        - verified:true → confirmed live; the user will see the new URL in Ads Manager. (May also include effective_status / review_feedback, e.g. PENDING_REVIEW, as informational — Meta's ad review can take up to ~24h but the destination is already set.)
        - pending:true with error SWAP_PENDING or DESTINATION_PENDING → after 3 checks Meta had not yet reflected the change. This is almost always transient propagation, NOT a failure: tell the user the update is applied on Meta's side and will reflect within a few minutes; do NOT keep retrying in a tight loop. Re-check after a short wait if confirmation is needed.
    - success with verified:false (either path) → the swap was sent but the confirmation read-back itself failed; re-check the ad before telling the user it's done.

CAMPAIGN OBJECTIVES (valid values for 'objective'):
  OUTCOME_TRAFFIC, OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT, OUTCOME_SALES, OUTCOME_LEADS, OUTCOME_APP_PROMOTION

BUDGET RULES (Campaign & Ad Set):
  - Provide daily_budget OR lifetime_budget, NEVER both
  - lifetime_budget requires end_time (ISO 8601)
  - advantage_campaign_budget=true enables campaign-level budget; use budget_amount instead of ad-set-level budget

CREATIVE SUB-TYPES (mutually exclusive — pick exactly one):
  IMAGE creative:    provide image_hash (from UPLOAD_IMAGE) OR image_url
  VIDEO creative:    provide video_id (from UPLOAD_VIDEO) + REQUIRED thumbnail: image_hash or image_url
                     (Meta API error 1443226 if thumbnail is missing — always upload thumbnail first)
  CAROUSEL creative: provide carousel_cards array with 2–10 items; each card needs at least one of image_hash, image_url, or video_id; plus title, link_url per card
  PLACEMENT-CUSTOMIZED creative: provide placement_assets — different image per placement in ONE creative (e.g. square for Feed, 9:16 for Stories/Reels). See below.
  RULE: video_id, carousel_cards, and placement_assets are mutually exclusive — pick one.

PLACEMENT ASSET CUSTOMIZATION (placement_assets) — fixes "invalid format / lacking 9:16 for story and reel":
  When an ad set uses manual placements that include Stories/Reels, a creative with only a square/4:5
  Feed image is rejected (missing 9:16) and the ad is auto-paused. Attach a vertical 9:16 asset for
  Stories/Reels while keeping the square image for Feed — in the SAME creative — via placement_assets.
  Shape: placement_assets = [
    { image_hash OR image_url, is_default: true },                 // fallback (square/Feed image) — exactly one
    { image_hash OR image_url, placements: ["story", "reels"] }     // 9:16 vertical asset for Stories/Reels
  ]
  Rules: at least 2 assets; EXACTLY ONE default (is_default:true or omit placements); body/title/link_url
  apply to all placements. image_url is auto-uploaded to a hash. Placement tokens: feed, facebook_feed,
  instagram_feed, story/stories, facebook_story, instagram_story, reels, facebook_reels, instagram_reels, explore.
  TO FIX AN EXISTING AD: AD UPDATE with ad_id + params.placement_assets — the system builds the new
  multi-placement creative and points the SAME ad at it (no Ads Manager UI, same ad_id).
  NOTES:
  - Instagram placements (story/reels/etc.) need an Instagram actor; the system auto-resolves it from the
    Page, or pass params.instagram_user_id explicitly. (Meta error 1772103 = "Instagram Account Is Missing".)
  - CTA must be allowed for the campaign objective on asset-feed creatives. e.g. BOOK_NOW is rejected under
    OUTCOME_SALES (Meta error 1885396) — use a supported CTA like LEARN_MORE / SIGN_UP / SHOP_NOW.

VIDEO CREATIVE WORKFLOW (3 steps, all required):
  Step 1: UPLOAD_VIDEO → returns video_id
  Step 2: UPLOAD_IMAGE → returns image_hash  (thumbnail — MANDATORY for video creatives)
  Step 3: AD_CREATIVE CREATE with video_id + image_hash (or image_url)

OBJECTIVE → OPTIMIZATION GOAL COMPATIBILITY (common mappings):
  OUTCOME_TRAFFIC   → LINK_CLICKS, LANDING_PAGE_VIEWS
  OUTCOME_AWARENESS → REACH, IMPRESSIONS
  OUTCOME_ENGAGEMENT → POST_ENGAGEMENT, PAGE_LIKES
  OUTCOME_SALES     → OFFSITE_CONVERSIONS, VALUE
  OUTCOME_LEADS     → LEAD_GENERATION, OFFSITE_CONVERSIONS
  OUTCOME_APP_PROMOTION → APP_INSTALLS

AD LIST COMPLETENESS:
  AD LIST returns ALL non-deleted ads including those paused at the campaign or adset level.
  Each ad includes effective_status which shows the true running state:
    ACTIVE           → ad is running
    PAUSED           → ad itself is paused
    CAMPAIGN_PAUSED  → ad's campaign is paused (ad would run if campaign is unpaused)
    ADSET_PAUSED     → ad's adset is paused (ad would run if adset is unpaused)
  To fully pause all spend, you must pause ads/adsets/campaigns in ALL effective statuses, not just ACTIVE.
  When asked to "pause all ads", always LIST first then UPDATE every ad regardless of effective_status.

GETTING DESTINATION URLS / CREATIVE DETAILS:
  AD LIST now returns creative sub-fields directly (name, body, title, image_url, thumbnail_url, object_story_spec).
  Extract link from: image creative → creative.object_story_spec.link_data.link
                     video creative → creative.object_story_spec.video_data.call_to_action.value.link
                     carousel       → creative.object_story_spec.link_data.child_attachments[].link
  If you need creatives for ALL ads in the account without filtering: use AD_CREATIVE LIST.`,
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["CAMPAIGN", "AD_SET", "AD_CREATIVE", "AD", "CUSTOM_AUDIENCE", "TARGETING", "PAGE", "DATASET"],
          description: "The Meta Ads entity to operate on."
        },
        action: {
          type: "string",
          enum: ["LIST", "GET", "CREATE", "UPDATE", "DELETE", "COPY_AD", "RETAG_UTM", "UPLOAD_IMAGE", "UPLOAD_VIDEO", "UPLOAD_USERS", "SEARCH", "GET_MATCH_QUALITY"],
          description: "The operation to perform. Must be valid for the chosen entity_type."
        },
        account_id: {
          type: "string",
          description: "Ad Account ID (without 'act_' prefix). Must be obtained from list_connected_accounts(platform='meta')."
        },
        campaign_id: {
          type: "string",
          description: "Campaign ID. Required for: CAMPAIGN UPDATE/DELETE, AD_SET CREATE, AD_SET LIST (optional filter)."
        },
        ad_set_id: {
          type: "string",
          description: "Ad Set ID. Required for: AD_SET UPDATE/DELETE, AD CREATE, AD LIST (optional filter)."
        },
        ad_id: {
          type: "string",
          description: "Ad ID. Required for: AD UPDATE/DELETE/COPY_AD/RETAG_UTM."
        },
        params: {
          type: "object",
          description: "Action-specific parameters. Required fields depend on entity_type + action (see tool description for the full matrix).",
          properties: {
            // --- Confirmation gate (write actions) ---
            confirm: { type: "boolean", description: "Set to true ONLY after showing the user the resolved target (campaign/ad set/asset) returned by the first call and getting explicit approval. Required to actually execute CAMPAIGN/AD_SET/AD CREATE/UPDATE/DELETE/COPY_AD/RETAG_UTM. Omit (or false) on the first call to preview the target." },

            // --- Common ---
            name: { type: "string", description: "Entity name." },
            status: { type: "string", enum: ["ACTIVE", "PAUSED", "ARCHIVED"], description: "Entity status." },

            // --- Campaign ---
            objective: { type: "string", description: "Campaign objective (e.g., OUTCOME_TRAFFIC, OUTCOME_SALES)." },
            objective_quote: {
              type: "string",
              description:
                "CAMPAIGN CREATE ONLY: the exact, literal substring from the user's own message that names this objective (e.g. the user typed \"set up a leads campaign\" → objective_quote: \"leads campaign\"). Provide this ONLY when the user explicitly named the objective themselves — it is checked against their actual message, and a quote that doesn't genuinely appear there is rejected. Do NOT invent or paraphrase a quote, and do NOT provide this if the user did not actually name an objective — just omit it and the objective will be confirmed automatically before the campaign is created.",
            },
            special_ad_categories: { type: "array", items: { type: "string" }, description: 'Special ad categories. Use ["NONE"] if not applicable.' },
            advantage_campaign_budget: { type: "boolean", description: "Enable Advantage Campaign Budget." },
            spend_cap: { type: "integer", minimum: 1, description: "CAMPAIGN CREATE/UPDATE: lifetime hard-stop spend cap for the campaign, as a positive WHOLE number of CENTS (e.g. 300000 = $3,000) — never dollars, never fractional. The write is verified by an independent read-back — see SPEND CAP in the tool description; only claim the cap is set when spend_cap_verified is true. Read it back any time via CAMPAIGN LIST with params.fields including spend_cap." },
            budget_amount: { type: "number", description: "Campaign-level daily budget in dollars (when advantage_campaign_budget is true)." },

            // --- Ad Set ---
            optimization_goal: { type: "string", description: "Optimization goal (must be compatible with campaign objective)." },
            billing_event: { type: "string", description: "Billing event (must be compatible with optimization_goal)." },
            daily_budget: { type: "number", description: "Daily budget in dollars. Min $1, max $5,000." },
            lifetime_budget: { type: "number", description: "Lifetime budget in dollars. Min $1, max $50,000. Requires end_time." },
            bid_strategy: { type: "string", enum: ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"], description: "Bid strategy." },
            bid_amount: { type: "number", description: "Bid amount in dollars. Required for BID_CAP and COST_CAP strategies." },
            targeting: {
              type: "object",
              description: "Targeting specification. geo_locations is required. targeting_automation.advantage_audience (0 or 1) is auto-injected as 0 if omitted — pass explicitly to override. Example: { geo_locations: { countries: ['US'] }, targeting_automation: { advantage_audience: 0 } }"
            },
            start_time: { type: "string", description: "ISO 8601 start datetime." },
            end_time: { type: "string", description: "ISO 8601 end datetime. Required with lifetime_budget." },
            promoted_object: { type: "object", description: "Promoted object (e.g., { page_id: 'ID' } or { pixel_id: 'ID', custom_event_type: 'PURCHASE' })." },
            destination_type: { type: "string", description: "Conversion location for the ad set. Defaults to 'WEBSITE' for website traffic/conversion goals (LINK_CLICKS, LANDING_PAGE_VIEWS, OFFSITE_CONVERSIONS, VALUE) so the ad-level Destination is explicitly set. Pass explicitly for other destinations: 'ON_AD' (instant lead forms), 'MESSENGER', 'APP'." },

            // --- Creative ---
            page_id: { type: "string", description: "Facebook Page ID (from list_meta_pages or PAGE LIST)." },
            instagram_user_id: { type: "string", description: "Instagram actor ID for the creative. Required when serving Instagram placements (e.g. placement_assets targeting story/reels); auto-resolved from the Page if omitted." },
            image_hash: { type: "string", description: "Image hash from UPLOAD_IMAGE." },
            image_url: { type: "string", description: "Image URL (for UPLOAD_IMAGE action or direct creative use)." },
            video_id: { type: "string", description: "Video ID from UPLOAD_VIDEO." },
            video_url: { type: "string", description: "Video URL (for UPLOAD_VIDEO action)." },
            carousel_cards: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_hash: { type: "string" }, video_id: { type: "string" },
                  title: { type: "string" }, description: { type: "string" }, link_url: { type: "string" }
                }
              },
              description: "Carousel card array for multi-card creatives."
            },
            placement_assets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_hash: { type: "string", description: "Image hash from UPLOAD_IMAGE." },
                  image_url: { type: "string", description: "Image URL (auto-uploaded to a hash)." },
                  placements: {
                    type: "array",
                    items: { type: "string" },
                    description: "Placement tokens this image serves (e.g. ['story','reels']). Omit for the default/fallback asset."
                  },
                  is_default: { type: "boolean", description: "Marks the fallback image that serves every unmatched placement (e.g. the square Feed image). Exactly one asset must be the default." }
                }
              },
              description: "Placement-level image customization (asset_feed_spec). Map different images to different placements in ONE creative (square→Feed, 9:16→Stories/Reels). Requires ≥2 assets and exactly one default. Mutually exclusive with video_id and carousel_cards."
            },
            body: { type: "string", description: "Ad body / primary text." },
            title: { type: "string", description: "Ad headline." },
            link_url: { type: "string", description: "Destination URL." },
            call_to_action_type: { type: "string", description: "CTA button (e.g., LEARN_MORE, SHOP_NOW, SIGN_UP)." },
            creative_id: { type: "string", description: "Creative ID. For AD CREATE: the creative to attach. For AD UPDATE: swap the ad onto this existing creative (nested as { creative: { creative_id } } — a top-level creative_id is silently ignored by Meta)." },

            // --- Custom Audience ---
            subtype: { type: "string", enum: ["CUSTOM", "LOOKALIKE"], description: "Audience subtype." },
            description: { type: "string", description: "Audience description." },
            customer_file_source: { type: "string", description: "Source type for CUSTOM audiences (e.g., USER_PROVIDED_ONLY)." },
            lookalike_spec: { type: "object", description: "Lookalike config: { origin: [{ id, type }], ratio: 0.01, country: 'US' }." },
            id: { type: "string", description: "Audience ID for UPLOAD_USERS." },
            schema: { type: "array", items: { type: "string" }, description: "PII field types for UPLOAD_USERS (e.g., ['EMAIL', 'FN', 'LN'])." },
            payload: { type: "string", description: "User data as JSON array-of-arrays for UPLOAD_USERS." },

            // --- Targeting Search ---
            q: { type: "string", description: "Search query for targeting search." },
            type: { type: "string", enum: ["adinterest", "adbehavior", "addemographics", "adgeolocation"], description: "Targeting category to search. Use 'adgeolocation' to resolve geo-targeting locations (cities/regions/zips) into keys usable in ad set geo_locations." },
            location_types: { type: "array", items: { type: "string" }, description: "For type='adgeolocation' only: restrict results to specific location kinds, e.g. ['city'], ['region'], ['zip'], ['country']." },

            // --- Dataset ---
            dataset_id: { type: "string", description: "Dataset ID. Required for DATASET GET_MATCH_QUALITY." }
          }
        }
      },
      required: ["entity_type", "action", "account_id"]
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callMetaMarketingApi(
      context?.userId,
      args.entity_type,
      args.action,
      args.account_id,
      args.campaign_id,
      args.ad_set_id,
      args.ad_id,
      args.params,
      context?.sessionId,
    );
  }
});

// ENG-600: audience_source shape shared by both new tools below. Exactly one
// of hubspot_list_id / csv_url must be given — csv_url accepts a chat file
// attachment's stored URL directly (the underlying UPLOAD_USERS action fetches
// and parses it automatically; do not route it through read_file_content first).
const AUDIENCE_SOURCE_SCHEMA = {
  type: "object",
  description: "Exactly one of hubspot_list_id or csv_url must be provided as the seed audience's source data.",
  properties: {
    hubspot_list_id: { type: "string", description: "HubSpot contact list (segment) ID to pull members from." },
    hubspot_account_id: { type: "string", description: "HubSpot connected-account ID that owns hubspot_list_id. REQUIRED whenever the user has more than one HubSpot account connected (list_connected_accounts platform=hubspot) — the tool cannot guess which portal a list ID belongs to, and errors asking for this if omitted and ambiguous. Not needed if only one HubSpot account is connected, or when using csv_url." },
    csv_url: { type: "string", description: "URL of an uploaded CSV attachment (email/phone columns). Pass the chat attachment's stored URL directly — it will be fetched and parsed automatically. Do not use read_file_content first." }
  }
} as const;

emmaToolRegistry.register({
  name: "launch_targeted_audience_campaign",
  definition: {
    name: "launch_targeted_audience_campaign",
    description: "Launch a Meta campaign targeted at a Custom Audience sourced from a HubSpot list or a CSV, optionally via a Lookalike built from that seed. Creates or reuses (by name) the Custom Audience, optionally creates a Lookalike from it, and attaches it to a NEW ad set under an existing campaign (kept separate from any broad/control campaign). Two-phase like call_meta_marketing_api writes: call once without confirm to get a preview (awaitingUserConfirmation), show it to the user, then call again with confirm=true to execute. Returns a completion ledger (source, audience, lookalike, campaign/ad set, any failures). Distinct from launch_retargeting_campaign, which requires exclude_audience_id.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Meta ad account ID (no 'act_' prefix)." },
        campaign_id: { type: "string", description: "Existing campaign to attach the new targeted ad set to. Create it first via call_meta_marketing_api CAMPAIGN CREATE if it doesn't exist — this tool does not create campaigns." },
        audience_name: { type: "string", description: "Name for the Meta Custom Audience to create or reuse. If an audience with this name already exists, its use is surfaced in the preview for confirmation, never reused silently." },
        audience_source: AUDIENCE_SOURCE_SCHEMA,
        use_lookalike: { type: "boolean", description: "Create a Lookalike Audience from the seed audience and target that instead of the seed directly." },
        lookalike_ratio: { type: "number", description: "Lookalike ratio 0.01-0.20 (e.g. 0.01 = top 1% of country population). Required if use_lookalike is true — no default is applied." },
        lookalike_country: { type: "string", description: "2-letter ISO country code for the lookalike (e.g. 'US'). Required if use_lookalike is true — no default is applied." },
        ad_set_params: { type: "object", description: "Standard ad set fields (name, daily_budget/lifetime_budget, optimization_goal, billing_event, targeting.geo_locations, start_time, etc.) — same shape as call_meta_marketing_api AD_SET CREATE params, minus targeting.custom_audiences which this tool sets automatically." },
        confirm: { type: "boolean", description: "Set true only after showing the user the resolved audience + ad set target from the preview and getting explicit approval." },
        preview_token: { type: "string", description: "The exact previewToken value returned by the preview call (no confirm). Required alongside confirm=true — copy it verbatim, do not retype or guess it. If it's missing or the arguments changed since the preview, the call returns a fresh preview instead of executing." }
      },
      required: ["account_id", "campaign_id", "audience_name", "audience_source", "ad_set_params"]
    }
  },
  execute: async (args, context) => {
    return await agentModeService.launchTargetedAudienceCampaign(context?.userId, args);
  }
});

emmaToolRegistry.register({
  name: "launch_retargeting_campaign",
  definition: {
    name: "launch_retargeting_campaign",
    description: "Launch a Meta retargeting campaign against a Custom Audience sourced from a HubSpot list or a CSV (e.g. past customers/existing contacts), REQUIRING an exclude_audience_id (typically the broad/prospecting audience) so retargeting spend never overlaps prospecting spend. Otherwise behaves like launch_targeted_audience_campaign: creates or reuses the audience by name, optionally builds a Lookalike from it (off by default here — retargeting usually targets the seed directly), attaches it to a NEW ad set under an existing campaign, and uses the same two-phase preview/confirm gate. Returns a completion ledger.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Meta ad account ID (no 'act_' prefix)." },
        campaign_id: { type: "string", description: "Existing campaign for the retargeting ad set. This tool does not create campaigns." },
        audience_name: { type: "string", description: "Name for the Meta Custom Audience to create or reuse. If an audience with this name already exists, its use is surfaced in the preview for confirmation, never reused silently." },
        audience_source: AUDIENCE_SOURCE_SCHEMA,
        exclude_audience_id: { type: "string", description: "REQUIRED. Custom Audience ID to exclude (typically the broad/prospecting audience or a control custom audience) so retargeting spend never overlaps prospecting spend. This is the key structural-separation mechanism for retargeting and has no equivalent in launch_targeted_audience_campaign." },
        use_lookalike: { type: "boolean", description: "Optional — retargeting normally targets the seed audience directly, not a lookalike of it." },
        lookalike_ratio: { type: "number", description: "Lookalike ratio 0.01-0.20. Required if use_lookalike is true — no default is applied." },
        lookalike_country: { type: "string", description: "2-letter ISO country code. Required if use_lookalike is true — no default is applied." },
        ad_set_params: { type: "object", description: "Standard ad set fields — same shape as call_meta_marketing_api AD_SET CREATE params, minus targeting.custom_audiences/excluded_custom_audiences which this tool sets automatically." },
        confirm: { type: "boolean", description: "Set true only after showing the user the resolved audience + ad set target from the preview and getting explicit approval." },
        preview_token: { type: "string", description: "The exact previewToken value returned by the preview call (no confirm). Required alongside confirm=true — copy it verbatim, do not retype or guess it. If it's missing or the arguments changed since the preview, the call returns a fresh preview instead of executing." }
      },
      required: ["account_id", "campaign_id", "audience_name", "audience_source", "exclude_audience_id", "ad_set_params"]
    }
  },
  execute: async (args, context) => {
    return await agentModeService.launchRetargetingCampaign(context?.userId, args);
  }
});

emmaToolRegistry.register({
  name: "call_meta_ads_insights_api",
  definition: {
    name: "call_meta_ads_insights_api",
    description:
      "Fetch performance reporting data from Meta Ads (impressions, clicks, spend, conversions, ROAS, etc.). Use this for custom queries with specific fields, date ranges, breakdowns, or filtering. Handles Meta's async reporting internally and returns the insights rows inline as { totalRows, metadata, data }. (If the result set is very large it may be offloaded to an S3 key readable with read_tool_response/search_tool_response.) You MUST provide either date_preset or time_range (defaults to all-time if omitted, which can be very large). For a quick pre-built dashboard summary of specific campaigns, use get_meta_ads_metrics instead.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description:
            "The ad account ID (numeric, without 'act_' prefix). Use list_connected_accounts to retrieve this. DO NOT guess.",
        },
        object_type: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description:
            "Entity level to fetch insights for. Use 'account' for the whole account.",
        },
        object_id: {
          type: "string",
          description:
            "The entity ID. REQUIRED when object_type is campaign, adset, or ad. Omit for account-level.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Metrics to retrieve. Common: impressions, reach, clicks, spend, ctr, cpc, cpm, actions, action_values, purchase_roas, conversions, video_views, cost_per_action_type.",
        },
        date_preset: {
          type: "string",
          enum: [
            "today",
            "yesterday",
            "this_month",
            "last_month",
            "this_quarter",
            "maximum",
            "last_3d",
            "last_7d",
            "last_14d",
            "last_28d",
            "last_30d",
            "last_90d",
            "this_year",
            "last_year"
          ],
          description:
            "Predefined date range. Recommended default: 'last_30d'. Use 'maximum' for lifetime. Mutually exclusive with time_range.",
        },
        time_range: {
          type: "object",
          properties: {
            since: {
              type: "string",
              description: "Start date (YYYY-MM-DD). Must be <= until.",
            },
            until: {
              type: "string",
              description: "End date (YYYY-MM-DD). Must be >= since.",
            },
          },
          required: ["since", "until"],
          description:
            "Custom date range. Both since and until are required. Mutually exclusive with date_preset.",
        },
        level: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description:
            "Row aggregation level. Example: object_type='account' + level='campaign' returns one row per campaign.",
        },
        breakdowns: {
          type: "array",
          items: {
            type: "string",
            enum: ["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform"],
          },
          description:
            "Segment results by dimension. E.g., ['age', 'gender'] splits each row by age+gender.",
        },
        action_breakdowns: {
          type: "array",
          items: {
            type: "string",
            enum: ["action_type", "action_target_id", "action_destination", "action_device", "action_reaction", "action_video_sound", "action_video_type", "action_carousel_card_id", "action_carousel_card_name"],
          },
          description:
            "Segment action/conversion metrics. Use 'action_type' to break down the 'actions' and 'action_values' fields by event type (e.g., purchase, link_click).",
        },
        filtering: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field to filter on (e.g., 'campaign.name', 'adset.name', 'campaign.objective')." },
              operator: { type: "string", enum: ["EQUAL", "NOT_EQUAL", "GREATER_THAN", "LESS_THAN", "IN", "NOT_IN", "CONTAIN", "NOT_CONTAIN"] },
              value: { description: "Filter value. String for EQUAL/CONTAIN, array for IN/NOT_IN." },
            },
            required: ["field", "operator", "value"],
          },
          description:
            "Server-side filters to narrow results before aggregation.",
        },
      },
      required: ["account_id", "object_type", "fields"],
    },
  },
  execute: async (args, context) => {
    return await agentModeService.callMetaAdsInsightsApiWrapper(
      context?.userId,
      args as any,
    );
  },
});

emmaToolRegistry.register({
  name: 'get_meta_ads_metrics',
  definition: {
    name: 'get_meta_ads_metrics',
    description: 'Quick pre-built dashboard: returns a formatted summary of campaign, ad set, and ad performance with demographics, placement, and device breakdowns for specific campaigns. Best for "how are my campaigns doing?" questions. For custom field selection, custom date ranges, or raw data export, use call_meta_ads_insights_api instead.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          description: 'Time period for metrics (7d, 14d, 30d, 90d)',
          enum: ['7d', '14d', '30d', '90d'],
          default: '7d'
        },
        campaign_ids: {
          // Union type so the static schema accepts exactly the shapes execute()
          // normalizes (array preferred; legacy single string also accepted).
          // minItems only fires for arrays, so a string id is not rejected.
          type: ['array', 'string'],
          items: { type: 'string' },
          minItems: 1,
          description: 'List of campaign IDs to filter metrics by (array preferred; a single campaign id string is also accepted). Use list_meta_ads_campaigns to get available campaign IDs (works even without a connected Meta account).'
        },
        campaign_id: {
          // Legacy single-id alias. execute() normalizes this into campaign_ids.
          type: 'string',
          description: 'Legacy alias for a single campaign id. Prefer campaign_ids. Provide at least one of campaign_ids or campaign_id.'
        },
        account_id: {
          type: 'string',
          description: 'Optional Meta ad account ID from list_connected_accounts. Required only when multiple Meta ad accounts are available.'
        }
      }
    }
  },
  execute: async (args, context) => {
    // Backward-compatible normalization: accept legacy campaign_id or string campaign_ids.
    const normalizedCampaignIds = normalizeMetaCampaignIds(
      args.campaign_ids,
      args.campaign_id,
    );

    return await agentModeService.getMetaAdsMetrics(
      args.timeframe || '7d',
      context?.userId,
      normalizedCampaignIds,
      args.account_id,
    );
  }
});

// --- LinkedIn Ads Tools ---
emmaToolRegistry.register({
  name: 'call_linkedin_marketing_api',
  definition: {
    name: 'call_linkedin_marketing_api',
    description: `Manage LinkedIn Ads entities via the Marketing Developer Platform API. Requires account_id from list_connected_accounts(platform='linkedin_ads').

INTERNAL TERMINOLOGY MAPPING (never mention API names in responses):
  User says "campaign"  →  use entity_type = CAMPAIGN_GROUP
  User says "ad set"    →  use entity_type = CAMPAIGN
  User says "ad"        →  use entity_type = CREATIVE
The words CAMPAIGN_GROUP, CAMPAIGN, CREATIVE must NEVER appear in your response to the user. These are internal API values only.
Always say "Campaign", "Ad Set", "Ad" — nothing else.
FORBIDDEN (never say these): "campaign group", "creative", "ad set (campaign)", "ads (creatives)", "campaigns (campaign groups)"

ACTION MATRIX (entity_type → supported actions):
  AD_ACCOUNT      → LIST
  CAMPAIGN_GROUP  → LIST, CREATE, UPDATE
  CAMPAIGN        → LIST, CREATE, UPDATE
  CREATIVE        → LIST, CREATE, CREATE_INLINE, CREATE_DYNAMIC, RETAG_UTM
  POST            → CREATE, GET (post_urn)
  TARGETING       → LIST_FACETS, SEARCH, ESTIMATE_REACH
  MEDIA           → UPLOAD_IMAGE, UPLOAD_VIDEO, UPLOAD_DOCUMENT
  INMAIL          → CREATE_CONTENT, SEND_TEST
  CONVERSATION_AD → CREATE, CREATE_CONTENT, SET_FIRST_CONTENT

ENTITY HIERARCHY: Ad Account → Campaign Group → Campaign → Creative

⚠️ AD FORMAT FLOWS — STRICTLY FOLLOW THESE, NO DEVIATION:

  SINGLE IMAGE AD (campaign type: SPONSORED_UPDATES):
    Ask first: "Show on company page or dark post only?"
    Company page (FLOW A): MEDIA/UPLOAD_IMAGE → POST/CREATE (feed_distribution=MAIN_FEED, image_urn) → CREATIVE/CREATE (post_urn)
    Dark post  (FLOW B): MEDIA/UPLOAD_IMAGE → CREATIVE/CREATE_INLINE (image_urn, commentary, campaign_id)

  CAROUSEL AD (Requires Campaign format: CAROUSEL) — ALWAYS FLOW B, NO EXCEPTIONS. NEVER use POST/CREATE + CREATIVE/CREATE for carousel (causes LinkedIn type conflict):
    MEDIA/UPLOAD_IMAGE (×N, one per card) → CREATIVE/CREATE_INLINE (carousel_cards, commentary, campaign_id)
    carousel_cards format: array of { image_urn, title, landing_page }
    LinkedIn does NOT support carousel as an organic company page post.

  VIDEO AD (campaign type: SPONSORED_UPDATES, Requires Campaign format: SINGLE_VIDEO) — NEVER ask user for file size:
    Ask first: "Show on company page or dark post only?"
    Company page (FLOW A): MEDIA/UPLOAD_VIDEO (video_url) → POST/CREATE (feed_distribution=MAIN_FEED, video_urn) → CREATIVE/CREATE (post_urn)
    Dark post  (FLOW B): MEDIA/UPLOAD_VIDEO (video_url) → CREATIVE/CREATE_INLINE (video_urn, commentary, campaign_id)
    MEDIA/UPLOAD_VIDEO auto-downloads the video, measures its size, handles multipart upload, and returns video_urn.

  ARTICLE AD (campaign type: SPONSORED_UPDATES):
    POST/CREATE (article_url, article_title, article_description, optional thumbnail_urn) → CREATIVE/CREATE (post_urn)
    No media upload needed — LinkedIn fetches the article preview automatically.

  DOCUMENT AD (campaign type: SPONSORED_UPDATES):
    MEDIA/UPLOAD_DOCUMENT (document_url) → POST/CREATE (document_urn, title) → CREATIVE/CREATE_INLINE (commentary, campaign_id) OR CREATIVE/CREATE (post_urn)

  TEXT AD (campaign type: TEXT_AD):
    CREATIVE/CREATE (headline, description, landing_page, optional image_urn, campaign_id)
    No post creation needed — text ads are self-contained in the creative.

  MESSAGE AD (InMail, campaign type: SPONSORED_INMAILS):
    INMAIL/CREATE_CONTENT → CREATIVE/CREATE (inmail_content_urn, campaign_id)
    Optionally send a test: INMAIL/SEND_TEST (inmail_content_urn, recipient_email)
    sender is auto-resolved from the connected account — do NOT ask the user for it.

  CONVERSATION AD (branching message, campaign type: SPONSORED_INMAILS):
    CONVERSATION_AD/CREATE (name, optional — becomes the ad's headline text; omit to let LinkedIn use the first message as the headline) → CONVERSATION_AD/CREATE_CONTENT (×N message nodes with buttons) → CONVERSATION_AD/SET_FIRST_CONTENT → CREATIVE/CREATE (inmail_content_urn=conversation_ad_urn, campaign_id)
    Each button can link to another message node (SEND_MESSAGE action) or a URL (OPEN_URL action).

  JOBS AD (campaign type: DYNAMIC, campaign format: JOBS):
    CREATIVE/CREATE_DYNAMIC (format=JOBS, headline, button_label, campaign_id)
    Campaign must use type=DYNAMIC. Do NOT set objectiveType — it is not supported for JOBS campaigns in LinkedIn API v202603+.

  SPOTLIGHT AD (campaign type: DYNAMIC):
    ⚠️ logo_urn is REQUIRED for SPOTLIGHT — LinkedIn mandates it if the company page has no logo. Upload first with MEDIA/UPLOAD_IMAGE.
    MEDIA/UPLOAD_IMAGE (logo image) → CREATIVE/CREATE_DYNAMIC (format=SPOTLIGHT, headline, call_to_action, landing_page, logo_urn, optional description/background_image_urn, campaign_id)

  FOLLOWER AD (campaign type: DYNAMIC):
    CREATIVE/CREATE_DYNAMIC (format=FOLLOW_COMPANY, headline, optional description/call_to_action, campaign_id)
    Uses LinkedIn pre-approved headline/CTA templates to match member profile.

  EVENT AD (campaign type: SPONSORED_UPDATES):
    POST/CREATE (event_urn from an existing LinkedIn Event) → CREATIVE/CREATE (post_urn, optional pre_event_registration_image)
    Or just CREATIVE/CREATE (post_urn=event_post_urn) if the event post already exists.

  VAST TAG VIDEO AD (third-party video, campaign type: SPONSORED_UPDATES):
    CREATIVE/CREATE (vast_tag_url, campaign_id) — no upload needed; video served by Innovid or approved vendor.

REQUIRED PARAMS PER ENTITY + ACTION:
  CAMPAIGN_GROUP CREATE: name, status (ACTIVE|DRAFT only — LinkedIn does NOT allow PAUSED on creation; if user wants paused, create as DRAFT then UPDATE to PAUSED), run_schedule_start (epoch ms — ask the user when the campaign group should start), totalBudget.amount + totalBudget.currencyCode
  CAMPAIGN CREATE: ⚠️ ALWAYS ask before creating: "What type of ads will run in this campaign?" Then set type accordingly:
    type: SPONSORED_UPDATES (image, video, carousel, article, document, event, VAST) | TEXT_AD | SPONSORED_INMAILS (message/conversation) | DYNAMIC (jobs, spotlight, follower)
    format: ⚠️ REQUIRED for DYNAMIC, VIDEO, and CAROUSEL ads.
      - If type=DYNAMIC: format=JOBS|SPOTLIGHT|FOLLOW_COMPANY
      - If type=SPONSORED_UPDATES for video ads: format=SINGLE_VIDEO
      - If type=SPONSORED_UPDATES for carousel ads: format=CAROUSEL
      - If type=SPONSORED_UPDATES for event ads: format=SPONSORED_UPDATE_EVENT
      - For single image / article / document: omit format (defaults to STANDARD_UPDATE).
    Campaign type is immutable after creation.
    Other required: name, status, campaignGroup (full URN), objectiveType (WEBSITE_VISIT|BRAND_AWARENESS|ENGAGEMENT|VIDEO_VIEWS|LEAD_GENERATION|WEBSITE_CONVERSIONS — omit entirely for DYNAMIC/JOBS campaigns), costType (CPM|CPC|CPV), unitCost, targeting_include (array)
    targeting_include format: array of { "facet_urn": "urn:li:adTargetingFacet:locations", "values": ["urn:li:geo:103644278"] }
    ALWAYS use targeting_include/targeting_exclude — never construct targetingCriteria manually
  CAMPAIGN UPDATE: campaign_id + fields to update. If the ad set was created with a runSchedule.start that has since elapsed,
    LinkedIn re-validates it on EVERY update (even status-only ones like archiving) and rejects with the old stored value --
    pass a future runSchedule (or run_schedule_start) alongside whatever else you're changing to get past this.
  CREATIVE LIST: params.campaign_id required
  CREATIVE CREATE: campaign_id + one of: post_urn (sponsored content/event/article/document), headline+description+landing_page (text ad), inmail_content_urn (message/conversation ad), vast_tag_url (VAST video). Optional: pre_event_registration_image (event ads). Lead Gen ad: also pass leadgen_form_urn + cta_label_type to attach an existing Lead Gen Form.
  CREATIVE CREATE_INLINE: Dark post only. Required: campaign_id, commentary, image_urn OR video_urn OR document_urn OR carousel_cards. Lead Gen ad (LEAD_GENERATION campaign): also pass leadgen_form_urn (adForm URN) + cta_label_type (e.g. SIGN_UP) to attach an existing Lead Gen Form.
  CREATIVE CREATE_DYNAMIC: campaign_id, format (JOBS|SPOTLIGHT|FOLLOW_COMPANY). JOBS needs headline+button_label. SPOTLIGHT needs headline+call_to_action+landing_page+logo_urn (logo_urn is REQUIRED — upload logo with MEDIA/UPLOAD_IMAGE first). FOLLOW_COMPANY needs headline.
  CREATIVE RETAG_UTM (ENG-239 — retrofit UTMs onto ONE existing creative found untagged, e.g. via audit_ad_utm_coverage):
    Requires creative_id + campaign_id. Single-target only, one creative per call — never loop over multiple.
    If it fails, tell the user plainly rather than retrying blindly.
    TEXT_AD creatives: retags the creative directly.
    Sponsored-content (post-reference) creatives: retags the underlying LinkedIn POST's CTA-button destination
    (contentLandingPage) instead — the only post field LinkedIn allows editing after publish. This does NOT
    cover an article post's own link, or any post with no CTA button configured; those return
    NO_RETAGGABLE_DESTINATION. Tell the user this plainly rather than treating it as a generic failure — it
    means a human needs to look, not that the call is broken.
  TARGETING SEARCH: facet (URN like urn:li:adTargetingFacet:locations), query (optional — omit for facets without typeahead like seniorities/industries)
    Common facets: locations, titles (job titles — NOT jobTitles), seniorities, industries, functions, staffCountRanges, memberInterests, skills
  TARGETING ESTIMATE_REACH: targeting_include (array of { facet_urn, values } — SAME shape as CAMPAIGN CREATE; resolve value URNs via TARGETING SEARCH first). Optional targeting_exclude. Returns { active, total }; total is 0 when the audience is under the 300-member minimum. ALWAYS run this before CAMPAIGN CREATE to confirm reach ≥ 300.
  MEDIA UPLOAD_IMAGE: image_url (public URL). Returns image_urn.
  MEDIA UPLOAD_VIDEO: video_url (public URL). Auto-downloads, measures size, handles multipart upload. Returns video_urn. NEVER ask the user for file size.
  MEDIA UPLOAD_DOCUMENT: document_url (public URL to PDF/PPT/DOC). Returns document_urn.
  INMAIL CREATE_CONTENT: name, subject, htmlBody, callToActionText (max 20 chars), callToActionLandingPageUrl. Optional: salutationText, senderName, senderTitle, senderCompany. (sender auto-resolved — do NOT pass it)
  INMAIL SEND_TEST: inmail_content_urn, recipient_email
  CONVERSATION_AD CREATE: none required. Optional: name (becomes the ad's headlineText — LinkedIn has no "name" field on this resource, so it is mapped for you)
  CONVERSATION_AD CREATE_CONTENT: conversation_ad_urn, body (message text), buttons (array of { text, action: OPEN_URL|SEND_MESSAGE, url? }). Optional: subject, footer.
  CONVERSATION_AD SET_FIRST_CONTENT: conversation_ad_urn, first_content_urn

POST/CREATE params: commentary (text), feed_distribution (NONE=dark post|MAIN_FEED=company page), campaign_id (OPTIONAL but STRONGLY RECOMMENDED — see UTM ATTRIBUTION below). Media: image_urn | video_urn | document_urn | article_url+article_title+article_description+thumbnail_urn | carousel_cards.
POST/GET params: post_urn (required). Reads a post/share's own stored fields (commentary, content, contentLandingPage, etc) — use this to inspect
  the actual destination of a sponsored-content creative, since CREATIVE LIST only returns the bare content.reference URN pointer for those, never
  the post's own fields.

UTM ATTRIBUTION — pass campaign_id to the CONTENT actions too:
  POST/CREATE, INMAIL/CREATE_CONTENT and CONVERSATION_AD/CREATE_CONTENT accept an OPTIONAL campaign_id.
  Emma stamps utm_source/utm_medium/utm_campaign onto every destination URL so leads from the ad can be
  attributed back to it. But these three actions author content BEFORE it is attached to a campaign, so
  without campaign_id the landing pages are left UNTAGGED and their leads arrive in the CRM with no source.
  You almost always created the campaign first, so you HAVE the id — pass it. If you genuinely do not have
  one yet, omit it: an untagged URL is correct, a fabricated utm_campaign is not.
  (CREATIVE/CREATE and CREATIVE/CREATE_DYNAMIC already require campaign_id, so those tag automatically.)

BUDGET FORMAT: decimal string e.g. "10.00" = $10.00 (NOT micro-currency)
SCOPES REQUIRED: r_ads, rw_ads (r_ads_reporting for analytics)`,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: ['AD_ACCOUNT', 'CAMPAIGN_GROUP', 'CAMPAIGN', 'CREATIVE', 'POST', 'TARGETING', 'MEDIA', 'INMAIL', 'CONVERSATION_AD'],
          description: 'The LinkedIn Ads entity to operate on.'
        },
        action: {
          type: 'string',
          enum: ['LIST', 'GET', 'CREATE', 'CREATE_INLINE', 'CREATE_DYNAMIC', 'RETAG_UTM', 'UPDATE', 'LIST_FACETS', 'SEARCH', 'ESTIMATE_REACH', 'UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'UPLOAD_DOCUMENT', 'INIT_VIDEO_UPLOAD', 'FINALIZE_VIDEO', 'CREATE_CONTENT', 'SEND_TEST', 'SET_FIRST_CONTENT'],
          description: 'The operation to perform. Must be valid for the chosen entity_type.'
        },
        account_id: {
          type: 'string',
          description: "LinkedIn Ads account ID. Obtain from list_connected_accounts(platform='linkedin_ads')."
        },
        params: {
          type: 'object',
          description: 'Action-specific parameters. See tool description for required fields per entity + action.',
          properties: {
            // Campaign Group / Campaign common
            name: { type: 'string', description: 'Entity name (internal label). Exception: for CONVERSATION_AD CREATE it becomes the member-visible headline text shown in LinkedIn inboxes — write headline copy, not an internal label.' },
            status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'CANCELED', 'COMPLETED'], description: 'Entity status.' },
            campaign_group_id: { type: 'string', description: 'Campaign Group numeric ID. Used for CAMPAIGN LIST.' },
            campaignGroup: { type: 'string', description: 'Campaign Group URN (urn:li:sponsoredCampaignGroup:ID). Required for CAMPAIGN CREATE.' },
            campaign_id: { type: 'string', description: 'Campaign ID. Required for CREATIVE LIST/CREATE, CREATIVE/RETAG_UTM (with creative_id), and CAMPAIGN UPDATE. ALSO accepted — and strongly recommended — on POST/CREATE, INMAIL/CREATE_CONTENT and CONVERSATION_AD/CREATE_CONTENT: without it those destination URLs ship with no utm_campaign and their leads cannot be attributed. Omit it only if no campaign exists yet.' },
            // Campaign
            objectiveType: { type: 'string', description: 'Campaign objective (WEBSITE_VISIT, BRAND_AWARENESS, ENGAGEMENT, VIDEO_VIEWS, LEAD_GENERATION, WEBSITE_CONVERSIONS). Omit entirely for DYNAMIC campaigns with format=JOBS.' },
            costType: { type: 'string', enum: ['CPM', 'CPC', 'CPV'], description: 'Bidding type.' },
            unitCost: { type: 'object', description: '{ amount: "10.00", currencyCode: "USD" }' },
            totalBudget: { type: 'object', description: '{ amount: "1000.00", currencyCode: "USD" }' },
            dailyBudget: { type: 'object', description: '{ amount: "50.00", currencyCode: "USD" }' },
            runSchedule: { type: 'object', description: '{ start: <epoch_ms>, end?: <epoch_ms> }' },
            targeting_include: {
              type: 'array',
              description: 'Targeting facets to include — used by both CAMPAIGN CREATE and TARGETING ESTIMATE_REACH. Each item: { facet_urn: string, values: string[] }. Use TARGETING SEARCH first to get value URNs.',
              items: {
                type: 'object',
                properties: {
                  facet_urn: { type: 'string' },
                  values: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            targeting_exclude: {
              type: 'array',
              description: 'Targeting facets to exclude (CAMPAIGN CREATE and TARGETING ESTIMATE_REACH). Same format as targeting_include.',
              items: {
                type: 'object',
                properties: {
                  facet_urn: { type: 'string' },
                  values: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            // Creative
            type: { type: 'string', enum: ['TEXT_AD', 'SPONSORED_UPDATES', 'SPONSORED_INMAILS', 'DYNAMIC'], description: 'Campaign/creative type.' },
            creative_id: { type: 'string', description: 'Creative ID or URN. Required for CREATIVE/RETAG_UTM (with campaign_id). Obtain from CREATIVE LIST or audit_ad_utm_coverage.' },
            format: { type: 'string', description: 'Campaign or creative format. DYNAMIC campaigns: JOBS|SPOTLIGHT|FOLLOW_COMPANY. Event campaigns: SPONSORED_UPDATE_EVENT.' },
            reference: { type: 'string', description: 'Post URN for SPONSORED_UPDATES creatives.' },
            post_urn: { type: 'string', description: 'Post/share URN (urn:li:share:... or urn:li:ugcPost:...). Required for POST/GET. Also accepted as an alias for reference/post_urn on CREATIVE/CREATE.' },
            // Creative — text ad
            headline: { type: 'string', description: 'Text ad headline. Required for CREATIVE/CREATE text ads.' },
            description: { type: 'string', description: 'Text ad description.' },
            landing_page: { type: 'string', description: 'Landing page URL for text ads.' },
            // Creative — VAST Tag Video Ad
            vast_tag_url: { type: 'string', description: 'VAST tag URL for third-party video ads (e.g. from Innovid). Required for CREATIVE/CREATE VAST video.' },
            // Creative — Event Ad
            pre_event_registration_image: { type: 'string', description: 'Image URN for pre-event registration. Optional for event ad creatives.' },
            // Creative — Lead Gen Form (LEAD_GENERATION campaigns)
            leadgen_form_urn: { type: 'string', description: 'Existing Lead Gen Form adForm URN (e.g. urn:li:adForm:1016740005 or just the numeric id). REQUIRED for a Lead Gen creative in CREATIVE/CREATE or CREATIVE/CREATE_INLINE — sets leadgenCallToAction.destination. Must be paired with cta_label_type.' },
            cta_label_type: { type: 'string', description: 'Lead Gen creative CTA button label (leadgenCallToAction.label), one of: APPLY, DOWNLOAD, VIEW_QUOTE, LEARN_MORE, SIGN_UP, SUBSCRIBE, REGISTER, REQUEST_DEMO, JOIN, ATTEND, UNLOCK_FULL_DOCUMENT. REQUIRED alongside leadgen_form_urn for Lead Gen creatives.' },
            // Creative — Dynamic Ad (Jobs / Spotlight / Follower)
            button_label: { type: 'string', description: 'CTA button text for Jobs dynamic ads (CREATIVE/CREATE_DYNAMIC format=JOBS).' },
            call_to_action: { type: 'string', description: 'CTA text for Spotlight/Follower dynamic ads.' },
            background_image_urn: { type: 'string', description: 'Background image URN for Spotlight dynamic ads.' },
            logo_urn: { type: 'string', description: 'Logo image URN for Spotlight dynamic ads.' },
            // Post
            commentary: { type: 'string', description: 'Post text content.' },
            visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'], description: 'Post visibility.' },
            feed_distribution: { type: 'string', enum: ['NONE', 'MAIN_FEED'], description: 'NONE = dark post (ad only, not shown on company page). MAIN_FEED = visible on company page AND runs as sponsored ad.' },
            // Post — Article Ad
            article_url: { type: 'string', description: 'URL of the article to feature. Required for POST/CREATE article ads.' },
            article_title: { type: 'string', description: 'Article title override for article ads.' },
            article_description: { type: 'string', description: 'Article description override for article ads.' },
            thumbnail_urn: { type: 'string', description: 'Image URN to use as article thumbnail. Optional — LinkedIn auto-fetches if omitted.' },
            // Targeting search
            facet: { type: 'string', description: 'Targeting facet URN (e.g. urn:li:adTargetingFacet:locations).' },
            query: { type: 'string', description: 'Search query for TARGETING SEARCH.' },
            // Post media
            image_url: { type: 'string', description: 'Public URL of the image to upload. Required for MEDIA/UPLOAD_IMAGE.' },
            image_urn: { type: 'string', description: 'Image URN returned by MEDIA/UPLOAD_IMAGE. Use in CREATIVE/CREATE_INLINE or POST/CREATE.' },
            carousel_cards: {
              type: 'array',
              description: 'Carousel ad cards. Each: { image_urn, title, landing_page }.',
              items: {
                type: 'object',
                properties: {
                  image_urn: { type: 'string' },
                  title: { type: 'string' },
                  landing_page: { type: 'string' },
                }
              }
            },
            // Media upload — video
            video_url: { type: 'string', description: 'Public URL of the video file. Required for MEDIA/UPLOAD_VIDEO. File size is auto-detected — do NOT ask the user.' },
            video_urn: { type: 'string', description: 'Video URN returned by MEDIA/UPLOAD_VIDEO. Use in CREATIVE/CREATE_INLINE.' },
            file_size: { type: 'number', description: 'Video file size in bytes. Required for MEDIA/INIT_VIDEO_UPLOAD only (legacy — prefer UPLOAD_VIDEO instead).' },
            // Media upload — document
            document_url: { type: 'string', description: 'Public URL of the document (PDF, PPT, DOC). Required for MEDIA/UPLOAD_DOCUMENT.' },
            document_urn: { type: 'string', description: 'Document URN returned by MEDIA/UPLOAD_DOCUMENT. Use in POST/CREATE for document ads.' },
            // InMail / Message Ad
            subject: { type: 'string', description: 'InMail subject line.' },
            htmlBody: { type: 'string', description: 'InMail body content (HTML allowed).' },
            callToActionText: { type: 'string', description: 'CTA button text (max 20 characters).' },
            callToActionLandingPageUrl: { type: 'string', description: 'URL the CTA button links to.' },
            salutationText: { type: 'string', description: 'Optional salutation (e.g. "Hi %FIRSTNAME%,").' },
            senderName: { type: 'string', description: 'Optional display name for the sender.' },
            senderTitle: { type: 'string', description: 'Optional job title of the sender.' },
            senderCompany: { type: 'string', description: 'Optional company name of the sender.' },
            inmail_content_urn: { type: 'string', description: 'InMail content URN (INMAIL/CREATE_CONTENT result). Use in CREATIVE/CREATE.' },
            recipient_email: { type: 'string', description: 'Email address to send test InMail to. Required for INMAIL/SEND_TEST.' },
            // Conversation Ad
            conversation_ad_urn: { type: 'string', description: 'Conversation Ad URN from CONVERSATION_AD/CREATE. Used in CREATE_CONTENT and SET_FIRST_CONTENT.' },
            body: { type: 'string', description: 'Message body text for CONVERSATION_AD/CREATE_CONTENT.' },
            footer: { type: 'string', description: 'Optional footer text for conversation ad messages.' },
            buttons: {
              type: 'array',
              description: 'CTA buttons for CONVERSATION_AD/CREATE_CONTENT. Each: { text, action: OPEN_URL|SEND_MESSAGE, url? }.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  action: { type: 'string', enum: ['OPEN_URL', 'SEND_MESSAGE'] },
                  url: { type: 'string' },
                }
              }
            },
            first_content_urn: { type: 'string', description: 'First message node URN. Required for CONVERSATION_AD/SET_FIRST_CONTENT.' },
          }
        }
      },
      required: ['entity_type', 'action', 'account_id']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callLinkedInMarketingApi(
      context?.userId,
      args.entity_type,
      args.action,
      args.account_id,
      args.params,
    );
  }
});

emmaToolRegistry.register({
  name: 'call_linkedin_ads_insights_api',
  definition: {
    name: 'call_linkedin_ads_insights_api',
    description: `Fetch LinkedIn Ads performance analytics (impressions, clicks, spend, conversions, etc.).
Analytics are synchronous — results return immediately, no polling needed.

INTERNAL TERMINOLOGY MAPPING (never mention API names in responses):
  User says "campaign"  →  use pivot = CAMPAIGN_GROUP
  User says "ad set"    →  use pivot = CAMPAIGN
  User says "ad"        →  use pivot = CREATIVE
The words CAMPAIGN_GROUP, CAMPAIGN, CREATIVE must NEVER appear in your response to the user. These are internal API values only.
Always say "Campaign", "Ad Set", "Ad" — nothing else.
FORBIDDEN (never say these): "campaign group", "creative", "ad set (campaign)", "ads (creatives)", "campaigns (campaign groups)"

PIVOT OPTIONS:
  CAMPAIGN_GROUP, CAMPAIGN, CREATIVE, COMPANY, ACCOUNT, MEMBER_COMPANY_SIZE,
  MEMBER_INDUSTRY, MEMBER_SENIORITY, MEMBER_JOB_FUNCTION, MEMBER_COUNTRY_V2,
  MEMBER_REGION_V2, PLACEMENT_NAME, IMPRESSION_DEVICE_TYPE

TIME_GRANULARITY: ALL (totals only), DAILY, MONTHLY, YEARLY

COMMON FIELDS: impressions, clicks, costInLocalCurrency, totalEngagements, videoViews,
  videoCompletions, leadGenerationMailContactInfoShares, oneClickLeads`,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: "LinkedIn Ads account ID from list_connected_accounts(platform='linkedin_ads')."
        },
        pivot: {
          type: 'string',
          description: 'Dimension to group results by (e.g. CAMPAIGN, CREATIVE, MEMBER_COUNTRY_V2).'
        },
        dateRange: {
          type: 'object',
          description: 'Date range. { start: { year, month, day }, end: { year, month, day } }',
          properties: {
            start: { type: 'object', properties: { year: { type: 'number' }, month: { type: 'number' }, day: { type: 'number' } }, required: ['year', 'month', 'day'] },
            end: { type: 'object', properties: { year: { type: 'number' }, month: { type: 'number' }, day: { type: 'number' } }, required: ['year', 'month', 'day'] }
          },
          required: ['start', 'end']
        },
        timeGranularity: {
          type: 'string',
          enum: ['ALL', 'DAILY', 'MONTHLY', 'YEARLY'],
          description: 'Time aggregation. Default: ALL (totals only).'
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to return. Common: impressions, clicks, costInLocalCurrency, totalEngagements.'
        },
        campaign_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of campaign group URNs (or numeric IDs) to filter by. Use this to get insights for a specific user-facing "Campaign".'
        },
        campaigns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of campaign URNs (or numeric IDs) to filter by. Use this to get insights for a specific user-facing "Ad Set".'
        },
        creatives: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of creative URNs (or numeric IDs) to filter by. Use this to get insights for a specific user-facing "Ad".'
        }
      },
      required: ['account_id', 'pivot', 'dateRange']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callLinkedInAdsInsightsApi(
      context?.userId,
      args.account_id,
      {
        pivot: args.pivot,
        dateRange: args.dateRange,
        timeGranularity: args.timeGranularity,
        fields: args.fields,
        campaign_groups: args.campaign_groups,
        campaigns: args.campaigns,
        creatives: args.creatives,
      }
    );
  }
});

emmaToolRegistry.register({
  name: 'get_post_analytics',
  definition: {
    name: 'get_post_analytics',
    description: 'Get detailed analytics for specific posts from a connected social media account. Returns engagement metrics including likes, comments, shares, impressions, and clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'The connected account ID (must belong to the authenticated user)'
        },
        post_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of post IDs to fetch analytics for (e.g., LinkedIn URNs like "urn:li:share:123")'
        }
      },
      required: ['account_id', 'post_ids']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.getPostAnalytics(context?.userId, args.account_id, args.post_ids);
  }
}
);

emmaToolRegistry.register({
  name: 'read_brand_guidelines',
  // ENG-822: reads/writes account-scoped data; refused in anonymous sessions.
  requiresUserAccount: true,
  definition: {
    name: 'read_brand_guidelines',
    description: 'Read the current user\'s brand guidelines (brand data and attachments). Returns exists=false if not set.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.readBrandGuidelines(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_brand_guidelines',
  // ENG-822: reads/writes account-scoped data; refused in anonymous sessions.
  requiresUserAccount: true,
  definition: {
    name: 'update_brand_guidelines',
    description: 'Update the user\'s brand guidelines. IMPORTANT: Use read_brand_guidelines first to fetch the latest data, then only update the fields that need to be changed. Can update both brand data and brand assets (logos, brand guides, etc.). NOTE: SVG files are NOT allowed for logo or secondaryLogo uploads. If the user provides an SVG file, ask them to convert it to PNG or another raster format first. RE-SETUP SCOPE: when the user asks for a broad brand re-setup or refresh (NOT a single-field edit like changing just the tagline or one color), pass refreshMarketStrategy=true so the same operation also refreshes market strategy positioning by regenerating ICPs and competitors from the updated brand. This REPLACES current ICPs and competitors while preserving the business overview. For a small single-field edit, leave refreshMarketStrategy false/omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        brandData: {
          type: 'object',
          description: 'Brand data object with only the fields that need to be updated',
          properties: {
            brandName: { type: 'string', description: 'Brand name' },
            tagline: { type: 'string', description: 'Brand tagline or slogan' },
            domain: { type: 'string', description: 'Website domain (e.g. example.com)' },
            primaryColor: { type: 'string', description: 'Primary brand color (hex code)' },
            primaryColorEnd: { type: 'string', description: 'End color for gradient (hex code)' },
            secondaryColor: { type: 'string', description: 'Secondary brand color (hex code)' },
            fontFamily: { type: 'string', description: 'Primary font family' },
            toneOfVoice: { type: 'string', description: 'Brand tone of voice' },
            brandPersonality: { type: 'string', description: 'Brand personality description' },
            targetAudience: { type: 'string', description: 'Target audience description' },
            valueProposition: { type: 'string', description: 'Brand-level value proposition — single most compelling promise the company makes to its customers, in one sentence. Used as the seed for the onboarding value-prop review screen.' },
            logoUrl: { type: 'string', description: 'Direct URL to the brand logo as discovered on the company website (e.g. https://example.com/logo.svg). Used by the onboarding review screens and downstream creative/ad surfaces.' },
            keyMessages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of key brand messages'
            },
            brandValues: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of brand values'
            },
            isGradient: { type: 'boolean', description: 'Whether primary color uses gradient' },
            founders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Founder name' },
                  jobTitle: { type: 'string', description: 'Founder job title' },
                  styleTone: { type: 'string', description: 'Founder communication style and tone' },
                  signaturePosts: { type: 'string', description: 'Notable posts or content the founder is known for' },
                  voiceExamples: { type: 'string', description: 'Actual post examples (verbatim) written by or for this founder. Emma uses these as a direct style reference when generating LinkedIn and social posts — paste 2–3 real posts separated by blank lines.' }
                },
                required: ['name']
              },
              description: 'Array of founder profiles'
            }
          }
        },
        brandAssets: {
          type: 'array',
          description: 'Brand assets to update (logos, brand guides, etc.) - array of asset objects with type, url, filename',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['logo', 'secondaryLogo', 'brandGuide', 'additionalAsset'], description: 'Type of brand asset' },
              url: { type: 'string', description: 'URL of the brand asset' },
              filename: { type: 'string', description: 'Original filename of the brand asset' }
            }
          }
        },
        refreshMarketStrategy: {
          type: 'boolean',
          description: 'Set true for a broad brand re-setup/refresh so ICPs and competitors are regenerated from the updated brand in the same operation. Omit or false for single-field edits and brand-only updates.'
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.updateBrandGuidelines(args, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'read_market_strategy',
  // ENG-822: reads/writes account-scoped data; refused in anonymous sessions.
  requiresUserAccount: true,
  definition: {
    name: 'read_market_strategy',
    description: 'Read the current user\'s market strategy (business overview, competitors, and ideal customer profiles). Returns exists=false if not set. The response is size-bounded: full competitor descriptions come one page at a time, further competitors are listed by name with a bracketed offset where space allows, and on a very large roster some stored competitors are NOT named at all (the response says how many). totalCompetitors is always the true stored count. NEVER conclude a competitor is absent because it does not appear in the response — before adding any competitor, verify with competitorNames, which answers stored/not-stored regardless of what this page shows. Use competitorOffset (or the returned nextCompetitorOffset) to read further descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        competitorOffset: {
          type: 'number',
          description: 'Optional 0-based index of the first competitor to return with its full description. As many competitors as fit the page budget are returned in full from there; further ones are listed by name where space allows. Defaults to 0. Pass the offset printed in brackets beside a name-only competitor to read that entry in full, or the nextCompetitorOffset value from a previous response to read the next page.'
        },
        competitorNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Names to check against the stored competitor list. The response answers stored/not-stored for each (with its offset when stored), regardless of whether that competitor appears in this page. ALWAYS use this before adding competitors to a large market strategy — it is the reliable way to avoid re-adding one that already exists. Up to 50 names per call.'
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.readMarketStrategy(context?.userId, {
      competitorOffset: args?.competitorOffset,
      competitorNames: args?.competitorNames,
    });
  }
});

emmaToolRegistry.register({
  name: 'update_market_strategy',
  // ENG-822: reads/writes account-scoped data; refused in anonymous sessions.
  requiresUserAccount: true,
  definition: {
    name: 'update_market_strategy',
    description: 'Update the user\'s market strategy. IMPORTANT: Use read_market_strategy first to fetch the latest data, then only update the fields that need to be changed. Can update business overview, competitors, and ideal customer profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        businessOverview: {
          type: 'string',
          description: 'Comprehensive business overview including mission, vision, and value propositions'
        },
        competitors: {
          type: 'array',
          description: 'Array of competitor objects with name and description',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Competitor name' },
              description: { type: 'string', description: 'Competitor description or analysis' }
            },
            required: ['name']
          }
        },
        icp: {
          type: 'array',
          description: 'Array of Ideal Customer Profile objects with title, description, value proposition, and buyer personas',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'ICP title or name' },
              description: { type: 'string', description: 'ICP description or characteristics' },
              valueProposition: { type: 'string', description: 'Value proposition for this customer type' },
              buyerPersonas: { type: 'array', description: 'List of buyer personas for this customer type', items: { type: 'string' } }
            },
            required: ['title']
          }
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.updateMarketStrategy(args, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'regenerate_market_strategy',
  // ENG-822: reads/writes account-scoped data; refused in anonymous sessions.
  requiresUserAccount: true,
  definition: {
    name: 'regenerate_market_strategy',
    description: 'Regenerate the user\'s market strategy (ideal customer profiles and competitors) from their CURRENT brand guidelines, so the strategy matches the latest brand. DESTRUCTIVE: this REPLACES the existing competitors and ICPs (the business overview is preserved). Only call this AFTER the user has explicitly confirmed they want to regenerate — if they already have competitors/ICPs, first tell them how many will be replaced and get a clear yes. Takes ~30-60s. Typically used as part of a brand re-setup when the user chose to also refresh their positioning/market strategy (option 2 of the brand re-setup scope question).',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.regenerateMarketStrategy(context?.userId);
  }
});

const visualContextTool = {
  name: 'get_visual_context',
  definition: {
    name: 'get_visual_context',
    description: 'Request a screenshot of the current page to understand visual layout, colors, design elements, UI structure. Use when the user asks about visual aspects, colors, design, or when you need to see the page to answer accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why you need the screenshot'
        }
      },
      required: []
    }
  },
  execute: async (args: any) => {
    return {
      needs_screenshot: true,
      reason: args.reason || 'Visual context requested',
      message: 'Screenshot will be captured from the browser and included in the next message.'
    };
  }
};

emmaToolRegistry.register(visualContextTool);


emmaToolRegistry.register({
  name: 'perform_deep_research',
  definition: {
    name: 'perform_deep_research',
    description: 'Perform comprehensive deep research on any topic using Gemini Deep Research. Uploads the research content to S3 and returns a URL to the markdown file. Use this for whitepapers, reports, executive summaries, or research documents. NOT for blog articles - use create_blog_article with deep_research=true instead. Takes several minutes to complete. The response includes research_url (S3 URL), title, summary, and word_count.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The main topic or subject to research'
        },
        prompt: {
          type: 'string',
          description: 'Additional instructions for the research (e.g., "Include executive summary", "Focus on competitive analysis", "Structure as a whitepaper")'
        },
        tone: {
          type: 'string',
          description: 'The tone of the research output',
          enum: ['professional', 'casual', 'technical', 'executive'],
          default: 'professional'
        },
        depth: {
          type: 'string',
          description: 'How thorough the research should be. "overview" for 1-2 pages, "detailed" for 3-5 pages, "comprehensive" for 5-10 pages.',
          enum: ['overview', 'detailed', 'comprehensive'],
          default: 'detailed'
        },
        focus_areas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific areas to focus on in the research (e.g., ["market trends", "competitor analysis", "implementation strategies"])'
        }
      },
      required: ['topic']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.performDeepResearchTool(
      args.topic,
      args.prompt,
      args.tone || 'professional',
      args.depth || 'detailed',
      args.focus_areas,
      context?.userId
    );
  }
});

// --- Tools from contentTools.ts ---
emmaToolRegistry.register({
  name: 'list_books',
  definition: {
    name: 'list_books',
    description: 'List all books and white papers for the current user. Returns a list of books with their IDs, titles, types, authors, status, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['book', 'whitepaper'],
          description: 'Optional filter by type: "book" or "whitepaper". If not provided, returns all types.'
        },
        status: {
          type: 'string',
          enum: ['draft', 'published', 'archived'],
          description: 'Optional filter by status: "draft", "published", or "archived". If not provided, returns all statuses.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listBooks(context?.userId, args.type, args.status);
  }
});

emmaToolRegistry.register({
  name: 'get_book_details',
  definition: {
    name: 'get_book_details',
    description: 'Get detailed information about a specific book or white paper including its outline (sections and chapters structure), characters (for books), and other metadata. Returns book metadata, characters, and the complete outline hierarchy.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to retrieve'
        }
      },
      required: ['book_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getBookDetails(args.book_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_book_content',
  definition: {
    name: 'get_book_content',
    description: 'Get the markdown content for a specific section or chapter in a book. If chapter_id is provided, returns chapter content. Otherwise, returns section content.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, returns chapter content. If not provided, returns section content.'
        }
      },
      required: ['book_id', 'section_id']
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.getBookContent(args.book_id, args.section_id, args.chapter_id, context?.userId);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

emmaToolRegistry.register({
  name: 'update_book_content',
  definition: {
    name: 'update_book_content',
    description: 'Update the markdown content for a specific section or chapter in a book using partial replacements. This function performs partial content updates only. For generating full content, use generate_book_content instead. IMPORTANT: Always use get_book_content first to retrieve the current content, then provide the exact old_content to replace. Note: Full content replacement will not work if the current content is empty - use generate_book_content to create new content instead.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, updates chapter content. If not provided, updates section content.'
        },
        replacement_json: {
          type: 'string',
          description: 'JSON string containing a list of replacement instructions: [{"old_content": "## Old Heading\\n\\nOld text...", "new_content": "## New Heading\\n\\nNew text...", "expected_count": 1}]. Use empty string for new_content to delete the specified content.'
        }
      },
      required: ['book_id', 'section_id', 'replacement_json']
    }
  },
  execute: async (args: any, context?: any) => {
    // Parse replacement_json
    let bookReplacementInstructions = [];
    try {
      if (args.replacement_json) {
        bookReplacementInstructions = JSON.parse(args.replacement_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in replacement_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
    return await agentModeService.updateBookContent(
      args.book_id,
      args.section_id,
      args.chapter_id,
      bookReplacementInstructions,
      context?.userId
    );
  }
});

emmaToolRegistry.register({
  name: 'generate_book_content',
  definition: {
    name: 'generate_book_content',
    description: 'Generate content for a book section/chapter. For BOOKS: short (1000-2000 words), medium (2000-3000 words), long (3000-4000 words). For WHITEPAPERS: short (300-600 words, ~1 page), medium (600-1000 words, ~2 pages), long (1000-1500 words, ~3 pages). IMPORTANT for whitepapers: Pass the relevant deep research content in content_description - the AI will reformat it for that section rather than generating new content. If existing content exists, it will be used as a base.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, generates chapter content. If not provided, generates section content.'
        },
        content_description: {
          type: 'string',
          description: 'Detailed description of what content should be generated for this section or chapter. Be as detailed as possible about the topics, themes, key points, and structure that should be included. IMPORTANT: Content from other sections of the book is not available to this function, so any relevant context, information, or details from other sections that should be referenced or built upon must be explicitly included in this description.'
        },
        length: {
          type: 'string',
          enum: ['short', 'medium', 'long'],
          description: 'Desired length of the content: short (1000-2000 words), medium (2000-3000 words), long (3000-4000 words)',
          default: 'medium'
        },
        imagine: {
          type: 'boolean',
          description: 'Whether to allow creative imagination and details that do not exist. Defaults to true. When false, the AI will stick strictly to facts and avoid inventing details.',
          default: true
        },
        research_url: {
          type: 'string',
          description: 'Optional S3 URL to deep research content (from perform_deep_research). For WHITEPAPERS: pass the research_url here instead of copying full content into content_description. The function will fetch the research and use it as context. When using this, content_description should focus on section-specific instructions (e.g., "Write the Executive Summary focusing on key strategic implications").'
        }
      },
      required: ['book_id', 'section_id', 'chapter_id', 'content_description']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateBookContent(
      args.book_id,
      args.section_id,
      args.chapter_id,
      args.content_description,
      args.length || 'medium',
      args.imagine !== undefined ? args.imagine : true,
      context?.userId,
      args.research_url,
      context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'create_book',
  definition: {
    name: 'create_book',
    description: 'Create a new book or white paper with metadata. Returns the created book with bookId for use in other operations.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the book or white paper'
        },
        description: {
          type: 'string',
          description: 'Description or summary of the book'
        },
        type: {
          type: 'string',
          enum: ['book', 'whitepaper'],
          description: 'Type: "book" or "whitepaper"'
        },
        author: {
          type: 'string',
          description: 'Author name'
        },
        language: {
          type: 'string',
          description: 'Language of the book (e.g., "English", "中文")',
          default: 'English'
        },
        genre: {
          type: 'string',
          description: 'Genre of the book (only applicable when type is "book"). Can be one of the predefined genres (Fiction, Non-Fiction, Science Fiction, Fantasy, Mystery, Thriller, Romance, Horror, Biography, Autobiography, History, Self-Help, Business, Technology, Science, Philosophy, Religion, Health & Fitness, Travel, Cooking, Art, Music, Poetry, Drama, Comedy, Education, Reference, Children\'s, Young Adult, Other) or a custom genre string. If not provided and type is "book", defaults to "Other".'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of tags for categorization',
          default: []
        }
      },
      required: ['title', 'description', 'type', 'author']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBook(args.title, args.description, args.type, args.author, args.language, args.genre, args.tags || [], context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_book_outline',
  definition: {
    name: 'create_book_outline',
    description: 'Create the complete outline structure (sections and chapters) for a book. This replaces any existing outline. Each section can have multiple chapters. Sections and chapters will be ordered by their order field.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to create outline for'
        },
        outline_json: {
          type: 'string',
          description: 'JSON string containing the outline structure: [{"title": "Section Title", "description": "Optional section description", "order": 1, "chapters": [{"title": "Chapter Title", "description": "Optional chapter description", "order": 1}]}]'
        }
      },
      required: ['book_id', 'outline_json']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBookOutline(args.book_id, args.outline_json, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'add_characters',
  definition: {
    name: 'add_characters',
    description: 'Add one or more characters to a book. Each character must have a name and description. Characters are appended to the existing list of characters for the book.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to add characters to'
        },
        characters_json: {
          type: 'string',
          description: 'JSON string containing an array of characters: [{"name": "Character Name", "description": "Character description"}]'
        }
      },
      required: ['book_id', 'characters_json']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addCharacters(args.book_id, args.characters_json, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_blog_article',
  definition: {
    name: 'create_blog_article',
    description: 'Create a blog article intended for CMS publishing (Basehub, Webflow, etc.). Generates article content, a hero image, and a blog-styled HTML file. Use ONLY for blog posts — NOT for reports, summaries, analyses, audits, or other documents. For non-blog HTML documents, use create_html_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        title_draft: {
          type: 'string',
          'x-aliases': ['title', 'headline', 'subject'],
          description: 'A draft title for the blog article. The final title will be generated and optimized from this draft.'
        },
        content_draft: {
          type: 'string',
          'x-aliases': ['content', 'body', 'text', 'markdown', 'article_content'],
          description: 'The blog article content in markdown format'
        },
        length: {
          type: 'string',
          description: 'The desired length of the article',
          enum: ['short', 'medium', 'long'],
          default: 'medium'
        },
        researchContext: {
          type: 'string',
          description: 'Optional research context or background information to include in the article',
          default: ''
        },
        requirements: {
          type: 'string',
          description: 'Specific requirements for the blog article (e.g., internal links, CTAs, branding guidelines)',
          default: ''
        },
        style: {
          type: 'string',
          description: 'The writing style of the blog article. Use "substack" for a personal, newsletter-like writing style with first-person perspective, engaging hooks, and conversational tone. Use "default" for standard blog post style.',
          enum: ['default', 'substack'],
          default: 'default'
        },
        deep_research: {
          type: 'boolean',
          description: 'When true, performs Gemini Deep Research for comprehensive information and includes 3-5 inline images. When false, uses standard content generation with hero image only. Takes several minutes when enabled.',
          default: false
        }
      },
      required: ['title_draft', 'content_draft']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBlogArticle(
      args.title_draft,
      args.content_draft,
      args.length || 'medium',
      args.researchContext || '',
      args.requirements || '',
      context?.userId,
      context?.sessionId,
      args.style || 'default',
      args.deep_research || false
    );
  }
});

emmaToolRegistry.register({
  name: 'publish_blog_article',
  definition: {
    name: 'publish_blog_article',
    description: 'Publish a blog article to CMS (Basehub or Webflow) based on the user\'s configured CMS type. Takes the title, description, hero image URL, and blog HTML URL from a previously created blog article (via create_blog_article), extracts the HTML body content, then publishes to the appropriate CMS. Articles are published as draft by default unless status is set to "published". IMPORTANT: When status is "published", at least one category must be provided. CRITICAL: Always review the article content with the user and get explicit approval before publishing, especially when status is "published" for live publication.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the blog article'
        },
        description: {
          type: 'string',
          description: 'The description/meta description of the blog article'
        },
        hero_image_url: {
          type: 'string',
          description: 'The URL of the hero image for the blog article'
        },
        blog_html_url: {
          type: 'string',
          description: 'The URL of the HTML file created by create_blog_article function'
        },
        status: {
          type: 'string',
          description: 'Publication status of the article. Default is "draft". Set to "published" to publish immediately.',
          enum: ['draft', 'published'],
          default: 'draft'
        },
        author: {
          type: 'string',
          description: 'Optional author name or ID for the article'
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of category names. Category names will be mapped to Webflow IDs using the "categories" mapping in secrets manager. Maps to multi-reference field "categories" by default. Defaults to empty array. REQUIRED when status is "published" - must provide at least one category.',
          default: []
        }
      },
      required: ['title', 'description', 'hero_image_url', 'blog_html_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.publishBlogArticle(
      args.title,
      args.description,
      args.hero_image_url,
      args.blog_html_url,
      context?.userId,
      context?.sessionId,
      args.status,
      args.author,
      args.categories,
      // ENG-827: this registry — not the MCP one — is what a live Emma session
      // dispatches through, so dropping the hook here left the CMS write unguarded on
      // the path that actually runs. publishBlogArticle fetches the article HTML over
      // the network before it writes, so the dispatcher's admission check precedes the
      // slow part rather than the irreversible one; this is re-run at the CMS write.
      context?.assertPublishStillAuthorized
    );
  }
});

emmaToolRegistry.register({
  name: 'list_cms_categories',
  definition: {
    name: 'list_cms_categories',
    description: 'List the available CMS categories for the current user. Returns category names configured in the user\'s Webflow CMS settings. Use this to discover valid category values before calling publish_blog_article.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (_args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'User context required' };
    }
    try {
      const { userDb } = await import('../services/db');
      const user = await userDb.getUserById(userId);
      const cmsType = user?.cmsType;

      if (cmsType === 'Webflow') {
        const { getWebflowConfig } = await import('../controllers/blog');
        const config = await getWebflowConfig(userId);
        const categoryNames = config.categories ? Object.keys(config.categories) : [];
        return { success: true, cmsType, categories: categoryNames };
      }

      if (cmsType === 'WordPress') {
        const { getWordPressConfig } = await import('../controllers/blog');
        const config = await getWordPressConfig(userId);
        const categoryNames = config.categories ? Object.keys(config.categories) : [];
        return { success: true, cmsType, categories: categoryNames };
      }

      return { success: true, cmsType: cmsType || null, categories: [] };
    } catch (error: any) {
      return { success: false, message: 'Failed to fetch CMS categories', error: error.message };
    }
  }
});

emmaToolRegistry.register({
  name: 'repair_blog_article',
  definition: {
    name: 'repair_blog_article',
    description: 'Repairs a blog article by creating a new version with optimized images. Automatically finds and resizes all images (including hero images with class="hero-image") that exceed file size limits. Creates a new HTML file with updated image URLs without modifying the original. Call this function when publish_blog_article fails due to image size errors. Returns a new article URL and hero image URL that can be used to retry publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        article_url: {
          type: 'string',
          description: 'The URL of the HTML file created by create_blog_article function'
        }
      },
      required: ['article_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.repairBlogArticle(
      args.article_url,
      context?.userId,
      context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'create_social_media_posts',
  definition: {
    name: 'create_social_media_posts',
    description: 'Create a list of social media posts and generate an HTML file containing all posts. Each post includes type (linkedin, x/twitter, instagram, facebook, or custom), rich text content that can be transformed to HTML for display and copied for use, and optional image URL. The output is an HTML file stored in S3 with all posts formatted for easy viewing and copying.',
    inputSchema: {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          description: 'Array of social media posts to create',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['linkedin', 'x/twitter', 'instagram', 'facebook', 'custom'],
                description: 'The social media platform type for this post'
              },
              content: {
                type: 'string',
                description: 'Rich text content for the post. IMPORTANT: Do not include image URLs in the content text as the format will not look good. Use the image_url parameter separately for images. CRITICAL FOR LINKEDIN POSTS: LinkedIn does NOT support markdown rendering. Never use markdown syntax like **bold**, *italic*, - bullet lists, [links](url), or # headings. Instead use LinkedIn-native plain text formatting: line breaks for structure, unicode bullets (•) or dashes (—) for lists, UPPERCASE or emojis for emphasis, and paste full URLs directly (LinkedIn auto-links them). Markdown will appear as raw text and look unprofessional.'
              },
              image_url: {
                type: 'string',
                description: 'Optional image URL for posts that include images'
              }
            },
            required: ['type', 'content']
          }
        }
      },
      required: ['posts']
    }
  },
  execute: async (args: any, context?: any) => {
    // Note: The backend createSocialMediaPosts currently expects an array of posts.
    // If the tool is supposed to generate them first, we might need a middle layer.
    // For now, mirroring the existing (buggy?) behavior but ensuring we pass sessionId.
    return await agentModeService.createSocialMediaPosts(args.posts, context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'list_html_templates',
  definition: {
    name: 'list_html_templates',
    description: "Get a list of all available HTML templates for the user (email and/or landing page templates). Use the optional 'type' filter to narrow results. IMPORTANT: If multiple templates share the same template_name, ask the user to choose which one to use and confirm by template_id (or by created_at/updated_at and isPublic if needed).",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: "Filter by template type: 'email' or 'landing_page'. Omit to list all templates."
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listHtmlTemplates(context?.userId, args.type);
  }
});

emmaToolRegistry.register({
  name: 'create_html_from_template',
  definition: {
    name: 'create_html_from_template',
    description: 'Create final HTML from a template by providing variable values and array variable values as JSON strings, then upload to S3. If the user refers to a template by name and multiple templates share that name, you MUST ask which template_id to use before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description: 'ID of the HTML template to use (from list_html_templates)'
        },
        variable_values_json: {
          type: 'string',
          description: 'JSON string containing regular variable values where keys are variable names and values are the actual values. Example: {"title": "Hello", "company_name": "Acme Corp"}'
        },
        array_variable_values_json: {
          type: 'string',
          description: 'JSON string containing array variable values where keys are array variable names and values are arrays of strings. If there is no data for an array variable, provide an empty array for that variable. Example: {"features_n": ["Feature 1", "Feature 2"], "links_n": []} for when links_n has no data.'
        }
      },
      required: ['template_id', 'variable_values_json', 'array_variable_values_json']
    }
  },
  execute: async (args: any, context?: any) => {
    // Parse JSON strings
    let variableValues = {};
    let arrayVariableValues = {};

    try {
      if (args.variable_values_json) {
        variableValues = JSON.parse(args.variable_values_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in variable_values_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    try {
      if (args.array_variable_values_json) {
        arrayVariableValues = JSON.parse(args.array_variable_values_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in array_variable_values_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return await agentModeService.createHtmlFromTemplate(context?.llmModel, args.template_id, variableValues, arrayVariableValues, context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'update_html_file',
  definition: {
    name: 'update_html_file',
    description: 'Update an HTML file using CSS selectors to target elements (preferred), or full file replacement with hash verification. ' +
      'CSS mode (update_type="css"): Use CSS selectors to precisely target and modify HTML elements without needing to reproduce exact content. ' +
      'jQuery-style selectors are supported: use :eq(n) (0-indexed) to select by position within matched set (e.g. ".step-block:eq(1)" for the 2nd .step-block), ' +
      ':contains("text") to match by text content (e.g. "h3:contains(\\"Step 2\\")"), and :has() for parent matching. ' +
      'IMPORTANT: Do NOT use :nth-of-type or :nth-child to target elements by class — these count by element type, not class. Use :eq(n) instead. ' +
      'SELECTOR SCOPING: When the same brand word or element appears more than once (e.g. a wordmark in both the header and the footer), do NOT rely on :contains("Brand"):first / position alone — in DOM order the header usually matches first, so you can clobber the wrong element. Instead scope by the containing section\'s distinctive style, e.g. the header logo as \'td[style*="linear-gradient"] img[alt="Brand"]\' and the footer logo as \'td[style*="#1a1a2e"] img[alt="Brand"]\'. Targeting by container/section background (or another stable container attribute) is far more reliable than :contains + position. ' +
      'Operations that fail (no selector match) are skipped and reported; successful operations still apply. ' +
      'Full mode (update_type="full"): Replace entire file content using hash verification.',
    inputSchema: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          description: 'URL of the HTML file to update (S3 URL)'
        },
        update_type: {
          type: 'string',
          enum: ['css', 'full'],
          description: 'Type of update: "css" (recommended) for CSS-selector-based editing, "full" for entire file replacement with hash'
        },
        operations_json: {
          type: 'string',
          'x-aliases': ['replacement_json'],
          description: 'JSON string containing operations. ' +
            'For CSS mode: [{"action": "remove", "selector": ".card[data-id=\\"123\\"]"}, ' +
            '{"action": "replace", "selector": "h1.title", "html": "<h1 class=\\"title\\">New Title</h1>"}, ' +
            '{"action": "replaceInner", "selector": ".bio", "html": "New bio text"}, ' +
            '{"action": "append", "selector": "#grid", "html": "<div>New item</div>"}, ' +
            '{"action": "prepend", "selector": "#grid", "html": "<div>First item</div>"}, ' +
            '{"action": "insertBefore", "selector": ".item:last-child", "html": "<div>Before last</div>"}, ' +
            '{"action": "insertAfter", "selector": ".item:first-child", "html": "<div>After first</div>"}, ' +
            '{"action": "setAttribute", "selector": "img.hero", "attribute": "src", "value": "new.jpg"}, ' +
            '{"action": "removeAttribute", "selector": "a", "attribute": "target"}]. ' +
            'For full mode: [{"old_content_hash": "abc123...", "new_content": "<!DOCTYPE html>...", "expected_count": 1}]'
        }
      },
      required: ['file_url', 'update_type', 'operations_json']
    }
  },
  execute: async (args: any, context?: any) => {
    let operations;
    try {
      operations = JSON.parse(args.operations_json);
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in operations_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return await agentModeService.updateHtmlFile(args.file_url, args.update_type, operations, context?.userId, context?.sessionId);
  }
});

// --- Tools from leadGtmTools.ts ---
emmaToolRegistry.register({
  name: 'list_gtm_plans',
  definition: {
    name: 'list_gtm_plans',
    description: 'List all Go-To-Market (GTM) plans for the current user. Returns a list of plans with their IDs, titles, descriptions, phase counts, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listGTMPlans(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'read_gtm_plan',
  definition: {
    name: 'read_gtm_plan',
    description: 'Read a specific GTM plan by its plan ID. Returns the complete plan details including all phases and work items with their statuses, durations, and completion times.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan to read'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.readGTMPlan(args.plan_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_gtm_plan',
  definition: {
    name: 'create_gtm_plan',
    description: 'Create a new Go-To-Market (GTM) plan with a title, optional description, optional DRI (Directly Responsible Individual) email, and optional phases with work items. Each phase can have multiple work items. DRI can be specified at plan level, phase level, or item level. Returns the created plan with its unique identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the GTM plan (e.g., "Q1 2024 Launch Plan")'
        },
        description: {
          type: 'string',
          description: 'Optional description of the GTM plan'
        },
        dri: {
          type: 'string',
          description: 'Optional DRI (Directly Responsible Individual) email address at the plan level'
        },
        phases: {
          type: 'array',
          description: 'Optional array of phases to include in the plan. Each phase should have a title, description, duration (in days), optional DRI email, and workItems array.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title of the phase (e.g., "Pre-Launch", "Launch", "Post-Launch")'
              },
              description: {
                type: 'string',
                description: 'Optional description of the phase'
              },
              duration: {
                type: 'number',
                description: 'Duration of the phase in days'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI (Directly Responsible Individual) email address at the phase level'
              },
              workItems: {
                type: 'array',
                description: 'Array of work items for this phase',
                items: {
                  type: 'object',
                  properties: {
                    title: {
                      type: 'string',
                      description: 'Title of the work item'
                    },
                    description: {
                      type: 'string',
                      description: 'Optional description of the work item'
                    },
                    duration: {
                      type: 'number',
                      description: 'Optional duration of the work item in days'
                    },
                    dri: {
                      type: 'string',
                      description: 'Optional DRI (Directly Responsible Individual) email address at the work item level'
                    }
                  },
                  required: ['title']
                }
              }
            },
            required: ['title', 'duration']
          }
        }
      },
      required: ['title']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createGTMPlan(
      args.title, args.description || '', args.dri || undefined, args.phases || [], context?.userId, context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'update_gtm_plan',
  definition: {
    name: 'update_gtm_plan',
    description: 'Update a GTM plan\'s title, description, DRI (Directly Responsible Individual), or due date. Only provided fields will be updated.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan to update'
        },
        title: {
          type: 'string',
          description: 'New title for the plan'
        },
        description: {
          type: 'string',
          description: 'New description for the plan'
        },
        dri: {
          type: 'string',
          description: 'New DRI (Directly Responsible Individual) email address. Pass empty string to remove.'
        },
        due_date: {
          type: 'string',
          description: 'New due date for the plan (ISO date string). Pass empty string to remove.'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateGTMPlan(args.plan_id, {
      title: args.title,
      description: args.description,
      dri: args.dri,
      dueDate: args.due_date,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'add_gtm_phase',
  definition: {
    name: 'add_gtm_phase',
    description: 'Add a new phase to an existing GTM plan. Optionally include work items for the phase.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        title: {
          type: 'string',
          description: 'Title of the new phase'
        },
        description: {
          type: 'string',
          description: 'Optional description of the phase'
        },
        dri: {
          type: 'string',
          description: 'Optional DRI email address for the phase'
        },
        due_date: {
          type: 'string',
          description: 'Optional due date for the phase (ISO date string)'
        },
        work_items: {
          type: 'array',
          description: 'Optional array of work items to add to the phase',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the work item'
              },
              description: {
                type: 'string',
                description: 'Optional description of the work item'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI email address for the work item'
              },
              due_date: {
                type: 'string',
                description: 'Optional due date for the work item (ISO date string)'
              }
            },
            required: ['title']
          }
        }
      },
      required: ['plan_id', 'title']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addGTMPhase(args.plan_id, {
      title: args.title,
      description: args.description,
      dri: args.dri,
      dueDate: args.due_date,
      workItems: args.work_items,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'add_gtm_work_items',
  definition: {
    name: 'add_gtm_work_items',
    description: 'Add one or more work items to an existing phase in a GTM plan.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'The unique identifier of the phase to add work items to'
        },
        work_items: {
          type: 'array',
          description: 'Array of work items to add',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the work item'
              },
              description: {
                type: 'string',
                description: 'Optional description of the work item'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI email address for the work item'
              },
              due_date: {
                type: 'string',
                description: 'Optional due date for the work item (ISO date string)'
              }
            },
            required: ['title']
          }
        }
      },
      required: ['plan_id', 'phase_id', 'work_items']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addGTMWorkItems(args.plan_id, args.phase_id, args.work_items, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_gtm_work_item',
  definition: {
    name: 'update_gtm_work_item',
    description: 'Update a specific work item in a GTM plan. Can change status, notes, DRI, title, description, or due date. Optionally send notifications about the changes.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'The unique identifier of the phase containing the work item'
        },
        work_item_id: {
          type: 'string',
          description: 'The unique identifier of the work item to update'
        },
        status: {
          type: 'string',
          description: 'New status: "pending", "in_progress", "completed", or "skipped"'
        },
        notes: {
          type: 'string',
          description: 'Notes for the work item. Pass empty string to clear.'
        },
        dri: {
          type: 'string',
          description: 'New DRI email address. Pass empty string to remove.'
        },
        title: {
          type: 'string',
          description: 'New title for the work item'
        },
        description: {
          type: 'string',
          description: 'New description for the work item. Pass empty string to clear.'
        },
        due_date: {
          type: 'string',
          description: 'New due date (ISO date string). Pass empty string to remove.'
        },
        notify_user: {
          type: 'boolean',
          description: 'Whether to notify the plan owner about the change'
        },
        notify_item_poc: {
          type: 'boolean',
          description: 'Whether to notify the work item DRI about the change'
        },
        notify_phase_poc: {
          type: 'boolean',
          description: 'Whether to notify the phase DRI about the change'
        },
        notify_plan_poc: {
          type: 'boolean',
          description: 'Whether to notify the plan DRI about the change'
        },
        notification_message: {
          type: 'string',
          description: 'Optional custom message to include in the notification'
        }
      },
      required: ['plan_id', 'phase_id', 'work_item_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateGTMWorkItem(args.plan_id, args.phase_id, args.work_item_id, {
      status: args.status,
      notes: args.notes,
      dri: args.dri,
      title: args.title,
      description: args.description,
      dueDate: args.due_date,
    }, {
      notifyUser: args.notify_user,
      notifyItemPoc: args.notify_item_poc,
      notifyPhasePoc: args.notify_phase_poc,
      notifyPlanPoc: args.notify_plan_poc,
      message: args.notification_message,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_gtm_phase',
  definition: {
    name: 'update_gtm_phase',
    description: 'Update a phase in a GTM plan. Can change title, description, DRI, or due date. Phase status is auto-calculated from work items and cannot be set manually.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'The unique identifier of the phase to update'
        },
        title: {
          type: 'string',
          description: 'New title for the phase'
        },
        description: {
          type: 'string',
          description: 'New description for the phase. Pass empty string to clear.'
        },
        dri: {
          type: 'string',
          description: 'New DRI email address. Pass empty string to remove.'
        },
        due_date: {
          type: 'string',
          description: 'New due date (ISO date string). Pass empty string to remove.'
        }
      },
      required: ['plan_id', 'phase_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateGTMPhase(args.plan_id, args.phase_id, {
      title: args.title,
      description: args.description,
      dri: args.dri,
      dueDate: args.due_date,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'delete_gtm_items',
  definition: {
    name: 'delete_gtm_items',
    description: 'Delete a GTM plan, phase, or work item. Provide only plan_id to delete the entire plan. Add phase_id to delete a specific phase. Add both phase_id and work_item_id to delete a specific work item.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'Optional phase ID. If provided with plan_id, deletes the phase. If provided with work_item_id, targets the work item in this phase.'
        },
        work_item_id: {
          type: 'string',
          description: 'Optional work item ID. Requires phase_id. Deletes the specific work item from the phase.'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteGTMItems(args.plan_id, args.phase_id, args.work_item_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_gtm_common_items',
  definition: {
    name: 'get_gtm_common_items',
    description: 'Fetch the catalog of common GTM items (template work items) organized by category. Users can select items from this catalog to add to their plans.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getGTMCommonItems();
  }
});

emmaToolRegistry.register({
  name: 'add_gtm_common_items',
  definition: {
    name: 'add_gtm_common_items',
    description: 'Import selected template items from the common items catalog into a GTM plan phase. Items can be added to an existing phase or a new phase.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        items: {
          type: 'array',
          description: 'Array of items to add (each with title and optional description)',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the item'
              },
              description: {
                type: 'string',
                description: 'Optional description of the item'
              }
            },
            required: ['title']
          }
        },
        target_phase_id: {
          type: 'string',
          description: 'ID of an existing phase to add items to. Either this or new_phase_name must be provided.'
        },
        new_phase_name: {
          type: 'string',
          description: 'Name for a new phase to create and add items to. Either this or target_phase_id must be provided.'
        }
      },
      required: ['plan_id', 'items']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addGTMCommonItems(args.plan_id, args.items, args.target_phase_id, args.new_phase_name, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'send_gtm_status_report',
  definition: {
    name: 'send_gtm_status_report',
    description: 'Send a status report email for a GTM plan or a specific phase. Choose recipients from plan owner, plan DRI, phase DRI(s). Omit phase_id for a plan-level report.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'Optional phase ID. If provided, sends a phase-level report. If omitted, sends a plan-level report.'
        },
        notify_user: {
          type: 'boolean',
          description: 'Whether to send the report to the plan owner'
        },
        notify_plan_poc: {
          type: 'boolean',
          description: 'Whether to send the report to the plan DRI'
        },
        notify_phase_poc: {
          type: 'boolean',
          description: 'For phase reports: whether to send to the phase DRI'
        },
        notify_phase_pocs: {
          type: 'boolean',
          description: 'For plan reports: whether to send to all phase DRIs'
        },
        message: {
          type: 'string',
          description: 'Optional custom message to include in the status report'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.sendGTMStatusReport(args.plan_id, args.phase_id, {
      notifyUser: args.notify_user,
      notifyPlanPoc: args.notify_plan_poc,
      notifyPhasePoc: args.notify_phase_poc,
      notifyPhasePocs: args.notify_phase_pocs,
      message: args.message,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_lead_lists',
  definition: {
    name: 'get_lead_lists',
    description: 'Get all lead lists for the current user. Returns a list of lead lists with their IDs, names, descriptions, lead counts, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
      }
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadLists(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_lead_list',
  definition: {
    name: 'create_lead_list',
    description: 'Create a new lead list with a name and optional description. Returns the created lead list with its ID. You can specify a list_type to determine default pipeline stages.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the lead list'
        },
        description: {
          type: 'string',
          description: 'Optional description of the lead list'
        },
        list_type: {
          type: 'string',
          enum: ['sales', 'customers'],
          description: 'Type of the list. "sales" lists use sales pipeline stages (new, contacted, qualified, etc.). "customers" lists use customer lifecycle stages (onboarding, active, at_risk, churned). Determines default status configuration.'
        }
      },
      required: ['name']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createLeadList(args.name, args.description || '', context?.userId, args.list_type);
  }
});

emmaToolRegistry.register({
  name: 'add_leads_to_list',
  definition: {
    name: 'add_leads_to_list',
    description: 'Add one or more leads to an existing lead list. Each lead is a flexible object that can contain any fields you want to store. Common fields include: email (used for deduplication and merging), firstName, lastName, phone, company, title, notes, linkedin, and any custom fields. You can use any field names that make sense for your data. If a lead with the same email already exists, it will be merged with the new data. IMPORTING A FILE: pass the WHOLE set of rows in ONE call — the backend already writes in chunks internally, and splitting a file across many calls only burns turn time and risks the import being cut off part-way. The call is safe to repeat: a row that is already in the list merges or is reported as already present, it is never duplicated (rows with no email and no LinkedIn URL dedupe on name+company). RESULT: `attempted`, a `reconciliation` breakdown (created / merged / alreadyPresent / duplicateInRequest / anonymizedSkipped / failed / unprocessed), `importedIdentifiers` naming every row now in the list, and — when the import did not complete — `resumable: true`, `unimportedRows` naming the rows that did not land, and `unimportedRowRanges` giving the positions of EVERY row that did not land within the rows you just sent (e.g. "7,19,101-220"). On a very large partial `unimportedRows` can be trimmed and says so; `unimportedRowRanges` is never truncated, so resend every row it names. If you get a partial result, immediately call this tool again with just those rows, and repeat until a result comes back with `complete: true`. Never end the turn telling the user to retry the import themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to add leads to'
        },
        leads: {
          type: 'array',
          items: {
            type: 'object',
            description: 'A lead object with any fields you want to store. Use field names that make sense for your data. The email field (if provided) is used for deduplication and merging.',
            additionalProperties: true,
            properties: {
              email: {
                type: 'string',
                description: 'Email address (optional, but recommended for deduplication and merging existing leads)'
              }
            }
          },
          description: 'Array of lead objects to add to the list. Each lead can have any fields you want to store.'
        }
      },
      required: ['list_id', 'leads']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addLeadsToList(args.list_id, args.leads || [], context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_email_draft_for_lead',
  definition: {
    name: 'update_email_draft_for_lead',
    description: 'Create or update an email draft for a specific lead. This function loads the lead record, engagement history, brand guidelines, and market strategy, then uses AI to generate a personalized email draft (subject and HTML content) based on the instruction provided. If a draft already exists, it will be included in the prompt for refinement. The draft is saved to the lead record along with the current session ID for future updates.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to create/update email draft for'
        },
        instruction: {
          type: 'string',
          description: 'Instructions for creating the email draft (e.g., "welcome email", "follow-up on their interest in our product", "introduce our new feature"). The AI will use this along with lead data, engagement history, brand guidelines, and market strategy to create a personalized email.'
        },
        email_format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Optional. The format for the email draft: "text" for plain text or "html" for HTML. If not provided, uses the lead\'s saved format preference (defaults to "text").'
        }
      },
      required: ['list_id', 'lead_id', 'instruction']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateEmailDraftForLead(
      args.list_id,
      args.lead_id,
      args.instruction,
      context?.sessionId,
      context?.userId,
      args.email_format
    );
  }
});

emmaToolRegistry.register({
  name: 'get_leads',
  definition: {
    name: 'get_leads',
    description: 'Browse and list leads from a lead list with optional text search, status, and ICP/engaged filters. Returns compact lead summaries including status and deal value. Use search_leads for structured field-level filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to browse'
        },
        search: {
          type: 'string',
          description: 'Optional text search query to filter leads across all fields (name, email, company, title, etc.)'
        },
        status: {
          type: 'string',
          description: 'Optional status filter — only return leads with this exact status (e.g. "qualified", "won", "lost")'
        },
        icp_only: {
          type: 'boolean',
          description: 'If true, only return leads that match ICP criteria'
        },
        engaged_only: {
          type: 'boolean',
          description: 'If true, only return leads that have engagement activity'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of leads to return (default 20, max 100)'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned as next_cursor from a previous call. Pass this to retrieve the next page of results.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeads(args.list_id, context?.userId, {
      search: args.search,
      status: args.status,
      icpOnly: args.icp_only,
      engagedOnly: args.engaged_only,
      limit: args.limit,
      cursor: args.cursor
    });
  }
});

emmaToolRegistry.register({
  name: 'search_leads',
  definition: {
    name: 'search_leads',
    description: 'Find leads matching structured field-level criteria within one or more lead lists. Pass list_id for a single list (legacy) or list_ids for up to 5 lists at once — each returned lead carries its listId/listName so you can attribute results. Supports standard fields (email, firstName, lastName, company, title, phone, notes, linkedin, status, dealValue, dealCurrency, createdAt, updatedAt), ICP fields (icpScore, icpMatch), engagementCount, custom field names, and dot-notation paths (e.g. "customFields.createdAt"). Use greater_than/less_than with ISO date strings for date filtering. All filters use AND logic. Optionally combine with a keyword search across all fields. For cross-CRM strategic questions ("who should I reach out to?"), prefer ask_crm. Each returned lead also carries `enrichmentMetadata`: a per-field provenance map (keyed by field name, including enriched custom fields like `funding_stage`, `revenue_range`/`arr`, `tech_stack`) with `source` (web_search/api/linkedin/manual/llm), `provider` (e.g. apollo, llm_web_search, enrich.so, unipile), `sourceUrl`/`sourceQuote` for web-sourced values, `confidence` (high/medium/low), and `enrichedAt`. When the user asks about enriched values across leads (e.g. "what is the funding stage for each lead?"), USE THIS to report the source and confidence per value — present a table with the value alongside its provider/source and confidence rather than stating values as bare fact, and explicitly caveat medium/low-confidence or web-sourced values. Each meta entry also carries `grounding`: "grounded" = the value was verified against a real fetched source (safe to state plainly); "web-unverified" = from a web source that could not be confirmed; "ai-knowledge" = the AI asserted it from its own general knowledge with no source found. NEVER state a "web-unverified" or "ai-knowledge" value as established fact — flag it as unverified and say which (e.g. "Series C (unverified — from an unconfirmed web source)" or "Series C (unverified — from AI general knowledge, no source found)"). A field with no entry in enrichmentMetadata was entered manually or imported, not enriched.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of a single lead list to search. Use this OR list_ids, not both.'
        },
        list_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of up to 5 lead lists to search across. Each returned lead includes its listId/listName. Inaccessible lists are silently skipped. Use this OR list_id, not both. For broader cross-CRM scope, prefer ask_crm.'
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Field name to filter on (standard: email, firstName, lastName, company, title, phone, notes, linkedin, status, dealValue, dealCurrency, createdAt, updatedAt; ICP: icpScore, icpMatch; engagement: engagementCount; dot-notation paths like "customFields.createdAt"; or any custom field name). When searching multiple lists, missing fields on a list silently fail to match (no error).'
              },
              operator: {
                type: 'string',
                enum: ['equals', 'contains', 'starts_with', 'greater_than', 'less_than', 'not_equals', 'is_empty', 'is_not_empty', 'ilike'],
                description: 'Comparison operator. ilike supports SQL-style wildcards: % matches any sequence of characters, _ matches any single character (case-insensitive). Example: "%@gmail.com" matches any Gmail address.'
              },
              value: {
                description: 'The value to compare against (not required for is_empty/is_not_empty)'
              }
            },
            required: ['field', 'operator']
          },
          description: 'Array of filter criteria (AND logic — all must match)'
        },
        search: {
          type: 'string',
          description: 'Optional keyword search across all fields (name, email, company, title, notes, custom fields, etc.). Applied in addition to filters (AND logic).'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching leads to return (default 20, max 100)'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned as next_cursor from a previous call. Pass this verbatim to retrieve the next page; the cursor freezes the list_ids set so paging is stable even if your list_ids change between calls.'
        }
      },
      required: ['filters']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchLeads(args.list_id, args.filters, context?.userId, args.limit, {
      search: args.search,
      cursor: args.cursor,
      listIds: args.list_ids,
    });
  }
});

emmaToolRegistry.register({
  name: 'ask_crm',
  definition: {
    name: 'ask_crm',
    description: 'Answer a free-form question about the CRM (hot leads, at-risk customers, deals closing, paying customers, specific contact). Returns a structured answer with intent classification, a summary line, and a ranked list of relevant leads with citation URLs. Use this when the user asks strategic pipeline questions like "who should I reach out to today", "which deals are about to close", "who is at risk", or "is Jane at Acme paying us". For single-list browsing, prefer get_leads/search_leads.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The free-form question to answer. Examples: "Who should I reach out to today?", "Which deals are close to closing?", "Is Jane at Acme paying us?", "Who are my at-risk customers?"'
        },
        limit: {
          type: 'number',
          description: 'Max number of leads in the response list (default 10, max 25)'
        },
        load_limit: {
          type: 'number',
          description: 'Max number of leads to scan across the user\'s lists (default 500). Rarely needed — only raise if the user has tons of lists.'
        }
      },
      required: ['question']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId;
    if (!userId) {
      return { error: 'Missing userId context. ask_crm is only available inside an authenticated Emma session.' };
    }

    const resultLimit = Math.min(Math.max(args.limit ?? 10, 1), 25);
    const loadLimit = Math.max(args.load_limit ?? 500, 1);

    // Lazy lead iteration across all of the user's lists. We flatten into the
    // AskCrmLead shape so askCrm doesn't have to know about the underlying
    // storage layout.
    const loadLeadsForUser = async (uid: string, opts: { limit: number }): Promise<AskCrmLead[]> => {
      const lists = (await crmDb.getLeadListsForUser(uid)) || [];
      const out: AskCrmLead[] = [];
      for (const list of lists as any[]) {
        if (out.length >= opts.limit) break;
        const remaining = opts.limit - out.length;
        const page = await crmDb.getLeadsByListId(list.listId, Math.min(remaining, 200));
        const items: any[] = (page && (page as any).items) || [];
        for (const it of items) {
          out.push({
            leadId: it.leadId,
            listId: it.listId,
            email: it.email || null,
            firstName: it.firstName || null,
            lastName: it.lastName || null,
            company: it.company || null,
            title: it.title || null,
            status: it.status || null,
            dealValue: typeof it.dealValue === 'number' ? it.dealValue : null,
            lifecycle: it.lifecycle || null,
            heatScore: typeof it.heatScore === 'number' ? it.heatScore : null,
            healthScore: typeof it.healthScore === 'number' ? it.healthScore : null,
            isICP: typeof it.isICP === 'boolean' ? it.isICP : null,
            lastEngagementAt: it.lastEngagementAt || null,
            openDealStages: Array.isArray(it.openDealStages) ? it.openDealStages : null,
            contactStatus: it.contactStatus || null,
          });
          if (out.length >= opts.limit) break;
        }
      }
      return out;
    };

    try {
      const answer = await askCrm(
        String(args.question || ''),
        userId,
        { loadLeadsForUser },
        { resultLimit, loadLimit }
      );
      return answer;
    } catch (err: any) {
      return { error: err?.message || 'ask_crm failed' };
    }
  }
});

emmaToolRegistry.register({
  name: 'get_lead_details',
  definition: {
    name: 'get_lead_details',
    description: 'Get full details for a single lead including all fields, ICP match info, email drafts, and recent engagement history. Also returns `lead.enrichmentMetadata`: a per-field provenance map (keyed by field name, including custom fields like `funding_stage`, `revenue_range`/`arr`, `tech_stack`) describing where each enriched value came from — `source` (web_search/api/linkedin/manual/llm), `provider` (e.g. apollo, llm_web_search, enrich.so, unipile), `sourceUrl` and `sourceQuote` for web-sourced values, `confidence` (high/medium/low), and `enrichedAt` (ISO timestamp). USE THIS to answer "where does this data come from / how accurate is it?" — cite the provider, source URL, and confidence rather than guessing. Each meta entry also carries `grounding`: "grounded" = verified against a real fetched source (safe to state plainly); "web-unverified" = from a web source that could not be confirmed; "ai-knowledge" = the AI asserted it from its own general knowledge with no source found. NEVER state a "web-unverified" or "ai-knowledge" value as established fact — flag it as unverified and name which (e.g. "unverified — from an unconfirmed web source" / "unverified — from AI general knowledge, no source found"), alongside the confidence. Fields with no entry in enrichmentMetadata were entered manually or imported, not enriched. Also returns `lead.linkedInConnectionStatus`: if the lead has a LinkedIn URL, this field indicates whether they are a 1st-degree connection (`isConnected: true/false`), and if connected, when they connected (`connectedAt` ISO string, `connectedAtTimestamp` UNIX milliseconds). Returns `null` if the lead has no LinkedIn URL. Use this to decide whether to send a connection invite vs. a direct message.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to get details for'
        }
      },
      required: ['list_id', 'lead_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadDetails(args.list_id, args.lead_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_leads_needing_followup',
  definition: {
    name: 'get_leads_needing_followup',
    description: 'For a LinkedIn-outreach lead list, return the cohort of leads who ACCEPTED your connection invite but still need a follow-up — in a single list-level call (no per-lead get_lead_details fan-out). A lead qualifies when they are a 1st-degree connection AND the most recent message is not an outbound touch sent after they connected (i.e. you never followed up after they accepted, or they replied and you owe a response). Each returned lead includes linkedInConnectionStatus (isConnected, connectedAt), lastEngagementType, lastEngagementDirection (inbound/outbound), lastEngagementAt, and awaitingReply. Requires the list to have a LinkedIn account assigned. Use this to answer "which leads accepted my invite but haven\'t been followed up?".',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the LinkedIn-outreach lead list to scan'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of leads to return (default 25, max 100)'
        },
        scan_limit: {
          type: 'number',
          description: 'Maximum number of leads to scan in the list (default 2000, max 5000). Raise only for very large lists; the response reports scannedAllLeads so you know whether the whole list was covered.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadsNeedingFollowup(args.list_id, context?.userId, {
      limit: args.limit,
      scanLimit: args.scan_limit,
    });
  }
});

emmaToolRegistry.register({
  name: 'update_lead',
  definition: {
    name: 'update_lead',
    description: 'Update fields on a lead. Supports standard fields (email, firstName, lastName, phone, company, title, notes, linkedin, status, dealValue, dealCurrency) and any custom fields. Changing status auto-creates a status.changed engagement event.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to update'
        },
        updates: {
          type: 'object',
          description: 'Object with field names and new values. Standard fields: email, firstName, lastName, phone, company, title, notes, linkedin, status, dealValue, dealCurrency. Any other fields are stored as custom fields.',
          additionalProperties: true
        }
      },
      required: ['list_id', 'lead_id', 'updates']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateLead(args.list_id, args.lead_id, args.updates, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'set_lead_contact_status',
  definition: {
    name: 'set_lead_contact_status',
    description: 'Set the contact status for one or more leads. Use "do-not-contact" to flag leads that should not receive any emails or outreach. Use "active" to clear the flag and allow contact again. Leads flagged as do-not-contact will be blocked from all email sends, draft creation, and group emails.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the leads'
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of lead IDs to update (max 200)'
        },
        contact_status: {
          type: 'string',
          enum: ['active', 'do-not-contact', 'unsubscribed'],
          description: 'The contact status to set. "do-not-contact" blocks all outreach, "unsubscribed" marks as opted out, "active" clears the flag.'
        },
        reason: {
          type: 'string',
          enum: ['opted-out', 'bounced', 'requested-removal', 'admin-flagged', 'compliance', 'other'],
          description: 'Reason for the status change (optional but recommended for do-not-contact/unsubscribed)'
        },
        note: {
          type: 'string',
          description: 'Optional free-text note explaining the status change'
        }
      },
      required: ['list_id', 'lead_ids', 'contact_status']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.setLeadContactStatus(
      args.list_id,
      args.lead_ids,
      args.contact_status,
      args.reason,
      args.note,
      context?.userId
    );
  }
});

emmaToolRegistry.register({
  name: 'delete_leads',
  definition: {
    name: 'delete_leads',
    description: 'Delete one or more leads from a lead list. Maximum 100 leads per call.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the leads'
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of lead IDs to delete (max 100)'
        }
      },
      required: ['list_id', 'lead_ids']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeads(args.list_id, args.lead_ids, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'delete_leads_by_filter',
  definition: {
    name: 'delete_leads_by_filter',
    description: 'Delete all leads matching filter criteria from a lead list. Use this instead of search_leads + delete_leads when deleting many leads by condition (e.g. all leads without a certain field, all leads with low ICP score). TWO-PHASE WORKFLOW: (1) First call without confirm=true to see count and preview of matching leads. (2) If user approves, call again with confirm=true to actually delete them. This prevents accidental mass deletions.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list'
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Field name: standard fields (email, firstName, lastName, company, title, phone, notes, linkedin, status, dealValue, dealCurrency, icpScore, icpMatch, engagementCount) or any custom field name'
              },
              operator: {
                type: 'string',
                enum: ['equals', 'not_equals', 'contains', 'starts_with', 'is_empty', 'is_not_empty', 'greater_than', 'less_than'],
                description: 'Comparison operator'
              },
              value: {
                description: 'Value to compare against (not needed for is_empty/is_not_empty)'
              }
            },
            required: ['field', 'operator']
          },
          description: 'Array of filter conditions (all must match for a lead to be deleted)'
        },
        confirm: {
          type: 'boolean',
          description: 'Set to true to actually delete leads. Omit or set to false to preview count and sample leads first. ALWAYS preview first before setting confirm=true.'
        }
      },
      required: ['list_id', 'filters']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeadsByFilter(args.list_id, args.filters, context?.userId, args.confirm);
  }
});

emmaToolRegistry.register({
  name: 'update_lead_list',
  definition: {
    name: 'update_lead_list',
    description: 'Update a lead list\'s name, description, filter settings, auto-draft configuration, or status pipeline configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to update'
        },
        name: {
          type: 'string',
          description: 'New name for the lead list'
        },
        description: {
          type: 'string',
          description: 'New description for the lead list'
        },
        icps_only: {
          type: 'boolean',
          description: 'If true, list only shows ICP-matching leads by default'
        },
        engaged_only: {
          type: 'boolean',
          description: 'If true, list only shows engaged leads by default'
        },
        auto_draft_enabled: {
          type: 'boolean',
          description: 'Enable or disable automatic email draft generation for new leads'
        },
        auto_draft_instruction: {
          type: 'string',
          description: 'Instructions for automatic email draft generation'
        },
        status_config: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Machine key (e.g. "qualified")' },
              label: { type: 'string', description: 'Display name (e.g. "Qualified")' },
              color: { type: 'string', description: 'Tailwind color name (e.g. "blue")' },
              type: { type: 'string', enum: ['active', 'won', 'lost', 'churned'], description: 'Status category' }
            },
            required: ['value', 'label', 'color', 'type']
          },
          description: 'Configure the status pipeline stages for this list. Each entry defines a pipeline stage with value, label, color, and type (active/won/lost/churned).'
        },
        list_type: {
          type: 'string',
          enum: ['sales', 'customers'],
          description: 'Set the list type. Can only be set once — once defined, it cannot be changed. "sales" lists track prospects through a sales pipeline; "customers" lists track existing customers through lifecycle stages.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateLeadList(args.list_id, {
      name: args.name,
      description: args.description,
      icpsOnly: args.icps_only,
      engagedOnly: args.engaged_only,
      autoDraftEnabled: args.auto_draft_enabled,
      autoDraftInstruction: args.auto_draft_instruction,
      statusConfig: args.status_config,
      listType: args.list_type
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'delete_lead_list',
  definition: {
    name: 'delete_lead_list',
    description: 'Permanently delete a lead list and all its leads. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to delete'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeadList(args.list_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_lead_status',
  definition: {
    name: 'update_lead_status',
    description: 'Update a lead\'s pipeline status (e.g. new → contacted → qualified → won/lost). Auto-creates a status.changed engagement event for audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to update'
        },
        status: {
          type: 'string',
          description: 'The new status value (must match a value from the list\'s statusConfig, e.g. "qualified", "won", "lost")'
        },
        deal_value: {
          type: 'number',
          description: 'Optional monetary deal amount (relevant for won/lost/negotiating statuses)'
        },
        deal_currency: {
          type: 'string',
          description: 'ISO 4217 currency code (default: USD)'
        },
        notes: {
          type: 'string',
          description: 'Optional notes about this status change'
        }
      },
      required: ['list_id', 'lead_id', 'status']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateLeadStatus(
      args.list_id, args.lead_id, args.status, context?.userId,
      args.deal_value, args.deal_currency, args.notes
    );
  }
});

emmaToolRegistry.register({
  name: 'get_lead_list_statuses',
  definition: {
    name: 'get_lead_list_statuses',
    description: 'Get the configured pipeline status stages for a lead list. Returns the status options with their labels, colors, and types (active/won/lost/churned).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadListStatuses(args.list_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'configure_lead_statuses',
  definition: {
    name: 'configure_lead_statuses',
    description: 'Configure the pipeline status stages for a lead list. Replaces the entire status configuration. Each status has a machine key (value), display name (label), color, and type (active/won/lost/churned).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to configure'
        },
        statuses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Machine key (e.g. "qualified")' },
              label: { type: 'string', description: 'Display name (e.g. "Qualified")' },
              color: { type: 'string', description: 'Tailwind color name (e.g. "blue", "green", "red")' },
              type: { type: 'string', enum: ['active', 'won', 'lost', 'churned'], description: 'Status category for grouping/reporting' }
            },
            required: ['value', 'label', 'color', 'type']
          },
          description: 'Array of status stage definitions in pipeline order'
        }
      },
      required: ['list_id', 'statuses']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.configureLeadStatuses(args.list_id, args.statuses, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_lead_engagements',
  definition: {
    name: 'get_lead_engagements',
    description: 'Get engagement history for a lead including emails sent/received, LinkedIn messages, and manual engagement events.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to get engagements for'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of engagement events to return (default 20)'
        }
      },
      required: ['list_id', 'lead_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadEngagements(args.list_id, args.lead_id, context?.userId, args.limit);
  }
});

emmaToolRegistry.register({
  name: 'add_lead_engagement',
  definition: {
    name: 'add_lead_engagement',
    description: 'Record a manual engagement event for a lead (e.g., phone calls, meetings, notes). The event_type must start with "custom." prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to record engagement for'
        },
        event_type: {
          type: 'string',
          description: 'Type of engagement event (must start with "custom.", e.g., "custom.phone_call", "custom.meeting", "custom.note")'
        },
        event_data: {
          type: 'object',
          description: 'Optional data associated with the event (e.g., { "notes": "Discussed pricing", "duration": "30 min" })',
          additionalProperties: true
        },
        event_date: {
          type: 'string',
          description: 'Optional ISO date string for when the engagement occurred (defaults to now)'
        }
      },
      required: ['list_id', 'lead_id', 'event_type']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addLeadEngagement(
      args.list_id, args.lead_id, args.event_type,
      context?.userId, args.event_data, args.event_date
    );
  }
});

emmaToolRegistry.register({
  name: 'send_email_to_lead',
  definition: {
    name: 'send_email_to_lead',
    description: 'Send the existing email draft to a lead using the configured CRM sender. The lead must have an email address and an email draft already created. A sender email must be configured for the lead list first — this is set per lead list by selecting the lead list and clicking "Senders". If no sender is configured, inform the user to select their lead list and click "Senders" to configure one.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to send the email to'
        }
      },
      required: ['list_id', 'lead_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.sendEmailToLead(args.list_id, args.lead_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'send_email_from_sender',
  definition: {
    name: 'send_email_from_sender',
    description:
      'Send a one-off email to any recipient using the user\'s CONFIGURED email sender (set up in CRM → Senders). ' +
      'Use this for ad-hoc emails that are NOT tied to a CRM lead draft — e.g. "send an email to alice@example.com". ' +
      'This does NOT require a connected mailbox: it sends through the user\'s configured sender (a verified custom-domain sender, or a connected Gmail / Outlook mailbox sender). ' +
      'Prefer this over the `email` tool when the user has no connected mailbox but has a configured sender. ' +
      'If no sender is configured, tell the user to open CRM, select a lead list, and click "Senders" to configure one. ' +
      'IMPORTANT about delivery: a successful result means the email was ACCEPTED for delivery by the provider, NOT that it reached the recipient\'s inbox. Do not claim guaranteed delivery — say it was "sent" or "queued for delivery". The provider cannot detect a well-formed but non-existent mailbox at send time; such messages bounce asynchronously to the sender\'s own inbox. Always double-check the recipient address with the user before sending if it looks suspicious. Malformed addresses are rejected before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address'
        },
        subject: {
          type: 'string',
          description: 'Email subject line'
        },
        html: {
          type: 'string',
          description: 'HTML body of the email. Provide a non-empty body via html, text, or body (html preferred for formatted emails).'
        },
        text: {
          type: 'string',
          'x-aliases': ['body'],
          description: 'Plain-text body of the email. Used when html is not provided. The email is not sent if no non-empty body is supplied.'
        },
        body: {
          type: 'string',
          description: 'Alias for text — the plain-text email body. Use this if you are not providing html.'
        },
        sender_id: {
          type: 'string',
          description: 'Optional sender to send from. Accepts the sender\'s email address, its from-name, the keyword "gmail" or "outlook" (to use the corresponding connected-mailbox sender), or the internal id. Omit to use the user\'s default configured sender. If the value does not match any configured sender, the tool returns the list of available senders (each marked [gmail], [outlook] or [resend]) — relay those options to the user rather than claiming no sender exists.'
        }
      },
      required: ['to', 'subject']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Missing user context');
    return await agentModeService.sendEmailFromConfiguredSender(userId, {
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      body: args.body,
      senderId: args.sender_id,
    });
  }
});

emmaToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: 'Returns list of social media accounts connected by the user. PLATFORM MAPPING: use platform="linkedin" for standard LinkedIn posting accounts; use platform="unipile" for LinkedIn Outreach accounts (sending connection invites and direct messages via the linkedin_outreach tool).',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Filter by platform. Common values: "linkedin" (standard LinkedIn posts), "facebook", "meta", "twitter", "youtube" (YouTube channels - for uploading videos and viewing channel metrics), "unipile" (LinkedIn Outreach - use this when the user asks about sending connection requests or direct messages on LinkedIn), or "all" for every platform.',
          default: 'all'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listConnectedAccounts(context?.userId, args.platform);
  }
});

emmaToolRegistry.register({
  name: 'list_connected_account_posts',
  definition: {
    name: 'list_connected_account_posts',
    description: 'List posts from a connected social media account with optional metrics. For company pages, posts are cached locally for 1 day to reduce API calls — use force_reload to bypass the cache and fetch the latest posts from LinkedIn.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The connected account ID' },
        limit: { type: 'number', description: 'Maximum number of posts to return', default: 10 },
        include_metrics: { type: 'boolean', description: 'Whether to include per-post metrics (likes, comments, etc.)', default: false },
        force_reload: { type: 'boolean', description: 'Force a fresh fetch from LinkedIn API, bypassing the local cache. Use this when the cached posts may be outdated.', default: false }
      },
      required: ['account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.loadConnectedAccountPosts(
      context?.userId,
      args.account_id,
      {
        limit: args.limit,
        include_metrics: args.include_metrics,
        force_reload: args.force_reload
      }
    );
  }
});

emmaToolRegistry.register({
  name: 'load_connected_account_metrics',
  definition: {
    name: 'load_connected_account_metrics',
    description: 'Load performance metrics for a specific connected account (e.g., page statistics, follower counts, engagement). Optionally filter by a date range using start_date and end_date. Note: YouTube metrics are always lifetime totals and are not affected by the date range.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'The unique identifier (id) of the connected account to load metrics for'
        },
        start_date: {
          type: 'string',
          description: 'Optional start date for metrics in ISO 8601 format (e.g. "2024-01-01"). Both start_date and end_date must be provided together — specifying only one has no effect.'
        },
        end_date: {
          type: 'string',
          description: 'Optional end date for metrics in ISO 8601 format (e.g. "2024-01-31"). Both start_date and end_date must be provided together — specifying only one has no effect.'
        }
      },
      required: ['account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    const parseDate = (val: string | undefined): Date | undefined => {
      if (!val) return undefined;
      const d = new Date(val);
      if (isNaN(d.getTime())) throw new Error(`Invalid date: "${val}"`);
      return d;
    };
    const startDate = parseDate(args.start_date);
    const endDate = parseDate(args.end_date);
    return await agentModeService.loadConnectedAccountMetrics(context?.userId, args.account_id, startDate, endDate);
  }
});

emmaToolRegistry.register({
  name: 'post_on_connected_account',
  definition: {
    name: 'post_on_connected_account',
    description: 'Create a post on a connected social media account. Supports LinkedIn, Instagram, YouTube, and X (Twitter). This is the ONLY tool for posting a new standalone tweet on X/Twitter — do NOT use twitter_manage_post for this. For YouTube: this UPLOADS a video — you MUST provide a video URL in media_urls. The content becomes the video title (first 100 chars) and description. For X (Twitter): content is trimmed to 280 characters on a word boundary. Provide either account_id OR platform — the tool auto-resolves to the matching account. CRITICAL: Always review the post content with the user and get explicit approval before publishing to social media. IMPORTANT: The content parameter must contain the COMPLETE, FULL post text exactly as approved by the user. Never truncate, abbreviate, summarize, or use placeholders like "..." in the content.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The connected account ID. Optional — provide either account_id or platform, not both. Use account_id when the user has multiple accounts on the same platform.' },
        platform: { type: 'string', enum: ['twitter', 'linkedin', 'instagram', 'youtube'], description: 'Platform to post on. Optional — use instead of account_id when the user has one account per platform. E.g. platform="twitter" to post a tweet.' },
        content: { type: 'string', description: 'The COMPLETE post text content. MUST include the full, untruncated text exactly as approved by the user. Do NOT abbreviate, summarize, or omit any part of the content. Include all paragraphs, hashtags, emojis, and formatting. Length limits depend on the specific platform. CRITICAL FOR LINKEDIN: LinkedIn does NOT render markdown. Never use **bold**, *italic*, - bullets, [links](url), or # headings — they appear as raw text. Use LinkedIn-native plain text: line breaks, unicode bullets (•), emojis for emphasis, and full URLs (LinkedIn auto-links them).' },
        media_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional URLs of images/videos to attach. REQUIRED for YouTube — must be a direct video file URL (e.g. .mp4). The video will be downloaded and uploaded to YouTube.'
        }
      },
      required: ['content']
    }
  },
  execute: async (args: any, context?: any) => {
    // ENG-827: the context carries `assertPublishStillAuthorized`, which the handler
    // runs immediately before the post becomes real — see postOnConnectedAccount.
    return await agentModeService.postOnConnectedAccount(context?.userId, args.account_id, args.content, args.media_urls, args.platform, context);
  }
});

emmaToolRegistry.register({
  name: 'linkedin_manage_post',
  definition: {
    name: 'linkedin_manage_post',
    description: 'Manage LinkedIn post interactions using a connected LinkedIn account. Supports reposting, commenting, listing comments, reacting, and fetching analytics — all in one tool.\n\nActions:\n- repost: Reshare an existing LinkedIn post, optionally adding your own commentary. Requires post_urn. CRITICAL: Always get explicit user approval before reposting.\n- comment: Create a comment on a post, or a nested reply when parent_comment_urn is provided. Requires post_urn and comment_text. CRITICAL: Always get explicit user approval before commenting.\n- list_comments: Fetch all comments on a post with their URNs (useful for finding parent_comment_urn for replies). Requires post_urn.\n- react: React to a post (LIKE/PRAISE/EMPATHY/INTEREST/APPRECIATION/ENTERTAINMENT). Requires post_urn. CRITICAL: Always get explicit user approval before reacting.\n- get_analytics: Fetch engagement metrics (likes, comments, shares, impressions, clicks) for one or more posts. Requires post_ids array.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['repost', 'comment', 'list_comments', 'react', 'get_analytics'],
          description: 'The operation to perform'
        },
        account_id: {
          type: 'string',
          description: 'The connected LinkedIn account ID'
        },
        post_urn: {
          type: 'string',
          description: 'LinkedIn post URN — required for repost, comment, list_comments, react (e.g., "urn:li:ugcPost:123456789" or "urn:li:share:987654321" or "urn:li:activity:123456789")'
        },
        commentary: {
          type: 'string',
          description: 'Optional text to add alongside a repost. Only used with action=repost. LinkedIn plain text only — no markdown.'
        },
        comment_text: {
          type: 'string',
          description: 'The comment text. Required for action=comment. LinkedIn plain text only — no markdown.'
        },
        parent_comment_urn: {
          type: 'string',
          description: 'Optional. URN of a parent comment to reply to (e.g., "urn:li:comment:(urn:li:ugcPost:123,456)"). Only used with action=comment. When provided, posts a nested reply instead of a top-level comment.'
        },
        reaction_type: {
          type: 'string',
          enum: ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'],
          description: 'Reaction type for action=react. LIKE=👍 PRAISE=👏 EMPATHY=❤️ INTEREST=💡 APPRECIATION=🙌 ENTERTAINMENT=😂. Defaults to LIKE.'
        },
        post_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of post URNs to fetch analytics for. Required for action=get_analytics.'
        }
      },
      required: ['action', 'account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.linkedinManagePost(context?.userId, args, context);
  }
});

emmaToolRegistry.register({
  name: 'list_task_templates',
  definition: {
    name: 'list_task_templates',
    description: '[DEPRECATED] List all available web automation task templates. Returns template names, IDs, descriptions, categories, and parameters. Use this only if you need to use create_task_from_template for a task that cannot be done via direct browser control.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listTaskTemplates();
  }
});

// --- Tools from taskTools.ts ---
emmaToolRegistry.register({
  name: 'create_task_from_template',
  definition: {
    name: 'create_task_from_template',
    description: '[DEPRECATED] Create a web automation task using a specific template. Only use this for tasks that cannot be accomplished via direct browser control with Playwright browser tools. If you need to do web automation (browsing, clicking, filling forms, scraping), prefer using the browser_* Playwright tools directly instead. IMPORTANT: You must call list_task_templates first to get the available template IDs before using this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description: 'The template ID obtained from list_task_templates. Do not guess or fabricate template IDs.'
        },
        parameters_json: {
          type: 'string',
          description: 'JSON string containing parameter values where keys are parameter names and values are the actual values. Example: {"site_url": "example.com", "business_area": "e-commerce"}'
        },
        attach_previous_task_results: {
          type: 'boolean',
          default: true,
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
        },
        attached_file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
          default: []
        },
        async: {
          type: 'boolean',
          description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
          default: false
        }
      },
      required: ['template_id', 'parameters_json']
    }
  },
  execute: async (args: any, context?: any) => {
    let parameters = args.parameters_json;
    if (typeof parameters === 'string') {
      try { parameters = JSON.parse(args.parameters_json); } catch (e) { }
    }
    return await agentModeService.createTaskFromTemplate(
      args.template_id,
      parameters,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async ?? false
    );
  }
});

emmaToolRegistry.register({
  name: 'create_task_from_prompt',
  definition: {
    name: 'create_task_from_prompt',
    description: '[DEPRECATED] Create a web automation task using a raw prompt when no suitable template is available. Web automation via agent engine is being phased out. Do not use this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Name for the task'
        },
        prompt: {
          type: 'string',
          description: 'The raw prompt/instructions for the task'
        },
        category: {
          type: 'string',
          description: 'Category for the task (e.g., Research, Marketing, Analysis)'
        },
        attach_previous_task_results: {
          type: 'boolean',
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
          default: true
        },
        attached_file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
          default: []
        },
        async: {
          type: 'boolean',
          description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
          default: false
        }
      },
      required: ['task_name', 'prompt', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async ?? false
    );
  }
});

emmaToolRegistry.register({
  name: 'create_image_task_from_prompt',
  definition: {
    name: 'create_image_task_from_prompt',
    description: '[DEPRECATED] Create an image generation task using a raw prompt for creating visual content. Use \'generate_image\' instead for creating and revising images.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Name for the image generation task'
        },
        prompt: {
          type: 'string',
          description: 'The detailed prompt describing what images to generate, including style, content, and specifications'
        },
        category: {
          type: 'string',
          description: 'Category for the task (e.g., Creatives, Marketing, Social Media)',
          default: 'Creatives'
        },
        attach_previous_task_results: {
          type: 'boolean',
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
          default: true
        }
      },
      required: ['task_name', 'prompt']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createImageTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results
    );
  }
});

emmaToolRegistry.register({
  name: 'create_revision',
  definition: {
    name: 'create_revision',
    description: '[DEPRECATED] Create a revision of an existing completed task execution (supports both reports and images). For image revision, use \'generate_image\' instead. For HTML report revision, use \'update_html_file\' instead.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to revise'
        },
        execution_id: {
          type: 'string',
          description: 'The ID of the execution to revise'
        },
        revision_prompt: {
          type: 'string',
          description: 'Detailed instructions for the revision'
        },
        target_result_name: {
          type: 'string',
          description: 'Name of the specific result file to revise (if execution has multiple results). If not provided, will use the first available result.',
          default: null
        }
      },
      required: ['task_id', 'execution_id', 'revision_prompt']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createRevision(
      args.task_id,
      args.execution_id,
      args.revision_prompt,
      context?.userId,
      args.target_result_name
    );
  }
});

emmaToolRegistry.register({
  name: 'get_task_subscriber_metrics',
  definition: {
    name: 'get_task_subscriber_metrics',
    description: 'Get comprehensive email metrics for all subscribers of a specific task, including open rates, click-through rates, and engagement data',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to get subscriber metrics for'
        }
      },
      required: ['task_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getTaskSubscriberMetrics(args.task_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_task_subscriber_engagement_events',
  definition: {
    name: 'get_task_subscriber_engagement_events',
    description: 'Get email engagement events for a specific task and email subject, showing detailed event history like delivered, opened, clicked, bounced, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to get engagement events for'
        },
        email_subject: {
          type: 'string',
          description: 'The email subject line to filter events by'
        }
      },
      required: ['task_id', 'email_subject']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getTaskSubscriberEngagementEvents(args.task_id, args.email_subject, context?.userId);
  }
});

// --- Tools from mediaTools.ts ---
emmaToolRegistry.register({
  name: "describe_image",
  definition: {
    name: "describe_image",
    description: 'Analyze and describe an image from a URL. Use this when the user mentions an image, asks to "read" an image, or when you need to understand visual content (jpg, jpeg, png, gif, webp, svg, etc.). Always prefer this over read_file_content for image files.',
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: 'string',
          description: 'Image URL to analyze and describe. Include the complete file URL in request.'
        },
        prompt: {
          type: 'string',
          description: 'Custom prompt/instructions for analyzing the image. Specify what aspects to focus on (e.g., colors, composition, text, branding, marketing elements, etc.)',
          default: 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.'
        }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any, _context?: any) => {
    // Intentionally pass no model: describe_image always uses the configured
    // agent_mode_default_model (resolved inside describeImage), not the chat's
    // selected model. (`args.llmModel` was never populated — the schema doesn't
    // expose it and the registry doesn't merge context into args.)
    return await agentModeService.describeImage(undefined, args.image_url, args.prompt);
  }
});

emmaToolRegistry.register({
  name: "describe_video",
  definition: {
    name: "describe_video",
    description: 'Analyze and describe a video from a URL using Gemini. Accepts direct video file URLs (mp4, mov, avi, webm, mkv, etc.) AND YouTube URLs (youtube.com or youtu.be). Always prefer this over read_file_content for video files. For scripting and content repurposing, set return_transcript=true to get a timestamped spoken-word transcript, and/or return_scenes=true to get a structured scene-by-scene breakdown. Use start_time/end_time to focus on a specific segment.',
    inputSchema: {
      type: "object",
      properties: {
        video_file_url: {
          type: 'string',
          description: 'Video URL to analyze and describe. Include the complete file URL in request.'
        },
        prompt: {
          type: 'string',
          description: 'Custom prompt/instructions for analyzing the video. Specify what aspects to focus on (e.g., key events, narration, visual details, or timing).',
          default: 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.'
        },
        return_transcript: {
          type: 'boolean',
          description: 'When true, returns a timestamped transcript of all spoken content as an array of {start, end, text} objects. Use for scripting, captioning, or content repurposing workflows.'
        },
        return_scenes: {
          type: 'boolean',
          description: 'When true, returns scene segmentation as an array of {start, end, title, description} objects identifying distinct video segments. Use for scene planning or B-roll identification.'
        },
        start_time: {
          type: 'string',
          description: 'Focus analysis on a time range starting at this timestamp (e.g. "0:30", "1:15"). Use together with end_time for targeted segment analysis.'
        },
        end_time: {
          type: 'string',
          description: 'Focus analysis on a time range ending at this timestamp (e.g. "2:00", "3:45"). Use together with start_time for targeted segment analysis.'
        }
      },
      required: ["video_file_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.describeVideo(args.video_file_url, args.prompt, {
      return_transcript: args.return_transcript,
      return_scenes: args.return_scenes,
      start_time: args.start_time,
      end_time: args.end_time,
      userId: context?.userId // charge this describe_video spend to the caller (ENG-200)
    });
  }
});

emmaToolRegistry.register({
  name: "remove_c2pa_from_image",
  definition: {
    name: "remove_c2pa_from_image",
    description: 'Remove C2PA (provenance) metadata from an image by downloading it, re-encoding it to strip ALL metadata, and uploading the cleaned image to S3. Returns the new S3 URL. ' +
      'IMPORTANT: This ONLY strips metadata. It does NOT remove or change any pixels — it cannot remove a background, make a background transparent, or create an alpha channel. ' +
      'To make a logo/image background transparent, use remove_image_background instead.',
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of the image to process (can be S3 URL, data URL, or any accessible image URL)'
        },
        filename: {
          type: 'string',
          description: 'Optional filename for the cleaned image. If not provided, will generate a filename based on the original URL'
        }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.removeC2PAFromImage(args.image_url, args.filename, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "remove_image_background",
  definition: {
    name: "remove_image_background",
    description:
      'Make the background of a logo/image transparent, producing a GENUINE transparent-alpha PNG. ' +
      'This operates on the ORIGINAL pixels (edge-seeded flood fill) and does NOT redraw or regenerate the artwork — ' +
      'the brand mark\'s exact letters, shapes, and colors are preserved byte-for-byte; only the background becomes transparent. ' +
      'PREFER this tool over generate_image when a user wants a transparent background: generate_image redraws the logo and can drift the icon/letters/colors and cannot guarantee true alpha. ' +
      'Note remove_c2pa_from_image does NOT do this — it only strips metadata. ' +
      'Best for logos/marks on a solid or near-solid background; it is not a general subject-segmentation tool for busy photographic backgrounds. ' +
      'If a transparent PNG already exists for the brand (e.g. the user supplied one, or brand guidelines include one), prefer using that directly via update_html_file rather than processing a JPEG. ' +
      'Optionally pass surface_color (the hex color of the surface the logo will sit on, e.g. a dark header) to get a WCAG contrast check that warns when the logo would be illegible (e.g. a dark wordmark on a dark background).',
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of the image to process (S3 URL, data URL, or any accessible image URL).'
        },
        filename: {
          type: 'string',
          description: 'Optional filename for the transparent image. Always saved as .png (alpha requires PNG).'
        },
        tolerance: {
          type: 'number',
          description: 'Optional color-match tolerance 0-255 (default 32). Higher removes more near-background colors (useful for JPEG noise / gradients); lower is stricter and preserves edge detail.'
        },
        surface_color: {
          type: 'string',
          description: 'Optional hex color (e.g. "#1a1a2e") of the surface the logo will be placed on. When provided, the result includes a WCAG fg/bg contrast ratio and warns if the logo would be hard to read on that surface.'
        }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.removeImageBackground(args.image_url, args.filename, context?.userId, {
      tolerance: args.tolerance,
      surfaceColor: args.surface_color
    });
  }
});

emmaToolRegistry.register({
  name: 'generate_image',
  definition: {
    name: 'generate_image',
    description: 'Generate or edit images using AI image generation models. Supports both text-to-image generation and image editing with input images.\n\nMULTIPLE VARIANTS: When the user asks for several INDEPENDENT variants of the same brief (e.g. "generate 3 variants"), emit ALL the generate_image calls together in a SINGLE turn — one tool call per variant. They run in parallel (bounded), so N variants finish in roughly the time of one instead of N× and stay within the turn\'s time limit; generating them one-by-one across separate turns is slow and can time out. Only chain image calls sequentially when a later image genuinely DEPENDS on an earlier one (e.g. editing a just-generated image).\n\nLOGO COMPOSITING BEST PRACTICES (tested and confirmed):\n- When the user wants an image with their logo, ALWAYS use the logo_image parameter with the logo URL from their brand guidelines (read_brand_guidelines tool). Do NOT describe the logo in the prompt — pass the actual PNG URL.\n- For logo compositing, prefer gemini-3.1-flash-image or gemini-3-pro-image-preview. Both successfully composite PNG logos with high fidelity. gemini-3.1-flash-image renders the logo largest and most prominently. These models also produce 4096×4096 output.\n- gpt-image-2 also supports logo compositing via logo_image and works correctly, preserving the logo faithfully at 1024×1024 (may add unrequested design elements around it).\n- gpt-image-1 is NOT reliable for logo compositing — it rewrites the logo (e.g. replaces the actual text in the logo with the company name from the prompt). Avoid gpt-image-1 when logo fidelity matters.\n- NEVER tell the user that AI image generation cannot composite a real logo — gemini-3-pro-image-preview, gemini-3.1-flash-image, and gpt-image-2 all handle it correctly when logo_image is provided.\n- NEVER switch the output format from image to HTML without explicit user approval.\n- Brand guideline PNG logos from the attachments array composite cleanly — use them directly.\n\nTRANSPARENT BACKGROUNDS — DO NOT use generate_image to "redraw the logo on a transparent background". This model redraws the mark and can drift its icon/letters/colors, and it CANNOT guarantee a true alpha channel. To make an existing logo\'s background transparent, use the remove_image_background tool (it operates on the original pixels and outputs genuine alpha). If the user already has a transparent PNG of the logo, use that directly. Only fall back to generation if no source logo exists at all.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or edit, including style, content, and visual specifications'
        },
        filename: {
          type: 'string',
          description: 'Name for the generated image file (should include .png extension)'
        },
        size: {
          type: 'string',
          description: 'Image size or ratio. For GPT models: 1024x1024, 1536x1024, 1024x1536, or auto. For Runway models: use ratio format like 1344:768, 768:1344, 1024:1024, 832x1248, etc. For Gemini 3 models (gemini-3-pro-image-preview, gemini-3.1-flash-image): use ratio format like 1:1, 9:16, 16:9, 3:4, 4:3, 3:2, 2:3, 5:4, 4:5, 21:9, or auto. Use "auto" for automatic sizing.',
          default: 'auto'
        },
        quality: {
          type: 'string',
          description: 'Image quality setting (low, medium, high). Defaults to medium if not specified.',
          enum: ['low', 'medium', 'high'],
          default: 'medium'
        },
        inputImages: {
          type: 'array',
          description: 'List of input image URLs to use for image editing (e.g., background images, base images to modify). Do NOT put logo images here — use the logo_image parameter instead for logos.',
          items: {
            type: 'string'
          }
        },
        logo_image: {
          type: 'string',
          description: 'URL of a logo image to add to the generated/edited image. ALWAYS use this parameter when the user wants to add a logo. The logo will be reproduced with strict precision — its exact text, shape, and colors will be preserved faithfully. This is the preferred way to include logos instead of putting them in inputImages.'
        },
        imageModel: {
          type: 'string',
          description: 'Optional: Specific image generation model to use. Model guide: gemini-3.1-flash-image (Google, BEST for logo compositing — renders logo most prominently, 4K output), gemini-3-pro-image-preview (Google, excellent for logo compositing, 4K output), gpt-image-2 (Azure, good for logo compositing — preserves logo faithfully, 1024×1024, may add extra design elements), gpt-image-1 (Azure, DO NOT USE for logo compositing — rewrites logo text instead of preserving it; fine for text-to-image with no logo), gemini-2.5-flash-image (Google, text-to-image only, no logo compositing), gen4_image (Runway, cinematic/photorealistic), gemini_2.5_flash (Runway). When logo_image is provided and no model is specified, gemini-3-pro-image-preview is the default.',
          enum: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gpt-image-1', 'gpt-image-2', 'gemini-2.5-flash-image', 'gen4_image', 'gemini_2.5_flash']
        },
        confirm: {
          type: 'boolean',
          description: 'EDITING existing images only (when inputImages is set): on the first call, omit (or false) — the tool returns the source image(s) it will edit and asks the user to confirm. Set true ONLY after the user has seen those images and approved. Ignored for text-to-image (no inputImages), which never needs confirmation.'
        },
        category: {
          type: 'string',
          enum: ['ad', 'organic_post'],
          description: "REQUIRED use-case declaration for the human eval queue: 'ad' when the image is a paid ad creative (Meta/Google/LinkedIn ads, retargeting creatives), 'organic_post' when it is organic social/content imagery (feed posts, blog headers, non-paid content). Reviewer feedback differs entirely between the two, so declare it from the request's context — never guess randomly; if the user's intent is genuinely unclear, ask them which use case the image is for before generating."
        }
      },
      required: ['prompt', 'filename', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    // ENG-510: pass the LLM's model choice through AS-IS (undefined when it didn't
    // pick one). Resolving the admin-configured default here made every request look
    // like an explicit model choice, which disabled the transient-timeout fallback in
    // generateImage — so a provider timeout produced zero deliverables. generateImage
    // now resolves the admin default itself and only suppresses the fallback for a
    // genuinely LLM-specified model.
    return await agentModeService.generateImage(
      args.prompt,
      args.filename,
      args.size || '1024x1024',
      args.quality || 'medium',
      args.inputImages || [],
      context?.userId,
      context?.sessionId,
      args.imageModel,
      args.logo_image,
      args.confirm,
      args.category
    );
  }
});

emmaToolRegistry.register({
  name: 'generate_video',
  definition: {
    name: 'generate_video',
    description: 'Generate videos using AI video generation models. Supports text-to-video generation and video generation with optional start and end frames for interpolation. Can optionally post-process the generated clip with Remotion to add brand overlays (headline, tagline, logo, CTA). IMPORTANT: For multi-clip videos (e.g. 24s = 3 clips), ALWAYS use a single generate_video call with durationSeconds=24 and compose=true — do NOT generate clips separately and stitch later. To stitch already-generated clips, use compose_video instead. REFERENCE IMAGES: When the user provides image(s) to base the video on, ALWAYS pass the actual image(s) as frames — never use a text description in place of the image. Recommended flow: (1) call describe_image on each reference image so you understand what it depicts (this grounds your motion prompt; it does NOT replace the frame); (2) pass the image URL(s) as frames — ONE image → set startFrame to its URL and leave endFrame unset (do NOT invent or duplicate a second frame); TWO images → startFrame = the opening/first image, endFrame = the closing/last image (only set endFrame when the user actually intends an end frame); (3) write a prompt that describes the MOTION/transition you want (informed by the descriptions) rather than restating the static contents the frame already carries. You may skip describe_image (step 1) when the user has already given a clear, detailed prompt and just wants the exact image animated. The default model (seedance-2.0 via Higgsfield) and the Veo fallback BOTH accept a single reference frame or two frames natively, so the actual image(s) are used. Only if a generation explicitly fails because a reference frame could not be loaded/imported should you fall back to describing the image(s) with describe_image and adding that to the prompt as text. ASPECT RATIO: infer the aspect ratio from the user\'s intent (e.g. a reel/short → vertical 9:16); if the user gives no orientation/format cue AND no reference frame to match, ASK them for the orientation before generating. Never ask about resolution — infer it or use the default. LENGTH: infer the duration from the request (4–15s for the default Seedance model); if the user gives no length and you cannot infer one, ASK before generating rather than defaulting silently.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the video to generate, including style, content, motion, and visual specifications'
        },
        filename: {
          type: 'string',
          description: 'Name for the generated video file (should include .mp4 extension, will be added automatically if missing)'
        },
        videoModel: {
          type: 'string',
          description: 'Optional: video generation model. Leave unset — the default is seedance-2.0 (ByteDance Seedance 2.0 via Higgsfield; text-to-video, or image-to-video when startFrame/endFrame are given). Veo 3.1 is used automatically as a fallback if Seedance fails. Do not surface model choice to the user.',
          enum: ['veo-3.1-generate-preview', 'seedance-2.0']
        },
        durationSeconds: {
          type: 'number',
          description: 'Requested total video length in seconds. INFER it from the user\'s request (e.g. "a 12-second video" → 12, "make it 15s" → 15); if the user does not specify a length and you cannot infer one, ASK them before generating — do NOT silently default. The default model (Seedance 2.0) produces a SINGLE clip of 4–15s, so for the normal path set this to the requested length within 4–15. (If a generation falls back to Veo, which caps at 8s/clip, durations >8s are produced as multiple 8s clips stitched to the target length via Remotion — needs compose:true; for ≤8s Veo uses a single clip.) Falls back to 8 only if truly unspecified.'
        },
        useKeyframes: {
          type: 'boolean',
          description: 'Optional: When true and durationSeconds > 8 (multiple clips), automatically generate AI keyframe images (f0, f1, ... fN) to guide each clip. Clip i gets startFrame=f[i] and endFrame=f[i+1], so Veo interpolates between visually coherent waypoints. This greatly improves visual continuity across clip boundaries. Recommended for multi-clip videos. Defaults to false.'
        },
        startFrame: {
          type: 'string',
          description: 'Optional: URL of the first frame image to use as the starting point for video generation. If provided, the video will start from this frame. When the user uploads/provides a reference image for the video, put its URL here (do NOT describe it into the prompt).'
        },
        endFrame: {
          type: 'string',
          description: 'Optional: URL of the last frame image to use as the ending point for video generation. If provided, the video will end at this frame. Can be used together with startFrame for interpolation between two frames. When the user provides a SECOND reference image, put its URL here.'
        },
        aspectRatio: {
          type: 'string',
          description: 'Video aspect ratio (Seedance 2.0). INFER it from the user\'s intent/format cues whenever possible — e.g. reel/short/story/TikTok/"vertical" → 9:16; "square"/feed post → 1:1; YouTube/"widescreen"/"landscape" → 16:9; cinematic → 21:9. If the user gives NO orientation or format cue, ASK them which orientation/aspect ratio they want BEFORE calling this tool — do not silently default. Exception: when a reference start frame is provided, "auto" (match the frame) is an acceptable no-ask default. (Resolution is the opposite — never ask; just infer or use the 720p default.)',
          enum: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
        },
        resolution: {
          type: 'string',
          description: 'Optional: output resolution (Seedance 2.0). Set from the user\'s request, e.g. "1080p"/"full HD"→1080p, "480p"/"low-res"→480p. Defaults to "720p".',
          enum: ['480p', '720p', '1080p']
        },
        compose: {
          type: 'boolean',
          description: 'Optional: When true, post-process the generated clip with Remotion to add branded overlays (brand name headline, tagline, logo, and optional CTA card). Requires composeParams. Use this when the user wants a polished, branded video rather than the raw AI-generated clip.'
        },
        composeParams: {
          type: 'object',
          description: 'Optional: Brand overlay configuration for Remotion post-processing. Required when compose is true.',
          properties: {
            brandName: {
              type: 'string',
              description: 'Brand display name shown as the headline overlay on the video'
            },
            tagline: {
              type: 'string',
              description: 'Optional tagline or subtitle shown under the brand name'
            },
            primaryColor: {
              type: 'string',
              description: 'Primary hex color for the gradient bar and background tint (e.g. "#1a73e8")'
            },
            secondaryColor: {
              type: 'string',
              description: 'Secondary hex color for accent elements like the divider line (e.g. "#fbbc04")'
            },
            logoUrl: {
              type: 'string',
              description: 'Optional URL of the brand logo image to display in the overlay'
            },
            ctaText: {
              type: 'string',
              description: 'Optional call-to-action text for the outro card (e.g. "Get started today")'
            },
            ctaUrl: {
              type: 'string',
              description: 'Optional URL shown alongside the CTA text (e.g. "agentweb.pro")'
            },
            clipDurationSeconds: {
              type: 'number',
              description: 'Optional: Duration of the source clip in seconds. Defaults to 8 (Veo default). Used to set correct composition duration.'
            },
            audioUrl: {
              type: 'string',
              description: 'Optional S3 URL of an MP3 voiceover audio file to overlay on the composed video. Generate first with generate_voiceover, then pass the returned audioUrl here.'
            },
            audioVolume: {
              type: 'number',
              description: 'Optional voiceover volume (0.0–1.0). Defaults to 1.0.'
            }
          },
          required: ['brandName', 'primaryColor', 'secondaryColor']
        }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    // If the LLM didn't specify a model, fall back to the admin-configured video API default
    const videoModel = args.videoModel || await agentModeService.getVideoApiDefaultModel();
    return await agentModeService.generateVideo(
      args.prompt,
      args.filename,
      context?.userId,
      context?.sessionId,
      videoModel,
      args.startFrame,
      args.endFrame,
      args.compose,
      args.composeParams,
      args.durationSeconds,
      args.useKeyframes,
      args.aspectRatio,
      args.resolution
    );
  }
});

emmaToolRegistry.register({
  name: 'compose_video',
  definition: {
    name: 'compose_video',
    description: 'Stitch pre-existing video clips together and add brand overlays using Remotion. Use this when you have already generated individual clips and need to combine them into a single branded video. For new multi-clip videos, prefer a single generate_video call with durationSeconds instead. CRITICAL: clip_urls order determines the final video sequence. Before calling this tool, explicitly list each clip URL in shot order (S1, S2, S3, ...) and verify the array matches. Never pass URLs in context/generation order — always pass them in intended playback order.',
    inputSchema: {
      type: 'object',
      properties: {
        clip_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'ORDERED list of clip URLs in intended playback sequence (S1 first, S2 second, etc.). The final video plays clips exactly in this order — wrong order here = wrong order in the output. Always sort by shot number before passing, regardless of what order clips were generated.'
        },
        filename: {
          type: 'string',
          description: 'Output filename for the composed video (e.g. "final_branded_video.mp4")'
        },
        clip_duration_seconds: {
          type: 'number',
          description: 'Duration of each individual clip in seconds (all clips must have the same duration). Defaults to 8.'
        },
        target_duration_seconds: {
          type: 'number',
          description: 'Optional: Exact total duration for the composed video in seconds. Use this to trim the output to the desired length (e.g. 30) when clips total more (e.g. 4 clips × 8s = 32s). If omitted, defaults to clip_duration_seconds × number of clips.'
        },
        clip_durations_seconds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional: Per-clip playback durations in seconds (variable-length support). E.g. [8, 8, 8, 6] for a 30s video with 3 full clips and one 6s clip. Overrides clip_duration_seconds for each individual clip. Use when clips have different lengths.'
        },
        brand_name: {
          type: 'string',
          description: 'Brand display name shown as the headline overlay'
        },
        tagline: {
          type: 'string',
          description: 'Optional tagline or subtitle shown under the brand name'
        },
        primary_color: {
          type: 'string',
          description: 'Primary hex color for the gradient bar and background tint (e.g. "#1a73e8")'
        },
        secondary_color: {
          type: 'string',
          description: 'Secondary hex color for accent elements (e.g. "#fbbc04")'
        },
        logo_url: {
          type: 'string',
          description: 'Optional URL of the brand logo image'
        },
        cta_text: {
          type: 'string',
          description: 'Optional call-to-action text for the outro card'
        },
        cta_url: {
          type: 'string',
          description: 'Optional website URL shown alongside the CTA text'
        },
        audio_url: {
          type: 'string',
          description: 'Optional S3 URL of an MP3 voiceover audio file to overlay on the composed video. Generate first with generate_voiceover, then pass the returned audioUrl here.'
        },
        audio_volume: {
          type: 'number',
          description: 'Optional voiceover volume (0.0–1.0). Defaults to 1.0.'
        }
      },
      required: ['clip_urls', 'filename', 'brand_name', 'primary_color', 'secondary_color']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.composeVideo(
      args.clip_urls,
      args.filename,
      context?.userId,
      context?.sessionId,
      {
        brandName: args.brand_name,
        tagline: args.tagline,
        primaryColor: args.primary_color,
        secondaryColor: args.secondary_color,
        logoUrl: args.logo_url,
        ctaText: args.cta_text,
        ctaUrl: args.cta_url,
        audioUrl: args.audio_url,
        audioVolume: args.audio_volume,
        // Runtime budget (not a model arg): the run's media-gen deadline, so a long render
        // hands off before the run's hard wall-clock timeout instead of being killed (ENG-123).
        renderDeadlineMs: context?.renderDeadlineMs,
      },
      args.clip_duration_seconds,
      args.target_duration_seconds,
      args.clip_durations_seconds
    );
  }
});

emmaToolRegistry.register({
  name: 'mux_video_with_audio',
  definition: {
    name: 'mux_video_with_audio',
    description: 'Combine a silent or muted video (MP4) with a voiceover audio track (MP3) into a single video file with audio. Use this after generate_video and generate_voiceover to produce a final video+audio file. The audio is trimmed to the video length automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        video_url: {
          type: 'string',
          description: 'S3 URL of the video file (MP4) — e.g. the videoUrl returned by generate_video or compose_video'
        },
        audio_url: {
          type: 'string',
          description: 'S3 URL of the voiceover MP3 — the audioUrl returned by generate_voiceover'
        },
        filename: {
          type: 'string',
          description: 'Output filename for the final video (e.g. "agentweb_ad_final.mp4"). .mp4 extension added automatically.'
        }
      },
      required: ['video_url', 'audio_url', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.muxVideoWithAudio(
      args.video_url,
      args.audio_url,
      args.filename,
      context?.userId,
      context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'generate_voiceover',
  definition: {
    name: 'generate_voiceover',
    description: 'Generate professional voiceover audio from a script using ElevenLabs TTS. Returns an S3 URL to an MP3 file. Use this to create narration for video ads, presentations, or any audio content. After generating, you can reference the audioUrl in your response so the user can download or play it.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The voiceover script text to convert to speech'
        },
        filename: {
          type: 'string',
          description: 'Output filename for the audio file (e.g. "product_ad_voiceover.mp3"). .mp3 extension is added automatically if missing.'
        },
        voice: {
          type: 'string',
          description: 'Voice to use. Available presets: "george" (warm confident male, default), "rachel" (clear professional female), "adam" (deep authoritative male), "bella" (soft friendly female), "josh" (energetic young male), "dorothy" (conversational female). Or pass a raw ElevenLabs voice ID.',
          enum: ['george', 'rachel', 'adam', 'bella', 'josh', 'dorothy']
        },
        stability: {
          type: 'number',
          description: 'Voice stability (0.0–1.0). Higher = more consistent but less expressive. Default: 0.5'
        },
        similarity_boost: {
          type: 'number',
          description: 'Voice similarity boost (0.0–1.0). Higher = closer to original voice. Default: 0.75'
        }
      },
      required: ['script', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateVoiceover(
      args.script,
      args.filename,
      context?.userId,
      context?.sessionId,
      args.voice,
      args.stability,
      args.similarity_boost
    );
  }
});

// --- Character management tools for Video Production ---
emmaToolRegistry.register({
  name: 'list_characters',
  definition: {
    name: 'list_characters',
    description: 'List all saved video characters for the user. Each character has a name, visual description, and a reference image URL. Call this at the start of video production to offer character selection. Pass the referenceImageUrl as startFrame in generate_video to anchor the character visually.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (_args: any, context?: any) => {
    return await agentModeService.listVideoCharacters(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_character',
  definition: {
    name: 'get_character',
    description: 'Get full details of a saved video character by ID, including their referenceImageUrl. Use the referenceImageUrl as startFrame in generate_video to anchor the character appearance in the video.',
    inputSchema: {
      type: 'object',
      properties: {
        character_id: {
          type: 'string',
          description: 'The characterId from list_characters'
        }
      },
      required: ['character_id']
    }
  },
  execute: async (args: any, _context?: any) => {
    return await agentModeService.getVideoCharacter(args.character_id);
  }
});

emmaToolRegistry.register({
  name: 'create_character',
  definition: {
    name: 'create_character',
    description: 'Save a new video character. First call generate_image with the character description to create a reference portrait, then pass the returned S3 URL here along with the name and description. The character will be saved and available for future video productions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Display name for the character (e.g. "Maya")'
        },
        description: {
          type: 'string',
          description: 'Visual description of the character (e.g. "confident woman in her 30s, blue blazer, professional studio background")'
        },
        reference_image_url: {
          type: 'string',
          description: 'S3 URL of the character portrait image, returned by generate_image'
        },
        prompt: {
          type: 'string',
          description: 'The exact prompt passed to generate_image to create the reference image'
        }
      },
      required: ['name', 'description', 'reference_image_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createVideoCharacter(context?.userId, {
      name: args.name,
      description: args.description,
      referenceImageUrl: args.reference_image_url,
      referenceImageKey: '',
      prompt: args.prompt || args.description,
    });
  }
});

emmaToolRegistry.register({
  name: 'delete_character',
  definition: {
    name: 'delete_character',
    description: 'Delete a saved video character by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        character_id: {
          type: 'string',
          description: 'The characterId to delete'
        }
      },
      required: ['character_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteVideoCharacter(context?.userId, args.character_id);
  }
});

// --- Tools from searchTools.ts ---
emmaToolRegistry.register({
  name: "you_search_web",
  definition: {
    name: "you_search_web",
    description: 'Search the public web using You.com Search. This tool has no hidden fallback provider; failures are reported as You.com search failures. For social-platform research, include explicit site filters when useful, e.g. site:x.com, site:linkedin.com, site:reddit.com, or site:instagram.com.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The web search query'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of web results to return (default: 5, max: 10)',
          default: 5
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: "Optional You.com freshness window; use for time-scoped research like 'this week's discussions'."
        },
        include_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional domain allowlist, e.g. ["reddit.com"] to restrict results to one site.'
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.youSearchWeb(args.query, args.max_results || 10, args.freshness, args.include_domains);
  }
});

emmaToolRegistry.register({
  name: "you_search_news",
  definition: {
    name: "you_search_news",
    description: 'Search current news using You.com Search. Use this only when the user asks for news, today/latest/breaking updates, or recent articles. Do not call it as a companion to ordinary web/social searches unless the user explicitly asks for news too. This tool has no hidden fallback provider; failures are reported as You.com search failures. Preserve freshness words from the user query such as today, latest, breaking, or the exact date; do not rewrite a today/latest-news request into a timeless entity query.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The news search query. For current-news requests, keep temporal terms like today/latest/breaking or include the exact date.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of news results to return (default: 5, max: 10)',
          default: 5
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Optional You.com freshness window. Defaults to week for news unless the query implies a fresher window.'
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.youSearchNews(args.query, args.max_results || 10, args.freshness);
  }
});

emmaToolRegistry.register({
  name: "google_search_web",
  definition: {
    name: "google_search_web",
    description: 'Opt-in Google Custom Search web search. This is not the default search tool and has no hidden provider fallback. Use only when the user explicitly asks for Google search, when a skill requires Google CSE, or when comparing provider output.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The Google Custom Search query'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of Google web results to return (default: 5, max: 10)',
          default: 5
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.googleSearchWeb(args.query, args.max_results || 10);
  }
});

emmaToolRegistry.register({
  name: "search_knowledge_base",
  definition: {
    name: "search_knowledge_base",
    description: 'Search the knowledge base for relevant information. The knowledge base contains private knowledge (user-specific), public knowledge (shared by all users and the platform), Google Drive shared folders, and ClickUp docs. This is complementary to web search - use knowledge base for stored information and web search for information from the internet.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant information in the knowledge base'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of search results to return (default: 5, max: 10)',
          default: 5
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchKnowledgeBase(args.query, args.max_results || 5, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "search_ads_knowledge_base",
  definition: {
    name: "search_ads_knowledge_base",
    description: "Search Foreplay ad library. Defaults to the user's saved swipefile + boards (free). Set source='discovery' to search Foreplay's global database of millions of ads — use this for competitive intelligence or finding ads from a specific company. IMPORTANT: discovery mode costs 1 Foreplay credit per result and returns at most 20 ads per call (max_results is capped at 20). For finding a specific company's currently-running Meta ads, or for cataloging/analyzing many ads at scale, this is the RELIABLE source. Targeting: for a SPECIFIC company/brand, pass company_name (optionally with query); for BROAD keyword/theme/category research NOT tied to one company (e.g. cataloging 100 winning B2B ads for 'book a demo'), pass query with niche/format/platform and use sort='newest' + live=true — do NOT force company_name for broad keyword research. To retrieve MORE than 20 ads (e.g. cataloging 100 ads for a scheduled run), page through results: the response returns a `cursor` and `hasMore` — call this tool again with the same filters plus the returned `cursor` to fetch the next page, and repeat until hasMore is false. Do NOT use search_knowledge_base for Foreplay ad searches. NOTE: This does NOT scrape the public Meta/Facebook Ads Library UI. Playwright DOM scraping of https://www.facebook.com/ads/library/ is best-effort only — Meta's DOM virtualization + lazy-loading make it unable to reliably extract ad copy/creative at scale — so prefer source='discovery' (or the official Meta Ad Library API) for any bulk or scheduled ad-creative extraction.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — keyword, headline, ad copy, or niche (e.g. 'checkout', 'SaaS onboarding', 'skincare'). Optional when company_name is provided."
        },
        source: {
          type: "string",
          enum: ["swipefile", "discovery"],
          description: "Where to search. 'swipefile' (default) = user's own saved ads, free. 'discovery' = Foreplay's global database of millions of ads, costs 1 credit per result."
        },
        company_name: {
          type: "string",
          description: "Company or brand name to search ads for (e.g. 'Nike', 'Shopify'). Only used when source='discovery'. Can be combined with query."
        },
        max_results: {
          type: "number",
          description: "Max results to return. Default 5 for swipefile, 10 for discovery (max 20).",
          default: 5
        },
        cursor: {
          type: "string",
          description: "Pagination cursor for source='discovery'. Omit for the first page; to fetch the next page, pass the `cursor` value returned by the previous call (repeat the same filters). Keep paging while `hasMore` is true to retrieve more than one page (e.g. cataloging many ads)."
        },
        format: {
          type: "array",
          items: { type: "string", enum: ["image", "video", "carousel", "dco"] },
          description: "Filter by ad format. Only applies to source='discovery'."
        },
        platform: {
          type: "array",
          items: { type: "string", enum: ["facebook", "instagram"] },
          description: "Filter by publisher platform. Only applies to source='discovery'."
        },
        niche: {
          type: "array",
          items: { type: "string" },
          description: "Filter by niche tags (e.g. ['ecommerce', 'saas']). Only applies to source='discovery'."
        },
        live: {
          type: "boolean",
          description: "If true, return only currently-running ads. If false, return only stopped ads. Only applies to source='discovery'."
        },
        sort: {
          type: "string",
          enum: ["newest", "oldest", "longest_running"],
          description: "Sort order. Only applies to source='discovery'."
        }
      }
    }
  },
  execute: async (args: any, context?: any) => {
    if (args.source === 'discovery') {
      return await agentModeService.searchForeplayDiscovery(
        args.query,
        {
          maxResults: args.max_results || 10,
          companyName: args.company_name,
          cursor: args.cursor,
          format: args.format,
          platform: args.platform,
          niche: args.niche,
          live: args.live,
          sort: args.sort,
        },
        context?.userId
      );
    }
    return await agentModeService.searchForeplayAds(args.query, args.max_results || 5, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "list_knowledge_base_files",
  definition: {
    name: "list_knowledge_base_files",
    description: 'List available knowledge base files for the current user, including private/public task KBs, Google Drive shared folders, ClickUp docs, and Foreplay boards. Google Drive entries have identifiers starting with "gdrive:". ClickUp doc entries start with "clickup:" and include a docId field — use docId as parent_doc_id in write_clickup_doc to nest content inside that doc. ClickUp folder entries start with "clickup-folder:" (these are task-hierarchy folders, for reference only — not writable doc parents). Use modified_after/modified_before to filter by date (ISO format, e.g. "2026-04-15") — this is the most efficient way to find recent files. Use limit/offset to paginate through large folders (default limit is 100). Use kb_type to narrow to a specific source ("google-drive", "private", "public", "clickup", "clickup-tasks", "foreplay-swipefile", "foreplay-board"). Returns file names, identifiers, sizes, types, and last modified timestamps. IMPORTANT: Use this tool (not search_knowledge_base) when you need to browse or list files by name or date. NOTE: the Google Drive entries here are READ-ONLY shared folders — CREATING or EDITING Google Docs/Sheets is a SEPARATE capability; discover and install the skill that provides Google Docs/Sheets create/edit tools via list_available_skills.',
    inputSchema: {
      type: "object",
      properties: {
        modified_after: {
          type: "string",
          description: 'Only return files modified on or after this date. ISO 8601 date string, e.g. "2026-04-15". Applies to Google Drive files.'
        },
        modified_before: {
          type: "string",
          description: 'Only return files modified on or before this date. ISO 8601 date string, e.g. "2026-04-22". Applies to Google Drive files.'
        },
        limit: {
          type: "number",
          description: 'Maximum number of files to return per knowledge base source (default: 100). Use with offset for pagination.'
        },
        offset: {
          type: "number",
          description: 'Number of files to skip within each knowledge base source (default: 0). Use with limit for pagination.'
        },
        kb_type: {
          type: "string",
          enum: ["google-drive", "private", "public", "clickup", "clickup-tasks", "foreplay-swipefile", "foreplay-board"],
          description: 'Filter to only return a specific type of knowledge base. Omit to return all types.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listKnowledgeBaseFiles(context?.userId, {
      modified_after: args?.modified_after,
      modified_before: args?.modified_before,
      limit: args?.limit,
      offset: args?.offset,
      kb_type: args?.kb_type,
    });
  }
});

emmaToolRegistry.register({
  name: "read_knowledge_base_files",
  definition: {
    name: "read_knowledge_base_files",
    description: 'Read one or more knowledge base files. Each entry requires a knowledge base identifier (kb_identifier) and a file name (file_name). For Google Drive shared folders, use the identifier from list_knowledge_base_files (e.g., "gdrive:FOLDER_ID") and the file name. For ClickUp docs, use the identifier (e.g., "clickup:WORKSPACE_ID") and the doc name. Public knowledge base files can be accessed by any user, while private files require ownership. Returns the content for each requested file.',
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: 'array',
          description: 'List of files to read',
          items: {
            type: 'object',
            properties: {
              kb_identifier: {
                type: 'string',
                description: 'Knowledge base identifier (taskId)'
              },
              file_name: {
                type: 'string',
                description: 'Name of the file to read (e.g., knowledge-base.txt or uploaded filename)'
              }
            },
            required: ['kb_identifier', 'file_name']
          }
        }
      },
      required: ["files"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.readKnowledgeBaseFiles(args.files, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_knowledge_base',
  definition: {
    name: 'create_knowledge_base',
    description: 'Create a new knowledge base with initial content. This creates a new task with a knowledge base file. Use this when the user wants to start a new knowledge base for research, documentation, or data collection. Returns the new taskId which can be used with update_knowledge_base_file and attach_knowledge_base_files.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new knowledge base (e.g., "Market Research Q1", "Competitor Analysis")'
        },
        content: {
          type: 'string',
          description: 'Initial content to write to the knowledge base'
        },
        knowledgeBaseType: {
          type: 'string',
          enum: ['public', 'private'],
          description: 'Whether the knowledge base is public or private. Default: private'
        }
      },
      required: ['name', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.createKnowledgeBase(
      args.name,
      args.content,
      args.knowledgeBaseType || 'private',
      context.userId,
      context.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'update_knowledge_base_file',
  definition: {
    name: 'update_knowledge_base_file',
    description: 'Update or append content to a specific file in a task\'s knowledge base. Use this to save information that should persist across executions, like research findings, data collected, or documentation. The user must own the task to update its knowledge base. IMPORTANT: Use list_knowledge_base_files first to see available knowledge bases and their identifiers (taskIds). Use fileName "knowledge-base.txt" for the main knowledge base file, or specify an attached file\'s name.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID (kb_identifier) whose knowledge base to update. Get this from list_knowledge_base_files.'
        },
        fileName: {
          type: 'string',
          description: 'The name of the file to update. Use "knowledge-base.txt" for the main KB file, or the filename of an attached file. If the file does not exist, a new one will be created.'
        },
        content: {
          type: 'string',
          description: 'The content to write to the file'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'Whether to replace the entire file or append to it. Default: append'
        }
      },
      required: ['taskId', 'fileName', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.updateKnowledgeBaseFile(
      args.taskId,
      args.fileName,
      args.content,
      args.mode || 'append',
      context.userId,
      context.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'attach_knowledge_base_files',
  definition: {
    name: 'attach_knowledge_base_files',
    description: 'Attach one or more files to a task\'s knowledge base. Use this to save multiple pieces of content as separate named files. The user must own the task. IMPORTANT: Use list_knowledge_base_files first to see available knowledge bases and their identifiers (taskIds).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID (kb_identifier) to attach files to. Get this from list_knowledge_base_files.'
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filename for the attached file (e.g., "research-summary.txt", "competitor-data.csv")'
              },
              content: {
                type: 'string',
                description: 'The file content'
              }
            },
            required: ['name', 'content']
          },
          description: 'Array of files to attach, each with a name and content'
        }
      },
      required: ['taskId', 'files']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.attachKnowledgeBaseFiles(
      args.taskId,
      args.files,
      context.userId,
      context.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'write_clickup_doc',
  definition: {
    name: 'write_clickup_doc',
    description: 'Create a new document in the user\'s ClickUp workspace. Use this when the user wants to save content (research, reports, documentation) directly to ClickUp. The workspace_id can be obtained from list_knowledge_base_files (ClickUp entries have identifiers like "clickup:WORKSPACE_ID"). To place content inside an existing ClickUp doc (e.g. a doc that acts as a folder/container), pass parent_doc_id using the docId from list_knowledge_base_files. NOTE: ClickUp task-hierarchy folders (clickup-folder: entries) cannot be used as doc parents — only existing doc IDs work.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'ClickUp workspace ID (get from list_knowledge_base_files, e.g., the part after "clickup:" in the identifier)'
        },
        name: {
          type: 'string',
          description: 'Document or page title'
        },
        content: {
          type: 'string',
          description: 'Document content (markdown)'
        },
        parent_doc_id: {
          type: 'string',
          description: 'Optional: ID of an existing ClickUp doc to create this content inside as a page. Get the docId from list_knowledge_base_files (each file entry under a "clickup:" knowledge base has a docId). If omitted, the document is created at the workspace root.'
        }
      },
      required: ['workspace_id', 'name', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) {
      throw new Error("Missing user context");
    }
    return await agentModeService.writeClickUpDoc(
      args.workspace_id,
      args.name,
      args.content,
      context.userId,
      args.parent_doc_id
    );
  }
});

emmaToolRegistry.register({
  name: "read_file_content",
  definition: {
    name: "read_file_content",
    description: 'Read and extract text content from a file URL. Supports text files, PDFs, HTML, Markdown, CSV, Excel/XLSX spreadsheets, Word documents (docx, doc), and other common formats. Do NOT use this for image files (jpg, jpeg, png, gif, webp, svg) — use describe_image instead. Do NOT use this for video files (mp4, mov, avi, webm, mkv) — use describe_video instead.',
    inputSchema: {
      type: "object",
      properties: {
        file_url: {
          type: 'string',
          description: 'The URL of the file to read and extract content from'
        }
      },
      required: ["file_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.readFileContent(args.file_url);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

emmaToolRegistry.register({
  name: "read_page_source",
  definition: {
    name: "read_page_source",
    description: 'Read and extract the HTML source code from any webpage URL. By default returns raw HTML. When extractDesignTokens is true, uses a headless browser to extract CSS design tokens (colors, typography, visual effects), brand identity (logo, name, tagline), and suggested brand tokens. Use extractDesignTokens when the user wants to extract design elements or brand identity from a website.',
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to read and extract HTML source from'
        },
        extractDesignTokens: {
          type: 'boolean',
          description: 'When true, extracts CSS design tokens, brand identity, and suggested brand tokens in addition to HTML. Use update_brand_guidelines to apply the suggested tokens. Default: false'
        }
      },
      required: ["url"]
    }
  },
  execute: async (args: any, context?: any) => {
    // If extractDesignTokens is true, use CSS extraction
    if (args.extractDesignTokens) {
      return await agentModeService.extractCSSFromURL(args, context?.userId);
    }

    // Default: read raw HTML
    const result = await agentModeService.readFileContent(args.url);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

// --- Tools from utilityTools.ts ---
emmaToolRegistry.register({
  name: "analyze_crm_data",
  definition: {
    name: "analyze_crm_data",
    description: "Analyze CRM lead data and email engagement metrics (open rate, bounce rate, click rate, top leads, trends, etc.) using AI-powered code execution. Fetches all leads and email events for the specified list, then runs analysis per the instruction. Data files are cached for 30 minutes so repeated analysis on the same list is fast.",
    inputSchema: {
      type: "object",
      properties: {
        list_id: {
          type: "string",
          description: "The CRM lead list ID to analyze"
        },
        instruction: {
          type: "string",
          description: "What to analyze or compute from the CRM data (e.g. 'Calculate open rate, click rate, and bounce rate', 'Which leads are most engaged?', 'Show email activity trend by week')"
        },
        time_range_days: {
          type: "number",
          description: "Optional: limit email events to the last N days (e.g. 30, 90). Defaults to all-time if omitted."
        }
      },
      required: ["list_id", "instruction"]
    }
  },
  execute: async (args: any, context?: any) => {
    const { mcpFetch } = await import('../mcp/server/httpClient');
    const ctx = { userId: context?.userId, agentUserId: context?.agentUserId, isDelegatedAccess: context?.isDelegatedAccess };
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/crm/lists/${args.list_id}/analyze`,
      body: { instruction: args.instruction, time_range_days: args.time_range_days },
      context: ctx,
      timeoutMs: 5 * 60 * 1000, // 5 min — Gemini code execution can take a while
    });
    return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
  }
});

emmaToolRegistry.register({
  name: "perform_data_analysis",
  definition: {
    name: "perform_data_analysis",
    description: 'Perform data analysis with code execution on files from URLs. IMPORTANT: The code execution runs in a remote isolated sandbox with no access to local files, tool response paths, or any previous context. All data must be provided either via file_urls (S3 URLs) or embedded directly in analysis_instruction. If data from a previous tool call is too large to embed inline, first save it using the save_file tool to get an S3 URL, then pass that URL in file_urls.',
    inputSchema: {
      type: "object",
      properties: {
        file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of S3 or HTTPS file URLs to fetch and analyze. Use this for large datasets — save data via save_file first to get a URL if needed.'
        },
        analysis_instruction: {
          type: 'string',
          description: 'The analysis task and any small inline datasets. Do NOT reference local file paths or tool-response paths — the sandbox cannot access them. For large datasets use file_urls instead.'
        }
      },
      required: ['file_urls', 'analysis_instruction']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.performDataAnalysis(args.file_urls, args.analysis_instruction, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "create_html_file",
  definition: {
    name: "create_html_file",
    description: "Create a well-formatted, standalone HTML document and return it as a file (S3 URL) the user can preview, download, or send. Use this for a ONE-OFF email or newsletter in HTML format, a report, weekly summary, performance analysis, audit, GTM plan, or any structured HTML document that is NOT a blog article. This is the right tool whenever the user wants to draft, build, preview, or send a specific HTML email/newsletter/document — i.e. a finished piece of content, NOT a reusable template. For an email or newsletter, set document_type to 'email' so the output is email-client-safe (table layout, inline CSS). For a REUSABLE, SAVED email template with {{variable}} placeholders stored in the Templates library, use create_html_template instead. For blog articles intended for CMS publishing, use create_blog_article instead. For a deployable landing page with a public URL hosted on Vercel, use generate_landing_page instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          'x-aliases': ['file_name', 'filename', 'name', 'headline', 'subject'],
          description: "Title of the HTML document, or the subject/headline for an email (e.g. 'Aquila May 2026 Newsletter'). Required."
        },
        content_draft: {
          type: "string",
          'x-aliases': ['html_content', 'content', 'body', 'text', 'markdown', 'document_content'],
          description: "The full content to include. Include all data, scores, analysis, and text sections. Required."
        },
        format_requirements: { type: "string", description: "Optional additional formatting instructions (e.g. 'use dark theme', 'include charts', 'brand color #1a73e8', 'add a CTA button to book a demo')." },
        document_type: { type: "string", enum: ["document", "email"], description: "Optional. Use 'email' for a one-off newsletter/marketing email so the HTML is email-client-safe (table-based layout, inline CSS, 600px container, no JS). Use 'document' (default) for reports, summaries, audits, and other web-style documents." }
      },
      required: ["title", "content_draft"]
    }
  },
  execute: async (args: any, context?: any) => {
    const documentType = args.document_type === 'email' ? 'email' : 'document';
    return await agentModeService.createHtmlFile(args.title, args.content_draft, args.format_requirements || '', context?.userId, context?.sessionId, documentType);
  }
});

emmaToolRegistry.register({
  name: "create_html_template",
  definition: {
    name: "create_html_template",
    description: "Create a REUSABLE email template and SAVE it to the user's Templates library, parameterized with {{variable}} placeholders (e.g. {{user_name}}, {{items_n}}) for dynamic content. ONLY use this when the user EXPLICITLY asks to create or save a reusable template they can reuse later with different data. Do NOT use this to draft, build, preview, or send a one-off email or newsletter — that is a finished HTML document, so use create_html_file instead (it does NOT save anything to the Templates library). NOTE: Do NOT use this to create a new landing page from scratch — use generate_landing_page for deployable landing pages hosted on Vercel.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "Optional ID of an existing template to update. If provided, the template with this ID will be updated."
        },
        html_source: {
          type: "string",
          description: "Either an S3 URL to an HTML file, or raw HTML content string"
        },
        template_name: {
          type: "string",
          description: "Unique name for this template (e.g., 'welcome_email', 'product_landing_page')"
        },
        subject: {
          type: "string",
          description: "Email subject line (only required for email templates). Can include variables like {{user_name}}"
        },
        additional_instructions: {
          type: "string",
          description: "Optional instructions for how to process the HTML (e.g., 'Add variables for company name and logo', 'Make it more professional', 'Convert product list to array variables')"
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Template types, e.g. ['email'], ['landing_page'], or ['email', 'landing_page']. Defaults to ['email']."
        }
      },
      required: ["html_source", "template_name"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createHtmlTemplate(
      args.html_source,
      args.template_id,
      args.template_name,
      args.subject,
      args.additional_instructions || '',
      context?.userId,
      context?.sessionId,
      args.types
    );
  }
});

emmaToolRegistry.register({
  name: "save_file",
  definition: {
    name: "save_file",
    description: 'Create and save a file with the provided content to S3, then return the file URL for sharing or reference. IMPORTANT: You must provide the COMPLETE file content as a string in the file_content parameter. This tool does NOT retrieve previously generated content - you must include the full content in this call.',
    inputSchema: {
      type: "object",
      properties: {
        file_name: {
          type: 'string',
          description: 'Name of the file to create (include appropriate extension like .txt, .md, .json, .csv, etc.)'
        },
        file_content: {
          type: 'string',
          description: 'REQUIRED: The complete content of the file to save as a string. You must provide the full file content - this tool cannot retrieve content from previous operations.'
        }
      },
      required: ["file_name", "file_content"]
    }
  },
  execute: async (args: any, context?: any) => {
    // Log parameters for debugging
    console.log('save_file tool called with args:', {
      file_name: args.file_name,
      file_content_type: typeof args.file_content,
      file_content_length: args.file_content?.length,
      has_file_content: args.file_content !== undefined,
      all_arg_keys: Object.keys(args)
    });

    return await agentModeService.saveFile(args.file_name, args.file_content, context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'convert_to_pdf',
  definition: {
    name: 'convert_to_pdf',
    description: 'Convert an HTML file (or any URL) to a PDF and upload it to S3. Use this when the user wants a PDF version of a previously generated HTML file or checklist. Pass the direct S3 URL of the HTML file as source_url. Orientation is auto-detected (a wide 16:9 slide deck prints landscape, a report prints portrait); only set orientation explicitly to override.',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: {
          type: 'string',
          description: 'The URL of the HTML file to convert to PDF (e.g. an S3 URL from a previously saved HTML file)',
        },
        output_filename: {
          type: 'string',
          description: 'Desired filename for the PDF (without extension, e.g. "sentriq-readiness-checklist-v5")',
        },
        orientation: {
          type: 'string',
          enum: ['auto', 'portrait', 'landscape'],
          description: 'Page orientation. "auto" (default) detects landscape vs portrait from the content; use "landscape" to force it for a slide deck/presentation, "portrait" for a document.',
        },
        format: {
          type: 'string',
          enum: ['A4', 'Letter', 'Legal', 'A3', 'A5', 'Tabloid'],
          description: 'Paper size. Defaults to A4.',
        },
      },
      required: ['source_url', 'output_filename'],
    },
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.convertToPdf(args.source_url, args.output_filename, context?.userId, {
      orientation: args.orientation,
      format: args.format,
    });
  },
});

// --- Tools from workflowTools.ts ---
emmaToolRegistry.register({
  name: 'create_work_plan',
  definition: {
    name: 'create_work_plan',
    description: 'Create a multi-step work plan for the current chat session. Use this to organize complex projects like client onboarding, campaign planning, or content creation workflows. IMPORTANT: Check if a work plan already exists in the session context before creating a new one. If a work plan already exists, use modify_work_plan instead to add or update steps.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the work plan (e.g., "Client Onboarding", "Q1 Campaign")'
        },
        steps: {
          type: 'array',
          description: 'Array of steps in the plan, each with stepCount (starting from 1), title, and optional description',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number starting from 1'
              },
              title: {
                type: 'string',
                description: 'Step title'
              },
              description: {
                type: 'string',
                description: 'Optional detailed description of the step'
              },
              requiredFunctionCalls: {
                type: 'array',
                description: 'Optional array of function names that must be called before marking this step as completed',
                items: {
                  type: 'string'
                }
              },
              expectedAssetCount: {
                type: 'number',
                description: 'Optional. For a step that must produce a specific number of media assets (e.g. "generate 18 images"), set this to that number. The step then cannot be marked completed until that many images/videos have actually been generated this session — preventing the step from being closed with only some assets produced. Omit for steps with no fixed asset count.'
              }
            },
            required: ['stepCount', 'title']
          }
        },
        autocomplete: {
          type: 'boolean',
          description: 'When true, Emma runs all steps automatically without pausing to ask the user for confirmation between steps. Defaults to false (Emma will present results after each step and wait for user approval before proceeding).'
        }
      },
      required: ['title', 'steps']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createWorkPlan(args.title, args.steps, context?.sessionId, args.autocomplete);
  }
});

// Note: the listing tool for templates is `list_predefined_work_plans`, registered
// in mcp/server/apiTools.ts. It is role-aware — non-admins get published/launchable
// templates (system/public + their private), admins get the full management list.

emmaToolRegistry.register({
  name: 'launch_predefined_work_plan',
  definition: {
    name: 'launch_predefined_work_plan',
    description: 'Launch (instantiate) a predefined work plan template into the current chat session. Use this when the user picks a template returned by list_predefined_work_plans. This copies the template\'s steps into the session as a fresh work plan (all pending), installs any skills the plan needs, and applies its settings, so you can then guide the user through the steps. If a work plan is already active in this session, the call returns requiresConfirmation — confirm with the user, then call again with force=true to replace it.',
    inputSchema: {
      type: 'object',
      properties: {
        planTitle: {
          type: 'string',
          description: 'The exact title (or planId) of the work plan template to launch, as returned by list_predefined_work_plans.'
        },
        force: {
          type: 'boolean',
          description: 'Set to true to replace an existing active work plan in this session. Only do this after the user confirms.'
        }
      },
      required: ['planTitle']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.applyPredefinedWorkPlan(args.planTitle, context?.sessionId, context?.userId, { force: args.force === true });
  }
});

emmaToolRegistry.register({
  name: 'modify_work_plan',
  definition: {
    name: 'modify_work_plan',
    description: 'Add new steps or modify existing step details in the current work plan. Does not change step status - use set_work_plan_status for that.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Array of steps to add or update',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number'
              },
              title: {
                type: 'string',
                description: 'Step title'
              },
              description: {
                type: 'string',
                description: 'Optional detailed description'
              },
              requiredFunctionCalls: {
                type: 'array',
                description: 'Optional array of function names that must be called before marking this step as completed',
                items: {
                  type: 'string'
                }
              },
              expectedAssetCount: {
                type: 'number',
                description: 'Optional. Number of media assets the step must produce before it can be completed. Set to a lower number (or 0 to remove the requirement entirely) when the user explicitly approves generating fewer assets than originally planned. Omitting it leaves the existing value unchanged.'
              }
            },
            required: ['stepCount', 'title']
          }
        },
        removeStepCounts: {
          type: 'array',
          description: 'Optional array of step numbers to remove',
          items: {
            type: 'number'
          }
        },
        autocomplete: {
          type: 'boolean',
          description: 'Optional. Update the autocomplete setting. When true, Emma runs all steps automatically without asking for user confirmation between steps.'
        }
      },
      required: ['steps']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.modifyWorkPlan(args.steps, args.removeStepCounts || [], context?.sessionId, args.autocomplete);
  }
});

emmaToolRegistry.register({
  name: 'set_work_plan_status',
  definition: {
    name: 'set_work_plan_status',
    description: 'Update the status of one or more steps in the work plan. Use this to track progress as you complete steps. You can update multiple steps at once.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Array of step status updates',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number to update (1, 2, 3, etc.)'
              },
              status: {
                type: 'string',
                enum: ['pending', 'completed', 'skipped'],
                description: 'New status for the step'
              },
              notes: {
                type: 'string',
                description: 'Optional notes about what was accomplished or why the step was skipped'
              }
            },
            required: ['stepCount', 'status']
          }
        }
      },
      required: ['updates']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.setWorkPlanStatus(args.updates, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'send_for_review',
  definition: {
    name: 'send_for_review',
    description: 'Send the generated result content to the configured reviewer for approval. Sends a review email with a link to view and send the final result. You MUST call this after generating the content.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Email subject line for the result.'
        },
        content_url: {
          type: 'string',
          description: 'Optional URL to the generated content (e.g., S3 link to HTML file, image, or video).'
        },
        content_html: {
          type: 'string',
          description: 'Optional inline HTML content to include in the email body.'
        }
      },
      required: ['subject']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.sendForReview(
      args.subject,
      context.sessionId,
      context.userId,
      args.content_url,
      args.content_html
    );
  }
});

// ── Email Tool (unified, multi-provider) ───────────────────────────────────

emmaToolRegistry.register({
  name: 'email',
  definition: {
    name: 'email',
    description:
      'Read, search, and send emails across connected email accounts (Gmail, and more providers in the future). ' +
      'Always call list_connected_accounts first to get the account_id for the user\'s email account. ' +
      'NOTE: this tool requires a CONNECTED Gmail account. To send a one-off email when the user has NO connected Gmail account but HAS a configured sender (CRM → Senders), use send_email_from_sender instead. ' +
      'Actions:\n' +
      '  \u2022 search \u2014 find emails by query. Gmail syntax: "from:alice@example.com subject:invoice newer_than:7d is:unread has:attachment"\n' +
      '  \u2022 list   \u2014 list recent emails from a folder (INBOX, SENT, TRASH, SPAM, or custom label)\n' +
      '  \u2022 get    \u2014 read full body of one or more emails using message_ids from search/list results\n' +
      '  \u2022 send   \u2014 send a new email or reply to an existing thread',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Email account ID from list_connected_accounts (e.g. the user\'s Gmail address)'
        },
        action: {
          type: 'string',
          enum: ['search', 'list', 'get', 'send'],
          description: 'Action to perform: search, list, get, or send'
        },
        query: {
          type: 'string',
          description: 'search action only \u2014 provider-specific search query. Gmail: "from:alice@example.com subject:invoice newer_than:7d"'
        },
        folder: {
          type: 'string',
          description: 'list action only \u2014 folder or label to list. Defaults to INBOX. Gmail examples: INBOX, SENT, TRASH, SPAM, or a custom label name'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'get action only \u2014 one or more message IDs from search or list results. Pass all IDs you need in one call.'
        },
        max_results: {
          type: 'number',
          description: 'search/list actions \u2014 max emails to return (default 10 for search, 20 for list, max 50)'
        },
        to: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'send action \u2014 recipient email address(es)'
        },
        subject: {
          type: 'string',
          description: 'send action \u2014 email subject line'
        },
        body: {
          type: 'string',
          description: 'send action \u2014 email body content (plain text by default; set is_html=true for HTML)'
        },
        cc: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'send action \u2014 CC recipient(s)'
        },
        bcc: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'send action \u2014 BCC recipient(s)'
        },
        reply_to_message_id: {
          type: 'string',
          description: 'send action \u2014 message ID to reply to. Sets the thread and In-Reply-To/References headers automatically.'
        },
        is_html: {
          type: 'boolean',
          description: 'send action \u2014 set to true if body contains HTML. Defaults to false (plain text).'
        }
      },
      required: ['account_id', 'action']
    }
  },
  execute: async (args: any, context?: any) => {
    const { bootstrapEmailProviders, resolveEmailAccount, EmailProviderError } = await import('../services/emailProviderService');

    const userId = context?.userId;
    if (!userId) throw new Error('Missing user context');

    await bootstrapEmailProviders();

    try {
      const { provider } = await resolveEmailAccount(userId, args.account_id);

      switch (args.action) {
        case 'search': {
          if (!args.query) return { error: 'search action requires a query parameter.' };
          const maxResults = Math.min(args.max_results || 10, 50);
          const results = await provider.searchEmails(userId, args.account_id, args.query, maxResults);
          if (results.length === 0) return { message: 'No emails found matching your search.' };
          return { emails: results, count: results.length };
        }

        case 'list': {
          const maxResults = Math.min(args.max_results || 20, 50);
          const results = await provider.listEmails(userId, args.account_id, args.folder || 'INBOX', maxResults);
          if (results.length === 0) return { message: 'No emails found.' };
          return { emails: results, count: results.length };
        }

        case 'get': {
          const ids: string[] = Array.isArray(args.message_ids) ? args.message_ids : [];
          if (ids.length === 0) return { error: 'get action requires a message_ids array with at least one ID.' };
          const emails = await provider.getEmails(userId, args.account_id, ids);
          return { emails, count: emails.length };
        }

        case 'send': {
          if (!args.to) return { error: 'send action requires a "to" parameter.' };
          if (!args.subject) return { error: 'send action requires a "subject" parameter.' };
          if (!args.body) return { error: 'send action requires a "body" parameter.' };
          const result = await provider.sendEmail(userId, args.account_id, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
            replyToMessageId: args.reply_to_message_id,
            isHtml: args.is_html,
          });
          return { success: true, messageId: result.messageId, threadId: result.threadId };
        }

        default:
          return { error: `Unknown action "${args.action}". Valid actions: search, list, get, send.` };
      }
    } catch (err: any) {
      // Covers every provider (Gmail, Outlook, ...) — they all extend EmailProviderError.
      if (err instanceof EmailProviderError) return { error: err.message };
      if (err.message?.includes('not found') || err.message?.includes('not an email account')) return { error: err.message };
      throw err;
    }
  }
});

// ─── Account Memory Tools ────────────────────────────────────────

emmaToolRegistry.register({
  name: 'save_memory',
  definition: {
    name: 'save_memory',
    description: 'Save a fact about this account for future sessions. Use this when you learn something important about the user, their preferences, business context, or workflow patterns. Categories: preference (user likes/dislikes), history (past actions/decisions), insight (business learnings), workflow (process patterns).',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          maxLength: 2000,
          description: 'The fact to remember (max 2000 chars). Be specific and actionable.'
        },
        category: {
          type: 'string',
          enum: ['preference', 'history', 'insight', 'workflow'],
          description: 'Category for the memory fact.'
        }
      },
      required: ['content', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { userDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    if (user?.memoryEnabled === false) {
      return { success: false, message: 'Memory is disabled for this account.' };
    }

    // Embed at write time so the memory can later be retrieved by relevance, not just
    // recency. Best-effort: a failure must not block saving (read path falls back to recency).
    const { embedText } = await import('../utils/embeddings');
    const embedding = (await embedText(args.content, { userId, feature: 'embeddings' })) ?? undefined;
    const memory = await accountMemoryDb.addMemory(
      userId,
      args.category,
      args.content,
      context?.sessionId,
      embedding
    );
    return {
      success: true,
      memoryId: memory.memoryId,
      message: `Saved memory: "${args.content.substring(0, 80)}${args.content.length > 80 ? '...' : ''}"`
    };
  }
});

emmaToolRegistry.register({
  name: 'delete_memory',
  definition: {
    name: 'delete_memory',
    description: 'Delete a specific memory by its ID. Use this when a fact is no longer accurate or relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          description: 'The ID of the memory to delete.'
        }
      },
      required: ['memoryId']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    await accountMemoryDb.deleteMemory(userId, args.memoryId);
    return { success: true, message: `Memory ${args.memoryId} deleted.` };
  }
});

// ─── Org Memory Tools ────────────────────────────────────────

emmaToolRegistry.register({
  name: 'save_org_memory',
  definition: {
    name: 'save_org_memory',
    description: 'Save a fact about this organization for all org members to share in future sessions. Use this when you learn something important about the company, its strategy, shared workflows, or team preferences that every member should know. Categories: preference (team likes/dislikes), history (past decisions), insight (business learnings), workflow (shared process patterns).',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The org-wide fact to remember (max 2000 chars). Be specific and actionable.'
        },
        category: {
          type: 'string',
          enum: ['preference', 'history', 'insight', 'workflow'],
          description: 'Category for the memory fact.'
        }
      },
      required: ['content', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { userDb, orgDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) {
      return { success: false, message: 'User is not a member of any organization.' };
    }

    const org = await orgDb.getOrgById(user.orgId);
    if (!org) {
      return { success: false, message: 'Organization not found.' };
    }
    if (org.orgMemoryEnabled === false) {
      return { success: false, message: 'Organization memory is disabled.' };
    }

    // Embed at write time so the memory can later be retrieved by relevance (best-effort).
    const { embedText } = await import('../utils/embeddings');
    const embedding = (await embedText(args.content, { userId, feature: 'embeddings' })) ?? undefined;
    const memory = await orgMemoryDb.addMemory(
      user.orgId,
      args.category,
      args.content,
      userId,
      embedding
    );
    return {
      success: true,
      memoryId: memory.memoryId,
      message: `Saved org memory: "${args.content.substring(0, 80)}${args.content.length > 80 ? '...' : ''}"`
    };
  }
});

emmaToolRegistry.register({
  name: 'delete_org_memory',
  definition: {
    name: 'delete_org_memory',
    description: 'Delete a specific org memory by its ID. Use this when an org-wide fact is no longer accurate or relevant. Only org owners can delete org memories.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          description: 'The ID of the org memory to delete.'
        }
      },
      required: ['memoryId']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { userDb, orgDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) {
      return { success: false, message: 'User is not a member of any organization.' };
    }

    const org = await orgDb.getOrgById(user.orgId);
    if (!org) {
      return { success: false, message: 'Organization not found.' };
    }
    if (!can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:configure")) {
      return { success: false, message: 'Only org owners and admins can delete org memories.' };
    }

    await orgMemoryDb.deleteMemory(user.orgId, args.memoryId);
    return { success: true, message: `Org memory ${args.memoryId} deleted.` };
  }
});

emmaToolRegistry.register({
  name: 'account_summary',
  definition: {
    name: 'account_summary',
    description: 'Get a full account overview. Returns: (1) account state — connected account count, knowledge base file count, saved config count, task count, active schedule count; (2) activity over the time period — sessions, assets (images, videos, reports, social posts, blogs), and results (published count, leads added, email delivery/clicks/replies/bounced, social media posts published/impressions/engagements/clicks).',
    inputSchema: {
      type: 'object',
      properties: {
        time_range: {
          type: 'string',
          enum: ['1d', '7d', '30d', '90d'],
          description: 'Time range for the summary. Defaults to 7d.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const timeRange = args.time_range || '7d';
    return await getAccountSummary(userId, timeRange);
  }
});

// --- SEO & Analytics Tools ---
emmaToolRegistry.register({
  name: 'get_seo_metrics',
  definition: {
    name: 'get_seo_metrics',
    description: 'Get SEO metrics for the user\'s configured domains. Returns Google Search Console data (clicks, impressions, CTR, average position, top queries, top pages, daily trends) and technical SEO score (PageSpeed). If the user has multiple domains configured, returns metrics for all domains unless a specific domain is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          enum: ['7d', '14d', '30d', '90d'],
          description: 'Time period for metrics. Default: 30d'
        },
        domain: {
          type: 'string',
          description: 'Specific domain to fetch metrics for (e.g. "example.com"). If omitted, returns metrics for all configured domains.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { fetchSearchConsoleMetrics } = await import('../services/seoService');
    return await fetchSearchConsoleMetrics(userId, args.timeframe || '30d', args.domain);
  }
});

emmaToolRegistry.register({
  name: 'get_website_analytics',
  definition: {
    name: 'get_website_analytics',
    description: 'Get Google Analytics (GA4) website analytics data. Returns sessions, users, page views, bounce rate, average session duration, traffic sources (with conversion counts per source/medium), a conversion breakdown by traffic source and event name (conversionsBySource), top pages by engagement, and daily trends. Use conversionsBySource for UTM-source-level attribution of form fills and other conversion events. Its conversion counts are historical — they show which events were counted as conversions when they were collected, not which events are currently marked as key events (GA4 key-event changes are not retroactive); this tool cannot read key-event configuration, so never infer it from this data. If the user has multiple GA4 properties configured, returns analytics for all properties unless a specific property is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          enum: ['7d', '14d', '30d', '90d'],
          description: 'Time period for analytics. Default: 30d'
        },
        property_id: {
          type: 'string',
          description: 'Specific GA4 property ID to fetch analytics for (e.g. "123456789"). If omitted, returns analytics for all configured properties.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { fetchGoogleAnalyticsMetrics } = await import('../services/seoService');
    return await fetchGoogleAnalyticsMetrics(userId, args.timeframe || '30d', args.property_id);
  }
});

emmaToolRegistry.register({
  name: 'get_clarity_metrics',
  definition: {
    name: 'get_clarity_metrics',
    description: 'Get Microsoft Clarity project information and dashboard links for the user\'s configured projects. Returns project IDs, labels, and direct links to Clarity dashboards. If the user has multiple Clarity projects, returns info for all unless a specific project is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Specific Clarity project ID to get info for. If omitted, returns info for all configured projects.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { fetchClarityProjectInfo } = await import('../services/seoService');
    return await fetchClarityProjectInfo(userId, args.project_id);
  }
});

// ─── CRM Enrichment tools ────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'enrich_leads_preview',
  definition: {
    name: 'enrich_leads_preview',
    description: `Preview a CRM lead enrichment job before running the full batch. Runs the V3 enrichment engine in preview mode on 2 sample leads and returns what it would produce.

Returns: runId, processedCount (the 2 sampled leads), and samples — each with leadId, enrichedFields, and unverifiedFields. In enrichedFields a missing value means nothing was found; tell the user "not found" rather than showing null. Show the samples and ask the user to confirm before calling enrich_leads_execute.

IMPORTANT — data accuracy / unverifiedFields: unverifiedFields lists the fields in this sample whose value is low-confidence or unverified (could not be confirmed against a real fetched source). These values may be wrong — for example a small company's funding_stage guessed from the web. Do NOT state unverified values as established fact. When you present them, caveat them explicitly. Use unverifiedProvenance (a per-field map) to say WHY: "ai-knowledge" means the value came from the AI's own general knowledge with no source found (e.g. "funding_stage: Series C (unverified — from AI knowledge, no source found; please confirm)"); "web-unverified" means it came from a web source the fact-check couldn't confirm (e.g. "funding_stage: Series C (unverified — from an unconfirmed web source; please confirm)"). If a field is in unverifiedFields but not in unverifiedProvenance, caveat it generically as unverified. Fields NOT in unverifiedFields are high-confidence (verified against a real source) and can be stated plainly. If the user questions or corrects an unverified value, accept the correction gracefully and explain it came from a low-confidence source.

IMPORTANT — identity resolution failures: If processedCount is 0 and failureBreakdown.identityResolutionFailed > 0, the sampled leads could not be matched to a real person/company. The engine already attempts a contextual LinkedIn search for name-only leads using the lead list's name/description (e.g. a "YC Poker Night" list disambiguates common names), so a failure here means even that fell short for the sample. Before declaring the list unenrichable: (1) if the leads have at least a full name but no email/LinkedIn/company, a contextual LinkedIn search needs a connected LinkedIn account — if the user has none, tell them connecting one (or adding email/LinkedIn/company to the list) would let enrichment resolve these leads; (2) the list name/description is the disambiguation signal, so a vague list name reduces match rate. If the leads truly lack any full name (only partial data), the list is genuinely unenrichable — tell the user clearly and do NOT call enrich_leads_execute for it. Otherwise, surface the above options rather than flatly refusing. Skip it and continue with the other lists either way.

"Enrich all lists" workflow: When the user asks to enrich multiple or all lists at once, preview each list first (you may run all previews sequentially without waiting for per-list confirmation). After all previews complete, summarize which lists passed (processedCount > 0) and which are unenrichable (processedCount === 0 with identityResolutionFailed > 0). If the user already confirmed they want all lists enriched, proceed to call enrich_leads_execute for each passing list without asking again per list — only pause if a list has an unexpected issue.

output_fields guidance: one entry per distinct data point. Each entry has a snake_case "name", an "instruction" (what to find / where it lives), and an optional "overwrite_policy". Numeric values, categorical values, URLs, and prose summaries each get their own field. The engine routes data sources (Apollo, LinkedIn, web search) automatically — you do not specify sources. If the result includes fieldRemaps, tell the user which requested fields were mapped onto existing CRM columns to avoid duplicates.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The CRM lead list ID to enrich.' },
        output_fields: {
          type: 'array',
          minItems: 1,
          description: 'Fields to populate. One entry per distinct data point.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Custom field name in snake_case, e.g. "funding_stage".' },
              instruction: { type: 'string', description: 'Natural-language description of what to find for this field.' },
              overwrite_policy: {
                type: 'string',
                enum: ['fill_if_empty', 'always_overwrite'],
                description: 'fill_if_empty (default): only set the field when it is currently empty. always_overwrite: refresh even when a value already exists.',
              },
            },
            required: ['name', 'instruction'],
          },
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. When provided, the 2 preview samples are drawn from this subset.',
        },
      },
      required: ['list_id', 'output_fields'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { runEmmaEnrichment, pickPreviewLeadIds } = await import('./enrichmentToolRunner');
    const leadIds = await pickPreviewLeadIds(args.list_id, args.lead_ids);
    const summary = await runEmmaEnrichment({
      listId: args.list_id,
      userId: context.userId,
      outputFields: args.output_fields,
      mode: 'preview',
      leadIds,
      socketId: context.socketId,
      socketEmit: context.socketEmit,
    });
    return summary;
  },
});

emmaToolRegistry.register({
  name: 'enrich_leads_execute',
  definition: {
    name: 'enrich_leads_execute',
    description: `Execute a CRM lead enrichment job on the V3 engine. Processes the list's leads in parallel, enriching the requested fields from Apollo, LinkedIn, and web search automatically.

Progress updates stream via Socket.IO. This call blocks until the job completes, then returns runId, processedCount, failedCount, and failureBreakdown.

Call enrich_leads_preview first. For a single-list enrichment, ask the user to confirm after the preview before executing. For a multi-list "enrich all" request where the user has already expressed intent to enrich, proceed directly to execute each list that had processedCount > 0 in its preview — no per-list re-confirmation needed. Do NOT call this for any list whose preview returned processedCount === 0 with identityResolutionFailed > 0. Pass the same output_fields used in the preview. Large lists are capped — if the list is over the limit, narrow it with lead_ids or tell the user to run a full enrichment from the CRM page. If the result includes fieldRemaps, tell the user which requested fields were mapped onto existing CRM columns to avoid duplicates.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The CRM lead list ID to enrich.' },
        output_fields: {
          type: 'array',
          minItems: 1,
          description: 'Fields to populate. One entry per distinct data point.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Custom field name in snake_case.' },
              instruction: { type: 'string', description: 'Natural-language description of what to find for this field.' },
              overwrite_policy: {
                type: 'string',
                enum: ['fill_if_empty', 'always_overwrite'],
                description: 'fill_if_empty (default): only set the field when empty. always_overwrite: refresh even when a value exists.',
              },
            },
            required: ['name', 'instruction'],
          },
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of lead IDs to enrich. Omit to enrich the whole list.',
        },
      },
      required: ['list_id', 'output_fields'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { runEmmaEnrichment, resolveExecuteLeadIds } = await import('./enrichmentToolRunner');
    const { getEmmaEnrichMaxLeads } = await import('./enrichmentToolConfig');
    const { leadIds, count } = await resolveExecuteLeadIds(args.list_id, args.lead_ids);
    if (count === 0) {
      throw new Error('This list has no leads to enrich.');
    }
    const max = getEmmaEnrichMaxLeads();
    if (count > max) {
      throw new Error(
        `This run targets ${count} leads, over the ${max}-lead limit for enrichment through chat. ` +
        `Narrow it with lead_ids, or run a full enrichment from the CRM page's Enrichment Config.`,
      );
    }
    const summary = await runEmmaEnrichment({
      listId: args.list_id,
      userId: context.userId,
      outputFields: args.output_fields,
      mode: 'enrich',
      leadIds,
      socketId: context.socketId,
      socketEmit: context.socketEmit,
    });
    enqueueLeadEnrichmentEval({
      summary,
      userId: context.userId,
      sessionId: context.sessionId,
      listId: args.list_id,
      leadIds,
      outputFields: args.output_fields,
      toolName: 'enrich_leads_execute',
    });
    return summary;
  },
});

emmaToolRegistry.register({
  name: 'enrich_lead_custom',
  definition: {
    name: 'enrich_lead_custom',
    description: `Enrich a single CRM lead with custom fields on demand, without running a whole-list job.

Use this when the user wants specific missing information filled on one lead (e.g. "find this person's LinkedIn headline and company size"). It runs the V3 enrichment engine on a batch of one. The response includes enrichedValues — a map of field name to the found value (null if nothing was found). Values are also persisted to the lead. Always show enrichedValues to the user; if a value is null, say nothing was found for that field. The response also includes enrichmentMetadata — a per-field provenance map (source, provider, sourceUrl/sourceQuote, confidence high/medium/low, enrichedAt, and a grounding field). Cite the source and confidence for each value, and explicitly caveat web-sourced or medium/low-confidence values (e.g. a funding stage found via web search) rather than stating them as established fact. Use grounding to be specific: "grounded" = verified against a real source (safe to state); "web-unverified" = from an unconfirmed web source; "ai-knowledge" = asserted from the AI's own general knowledge with no source found — flag these last two as unverified and name which.

output_fields: one entry per field to populate, each with a snake_case "name", an "instruction" describing what to find, and an optional "overwrite_policy" (defaults to fill_if_empty; use always_overwrite to refresh a field that already has a value). If the result includes fieldRemaps, tell the user which requested fields were mapped onto existing CRM columns to avoid duplicates.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The CRM lead list ID containing the lead.' },
        lead_id: { type: 'string', description: 'The specific lead to enrich.' },
        output_fields: {
          type: 'array',
          minItems: 1,
          description: 'Fields to populate on this lead.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Custom field name in snake_case.' },
              instruction: { type: 'string', description: 'Natural-language description of what to find for this field.' },
              overwrite_policy: {
                type: 'string',
                enum: ['fill_if_empty', 'always_overwrite'],
                description: 'fill_if_empty (default): only set the field when empty. always_overwrite: refresh even when a value exists.',
              },
            },
            required: ['name', 'instruction'],
          },
        },
      },
      required: ['list_id', 'lead_id', 'output_fields'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { runEmmaEnrichment } = await import('./enrichmentToolRunner');
    const summary = await runEmmaEnrichment({
      listId: args.list_id,
      userId: context.userId,
      outputFields: args.output_fields,
      mode: 'enrich',
      leadIds: [args.lead_id],
      socketId: context.socketId,
      socketEmit: context.socketEmit,
    });
    enqueueLeadEnrichmentEval({
      summary,
      userId: context.userId,
      sessionId: context.sessionId,
      listId: args.list_id,
      leadId: args.lead_id,
      outputFields: args.output_fields,
      toolName: 'enrich_lead_custom',
    });

    // Read the lead back so we can return the actual enriched values.
    // V3 writes standard columns top-level and custom names into customFields.
    const enrichedValues: Record<string, string | null> = {};
    // Per-field provenance for the just-enriched fields — lets the agent cite
    // source/provider/confidence (and caveat web-sourced/low-confidence values)
    // instead of stating bare values. Sanitized so cross-tenant CRM-history
    // lineage never reaches the customer — mirrors get_lead_details/search_leads.
    let enrichmentMetadata: Record<string, any> | undefined;
    if (summary.processedCount > 0) {
      try {
        const { crmDb } = await import('../services/db');
        const { sanitizeEnrichmentMetadataForResponse } = await import('../utils/enrichmentMetadataPresentation');
        const lead: any = await crmDb.getLeadById(args.list_id, args.lead_id);
        const customFields = (lead?.customFields ?? {}) as Record<string, string>;
        const requestedNames = (args.output_fields as Array<{ name: string }>).map(f => f.name);
        for (const name of requestedNames) {
          enrichedValues[name] = customFields[name] ?? lead?.[name] ?? null;
        }
        const sanitized = sanitizeEnrichmentMetadataForResponse(
          lead?.enrichmentMetadata as Record<string, any> | undefined,
        );
        if (sanitized) {
          // Only surface metadata for the fields this call enriched.
          const scoped: Record<string, any> = {};
          for (const name of requestedNames) {
            if (sanitized[name] !== undefined) scoped[name] = sanitized[name];
          }
          if (Object.keys(scoped).length > 0) enrichmentMetadata = scoped;
        }
      } catch {
        // Non-fatal — enrichment succeeded, values are in the DB.
      }
    }

    return {
      leadId: args.lead_id,
      listId: args.list_id,
      enrichedValues,
      ...(enrichmentMetadata ? { enrichmentMetadata } : {}),
      runId: summary.runId,
      processedCount: summary.processedCount,
      failedCount: summary.failedCount,
      failureBreakdown: summary.failureBreakdown,
      warnings: summary.warnings,
      fieldRemaps: summary.fieldRemaps,
    };
  },
});

// ─── Scheduled Chat tools (bridged from mcpToolRegistry / apiTools.ts) ───────
// These tools wrap REST endpoints via mcpFetch. Rather than duplicating
// definitions, we re-register them from the MCP server registry.
// Ensure apiTools has registered its tools before we try to bridge them.
import '../mcp/server/apiTools';
import { mcpToolRegistry } from '../mcp/server/registry';
import { can } from "../services/orgAuthz";

// Also register get_visual_context in mcpToolRegistry (after the import above, which is needed
// for mcpToolRegistry to be available).
mcpToolRegistry.register(visualContextTool);

mcpToolRegistry.register({
  name: 'manage_linear_governance_label',
  definition: {
    name: 'manage_linear_governance_label',
    description:
      'Admin-only: read, dry-run, or update an existing allowlisted Linear routing/intake label. ' +
      'Returns verified before/after readback evidence. It cannot create, delete, or move labels and never exposes Linear credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        label_name: {
          type: 'string',
          description: 'Existing allowlisted governance label, such as Route: Emma or Needs PM.',
        },
        name: {
          type: 'string',
          description: 'Optional replacement name. It must also be an allowlisted governance label and must not already exist.',
        },
        description: {
          type: 'string',
          maxLength: 1000,
          description: 'Optional replacement description.',
        },
        color: {
          type: 'string',
          pattern: '^#[0-9A-Fa-f]{6}$',
          description: 'Optional six-digit hex color.',
        },
        reason: {
          type: 'string',
          description: 'Required audit reason for the read, dry-run, or update.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, return the exact proposed definition without mutating Linear.',
        },
      },
      required: ['label_name', 'reason'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');
    const user = await userDb.getUserById(userId);
    const delegated = context?.isDelegatedAccess === true || context?.isDelegatedAdmin === true;
    if (user?.isAdmin !== true && !delegated) {
      throw new Error('Admin access required to manage Linear governance labels');
    }
    let actor: string | undefined;
    if (delegated) {
      actor = context?.adminEmail;
      if (!actor && context?.sessionId) {
        const session = await chatbotDb.getChatSession(context.sessionId);
        if (session?.delegateInfo?.isDelegated) {
          actor = session.delegateInfo.adminEmail;
        }
      }
      if (!actor) {
        throw new Error('Delegated administrator identity unavailable');
      }
    } else {
      actor = user?.email || userId;
    }
    if (!actor) {
      throw new Error('Administrator identity unavailable');
    }
    const { manageLinearGovernanceLabel } = await import('../services/linearGovernanceLabelService');
    return manageLinearGovernanceLabel({
      labelName: args.label_name,
      name: args.name,
      description: args.description,
      color: args.color,
      reason: args.reason,
      actor,
      dryRun: args.dry_run === true,
    });
  },
});

const bridgedToolNames = [
  // Scheduled Chat tools
  'list_scheduled_chats',
  'manage_scheduled_chat',
  'test_scheduled_chat',
  'get_scheduled_chat_test_history',
  'submit_scheduled_chat_variables',
  // Schedule Template tools
  'list_schedule_templates',
  'manage_schedule_template',
  'create_schedule_from_template',
  // Landing Page tools (v0 generation + management — file editing delegated to coding_agent)
  'generate_landing_page',
  'deploy_landing_page',
  'list_landing_pages',
  'get_landing_page',
  'delete_landing_page',
  'enable_lead_list_public_access',
  'duplicate_landing_page',
  'get_deployment_status',
  // 'list_landing_page_files' — removed: coding_agent handles file listing internally
  'get_landing_page_preview_url',
  'publish_landing_page_changes',
  'revert_landing_page_publish',
  'update_landing_page_context',
  'resolve_skill',
  // Self account status (no-arg; wraps /api/auth/me for the CALLER's own account).
  // Bridged so the in-app loop can resolve the handler; also added to
  // DEFAULT_FOUNDATION_TOOLS so the loop actually offers it. Without this, Emma
  // had no self-status tool and fell back to assess_client_health (admin lookup
  // by email) — the user-reported "asked me for my email" bug.
  'get_account_status',
];

// ─── Admin-only tools (bridged from mcpToolRegistry / apiTools.ts) ───────────
const adminToolNames = [
  'manage_linear_governance_label',
  'list_predefined_work_plans',
  'manage_predefined_work_plan',
  'list_skills',
  'manage_skill',
  'get_chat_history',
  'list_all_clients',
  'assess_client_health',
  'get_pr_digest',
  'freeze_user_account',
  'manage_scoring_judges',
  'manage_user_notes',
  'get_users_by_lifecycle_stage',
  'get_registration_status',
  'resolve_landing_page_by_url',
  'share_landing_page_with_org',
  'get_landing_page_effective_view',
];

for (const toolName of bridgedToolNames) {
  const handler = mcpToolRegistry.getTool(toolName);
  if (handler) {
    emmaToolRegistry.register({
      name: handler.name,
      definition: handler.definition,
      execute: handler.execute,
    });
  } else {
    console.warn(`[emma/tools] Failed to bridge tool "${toolName}" — not found in mcpToolRegistry`);
  }
}

// ─── Coding Agent tool (sub-agent for code editing tasks) ───────────────────
emmaToolRegistry.register({
  name: 'coding_agent',
  definition: {
    name: 'coding_agent',
    description: 'Delegate a code editing task to a specialized coding agent. The coding agent pushes changes to the reusable STAGING branch draft/agentweb-preview (not directly to production). This creates a Vercel preview deployment URL for the user to review. After calling this tool, ALWAYS tell the user: (1) changes are on a staging branch and NOT live yet, (2) provide the preview URL so they can review, (3) they can ask you to "publish" to push changes live. Use this for ANY task that involves modifying landing page code. For user-visible landing-page changes, pass typed acceptance_checks that prove the requested behavior on the preview page; the backend verifier runs them after the coding agent finishes and fails or blocks the tool if they do not pass. Do not use hard-coded human-looking benchmark copy; use user-requested content or opaque tokens where a test marker is needed. If the tool fails because acceptance failed, report the failed checks and ask for the missing input or run a narrower follow-up. Only call coding_agent ONCE per user request unless it explicitly fails. LOGO TIP: Always pass logo URLs directly in the task_description — the coding agent will use them in <img src="..."> tags. For public company logos use Google\'s favicon service (https://www.google.com/s2/favicons?domain={domain}&sz=128). For the user\'s own brand logo, look it up with read_brand_guidelines first and include the URL in the task.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'string',
          'x-aliases': ['landing_page_id'],
          description: 'The landing page ID to edit'
        },
        task_description: {
          type: 'string',
          'x-aliases': ['instructions'],
          description: 'Detailed description of what code changes to make. Include specific requirements, file paths if known, and any context about the desired outcome. Be as specific as possible.'
        },
        acceptance_checks: {
          type: 'array',
          description: 'Optional deterministic checks to run against the staging preview after the coding agent finishes. Use these for landing-page edits so success means the requested behavior actually passed.',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['http_status', 'text_present', 'selector_exists', 'no_console_errors', 'no_external_hosts'],
                description: 'Typed verifier check. http_status checks URL status. text_present checks text under a selector. selector_exists checks for an element. no_console_errors fails on console errors. no_external_hosts fails on disallowed external asset hosts.'
              },
              label: { type: 'string', description: 'Short check name, e.g. "requested headline visible" or "no external font hosts".' },
              url: { type: 'string', description: 'Check URL. For browser checks, omit this to use the preview URL, or use {{previewUrl}} as a placeholder.' },
              method: { type: 'string', enum: ['GET', 'HEAD'], description: 'HTTP method for http_status checks.' },
              expectStatus: { type: 'number', description: 'Expected HTTP status for http_status checks. Defaults to 200.' },
              selector: { type: 'string', description: 'CSS selector for text_present or selector_exists checks. text_present defaults to body.' },
              text: { type: 'string', description: 'Expected text for text_present checks.' },
              allowPatterns: { type: 'array', items: { type: 'string' }, description: 'Regex patterns for no_console_errors messages that should be ignored.' },
              allowHosts: { type: 'array', items: { type: 'string' }, description: 'Allowed hostnames for no_external_hosts. Preview host is allowed automatically.' },
              denyPatterns: { type: 'array', items: { type: 'string' }, description: 'Regex hostname patterns for no_external_hosts. Defaults catch common external font/CDN hosts.' }
            },
            required: ['type']
          }
        }
      },
      required: ['page_id', 'task_description']
    }
  },
  execute: async (args: any, context?: any) => {
    const { LANDING_PAGE_PREVIEW_BRANCH, runCodingAgent } = await import('../services/codingAgentService');
    const executeMcpTool = context?.service
      ? async (toolName: string, toolArgs: any) => {
        return context.service.executeTool(
          context.llmModel || 'anthropic.claude-sonnet-4-6',
          toolName,
          toolArgs,
          context.userId,
          context.sessionId
        );
      }
      : undefined;

    // Use one reusable staging branch per landing-page repo. The coding agent
    // resets it to main at run start, preventing unbounded draft branch/PR growth.
    const sessionId = context?.sessionId || '';
    const draftBranch = LANDING_PAGE_PREVIEW_BRANCH;

    const result = await runCodingAgent(
      args.task_description,
      {
        pageId: args.page_id,
        userId: context?.userId,
        sessionId,
        llmModel: context?.llmModel || 'anthropic.claude-sonnet-4-6',
        socketEmit: context?.socketEmit,
        executeMcpTool,
        draftBranch,
        acceptanceChecks: Array.isArray(args.acceptance_checks) ? args.acceptance_checks : undefined,
      }
    );

    // Charge the coding agent's own LLM turns to the caller's monthly usage. This
    // loop makes its own (often high-cost) LLM calls that the parent agent-mode
    // meter never sees, so without this its spend escapes the per-user token/cost
    // cap (ENG-200). Fire-and-forget + fail-open: never block/fail the tool result.
    if (result.usageTotals && context?.userId) {
      const { totalTokens, costUsd } = result.usageTotals;
      incrementUserTokenUsage(context.userId, totalTokens, costUsd).catch((err: unknown) =>
        console.error('coding_agent: failed to record per-user usage:', err)
      );
    }

    if (result.success) {
      return {
        success: true,
        message: result.message,
        iterations: result.iterations,
        previewUrl: result.previewUrl,
        branch: result.branch,
        runId: result.runId,
        state: result.state,
        acceptanceStatus: result.acceptanceStatus,
        acceptance: result.acceptance,
        verification: result.verification,
        recovery: result.recovery,
        retryable: result.retryable,
        is_staging: !!result.branch && result.branch !== 'main',
        note: result.branch && result.branch !== 'main'
          ? `Changes are on staging branch "${result.branch}". The user must review the preview URL and ask to publish before changes go live.`
          : undefined,
      };
    } else {
      return {
        success: false,
        error: result.message,
        iterations: result.iterations,
        previewUrl: result.previewUrl,
        branch: result.branch,
        runId: result.runId,
        state: result.state,
        acceptanceStatus: result.acceptanceStatus,
        acceptance: result.acceptance,
        verification: result.verification,
        recovery: result.recovery,
        retryable: result.retryable,
        is_staging: !!result.branch && result.branch !== 'main',
        // Authorization denials are not retryable — the caller lacks edit rights
        // on this page. Signal the parent agent to surface the message and stop
        // re-invoking coding_agent (which previously burned several attempts).
        ...(result.notAuthorized
          ? { notAuthorized: true, retryable: false }
          : {}),
      };
    }
  }
});

// --- User Skill Creation ---
emmaToolRegistry.register({
  name: 'create_skill',
  definition: {
    name: 'create_skill',
    description: 'Create a new agent skill for the user. A skill is a named bundle of tools with an optional system prompt that customizes agent behavior. The skill starts as private and the user can submit it for platform review later via the Settings > Skills page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the skill (e.g., "LinkedIn Post Creator from Latest News")'
        },
        description: {
          type: 'string',
          description: 'Description of what the skill does'
        },
        toolNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tool names this skill can use (e.g., ["you_search_web", "create_social_media_posts"])'
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional custom instructions for the agent when this skill is active'
        }
      },
      required: ['name', 'description', 'toolNames']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error('Authentication required: no user context');
    }
    // LLMs sometimes send "tools" instead of "toolNames", and may stringify the array
    let rawTools = args.toolNames ?? args.tools ?? [];
    if (typeof rawTools === 'string') {
      try { rawTools = JSON.parse(rawTools); } catch { rawTools = []; }
    }
    const toolNames: string[] = Array.isArray(rawTools) ? rawTools : [];
    const { skillService } = await import('../services/skillService');

    // Skills are member-owned: any org member may create their own. The new
    // skill is stamped with the creator's orgId so that, when the org's skills
    // sharing toggle is enabled, it shows up in org-wide fanout.
    const { userDb } = await import('../services/db');
    const creator = await userDb.getUserById(userId);
    const orgId = creator?.orgId;

    const skill = await skillService.createSkill(
      args.name,
      args.description,
      toolNames,
      args.systemPrompt,
      false
    );
    // Set ownership fields and re-save with toolNames explicitly preserved
    skill.ownerId = userId;
    skill.visibility = 'private';
    skill.isBuiltIn = false;
    skill.toolNames = toolNames;
    if (orgId) skill.orgId = orgId;
    await skillService.updateSkill(skill);
    return {
      success: true,
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      toolNames: skill.toolNames,
      visibility: skill.visibility,
      message: `Skill "${skill.name}" created successfully. It is currently private. The user can submit it for platform review from Settings > Skills.`
    };
  }
});

emmaToolRegistry.register({
  name: 'save_work_plan',
  definition: {
    name: 'save_work_plan',
    description: 'Save a work plan to the user\'s library for future reuse. The plan starts as private and the user can submit it for platform review later via Settings > Work Plans. Use this after creating a work plan with create_work_plan when the user wants to keep it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the work plan'
        },
        description: {
          type: 'string',
          description: 'Description of what the work plan accomplishes'
        },
        welcomeMessage: {
          type: 'string',
          description: 'Optional greeting shown when the plan starts'
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepCount: { type: 'number', description: 'Step number (1-based)' },
              title: { type: 'string', description: 'Step title' },
              description: { type: 'string', description: 'Step description' },
              requiredFunctionCalls: {
                type: 'array',
                items: { type: 'string' },
                description: 'Function names that must be called to complete this step (e.g. you_search_web, update_brand_guidelines)'
              },
              skillIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Skill IDs to auto-install when this step becomes active'
              },
              expectedAssetCount: {
                type: 'number',
                description: 'Number of media assets that must have been generated in the run before this step can be completed (e.g. 18 for "generate 3 images per hook, 18 total"). Counted per run, not per step. Carried over from the session work plan when omitted.'
              },
            },
            required: ['stepCount', 'title']
          },
          description: 'Array of steps in the work plan'
        }
      },
      required: ['title', 'steps']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error('Authentication required: no user context');
    }
    const { workPlanService } = await import('../services/workPlanService');

    // If there's a session work plan, merge requiredFunctionCalls/skillIds from it
    // because the LLM often omits these when calling save_work_plan
    let sessionWorkPlan: any = null;
    if (context?.sessionId) {
      try {
        const { chatbotDb } = await import('../services/chatbotService');
        const session = await chatbotDb.getChatSession(context.sessionId);
        if (session?.workPlan) {
          sessionWorkPlan = session.workPlan;
        }
      } catch {
        // Non-critical — proceed without session data
      }
    }

    // Normalize steps
    let steps = args.steps || [];
    if (typeof steps === 'string') {
      try { steps = JSON.parse(steps); } catch { steps = []; }
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('At least one step is required');
    }

    // Build a lookup of session step data by stepCount for merging
    const sessionStepMap = new Map<number, any>();
    if (sessionWorkPlan?.steps) {
      for (const s of sessionWorkPlan.steps) {
        sessionStepMap.set(s.stepCount, s);
      }
    }

    const plan = await workPlanService.createWorkPlan({
      title: args.title,
      description: args.description || '',
      welcomeMessage: args.welcomeMessage || '',
      steps: steps.map((s: any, i: number) => {
        const stepNum = s.stepCount || i + 1;
        const sessionStep = sessionStepMap.get(stepNum);
        return {
          stepCount: stepNum,
          title: s.title,
          description: s.description || '',
          requiredFunctionCalls: Array.isArray(s.requiredFunctionCalls) && s.requiredFunctionCalls.length > 0
            ? s.requiredFunctionCalls
            : (sessionStep?.requiredFunctionCalls || []),
          skillIds: Array.isArray(s.skillIds) && s.skillIds.length > 0
            ? s.skillIds
            : (sessionStep?.skillIds || []),
          // Same reason as the two above: the LLM usually omits the asset gate
          // when saving, and losing it here would silently strip the session
          // plan's "must actually produce N assets" guarantee (ENG-889).
          ...(() => {
            const count = s.expectedAssetCount !== undefined
              ? s.expectedAssetCount
              : sessionStep?.expectedAssetCount;
            return count !== undefined ? { expectedAssetCount: count } : {};
          })(),
        };
      }),
      ownerId: userId,
      visibility: 'private',
      isBuiltIn: false,
    });
    return {
      success: true,
      planId: plan.planId,
      title: plan.title,
      steps: plan.steps.length,
      visibility: plan.visibility,
      message: `Work plan "${plan.title}" saved successfully. It is currently private. The user can submit it for platform review from Settings > Work Plans.`
    };
  }
});

// --- Report product issues tool ---

emmaToolRegistry.register({
  name: 'report_product_issues',
  definition: {
    name: 'report_product_issues',
    description: 'File product feedback for the team: BUGS (errors, unexpected behavior, broken output) AND FEATURE REQUESTS / enhancement ideas — including when nothing is broken and the user simply wants a new capability ("I want a feature where…", "I wish the app could…", "can you add…", "it would be great if…"). Creates a tracked item the user can follow: feature requests go on the public, votable roadmap; bugs are tracked privately so the user sees their own. Set `type` to "feature_request" or "bug". Batch multiple items into a single call when possible. Prefer filing over silently declining — if a request is a product capability you do not have, file it as a feature_request rather than just saying no.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          description: 'Array of issues to report',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short title for the issue (e.g., "Login page crashes on mobile")'
              },
              description: {
                type: 'string',
                description: 'Detailed description of the issue including steps to reproduce, expected behavior, and actual behavior'
              },
              priority: {
                type: 'string',
                enum: ['High', 'Medium', 'Low'],
                description: 'Priority level. Default: Medium'
              },
              pageUrl: {
                type: 'string',
                description: 'URL of the page where the issue occurred (optional)'
              },
              attachment_urls: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional https URLs of screenshots or files (e.g. S3 links) that evidence the issue. Upload files first, then pass their URLs here.'
              },
              run_id: {
                type: 'string',
                description: 'Optional AgentRun id (from the AgentRun inspector / runtime telemetry). When given, the server automatically attaches the run dossier — verdict, failed tool calls with error class/message and the failing arguments — to the report. Strongly recommended when reporting an agent/tool failure.'
              },
              type: {
                type: 'string',
                enum: ['bug', 'feature_request'],
                description: 'Whether this is a bug report or a feature request. Feature requests go to the public, votable roadmap; bugs are tracked privately (the user sees their own). Default: bug.'
              }
            },
            required: ['title', 'description']
          },
          minItems: 1
        }
      },
      required: ['issues']
    }
  },
  execute: async (args: any, context: any) => {
    // Lazy imports to avoid pulling in heavy dependencies at module load time
    const { resendService } = await import('../services/resendService');

    const userId = context?.userId;
    if (!userId) {
      throw new Error('Authentication required to report issues');
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // isDelegatedAdmin is set when called via chatbotService (Emma sidebar).
    // isDelegatedAccess is set when called via agentModeService (agent mode chat).
    // In both cases, look up the admin email from the session's delegateInfo in DB.
    const isDelegate = context?.isDelegatedAdmin === true || context?.isDelegatedAccess === true;
    let adminEmail: string | undefined = context?.adminEmail;
    if (isDelegate && !adminEmail && context?.sessionId) {
      const { chatbotDb } = await import('../services/chatbotService');
      const session = await chatbotDb.getChatSession(context.sessionId);
      if (session?.delegateInfo?.isDelegated && session.delegateInfo.adminEmail) {
        adminEmail = session.delegateInfo.adminEmail;
      }
    }
    const isDelegatedAdmin = isDelegate && !!adminEmail;

    const results: Array<{ title: string; success: boolean; issueId?: string; error?: string; deduped?: boolean; url?: string; trackingUrl?: string; canonicalUrl?: string }> = [];
    // ENG-289: the reporting admin gets the canonical Linear link back in chat — but ONLY when they are
    // an admin or in a delegated-admin session (someone who can actually open a Linear issue). External
    // customers and ALL external-MCP callers never receive the internal link (preserves the leak guard:
    // the tool result is JSON.stringified to external MCP clients and preserved into Agent Mode LLM context
    // + persisted sidebar state). The internal team notification email always gets it regardless.
    const reporterIsInternal = context?.externalMcp !== true && (user?.isAdmin === true || isDelegatedAdmin);
    // Public, user-facing board (what the customer can actually open). Per-result `url` is the
    // internal tracker (Linear/Notion) for the team email; `trackingUrl`/`userUrl` is the user's link.
    const FEATUREBASE_BOARD_URL = 'https://agentweb.featurebase.app/';

    // Fetch once before the loop to avoid N DynamoDB reads for a batch of issues
    const { settingsService } = await import('../services/settingsService');
    const productIssueEmails = await settingsService.getJsonArraySetting('product_issue_emails', ['founders@agentweb.pro']);
    const funnelStatusLabel = getUserFunnelStatusLabel(user.funnelStatus);
    const funnelStatusTags = getUserFunnelStatusIssueTags(user.funnelStatus);

    for (const rawIssue of args.issues) {
      // Gemini may serialize array items as JSON strings instead of objects — normalize
      const issue = typeof rawIssue === 'string' ? JSON.parse(rawIssue) : rawIssue;
      try {
        const issueContext: Record<string, any> = {
          'User Name': user.displayName || user.email,
          'User Email': user.email,
          'User ID': userId,
          'Priority': issue.priority || 'Medium',
          'Page URL': issue.pageUrl || 'N/A',
          'Session ID': context?.sessionId || 'N/A',
        };
        if (funnelStatusLabel) {
          issueContext['User Status'] = funnelStatusLabel;
        }

        const attachmentUrls = Array.isArray(issue.attachment_urls)
          ? issue.attachment_urls.filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
          : [];
        if (attachmentUrls.length > 0) {
          issueContext['Attachments'] = attachmentUrls.join('\n');
        }

        // Server-side run-dossier enrichment: the reporter passes a run_id and
        // the server pulls the telemetry it already has. Best-effort — a
        // failed lookup must never block the report.
        let description: string = issue.description;
        if (typeof issue.run_id === 'string' && issue.run_id.trim()) {
          try {
            const { fetchAgentRunSummaries } = await import('../services/agentRunInspectorService');
            const { runs } = await fetchAgentRunSummaries({ runId: issue.run_id.trim(), limit: 1 });
            const run = runs[0];
            if (run) {
              const failures = (run.outcomes || [])
                .filter((o: any) => o.eventType === 'agent_tool_failed')
                .slice(0, 10)
                .map((o: any) => {
                  const argsPart = o.failedArgsJson ? `\n  args: ${o.failedArgsJson}` : '';
                  return `- ${o.toolName || 'unknown'} [${o.errorClass || 'Error'}]: ${o.errorMessage || ''}${argsPart}`;
                });
              description += [
                '',
                '',
                '---',
                `AgentRun dossier (auto-attached from run_id ${run.runId}):`,
                `- verdict: ${(run as any).verdict || 'n/a'}  |  tool calls: ${(run as any).toolCalls ?? 'n/a'}  |  failed: ${(run as any).failedToolCalls ?? 'n/a'}`,
                ...(run.sessionId ? [`- session: ${run.sessionId}`] : []),
                ...(failures.length > 0 ? ['- failed tool calls:', ...failures] : []),
              ].join('\n');
              issueContext['AgentRun ID'] = run.runId;
            }
          } catch (e) {
            console.warn('[report_product_issues] run dossier enrichment failed (report still filed):', e instanceof Error ? e.message : e);
          }
        }

        if (isDelegatedAdmin && adminEmail) {
          issueContext['Reported By (Admin)'] = adminEmail;
        }

        // Route user-filed intake through the shared intake service: dedup -> stack onto an
        // existing public canonical, else create a new one (Featurebase-imported public post).
        // The FEATUREBASE_INTAKE flag selects Linear vs Notion (migration switch, not a
        // fallback). A hard failure here propagates to this loop's per-issue catch below,
        // which records the issue as failed — we do NOT silently reroute to another tracker.
        const itemType: 'feature_request' | 'bug' = issue.type === 'feature_request' ? 'feature_request' : 'bug';
        const { fileUserIssue } = await import('../services/intakeService');
        const INTAKE_TIMEOUT_MS = 30_000;
        const filed = await Promise.race([
          fileUserIssue({
            type: itemType,
            title: issue.title,
            description,
            userEmail: user.email,
            userName: user.displayName || user.email,
            reportedByAdmin: isDelegatedAdmin && adminEmail ? adminEmail : undefined,
            sessionId: context?.sessionId,
            // Same value that lands as "Priority:" text in issueContext — the intake service
            // maps it onto the Linear priority field so text and board agree (ENG-231).
            priority: issue.priority,
            // Linear-side triage enrichment (ENG-187): stage labels + priority/state/assignee defaults.
            funnelStatus: user.funnelStatus,
            // External MCP clients (Claude Code etc.) are tagged distinctly so benchmark
            // filters on Customer Reported stay clean (used on the flag-off Notion path).
            notionTags: [
              context?.externalMcp === true ? 'MCP Reported' : 'Customer Reported',
              ...funnelStatusTags,
            ],
            notionContext: issueContext,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Issue filing timed out after 30s')), INTAKE_TIMEOUT_MS)
          ),
        ]);
        const result = { pageId: filed.pageId, url: filed.trackerUrl, tracker: filed.tracker, deduped: filed.deduped, userUrl: filed.userUrl, canonicalUrl: reporterIsInternal ? filed.canonicalUrl : undefined };

        // Never email the customer — internal team + admin (if known) only.
        const emailRecipients = adminEmail
          ? [...productIssueEmails, adminEmail]
          : [...productIssueEmails];

        const priorityColor = (issue.priority || 'Medium') === 'High' ? '#dc2626' : (issue.priority || 'Medium') === 'Low' ? '#6b7280' : '#d97706';
        // Fire-and-forget — internal notification email; must not block the user-facing response
        resendService.sendEmail({
          from: `${RESEND_SYSTEM_NAME} Support <${RESEND_SYSTEM_EMAIL}>`,
          to: emailRecipients,
          subject: `[Issue] ${issue.title} — reported by ${user.email}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background-color: #f8f9fa; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
                <h2 style="margin: 0; color: #111; font-size: 18px;">Customer Issue Report</h2>
                <span style="background-color: ${priorityColor}; color: #fff; font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 12px;">${issue.priority || 'Medium'}</span>
              </div>

              <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr>
                  <td style="padding: 6px 0; color: #666; width: 140px; vertical-align: top;"><strong>Reported by</strong></td>
                  <td style="padding: 6px 0;"><a href="mailto:${user.email}" style="color: #4F46E5;">${user.displayName || user.email}</a> (${user.email})</td>
                </tr>
                ${funnelStatusLabel ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>User status</strong></td><td style="padding: 6px 0;">${funnelStatusLabel}</td></tr>` : ''}
                ${isDelegatedAdmin && adminEmail ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Via delegation</strong></td><td style="padding: 6px 0;">${adminEmail}</td></tr>` : ''}
                ${result.pageId ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Issue ID</strong></td><td style="padding: 6px 0; font-family: monospace;">AGW-${result.pageId}</td></tr>` : ''}
                ${result.url ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>${result.tracker}</strong></td><td style="padding: 6px 0;"><a href="${result.url}" style="color: #4F46E5; font-weight: 600;">→ Open in ${result.tracker}</a></td></tr>` : ''}
                ${filed.canonicalUrl ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Linear canonical</strong></td><td style="padding: 6px 0;"><a href="${filed.canonicalUrl}" style="color: #4F46E5; font-weight: 600;">→ Open canonical in Linear</a></td></tr>` : ''}
                ${issue.pageUrl ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Page URL</strong></td><td style="padding: 6px 0;"><a href="${issue.pageUrl}" style="color: #4F46E5;">${issue.pageUrl}</a></td></tr>` : ''}
              </table>

              <div style="background-color: #fff; border-left: 4px solid #4F46E5; padding: 15px; border-radius: 0 4px 4px 0;">
                <div style="font-weight: 600; margin-bottom: 8px; color: #333;">Description</div>
                <div style="color: #444; line-height: 1.6;">${issue.description.replace(/\n/g, '<br>')}</div>
              </div>

              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
                Reply to this email to respond directly to the customer.
              </div>
            </div>
          `,
          replyTo: user.email,
        }).catch((e: any) => console.warn('[report_product_issues] notification email failed (non-critical):', e?.message));

        results.push({ title: issue.title, success: true, issueId: `AGW-${result.pageId}`, deduped: result.deduped === true, url: result.url || undefined, trackingUrl: result.userUrl || undefined, canonicalUrl: result.canonicalUrl || undefined });
      } catch (err: any) {
        results.push({ title: issue.title, success: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const dedupedCount = results.filter(r => r.success && r.deduped).length;
    // Tell Emma how to talk to the user: deduped items are KNOWN requests the user's
    // vote/report was added to (not newly filed), so she should say so rather than
    // implying a brand-new ticket was created.
    // Surface a clickable public-board link to the user (their item, even when it's a
    // duplicate they were stacked onto). trackingUrl is the Featurebase board/post.
    const trackingLinks = results.filter(r => r.success && r.trackingUrl).map(r => r.trackingUrl);
    const linkLine = trackingLinks.length === 1
      ? ` You can track it here: ${trackingLinks[0]}`
      : (trackingLinks.length > 1 ? ` Track them on the roadmap: ${FEATUREBASE_BOARD_URL}` : '');
    let summary: string;
    if (failCount > 0) {
      summary = `${successCount} of ${results.length} issue(s) reported successfully. ${failCount} failed.`;
    } else if (dedupedCount === successCount && successCount > 0) {
      summary = `This is already a known request that's being tracked — I've added your report/vote to the existing item and you'll be notified when its status changes. Nothing new was filed.${linkLine}`;
    } else if (dedupedCount > 0) {
      summary = `Tracked: ${successCount - dedupedCount} new item(s) filed, and ${dedupedCount} matched existing known request(s) (your report/vote was added to those). The engineering team has been notified.${linkLine}`;
    } else {
      summary = `All ${successCount} issue(s) have been reported and tracked. The engineering team has been notified.${linkLine}`;
    }

    // Admins / delegated-admin sessions also get the canonical Linear link in chat (ENG-289) so they can
    // track the eng issue directly. `canonicalUrl` is only populated on results[] for internal reporters
    // (gated by reporterIsInternal above), so this stays empty for external customers + external-MCP callers.
    const linearLinks = results
      .map(r => (r.success ? r.canonicalUrl : undefined))
      .filter((u): u is string => !!u);
    if (linearLinks.length === 1) summary += ` Engineering is tracking this in Linear: ${linearLinks[0]}`;
    else if (linearLinks.length > 1) summary += ` Engineering is tracking these in Linear: ${linearLinks.join(', ')}`;

    return {
      success: failCount === 0,
      message: summary,
      results,
    };
  }
});

// Bridge report_product_issues onto the EXTERNAL MCP registry so the claude.ai
// Emma connector (api.agentweb.pro/mcp) can file bug reports directly — without
// portal login. Without this it is only reachable by in-app Emma. The handler
// reads context.userId (set to agentUserId for external clients) and
// context.externalMcp (true only on the external server) for source tagging, so
// the same handler works on both surfaces.
const reportProductIssuesHandler = emmaToolRegistry.getTool('report_product_issues');
if (reportProductIssuesHandler) {
  mcpToolRegistry.register(reportProductIssuesHandler);
}

emmaToolRegistry.register({
  name: 'get_user_profile',
  definition: {
    name: 'get_user_profile',
    description: "Retrieve the current user's profile information, including their email address, display name, company name, and subscription type. Call this when the user asks about their account details or when you need to know who you're talking to.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (_args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error("Authentication required: no user context");
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return { error: 'User profile not found.' };
    }
    // Org members inherit the owner's tier dynamically (ENG-288) — resolve
    // through the canonical helper instead of reading the raw field, so this
    // self-report matches what the member actually has access to.
    const { getUserSubscriptionType } = await import('../services/subscriptionService');
    const subscriptionType = await getUserSubscriptionType(userId);
    return {
      email: user.email,
      displayName: user.displayName || null,
      companyName: user.companyName || null,
      subscriptionType: subscriptionType || null,
    };
  }
});

// ---------------------------------------------------------------------------
// G2: CRM action tools — assign_lead, promote_to_deal, rotate_primary,
// get_hot_leads. These complement ask_crm (G1) by giving Emma the ability
// to actually mutate CRM state instead of just reading it.
// ---------------------------------------------------------------------------

async function resolveLeadForAction(
  listId: string,
  leadId: string,
  userId: string
): Promise<{ lead: any; list: any } | { error: string }> {
  if (!listId || !leadId) return { error: 'list_id and lead_id are required' };
  const list = await crmDb.getLeadListById(listId);
  if (!list) return { error: `Lead list ${listId} not found` };
  // ENG-1049: was a strict `list.userId !== userId` owner-only check, which
  // over-blocked the org owner and listed crm.editors from acting on lists
  // they don't personally own — inconsistent with every other CRM write
  // surface. Delegate to the shared destructive guard instead.
  const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../services/crmAccessControl');
  if (!(await canDestructiveCrmList(userId, list as any))) {
    return { error: CRM_EDITOR_REQUIRED_MESSAGE };
  }
  const lead = await crmDb.getLeadById(listId, leadId);
  if (!lead) return { error: `Lead ${leadId} not found in list ${listId}` };
  return { lead, list };
}

emmaToolRegistry.register({
  name: 'assign_lead',
  definition: {
    name: 'assign_lead',
    description: "Assign a lead (contact) to an account owner by setting the lead's accountOwnerUserId. Logs a contact.updated event so the timeline shows the reassignment. Use this when the user says things like 'give that lead to Matt' or 'reassign Acme to me'.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list containing the lead' },
        lead_id: { type: 'string', description: 'The ID of the lead to reassign' },
        account_owner_user_id: {
          type: 'string',
          description: 'The userId of the new account owner. Pass the same userId as the caller to assign to self.'
        },
      },
      required: ['list_id', 'lead_id', 'account_owner_user_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const resolved = await resolveLeadForAction(args.list_id, args.lead_id, userId);
    if ('error' in resolved) return resolved;
    const { lead } = resolved;

    const newOwner = String(args.account_owner_user_id || '').trim();
    if (!newOwner) return { error: 'account_owner_user_id is required' };

    const previousOwner = lead.accountOwnerUserId || null;
    if (previousOwner === newOwner) {
      return { success: true, noop: true, leadId: lead.leadId, accountOwnerUserId: newOwner };
    }

    try {
      await crmDb.updateLead(args.list_id, args.lead_id, { accountOwnerUserId: newOwner });
    } catch (err: any) {
      return { error: err?.message || 'Failed to update lead' };
    }

    // Best-effort event logging — never fail the assignment on log errors.
    try {
      const contactKey = lead.email ? normalizeContactId(lead.email) : `nocontact:${lead.leadId}`;
      await contactEventsDb.logEvent({
        contactId: contactKey,
        source: 'emma_session',
        eventType: 'contact.updated',
        sourceRecordId: `assign_lead:${lead.leadId}:${Date.now()}`,
        payload: {
          action: 'assign_lead',
          previousAccountOwnerUserId: previousOwner,
          accountOwnerUserId: newOwner,
          leadId: lead.leadId,
          listId: args.list_id,
          actorUserId: userId,
        },
      });
    } catch (err: any) {
      console.error('[assign_lead] event log failed', err?.message || err);
    }

    return {
      success: true,
      leadId: lead.leadId,
      accountOwnerUserId: newOwner,
      previousAccountOwnerUserId: previousOwner,
    };
  },
});

emmaToolRegistry.register({
  name: 'promote_to_deal',
  definition: {
    name: 'promote_to_deal',
    description: "Promote one or more leads (contacts) into a new Deal in the AW-Deals table. The first lead in `lead_ids` becomes the primary contact unless `primary_lead_id` is passed. Returns the created deal. Use this when the user says 'turn Acme into a deal', 'create a deal for these contacts', or similar.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list that contains the leads being promoted' },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'The leadIds to add to the new deal. Must be non-empty.',
        },
        primary_lead_id: { type: 'string', description: 'Optional — which leadId is the primary contact. Defaults to the first entry in lead_ids.' },
        deal_name: { type: 'string', description: 'Optional deal name / label (stored in notes for now).' },
        deal_value: { type: 'number', description: 'Optional dollar value of the deal' },
        expected_close: { type: 'string', description: 'Optional expected close date (ISO 8601 or YYYY-MM-DD)' },
        stage: {
          type: 'string',
          enum: [...DEAL_STAGES],
          description: "Optional initial stage. Defaults to 'Lead'.",
        },
      },
      required: ['list_id', 'lead_ids'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const listId: string = String(args.list_id || '').trim();
    const leadIds: string[] = Array.isArray(args.lead_ids) ? args.lead_ids.filter(Boolean) : [];
    if (!listId) return { error: 'list_id is required' };
    if (leadIds.length === 0) return { error: 'lead_ids must be a non-empty array' };

    // Validate leads exist + ownership, and collect company domains.
    const refs: { listId: string; leadId: string }[] = [];
    let companyDomain: string | undefined;
    for (const leadId of leadIds) {
      const resolved = await resolveLeadForAction(listId, leadId, userId);
      if ('error' in resolved) return resolved;
      refs.push({ listId, leadId });
      if (!companyDomain) {
        const raw = resolved.lead.email || '';
        const at = raw.indexOf('@');
        if (at > -1) companyDomain = raw.slice(at + 1).toLowerCase();
      }
    }

    const primary = args.primary_lead_id && leadIds.includes(args.primary_lead_id)
      ? args.primary_lead_id
      : leadIds[0];

    const stage: DealStage | undefined = args.stage;
    if (stage && !DEAL_STAGES.includes(stage)) {
      return { error: `Invalid stage '${stage}'. Must be one of ${DEAL_STAGES.join(', ')}` };
    }

    try {
      const notes = args.deal_name ? `name: ${String(args.deal_name).slice(0, 200)}` : undefined;
      const deal = await dealDb.promoteContactsToDeal(refs, {
        ownerUserId: userId,
        primaryContactId: primary,
        ...(companyDomain ? { companyDomain } : {}),
        ...(typeof args.deal_value === 'number' ? { dealValue: args.deal_value } : {}),
        ...(args.expected_close ? { expectedClose: String(args.expected_close) } : {}),
        ...(stage ? { stage } : {}),
        ...(notes ? { notes } : {}),
        source: 'emma_session',
      } as any);

      try {
        await contactEventsDb.logEvent({
          contactId: `deal:${deal.dealId}`,
          source: 'emma_session',
          eventType: 'deal.created',
          sourceRecordId: `promote_to_deal:${deal.dealId}`,
          dealId: deal.dealId,
          payload: {
            action: 'promote_to_deal',
            leadIds,
            primaryContactId: primary,
            dealName: args.deal_name || null,
            dealValue: typeof args.deal_value === 'number' ? args.deal_value : null,
            stage: deal.stage,
            actorUserId: userId,
          },
        });
      } catch (err: any) {
        console.error('[promote_to_deal] event log failed', err?.message || err);
      }

      return { success: true, deal };
    } catch (err: any) {
      return { error: err?.message || 'promote_to_deal failed' };
    }
  },
});

emmaToolRegistry.register({
  name: 'rotate_primary',
  definition: {
    name: 'rotate_primary',
    description: "Change the primary contact on an existing deal. The new primary must already be a contact on the deal OR a valid lead the caller owns; the tool adds them to the deal's contactIds if needed. Use this when the user says 'the main contact on Acme changed to Jane' or 'make Pat the primary on that deal'.",
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'The dealId to update' },
        new_primary_contact_id: { type: 'string', description: 'The leadId of the new primary contact' },
        list_id: { type: 'string', description: 'Optional — the lead list containing the new primary contact, used to mirror the isPrimary flag onto the lead row.' },
        old_primary_list_id: { type: 'string', description: 'Optional — the lead list containing the OLD primary contact, used to clear its isPrimary flag.' },
      },
      required: ['deal_id', 'new_primary_contact_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const dealId = String(args.deal_id || '').trim();
    const newPrimary = String(args.new_primary_contact_id || '').trim();
    if (!dealId) return { error: 'deal_id is required' };
    if (!newPrimary) return { error: 'new_primary_contact_id is required' };

    try {
      const existing = await dealDb.getDeal(dealId);
      if (!existing) return { error: `Deal ${dealId} not found` };

      const refs: any = {};
      if (args.old_primary_list_id && existing.primaryContactId) {
        refs.oldPrimary = { listId: args.old_primary_list_id, leadId: existing.primaryContactId };
      }
      if (args.list_id) {
        refs.newPrimary = { listId: args.list_id, leadId: newPrimary };
      }

      const updated = await dealDb.rotatePrimary(dealId, userId, newPrimary, refs);

      try {
        await contactEventsDb.logEvent({
          contactId: `deal:${dealId}`,
          source: 'emma_session',
          eventType: 'deal.primary_rotated',
          sourceRecordId: `rotate_primary:${dealId}:${Date.now()}`,
          dealId,
          payload: {
            action: 'rotate_primary',
            previousPrimaryContactId: existing.primaryContactId,
            newPrimaryContactId: newPrimary,
            actorUserId: userId,
          },
        });
      } catch (err: any) {
        console.error('[rotate_primary] event log failed', err?.message || err);
      }

      return { success: true, deal: updated };
    } catch (err: any) {
      if (err instanceof DealAuthError) return { error: 'Not authorized for this deal' };
      if (err instanceof DealNotFoundError) return { error: `Deal ${dealId} not found` };
      return { error: err?.message || 'rotate_primary failed' };
    }
  },
});

emmaToolRegistry.register({
  name: 'get_hot_leads',
  definition: {
    name: 'get_hot_leads',
    description: "Return the user's highest-scoring leads across all their lists, ranked by heatScore (0-100). Optional filters for lifecycle stage, minimum heat score, and account-owner scope. Use this when the user asks 'who are my hottest leads', 'top prospects today', 'show me my MQLs with heat > 70'.",
    inputSchema: {
      type: 'object',
      properties: {
        lifecycle: {
          type: 'string',
          description: "Optional lifecycle filter (e.g. 'Lead', 'MQL', 'SQL', 'Customer'). Matches the lead's lifecycle field exactly.",
        },
        min_heat_score: {
          type: 'number',
          description: 'Optional minimum heatScore (0-100). Leads below this score are filtered out. Defaults to 0.',
        },
        owner_filter: {
          type: 'string',
          description: "Optional accountOwnerUserId filter. Pass a userId to only return leads owned by that user, or 'me' to filter to the caller.",
        },
        limit: {
          type: 'number',
          description: 'Max number of leads to return (default 20, max 100).',
        },
      },
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const minHeat = typeof args.min_heat_score === 'number' ? args.min_heat_score : 0;
    const lifecycleFilter = args.lifecycle ? String(args.lifecycle) : null;
    let ownerFilter: string | null = null;
    if (args.owner_filter) {
      ownerFilter = args.owner_filter === 'me' ? userId : String(args.owner_filter);
    }

    // Scan caller's lists and collect candidates. Ranking by heatScore desc.
    let lists: any[] = [];
    try {
      lists = (await crmDb.getLeadListsForUser(userId)) || [];
    } catch (err: any) {
      return { error: err?.message || 'Failed to load lead lists' };
    }

    const candidates: any[] = [];
    const scanCap = 500; // cap total leads we scan so this stays cheap
    let scanned = 0;
    for (const list of lists) {
      if (scanned >= scanCap) break;
      const page = await crmDb.getLeadsByListId((list as any).listId, Math.min(200, scanCap - scanned));
      const items: any[] = (page && (page as any).items) || [];
      scanned += items.length;
      for (const it of items) {
        const heat = typeof it.heatScore === 'number' ? it.heatScore : 0;
        if (heat < minHeat) continue;
        if (lifecycleFilter && it.lifecycle !== lifecycleFilter) continue;
        if (ownerFilter && it.accountOwnerUserId !== ownerFilter) continue;
        candidates.push({
          leadId: it.leadId,
          listId: it.listId,
          listName: (list as any).name || null,
          email: it.email || null,
          firstName: it.firstName || null,
          lastName: it.lastName || null,
          company: it.company || null,
          title: it.title || null,
          heatScore: heat,
          lifecycle: it.lifecycle || null,
          accountOwnerUserId: it.accountOwnerUserId || null,
          lastEngagementAt: it.lastEngagementAt || null,
        });
      }
    }

    candidates.sort((a, b) => (b.heatScore || 0) - (a.heatScore || 0));
    return {
      leads: candidates.slice(0, limit),
      count: Math.min(candidates.length, limit),
      scanned,
      filters: { lifecycle: lifecycleFilter, minHeatScore: minHeat, ownerFilter },
    };
  },
});

emmaToolRegistry.register({
  name: 'search_user_assets',
  definition: {
    name: 'search_user_assets',
    description: "Search for assets (images, videos, HTML reports) that were generated in the user's Agent Mode sessions. Returns matching assets with their URLs, filenames, creation dates, asset type, favorite status, and the session they came from (sessionId + title). Use this when the user asks to find images, videos, reports, or files they've created. Supports filtering by favorite status and approval status.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['images', 'videos', 'htmlReports', 'all'],
          description: "Filter by asset type. Use 'all' or omit to return every type."
        },
        query: {
          type: 'string',
          description: 'Optional keyword to filter by filename (case-insensitive partial match).'
        },
        favorites_only: {
          type: 'boolean',
          description: "When true, return only assets the user has favorited/starred (❤️ button on the Images page). Use this when the user asks for their favorites, starred, or bookmarked images."
        },
        approved_only: {
          type: 'boolean',
          description: "When true, return only assets that have been approved via the Slack approval workflow. Use this when the user asks for approved images or assets."
        }
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const lowerQuery = args.query?.toLowerCase();
    const assetTypeFilter: string | null = args.type === 'all' || !args.type ? null : args.type;

    // Agent mode session assets (images, videos, HTML reports from save_file, etc.)
    const sessionAssets = await chatbotDb.searchUserAssets(
      userId,
      args.type,
      args.query,
      args.favorites_only,
      args.approved_only
    );

    // Task execution result_files — reuse the same code path as the Research Reports page.
    // Only included when not filtering to favorites (task files have no favorite state).
    const taskAssets: typeof sessionAssets = [];
    if (!args.favorites_only && !args.approved_only) {
      const assetTypeForTasks = (!assetTypeFilter || assetTypeFilter === 'htmlReports') ? 'html-reports'
        : assetTypeFilter === 'images' ? 'images'
        : assetTypeFilter === 'videos' ? 'videos'
        : null;

      if (assetTypeForTasks) {
        const execResult = await getExecutionsWithAssets(userId, assetTypeForTasks as any, '');
        for (const task of Object.values(execResult) as any[]) {
          if (task.source !== 'task') continue;
          for (const execution of task.executions || []) {
            for (const file of execution.result_files || []) {
              const url: string = file.url || file.s3_url || '';
              const filename: string = file.filename || url.split('/').pop() || '';
              if (!url || !filename) continue;
              if (lowerQuery && !filename.toLowerCase().includes(lowerQuery) && !url.toLowerCase().includes(lowerQuery)) continue;
              const assetType: 'image' | 'video' | 'htmlReport' = assetTypeForTasks === 'html-reports' ? 'htmlReport'
                : assetTypeForTasks === 'images' ? 'image' : 'video';
              taskAssets.push({
                url,
                filename,
                assetType,
                generatedAt: execution.startTime || '',
                sessionId: `task-${execution.executionId}`,
                sessionTitle: task.taskName || 'Task execution',
                isFavorited: false,
              });
            }
          }
        }
      }
    }

    const allAssets = [...sessionAssets, ...taskAssets]
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

    if (allAssets.length === 0) {
      return { message: 'No assets found matching your criteria.', assets: [] };
    }

    return {
      count: allAssets.length,
      assets: allAssets.map(a => ({
        url: a.url,
        filename: a.filename,
        assetType: a.assetType,
        generatedAt: a.generatedAt,
        sessionId: a.sessionId,
        sessionTitle: a.sessionTitle,
        isFavorited: a.isFavorited,
        ...(a.approvalStatus !== undefined && { approvalStatus: a.approvalStatus }),
      })),
    };
  }
});

emmaToolRegistry.register({
  name: 'log_contact_event',
  definition: {
    name: 'log_contact_event',
    description:
      "Log a natural-language activity event on a CRM contact's timeline. Use this when the user dictates a note like 'add a note that I called Jane and left a voicemail' or 'log that Acme sent over the signed contract'. The event shows up in the contact's Activity Timeline alongside auto-captured events (form submits, payments, meetings). Input: contactId (normalized email, e.g. 'jane@acme.com'), eventType (pick from known types — use 'manual.note' for freeform notes, 'meeting.attended' for calls, 'support.opened' for issues, etc), summary (1-line human-readable description), details (optional structured data).",
    inputSchema: {
      type: 'object',
      properties: {
        contactId: {
          type: 'string',
          description:
            "The contact to log against. Almost always the contact's lowercase email (e.g. 'jane@acme.com'). For leads without an email, use the fallback form 'nocontact:<leadId>'.",
        },
        eventType: {
          type: 'string',
          description:
            "Event type. Use 'manual.note' for freeform notes; 'meeting.attended' for call/meeting logs; 'support.opened' / 'support.resolved' for issues; 'engagement.email_clicked' etc for engagement events you know happened but weren't auto-captured. Defaults to 'manual.note' if omitted.",
        },
        summary: {
          type: 'string',
          description:
            "Short 1-line human-readable summary of the event. Shown verbatim on the timeline. E.g. 'Left voicemail — asked about enterprise pricing'.",
        },
        details: {
          type: 'object',
          description:
            'Optional structured data to attach to the event (duration, source, references, etc). Shown as metadata under the summary on the timeline.',
        },
      },
      required: ['contactId', 'summary'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) {
      return { error: 'Authentication required: no user context' };
    }

    const contactId = typeof args.contactId === 'string' ? args.contactId.trim() : '';
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    const eventType =
      typeof args.eventType === 'string' && args.eventType ? args.eventType : 'manual.note';

    if (!contactId) {
      return { error: 'contactId is required' };
    }
    if (!summary) {
      return { error: 'summary is required' };
    }

    const { logManualEvent, isKnownContactEventType } = await import(
      '../services/contactCaptureHooks'
    );

    // Accept unknown types (forward-compat) but surface a warning so the user
    // knows the timeline renderer may not have a template for it yet.
    const warning = isKnownContactEventType(eventType)
      ? undefined
      : `Unknown eventType "${eventType}" — logged, but the timeline renderer may show it as a generic row.`;

    const details =
      args.details && typeof args.details === 'object' && !Array.isArray(args.details)
        ? (args.details as Record<string, unknown>)
        : undefined;

    const result = await logManualEvent({
      contactId,
      eventType,
      summary,
      details,
      loggedByUserId: userId,
    });

    if (!result) {
      return { error: 'Failed to log contact event' };
    }

    return {
      success: true,
      eventId: result.event.eventId,
      eventType: result.event.eventType,
      contactId: result.event.contactId,
      deduplicated: result.deduplicated,
      ...(warning ? { warning } : {}),
    };
  },
});

for (const toolName of adminToolNames) {
  const handler = mcpToolRegistry.getTool(toolName);
  if (handler) {
    emmaToolRegistry.register({
      name: handler.name,
      definition: handler.definition,
      execute: handler.execute,
    });
  } else {
    console.warn(`[emma/tools] Failed to bridge admin tool "${toolName}" — not found in mcpToolRegistry`);
  }
}

// Login credentials tool — lets Emma retrieve saved website credentials for browser automation
emmaToolRegistry.register({
  name: 'get_login_credentials',
  definition: {
    name: 'get_login_credentials',
    description: 'Retrieve saved login credentials for a website domain. Use this when you need to log into a website during browser automation. Credentials must be pre-saved by the user in Settings > Login Credentials. Never ask the user to paste passwords in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain of the website to get credentials for (e.g. "linkedin.com", "app.hubspot.com")'
        }
      },
      required: ['domain']
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const domain = (args.domain || '').toLowerCase().trim();
    if (!domain) return { error: 'domain is required' };

    const { DynamoDB } = await import('aws-sdk');
    const { decryptPassword } = await import('../utils/crypto');
    const dynamodb = new DynamoDB.DocumentClient();
    const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

    // Extract base domain for fuzzy matching (strip www. and subdomains down to registrable domain)
    const baseDomain = domain.replace(/^www\./, '');

    const result = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'attribute_not_exists(isApiConfig) OR isApiConfig = :false',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':false': false
      }
    }).promise();

    const items = result.Items || [];

    // Match by exact domain or base domain suffix
    const match = items.find((c: any) => {
      const w = (c.website || '').toLowerCase();
      return w === domain || w === baseDomain || domain.endsWith('.' + w) || baseDomain.endsWith('.' + w);
    });

    if (!match) {
      const saved = items.filter((c: any) => !c.isApiConfig).map((c: any) => c.website).join(', ');
      return {
        error: `No credentials saved for "${domain}". Please go to Settings > Login Credentials to save them first.`,
        savedDomains: saved || 'none'
      };
    }

    const encrypted = match.encryptedPassword || match.password;
    if (!encrypted) {
      return { error: `Credentials found for "${match.website}" but no password is stored.` };
    }

    try {
      const { password } = decryptPassword(encrypted);
      return {
        username: match.username,
        password,
        domain: match.website
      };
    } catch {
      return { error: `Failed to decrypt credentials for "${match.website}". The saved credentials may be corrupted.` };
    }
  }
});

emmaToolRegistry.register({
  name: 'import_leads_from_search',
  definition: {
    name: 'import_leads_from_search',
    description: `Search LinkedIn for people and import the results directly into a CRM lead list.
Uses the user's connected LinkedIn account if available, otherwise falls back to platform-wide outreach accounts — so this works even without a personal LinkedIn connection.

Use this when the user wants to:
- Find leads matching a job title, company, location, industry, school, or keyword
- Populate a CRM list with discovered prospects
- Discover new contacts to reach out to

Free-text company/location/industry/school are auto-resolved to LinkedIn entity IDs by the backend (via the search-parameter resolver), giving precise structured filtering. Pass keywords ONLY for free-text broad search — when you have structured filters, the backend handles Unipile's keyword requirement transparently.

For more than ~30 results from a single query, use the cursor returned in the response to paginate through subsequent pages.

When you make multiple sequential import calls, trust the "list_total_after_import" field on each response for the actual list size — do NOT sum the per-call "imported" values across calls, because the same lead can match multiple queries and is correctly deduplicated by the backend. Summing produces an inflated count.

Setting auto_enrich=true queues a background email-finder job for the newly imported leads — the response then includes "autoEnrichJobId" so the caller can poll job status. When auto_enrich is false (default), no background work is started and you should recommend enriching the list with "Enrich with Web" to fill in missing details like email addresses.

Response keys:
- imported / skipped / errors / total — per-call counts (do not sum across calls)
- list_total_after_import — actual post-import list size (trust this for cumulative counts)
- cursor — pagination cursor for the next page of the same query (null when no more results)
- anonymizedSkipped — count of out-of-network placeholder results ("LinkedIn Member", "LinkedIn User" and their localized equivalents) that were discarded before writing (they carry no usable name, email or profile URL, so they are not importable). A high value means the search reached beyond the connected account's network.
- importedLeads — summaries (firstName, lastName, linkedin, title, company) of up to the first 5 leads ACTUALLY WRITTEN by this call. It never includes results that were deduplicated into an existing lead, trimmed to honour the requested limit, or discarded as anonymized — report only from this array, and never describe a search result as imported unless it appears here.
- autoEnrichJobId — present only when auto_enrich=true AND at least 1 new lead was imported AND the background job was successfully queued`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The CRM lead list ID to import leads into. Required.'
        },
        keywords: {
          type: 'string',
          description: 'Optional free-text search keywords. Omit when using structured filters — the backend will synthesize a keyword from your most-specific filter (title > company > location > industry > school) so the Unipile classic-search keyword requirement is satisfied transparently.'
        },
        title: {
          type: 'string',
          description: 'Job title filter (e.g. "CTO", "VP Sales").'
        },
        company: {
          type: 'string',
          description: 'Company name filter — free text, auto-resolved to a LinkedIn company id if no company_id is provided.'
        },
        company_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn company entity ID — when provided, skips the resolver.'
        },
        location: {
          type: 'string',
          description: 'Location filter — free text (e.g. "San Francisco Bay Area"), auto-resolved to a LinkedIn location entity id if no location_id is provided.'
        },
        location_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn location entity ID — when provided, skips the resolver.'
        },
        industry: {
          type: 'string',
          description: 'Industry filter — free text, auto-resolved to a LinkedIn industry entity id if no industry_id is provided.'
        },
        industry_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn industry entity ID — when provided, skips the resolver.'
        },
        school: {
          type: 'string',
          description: 'School filter — free text, auto-resolved to a LinkedIn school entity id if no school_id is provided.'
        },
        school_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn school entity ID — when provided, skips the resolver.'
        },
        search_url: {
          type: 'string',
          description: 'A LinkedIn search URL copied from the browser. Overrides keywords/title/company/etc.'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for fetching the next page of results from a previous import_leads_from_search call. Use the cursor value returned in the previous response to fetch the next ~30 results from the same query.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of leads to import. Defaults to 20, max 500.'
        },
        auto_enrich: {
          type: 'boolean',
          description: 'When true, after import, queue a background email-finder job for the new leads. Returns autoEnrichJobId in the response. Default: false.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) throw new Error('Authentication required');
    const limit = Math.min(args.limit ?? 20, 500);
    return agentModeService.importLeadsFromSearch(context.userId, {
      listId: args.list_id,
      keywords: args.keywords,
      search_url: args.search_url,
      title: args.title,
      company: args.company,
      company_id: args.company_id,
      location: args.location,
      location_id: args.location_id,
      industry: args.industry,
      industry_id: args.industry_id,
      school: args.school,
      school_id: args.school_id,
      cursor: args.cursor,
      limit,
      auto_enrich: args.auto_enrich,
    });
  }
});

// ── Google Ads Tools ────────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'call_google_ads_api',
  definition: {
    name: 'call_google_ads_api',
    description: `Manage Google Ads entities via the Google Ads API.

ACTION MATRIX:
  BUDGET      → LIST, CREATE (name, amount_micros, explicitly_shared?), UPDATE (budget_resource_name, amount_micros), REMOVE (budget_resource_name; must not be attached to any campaign)
  CAMPAIGN    → LIST, CREATE (name, type, budget_resource_name, bidding_strategy OR bidding_strategy_resource_name, location_target_ids?, brand_business_name?, brand_logo_asset_resource_name?), PAUSE, RESUME, UPDATE (campaign_resource_name, name?, status?, bidding_strategy? OR bidding_strategy_resource_name?, bidding_strategy_target?, budget_resource_name?, final_url_suffix?), REMOVE (campaign_resource_name)
              For PERFORMANCE_MAX: pass brand_business_name and brand_logo_asset_resource_name — backend batches campaign creation + brand asset attachment atomically
              Bidding: pass bidding_strategy for a standard (embedded) strategy, OR bidding_strategy_resource_name to attach a portfolio/shared strategy (from BIDDING_STRATEGY LIST) — never both. Switching to a standard strategy detaches any portfolio strategy.
              LAUNCH GATE: RESUME (or UPDATE with status=ENABLED) enables a campaign — this runs a pre-flight tracking check on the campaign's final URLs. If any URL lacks a detectable GA4/GTM/Google Ads conversion snippet the launch is BLOCKED (result has blocked=true and names the unmeasured URLs). Relay that to the user and help them fix tracking; only pass override_tracking_check=true if they explicitly choose to launch anyway.
              ADD_PROXIMITY (campaign_resource_name, radius, address{street_address?, city_name?, postal_code?, province_code?, province_name?, country_code?}; radius_units defaults MILES) — mile/km-radius targeting centered on a real address (Google geocodes it server-side). This is native API support for "within N miles of our store/showroom" requests — do NOT tell the user proximity/radius targeting requires the UI; it does not. Additive to any existing LOCATION (city) criteria — REMOVE_PROXIMITY the old one first if only the radius should apply.
              REMOVE_PROXIMITY (criterion_resource_name) — removes a campaign-level LOCATION or PROXIMITY criterion. Obtain resource names via a raw GAQL query on campaign_criterion (call_google_ads_reporting_api mode="raw").
              TRANSPARENCY GUARDRAIL: if any Google Ads request cannot be fully satisfied via this API — including cases where you genuinely must fall back to a UI-only step (e.g. linking Google Business Profile) — you MUST say so explicitly to the user at deployment: name the gap, what you did instead, and the exact manual step left for them. Never silently substitute a workaround or imply a request is fully done when a manual step remains outstanding.
  CAMPAIGN_CRITERION → ADD (campaign_resource_name, placement_urls? and/or mobile_app_category_resource_names?)
              Adds campaign-scoped negative placement and mobile-app-category criteria atomically. placement_urls accepts domains or HTTP(S) URLs. mobile_app_category_resource_names must use canonical mobileAppCategoryConstants/<id> resource names. This is not a keyword/ad-group fallback.
  BIDDING_STRATEGY → LIST (portfolio/shared bidding strategies; returns resource_name for use as bidding_strategy_resource_name)
  AD_GROUP    → LIST (campaign_resource_name)
               CREATE (name, campaign_resource_name, type [SEARCH_STANDARD|DISPLAY_STANDARD], cpc_bid_micros?)
               UPDATE (ad_group_resource_name, name?, status?, cpc_bid_micros?, ad_rotation_mode?, target_cpa_micros?, target_roas?)
               REMOVE (ad_group_resource_name)
  KEYWORD     → LIST (ad_group_resource_name), ADD (ad_group_resource_name, keywords[]), ADD_NEGATIVE (keywords[], campaign_resource_name OR ad_group_resource_name), UPDATE (criterion_resource_name, status?, cpc_bid_micros?), REMOVE (criterion_resource_name)
  AD          → LIST (ad_group_resource_name), CREATE (ad_group_resource_name, type [RESPONSIVE_SEARCH_AD|RESPONSIVE_DISPLAY_AD], headlines[], descriptions[], final_url), UPDATE (ad_resource_name, status?), REMOVE (ad_resource_name), RETAG_UTM (ad_resource_name)
              NOTE: final_url, headlines, descriptions are ALL immutable after creation — to change any of these, REMOVE and recreate the ad
              RETAG_UTM (ENG-239 — retrofit UTMs onto an ad found untagged, e.g. via audit_ad_utm_coverage):
              Writes the UTM suffix to the ad's CAMPAIGN, not the ad — Google's API rejects a direct ad-level
              write on an existing ad. Merges with whatever the campaign already has (never overwrites existing
              tracking). This means the change affects EVERY ad in that campaign, not just the one you named —
              tell the user this explicitly before calling, the same way you would for any change with a wider
              blast radius than it sounds like. Never call in a loop over multiple ads — single-target only,
              one ad per call.
  ASSET       → UPLOAD
  CAMPAIGN_ASSET → ATTACH (campaign_resource_name, assets[{fieldType, assetResourceName?, text?}])
              fieldType values: BUSINESS_NAME (use text), LOGO, SQUARE_MARKETING_IMAGE, MARKETING_IMAGE (use assetResourceName)
              Note: brand guidelines are handled automatically in CAMPAIGN CREATE — use ATTACH only for adding additional campaign-level assets after campaign creation
  ASSET_GROUP → CREATE, RETAG_UTM (asset_group_resource_name)
              RETAG_UTM (ENG-239 — retrofit UTMs onto a PMax asset group found untagged, e.g. via
              audit_ad_utm_coverage): merges missing UTM keys directly into final_urls (asset groups have no
              final_url_suffix field). No utm_content — {creative} is unsupported on Performance Max, per
              Google's own docs. Also omits any key the CAMPAIGN's final_url_suffix already supplies, since an
              asset group inherits that at delivery — never duplicates. Never call in a loop — single-target
              only, one asset group per call.
  LOCATION    → SEARCH`,
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID (numeric, no dashes). Call list_connected_accounts(platform="google_ads") and use the "customer_id" field from the result (NOT the "id" field).' },
        entity_type: { type: 'string', enum: ['BUDGET', 'CAMPAIGN', 'CAMPAIGN_CRITERION', 'AD_GROUP', 'KEYWORD', 'AD', 'ASSET', 'CAMPAIGN_ASSET', 'ASSET_GROUP', 'LOCATION', 'BIDDING_STRATEGY'] },
        action: { type: 'string', description: 'Action to perform. See ACTION MATRIX.' },
        name: { type: 'string' },
        type: { type: 'string', description: 'Campaign type (SEARCH|DISPLAY|PERFORMANCE_MAX), ad group type (SEARCH_STANDARD|DISPLAY_STANDARD), or ad type for AD CREATE (RESPONSIVE_SEARCH_AD|RESPONSIVE_DISPLAY_AD).' },
        budget_resource_name: { type: 'string', description: 'From BUDGET CREATE. Required for CAMPAIGN CREATE.' },
        amount_micros: { type: 'number', description: 'Budget in micros. $10/day = 10000000.' },
        explicitly_shared: { type: 'boolean', description: 'Whether the budget is explicitly shared across campaigns. Optional for BUDGET CREATE.' },
        bidding_strategy: { type: 'string', enum: ['MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_IMPRESSION_SHARE', 'TARGET_SPEND', 'MANUAL_CPC'], description: 'A standard (embedded) bidding strategy. TARGET_SPEND = Maximize Clicks (optionally capped by cpc_bid_ceiling_micros). Mutually exclusive with bidding_strategy_resource_name.' },
        bidding_strategy_resource_name: { type: 'string', description: 'Resource name of a portfolio/shared bidding strategy (from BIDDING_STRATEGY LIST) to attach on CAMPAIGN CREATE/UPDATE. Mutually exclusive with bidding_strategy.' },
        bidding_strategy_target: { type: 'number' },
        cpc_bid_ceiling_micros: { type: 'number', description: 'Max CPC bid ceiling in micros for TARGET_IMPRESSION_SHARE (default 100000000 ≈100 currency units) or TARGET_SPEND/Maximize Clicks campaigns. Pass a lower value to cap spend per click.' },
        location_target_ids: { type: 'array', items: { type: 'number' }, description: 'From LOCATION SEARCH.' },
        campaign_resource_name: { type: 'string', description: 'Required for CAMPAIGN PAUSE/RESUME/UPDATE/REMOVE/ADD_PROXIMITY and AD_GROUP LIST.' },
        radius: { type: 'number', description: 'Proximity radius for CAMPAIGN ADD_PROXIMITY, in radius_units (default MILES).' },
        radius_units: { type: 'string', enum: ['MILES', 'KILOMETERS'], description: 'Unit for radius on CAMPAIGN ADD_PROXIMITY. Defaults to MILES.' },
        address: {
          type: 'object',
          description: 'Address to center the radius on for CAMPAIGN ADD_PROXIMITY (Google geocodes it server-side). At least one field required.',
          properties: {
            street_address: { type: 'string' },
            city_name: { type: 'string' },
            postal_code: { type: 'string' },
            province_code: { type: 'string' },
            province_name: { type: 'string' },
            country_code: { type: 'string' },
          },
        },
        final_url_suffix: { type: 'string', description: 'Campaign-level Final URL suffix (query params appended to all final URLs, e.g. "utm_source=google&utm_medium=cpc"). For CAMPAIGN UPDATE only.' },
        ad_group_resource_name: { type: 'string', description: 'Required for KEYWORD LIST/ADD/ADD_NEGATIVE/REMOVE, AD LIST/CREATE, AD_GROUP UPDATE.' },
        ad_resource_name: { type: 'string', description: 'AdGroupAd resource name. Required for AD UPDATE/REMOVE/RETAG_UTM. Obtain from AD LIST.' },
        asset_group_resource_name: { type: 'string', description: 'Asset group resource name. Required for ASSET_GROUP RETAG_UTM. Obtain from audit_ad_utm_coverage or a GAQL read on asset_group.' },
        brand_business_name: { type: 'string', description: 'Business name for PMax brand guidelines. Required for PERFORMANCE_MAX CAMPAIGN CREATE when brand guidelines are enforced.' },
        brand_logo_asset_resource_name: { type: 'string', description: 'Logo image asset resource name for PMax brand guidelines. Upload via ASSET UPLOAD first.' },
        criterion_resource_name: { type: 'string', description: 'Criterion resource name. Required for KEYWORD REMOVE (ad group criterion, from KEYWORD LIST) and CAMPAIGN REMOVE_PROXIMITY (campaign criterion, from a raw GAQL query on campaign_criterion).' },
        placement_urls: { type: 'array', items: { type: 'string' }, description: 'Placement domains or HTTP(S) URLs to add as negative campaign criteria. For CAMPAIGN_CRITERION ADD.' },
        mobile_app_category_resource_names: { type: 'array', items: { type: 'string' }, description: 'Canonical mobileAppCategoryConstants/<id> resource names to add as negative campaign criteria. For CAMPAIGN_CRITERION ADD.' },
        assets: { type: 'array', items: { type: 'object', properties: { fieldType: { type: 'string', enum: ['BUSINESS_NAME', 'LOGO', 'SQUARE_MARKETING_IMAGE', 'MARKETING_IMAGE', 'HEADLINE', 'DESCRIPTION'] }, assetResourceName: { type: 'string' }, text: { type: 'string' } }, required: ['fieldType'] }, description: 'Assets to attach for CAMPAIGN_ASSET ATTACH. Use text for BUSINESS_NAME, assetResourceName for image/logo types.' },
        keywords: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, matchType: { type: 'string', enum: ['BROAD', 'PHRASE', 'EXACT'] } }, required: ['text', 'matchType'] }, description: 'Keywords for ADD or ADD_NEGATIVE action.' },
        query: { type: 'string', description: 'Location search query.' },
        status: { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'Entity status for CREATE or UPDATE.' },
        override_tracking_check: { type: 'boolean', description: 'Enabling/launching a campaign (CAMPAIGN RESUME, or UPDATE with status=ENABLED) runs a deterministic pre-flight tracking check: each final URL must serve a detectable GA4/GTM/Google Ads conversion snippet, or the launch is BLOCKED (blocked=true, reason="tracking_preflight"). Only set this to true to launch anyway after the user has explicitly confirmed they accept unmeasured/server-side tracking — the override is recorded on the run record. Never set it on your own.' },
        cpc_bid_micros: { type: 'number', description: 'CPC bid in micros for AD_GROUP CREATE or UPDATE.' },
        ad_rotation_mode: { type: 'string', enum: ['OPTIMIZE', 'ROTATE_FOREVER'], description: 'Ad rotation mode for AD_GROUP UPDATE.' },
        target_cpa_micros: { type: 'number', description: 'Ad-group-level target CPA in micros for AD_GROUP UPDATE. Overrides campaign-level target.' },
        target_roas: { type: 'number', description: 'Ad-group-level target ROAS for AD_GROUP UPDATE. Overrides campaign-level target.' },
        headlines: { type: 'array', items: { type: 'string' }, description: 'Ad headlines. Required for AD CREATE. Min 3 for RSA.' },
        descriptions: { type: 'array', items: { type: 'string' }, description: 'Ad descriptions. Required for AD CREATE. Min 2 for RSA.' },
        final_url: { type: 'string', description: 'Landing page URL. Required for AD CREATE and ASSET_GROUP CREATE.' },
        image_asset_resource_names: { type: 'array', items: { type: 'string' }, description: 'Image asset resource names. Optional, Display ads only.' },
        asset_type: { type: 'string', enum: ['IMAGE', 'LOGO', 'VIDEO'], description: 'Asset type for ASSET UPLOAD. Use LOGO for square logo images (internally uploaded as IMAGE). Use IMAGE for marketing images. Use VIDEO for YouTube videos.' },
        data: { type: 'string', description: 'Asset data. For IMAGE/LOGO: a public URL (https://...) — backend will fetch and upload. For VIDEO: YouTube video ID string. for VIDEO.' },
        long_headlines: { type: 'array', items: { type: 'string' }, description: 'Long headlines for ASSET_GROUP CREATE (PMax).' },
        square_image_assets: { type: 'array', items: { type: 'string' }, description: 'Square image asset resource names for ASSET_GROUP CREATE.' },
        landscape_image_assets: { type: 'array', items: { type: 'string' }, description: 'Landscape image asset resource names for ASSET_GROUP CREATE.' },
        logo_assets: { type: 'array', items: { type: 'string' }, description: 'Logo asset resource names for ASSET_GROUP CREATE.' },
        video_assets: { type: 'array', items: { type: 'string' }, description: 'Video asset resource names for ASSET_GROUP CREATE. Optional.' },
      },
      required: ['customer_id', 'entity_type', 'action'],
    },
  },
  execute: async (args: any, context: any) => {
    return await agentModeService.handleCallGoogleAdsApi(context?.userId || context?.agentUserId, args, { sessionId: context?.sessionId });
  },
});

emmaToolRegistry.register({
  name: 'call_google_ads_reporting_api',
  definition: {
    name: 'call_google_ads_reporting_api',
    description: `Fetch Google Ads performance data.

TWO MODES:
- mode="dashboard": Pre-formatted markdown table (spend, impressions, clicks, CTR, conversions, avg CPC). Use for "how are my campaigns doing?" questions.
- mode="raw": Custom GAQL query, returns structured results. Use for keyword-level data, custom breakdowns, or specific fields.

COST: cost_micros from API ÷ 1,000,000 = spend in account currency. Check the currency field in response.
NEVER fabricate metrics — only report what tools return.

GAQL EXAMPLES:
  Campaign: SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS
  Keywords: SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks, metrics.cost_micros, metrics.average_cpc FROM keyword_view WHERE segments.date DURING LAST_30_DAYS`,
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID (numeric, no dashes). Call list_connected_accounts(platform="google_ads") and use the "customer_id" field (NOT the "id" field).' },
        mode: { type: 'string', enum: ['raw', 'dashboard'], description: '"dashboard" for formatted summary. "raw" for custom GAQL.' },
        query: { type: 'string', description: 'GAQL query. Required for mode="raw".' },
        campaign_ids: { type: 'array', items: { type: 'string' }, description: 'Filter to specific campaigns (dashboard mode only). Omit for all.' },
        date_preset: { type: 'string', enum: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'THIS_MONTH', 'LAST_MONTH', 'THIS_YEAR'], description: 'Defaults to LAST_30_DAYS.' },
      },
      required: ['customer_id', 'mode'],
    },
  },
  execute: async (args: any, context: any) => {
    return await agentModeService.handleCallGoogleAdsReportingApi(context?.userId || context?.agentUserId, args);
  },
});

// ─── HubSpot ──────────────────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'call_hubspot_api',
  definition: {
    name: 'call_hubspot_api',
    description: `Manage HubSpot marketing assets and data via a single unified tool.
Use entity_type to select the resource, action to select the operation.

ENTITY_TYPE + ACTION MATRIX:

  CAMPAIGN   → LIST | GET (guid) | CREATE (name) | UPDATE (guid) | DELETE (guid) | GET_METRICS (guid)
             → LIST_ASSETS (guid; optional: asset_type, start_date, end_date, cursor)
             → ADD_ASSET (guid, asset_type, asset_id) | REMOVE_ASSET (guid, asset_type, asset_id)
             Requires Marketing Hub Professional+. asset_type: MARKETING_EMAIL, LANDING_PAGE, BLOG_POST, FORM, WEB_INTERACTIVE, CTA, SOCIAL_BROADCAST, WORKFLOW.

  EMAIL      → LIST (cursor?) | GET (email_id) | GET_STATS (email_ids[], start_timestamp?, end_timestamp?)
             → CREATE (name; subject?, from_name?, from_email?, subscription_id?, contact_lists_include[]?, contact_lists_exclude[]?, send_on_publish?, publish_date?)
             → UPDATE (email_id; same optional fields as CREATE) | CLONE (email_id, name)
             → PUBLISH (email_id) | UNPUBLISH (email_id) | LIST_SUBSCRIPTION_TYPES
             → DELETE (email_id)
             Requires "content" OAuth scope. PUBLISH/UNPUBLISH require Marketing Hub Enterprise or the transactional email add-on.
             SENDING A MARKETING EMAIL — set audience + schedule on CREATE/UPDATE, then PUBLISH:
               1. LIST_SUBSCRIPTION_TYPES → pick a subscription_id (email type).
               2. Ensure recipients are IN the target contact list(s): use CONTACT_LIST LIST to get list IDs, CONTACT_LIST ADD_CONTACTS to populate. (Leads synced from AgentWeb land in HubSpot's contact DB, NOT automatically in a list.)
               3. CREATE/UPDATE with subscription_id + contact_lists_include[] (+ contact_lists_exclude[]).
                  send_on_publish=true → send immediately on PUBLISH; publish_date (ISO8601) → schedule for that time.
               4. PUBLISH (email_id) to send/schedule. UNPUBLISH cancels a scheduled send (already-sending emails may not be cancellable).

  FORM       → LIST (cursor?) | GET (form_id) | GET_SUBMISSIONS (form_id; cursor?) | GET_FORM_FIELDS (form_id)
             → CREATE (name, formType="hubspot", fieldGroups=[], configuration={}, displayOptions={}, legalConsentOptions={type:"none"})
             → UPDATE (form_id; name?, fieldGroups?, configuration?, displayOptions?, legalConsentOptions?)
             → SUBMIT (form_id, fields[{name,value}]; submission_context?, legal_consent_options?)
             → DELETE (form_id)
             Requires "forms" OAuth scope. CREATE: formType must be "hubspot" (only valid value). All 6 fields required by HubSpot schema. Pass minimum: formType="hubspot", fieldGroups=[], configuration={}, displayOptions={}, legalConsentOptions={type:"none"}.
             GET_FORM_FIELDS: returns a flat list of the form's fields ({name,label,fieldType,required,objectTypeId,options}) — use it to discover what to pass to SUBMIT instead of parsing the nested fieldGroups schema.
             SUBMIT: pushes a submission INTO the form (lead capture) via HubSpot's public submission API. fields = [{ name, value }] using the field "name" from GET_FORM_FIELDS. form_id is the form GUID. submission_context (e.g. { pageUri, pageName }) and legal_consent_options are optional.
             DELETE is a soft-delete (archive); permanently purged after 3 months.

  LANDING_PAGE → LIST (cursor?) | GET (page_id) | CREATE (name; template_path?, slug?, meta_description?)
               → PUBLISH (page_id) | UPDATE (page_id; name?, html_title?, meta_description?, slug?, ...)
               → DELETE (page_id)
               Requires "content" scope + CMS Hub.

  BLOG_POST  → LIST (cursor?) | GET (post_id) | CREATE (name, content_group_id; slug?, meta_description?, post_body?)
             → PUBLISH (post_id) | UPDATE (post_id; name?, html_title?, meta_description?, slug?, ...)
             → DELETE (post_id)
             Requires "content" scope. Get content_group_id from LIST.

  WORKFLOW   → LIST | GET (workflow_id) | DELETE (workflow_id) | GET_PERFORMANCE (workflow_id, start, end, bucket)
             → ENABLE (workflow_id) | DISABLE (workflow_id)
             Requires "automation" scope + Marketing Hub Professional+.
             ENABLE/DISABLE toggle a workflow on/off (v4 flows read-modify-write PUT). ENABLE turns automation live — it will enroll contacts and run actions.
             Enrollment stats in contactListIds.enrolled / contactListIds.active.
             GET_PERFORMANCE: start/end = epoch ms, bucket = DAY|WEEK|MONTH. Returns ENROLLED/UNENROLLED/COMPLETED counts per bucket.
             WARNING: DELETE is irreversible via API — deleted workflow can only be restored by HubSpot Support.

  SOCIAL     → LIST_CHANNELS | LIST_BROADCASTS | CREATE_BROADCAST (channel_key, body; trigger_at?)
             → DELETE_BROADCAST (broadcast_guid)
             channel_key format: "Twitter:403551555". trigger_at: epoch ms.
             NOTE: DELETE_BROADCAST only cancels pending/scheduled broadcasts — already-published ones are not retracted.

ASSET METRICS (CAMPAIGN LIST_ASSETS):
  MARKETING_EMAIL → opens, clicks, bounces, unsubscribes
  FORM → views, submissions, conversion_rate
  LANDING_PAGE → views, conversions  |  BLOG_POST → views
  WORKFLOW → enrolled, active, completed counts
  SOCIAL_BROADCAST → facebook_clicks, linkedin_clicks, twitter_clicks

  CONTACT_LIST → LIST (query?, cursor?, count?) | GET (list_id) | CREATE (name, processing_type; object_type_id?)
               → ADD_CONTACTS (list_id, record_ids[]) | REMOVE_CONTACTS (list_id, record_ids[])
               → DELETE (list_id)
               processing_type: MANUAL (static, edit via API) | DYNAMIC (auto-filters) | SNAPSHOT (filter once, then static).
               ADD_CONTACTS/REMOVE_CONTACTS only work on MANUAL or SNAPSHOT lists.
               DELETE is soft-delete — recoverable within 90 days. Scopes: crm.lists.read / crm.lists.write.

NOT AVAILABLE VIA API: Ad metrics (Google/Meta — use those tools), social engagement counts.

TYPICAL WORKFLOW:
  1. CAMPAIGN LIST → get guid
  2. CAMPAIGN LIST_ASSETS (guid, asset_type?) → see assets + per-asset metrics
  3. CAMPAIGN GET_METRICS (guid) → campaign roll-up`,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type:      { type: 'string', enum: ['CAMPAIGN', 'EMAIL', 'FORM', 'LANDING_PAGE', 'BLOG_POST', 'WORKFLOW', 'SOCIAL', 'CONTACT_LIST'], description: 'HubSpot resource to operate on.' },
        action:           { type: 'string', description: 'Action to perform. See ACTION MATRIX.' },
        // CAMPAIGN
        guid:             { type: 'string', description: 'Campaign guid. Required for CAMPAIGN GET/UPDATE/DELETE/GET_METRICS/LIST_ASSETS/ADD_ASSET/REMOVE_ASSET.' },
        asset_type:       { type: 'string', description: 'Asset type for CAMPAIGN LIST_ASSETS/ADD_ASSET/REMOVE_ASSET. One of: MARKETING_EMAIL, LANDING_PAGE, BLOG_POST, FORM, WEB_INTERACTIVE, CTA, SOCIAL_BROADCAST, WORKFLOW.' },
        asset_id:         { type: 'string', description: 'Asset ID for CAMPAIGN ADD_ASSET/REMOVE_ASSET.' },
        utm:              { type: 'string', description: 'UTM campaign value. CAMPAIGN CREATE/UPDATE.' },
        notes:            { type: 'string', description: 'Internal notes. CAMPAIGN CREATE/UPDATE.' },
        // EMAIL
        email_id:         { type: 'string', description: 'Email ID. Required for EMAIL GET/UPDATE/CLONE/DELETE.' },
        email_ids:        { type: 'array', items: { type: 'string' }, description: 'Email IDs for EMAIL GET_STATS.' },
        subject:          { type: 'string', description: 'Email subject line. EMAIL CREATE/UPDATE.' },
        from_name:        { type: 'string', description: 'Sender display name. EMAIL CREATE/UPDATE.' },
        from_email:       { type: 'string', description: 'Sender email address. EMAIL CREATE/UPDATE.' },
        subscription_id:  { type: 'string', description: 'HubSpot subscription type ID (email type). From EMAIL LIST_SUBSCRIPTION_TYPES. Set on EMAIL CREATE/UPDATE before a marketing email can be sent.' },
        contact_lists_include: { type: 'array', items: { type: 'string' }, description: 'Contact list IDs to send to. EMAIL CREATE/UPDATE. Get IDs from CONTACT_LIST LIST.' },
        contact_lists_exclude: { type: 'array', items: { type: 'string' }, description: 'Contact list IDs to suppress. EMAIL CREATE/UPDATE.' },
        send_on_publish:  { type: 'boolean', description: 'EMAIL CREATE/UPDATE. true → email sends immediately when PUBLISHed.' },
        publish_date:     { type: 'string', description: 'ISO8601 datetime — MUST be in the future; compute from the actual current date/time (correct current year). EMAIL CREATE/UPDATE. Schedules the send for this time on PUBLISH.' },
        start_timestamp:  { type: 'string', description: 'Start of date range (string). Filter EMAIL GET_STATS.' },
        end_timestamp:    { type: 'string', description: 'End of date range (string). Filter EMAIL GET_STATS.' },
        // FORM
        form_id:          { type: 'string', description: 'Form ID (GUID). Required for FORM GET/GET_SUBMISSIONS/GET_FORM_FIELDS/UPDATE/DELETE/SUBMIT.' },
        fields:           { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: {}, objectTypeId: { type: 'string' } }, required: ['name', 'value'] }, description: 'Submission values for FORM SUBMIT: [{ name, value }]. Use field "name" from FORM GET_FORM_FIELDS.' },
        submission_context: { type: 'object', description: 'Optional context for FORM SUBMIT (e.g. { pageUri, pageName, hutk }).' },
        legal_consent_options: { type: 'object', description: 'Optional GDPR consent object for FORM SUBMIT.' },
        // LANDING_PAGE
        page_id:          { type: 'string', description: 'Landing page ID. Required for LANDING_PAGE GET/PUBLISH/UPDATE/DELETE.' },
        template_path:    { type: 'string', description: 'HubSpot template path (no leading slash). LANDING_PAGE CREATE.' },
        // BLOG_POST
        post_id:          { type: 'string', description: 'Blog post ID. Required for BLOG_POST GET/PUBLISH/UPDATE/DELETE.' },
        content_group_id: { type: 'string', description: 'Blog ID (contentGroupId). Required for BLOG_POST CREATE.' },
        post_body:        { type: 'string', description: 'HTML body. BLOG_POST CREATE.' },
        // shared
        name:             { type: 'string', description: 'Name/title. Required for CAMPAIGN CREATE, EMAIL CREATE/CLONE, LANDING_PAGE CREATE, BLOG_POST CREATE.' },
        start_date:       { type: 'string', description: 'YYYY-MM-DD. CAMPAIGN CREATE/UPDATE; metrics window start for LIST_ASSETS.' },
        end_date:         { type: 'string', description: 'YYYY-MM-DD. Metrics window end for CAMPAIGN LIST_ASSETS.' },
        slug:             { type: 'string', description: 'URL slug. LANDING_PAGE/BLOG_POST CREATE.' },
        meta_description: { type: 'string', description: 'SEO meta description. LANDING_PAGE/BLOG_POST CREATE.' },
        cursor:           { type: 'string', description: 'Pagination cursor for LIST actions.' },
        // WORKFLOW
        workflow_id:      { type: 'string', description: 'Workflow ID. Required for WORKFLOW GET, DELETE, GET_PERFORMANCE.' },
        start:            { type: 'number', description: 'Start time as Unix epoch milliseconds. Required for WORKFLOW GET_PERFORMANCE.' },
        end:              { type: 'number', description: 'End time as Unix epoch milliseconds. Required for WORKFLOW GET_PERFORMANCE.' },
        bucket:           { type: 'string', enum: ['DAY', 'WEEK', 'MONTH'], description: 'Time bucket granularity. Required for WORKFLOW GET_PERFORMANCE.' },
        // SOCIAL
        channel_key:      { type: 'string', description: 'Social channel key (e.g. "Twitter:403551555"). From SOCIAL LIST_CHANNELS. Required for CREATE_BROADCAST.' },
        body:             { type: 'string', description: 'Post text. Required for SOCIAL CREATE_BROADCAST.' },
        trigger_at:       { type: 'number', description: 'Scheduled time as Unix epoch ms — MUST be in the future. Compute it from the actual current date/time (use the correct current year); a past value posts immediately. Omit to post immediately. SOCIAL CREATE_BROADCAST.' },
        broadcast_guid:   { type: 'string', description: 'Broadcast GUID. Required for SOCIAL DELETE_BROADCAST.' },
        // CONTACT_LIST
        list_id:          { type: 'string', description: 'ILS list ID. Required for CONTACT_LIST GET/ADD_CONTACTS/REMOVE_CONTACTS/DELETE.' },
        processing_type:  { type: 'string', enum: ['MANUAL', 'SNAPSHOT', 'DYNAMIC'], description: 'List type. Required for CONTACT_LIST CREATE.' },
        object_type_id:   { type: 'string', description: 'HubSpot object type ID. Defaults to "0-1" (contacts). CONTACT_LIST CREATE.' },
        record_ids:       { type: 'array', items: { type: 'string' }, description: 'Contact record IDs. Required for CONTACT_LIST ADD_CONTACTS/REMOVE_CONTACTS.' },
        query:            { type: 'string', description: 'Search query for CONTACT_LIST LIST.' },
        count:            { type: 'number', description: 'Page size for CONTACT_LIST LIST. Default 50, max 500.' },
        filter_branch:    { type: 'object', description: 'Filter criteria for DYNAMIC/SNAPSHOT CONTACT_LIST CREATE.' },
        account_id:       { type: 'string', description: 'HubSpot account ID. Required when the user has multiple HubSpot accounts connected — the error message will list them; ask the user which to use.' },
      },
      required: ['entity_type', 'action'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) return { success: false, error: 'Authentication required: no user context.' };
    return agentModeService.handleHubspotApi(userId, args);
  },
});

emmaToolRegistry.register({
  name: 'read_google_doc',
  definition: {
    name: 'read_google_doc',
    description: 'Read a Google Doc or Google Sheet by URL or file ID, including all inline comments and replies. If the user has connected Google Drive in Settings → Connected Accounts, uses their credentials (works for internal Workspace files). Otherwise falls back to the service account (file must be shared with the SA). Use this to ingest a specific Doc or Sheet that is NOT inside a registered Drive folder.',
    inputSchema: {
      type: 'object',
      properties: {
        url_or_id: {
          type: 'string',
          description: 'Google Doc/Sheet URL (e.g. https://docs.google.com/document/d/FILE_ID/edit) or raw file ID',
        },
      },
      required: ['url_or_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) return { success: false, message: 'Authentication required' };
    const fileId = (args.url_or_id as string).match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? args.url_or_id.trim();
    return agentModeService.readGoogleFileById(fileId, context.userId);
  },
});

emmaToolRegistry.register({
  name: 'google_drive',
  definition: {
    name: 'google_drive',
    description: 'Google Drive utility actions. Use action="search" when user refers to a file/folder by name or wants to browse/find something — search immediately, do NOT ask the user for a URL. Use action="list" to list contents of a folder — use folder_url_or_id="root" when user asks to browse their Drive or list folders without specifying a location. Use action="create_folder" when the user asks to create a folder — just do it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'list', 'create_folder'],
          description: '"search" — find files/folders by name. "list" — list contents of a folder (use "root" for root Drive). "create_folder" — create a new Drive folder.',
        },
        // search params
        query: {
          type: 'string',
          description: '[search] Name or partial name to search for.',
        },
        type: {
          type: 'string',
          enum: ['folder', 'file', 'any'],
          description: '[search] Filter: "folder", "file", or "any" (default).',
        },
        // list params
        folder_url_or_id: {
          type: 'string',
          description: '[list] Google Drive folder URL, folder ID, or "root" to list the root Drive.',
        },
        // create_folder params
        name: {
          type: 'string',
          description: '[create_folder] Name of the folder to create.',
        },
        parent_folder_id: {
          type: 'string',
          description: '[create_folder] Optional parent folder ID. Omit to create in Drive root.',
        },
      },
      required: ['action'],
    },
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) return { success: false, message: 'Authentication required' };
    if (args.action === 'search') {
      if (!args.query) return { success: false, message: 'query is required for action=search' };
      return agentModeService.searchGoogleDrive(args.query, context.userId, args.type);
    }
    if (args.action === 'list') {
      if (!args.folder_url_or_id) return { success: false, message: 'folder_url_or_id is required for action=list' };
      return agentModeService.listGoogleDriveFolder(args.folder_url_or_id, context.userId);
    }
    if (args.action === 'create_folder') {
      if (!args.name) return { success: false, message: 'name is required for action=create_folder' };
      return agentModeService.createGoogleDriveFolder(args.name, context.userId, args.parent_folder_id);
    }
    return { success: false, message: `Unknown action: ${args.action}` };
  },
});

emmaToolRegistry.register({
  name: 'create_google_doc',
  definition: {
    name: 'create_google_doc',
    description: 'Create a new Google Doc with rich formatting. Requires the user to have connected Google Drive in Settings → Connected Accounts. The Doc is created in the user\'s own Drive (or a specific folder if folder_id is provided) and optionally shared with additional emails. Returns the Doc URL. Content is written in markdown and automatically converted to rich Google Docs formatting (headings, bold, italic, bullet lists, numbered lists, tables, code blocks, blockquotes, etc.) — write full markdown, do NOT flatten to plain text. BEHAVIOR: Just do it — do NOT present options or ask the user to choose a format. Make the best judgment call from context and create the doc immediately. If the user names a destination folder by name (e.g. "Emma Test folder"), use google_drive action=search first to find its ID — do NOT ask the user for the URL. Images and logos cannot be embedded inline via the API — include them as clickable links in the doc content instead. Docs are styled by default — set plain=true only if the user explicitly wants a simple/minimal doc with no formatting. Use style_options.primary_color to apply brand colors or a color the user requested.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the Google Doc',
        },
        content: {
          type: 'string',
          description: 'Content in markdown format. Write full markdown (# Heading 1, ## Heading 2, **bold**, *italic*, - bullet lists, 1. numbered lists, | tables |, ```code blocks```, > blockquotes, [text](url) links). Markdown is automatically converted to rich Google Docs formatting — do NOT flatten to plain text. To style just one word/phrase without affecting the rest of the document (not the document-wide accent/font from style_options), use an inline style span: [text]{attr=value;flag;...}. Supported: color=blue or color=#ff0000 (text color), font=Verdana (font family — letters/spaces only, e.g. "Times New Roman"), underline (flag, no value), italic (flag), bold (flag). Combine multiple in one span with semicolons, e.g. [Phase 1]{color=yellow;font=Verdana;italic;underline}. Only use this when the user explicitly asks for specific word/line formatting, not proactively. This composes with heading markdown: writing "# [test 2]{color=blue}" makes that one heading big+bold (from the # itself) AND blue, without recoloring any other heading in the document — do NOT treat "make it a heading" and "color it" as mutually exclusive options; combine them in a single line for a "big, bold, and [color]" request on one specific item.',
        },
        folder_id: {
          type: 'string',
          description: 'Optional: Google Drive folder ID to create the Doc in. If omitted, creates in the user\'s root Drive or first connected folder. Get folder IDs from list_knowledge_base_files (gdrive: identifiers).',
        },
        share_with_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: additional email addresses to share the Doc with (writer access). The calling user is always shared automatically.',
        },
        plain: {
          type: 'boolean',
          description: 'Set true ONLY if the user explicitly asks for a plain/simple/minimal doc or quick note with no formatting. Omit (or false) for everything else.',
        },
        style_options: {
          type: 'object',
          description: 'Visual customizations. Only set what the user asked for — everything else uses sensible defaults (Arial 14px, blue accent). Set primary_color if you know the brand or the user specified a color. Set font_family or font_size only if the user asks.',
          properties: {
            primary_color: {
              type: 'string',
              description: 'Hex accent color for headings and table headers. Derive from brand colors or user request (e.g. brand pink → "#e6518d", "use purple" → "#7C3AED"). Default: #1a73e8.',
            },
            font_family: {
              type: 'string',
              description: 'Body font. Examples: "Georgia, serif" (editorial), "Times New Roman, serif" (formal), "Trebuchet MS, sans-serif" (modern), "Courier New, monospace" (technical). Default: "Arial, sans-serif".',
            },
            font_size: {
              type: 'number',
              description: 'Base body font size in px. Heading sizes scale proportionally. Use 12 for compact, 16-18 for larger. Default: 14.',
            },
            line_height: {
              type: 'number',
              description: 'Line spacing multiplier. 1.4 = tight, 1.7 = default, 2.0 = spacious.',
            },
            compact: {
              type: 'boolean',
              description: 'Reduce table cell padding and element spacing. Default: false.',
            },
          },
        },
      },
      required: ['title', 'content'],
    },
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) return { success: false, message: 'Authentication required' };
    const style = args.plain === true ? 'plain' : 'styled';
    const so = args.style_options;
    const styleOptions = so ? { primaryColor: so.primary_color, fontFamily: so.font_family, fontSize: so.font_size, lineHeight: so.line_height, compact: so.compact } : undefined;
    return agentModeService.createGoogleDoc(args.title, args.content, context.userId, args.folder_id, args.share_with_emails, style, styleOptions);
  },
});

emmaToolRegistry.register({
  name: 'update_google_doc',
  definition: {
    name: 'update_google_doc',
    description: 'Replace the entire content of an existing Google Doc with rich formatting. Content is written in markdown and automatically converted to rich Google Docs formatting — write full markdown, do NOT flatten to plain text. Use this to write revised content back to a Doc after the team has left comments and the user has approved edits. Accepts a Doc URL or file ID. BEHAVIOR: this REPLACES THE WHOLE DOCUMENT. On the FIRST update_google_doc call in a conversation, warn the user first (e.g. "this will replace the entire doc\'s content — the previous version stays recoverable via File → Version History if needed. Want me to go ahead?") and wait for explicit confirmation before calling this tool — do NOT call it on the first ask. For any SUBSEQUENT update_google_doc call later in the SAME conversation (i.e. you already asked and the user confirmed once before), do not ask again — just call it directly, but still briefly mention afterward that the previous version is recoverable via File → Version History, every time. STYLING: unlike create_google_doc, an update defaults to leaving the doc\'s existing visual decoration alone (headings/bullets/tables still render properly, just without imposed colors/fonts) — only pass plain=false or style_options when the user explicitly asks for the doc to be restyled/colorized.',
    inputSchema: {
      type: 'object',
      properties: {
        url_or_id: {
          type: 'string',
          description: 'Google Doc URL or file ID',
        },
        content: {
          type: 'string',
          description: 'New content in markdown format (replaces all existing content). Write full markdown — it is automatically converted to rich Google Docs formatting. Do NOT flatten to plain text. To style just one word/phrase without affecting the rest of the document (not the document-wide accent/font from style_options), use an inline style span: [text]{attr=value;flag;...}. Supported: color=blue or color=#ff0000 (text color), font=Verdana (font family — letters/spaces only, e.g. "Times New Roman"), underline (flag, no value), italic (flag), bold (flag). Combine multiple in one span with semicolons, e.g. [Phase 1]{color=yellow;font=Verdana;italic;underline}. Only use this when the user explicitly asks for specific word/line formatting, not proactively. This composes with heading markdown: writing "# [test 2]{color=blue}" makes that one heading big+bold (from the # itself) AND blue, without recoloring any other heading in the document — do NOT treat "make it a heading" and "color it" as mutually exclusive options; combine them in a single line for a "big, bold, and [color]" request on one specific item.',
        },
        plain: {
          type: 'boolean',
          description: 'Set true ONLY if the original doc was plain or user wants no formatting.',
        },
        style_options: {
          type: 'object',
          description: 'Visual customizations. Match what was used when the doc was originally created, or apply any new style the user requests.',
          properties: {
            primary_color: { type: 'string', description: 'Hex accent color.' },
            font_family: { type: 'string', description: 'Body font family.' },
            font_size: { type: 'number', description: 'Base font size in px.' },
            line_height: { type: 'number', description: 'Line spacing multiplier.' },
            compact: { type: 'boolean', description: 'Tighter table/element spacing.' },
          },
        },
      },
      required: ['url_or_id', 'content'],
    },
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) return { success: false, message: 'Authentication required' };
    // Unlike create (styled by default), an update defaults to leaving the doc's existing
    // look alone — only restyle when the user explicitly asked (plain: false) or gave style_options.
    const style = args.plain === true ? 'plain' : (args.plain === false || args.style_options) ? 'styled' : 'plain';
    const so = args.style_options;
    const styleOptions = so ? { primaryColor: so.primary_color, fontFamily: so.font_family, fontSize: so.font_size, lineHeight: so.line_height, compact: so.compact } : undefined;
    return agentModeService.updateGoogleDoc(args.url_or_id, args.content, context.userId, style, styleOptions);
  },
});

emmaToolRegistry.register({
  name: 'create_google_sheet',
  definition: {
    name: 'create_google_sheet',
    description: 'Create a new Google Sheet with structured data. Requires the user to have connected Google Drive in Settings → Connected Accounts. The Sheet is created in the user\'s own Drive and optionally shared with additional emails. Data is a 2D array (rows × columns). Use this to deliver tabular output as a native Google Sheet. IMPORTANT: Before calling this tool, always ask the user two things and wait for explicit answers: (1) "Should I go ahead and create this Google Sheet titled X?" (2) "Where should I put it — your root Drive, or a specific folder? If a folder, please share the folder ID or URL."',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the Google Sheet',
        },
        data: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Rows of data. First row is typically headers. Example: [["Name","Email","Score"],["Alice","a@co.com","90"]]',
        },
        folder_id: {
          type: 'string',
          description: 'Optional: Google Drive folder ID to create the Sheet in. If omitted, creates in the user\'s root Drive or first connected folder.',
        },
        share_with_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: additional emails to share with (writer access).',
        },
      },
      required: ['title', 'data'],
    },
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) return { success: false, message: 'Authentication required' };
    return agentModeService.createGoogleSheet(args.title, args.data, context.userId, args.folder_id, args.share_with_emails);
  },
});

emmaToolRegistry.register({
  name: 'update_google_sheet',
  definition: {
    name: 'update_google_sheet',
    description: 'Write data into a range of an existing Google Sheet. Use this to update specific cells or add new rows to a Sheet. Existing data outside the range is preserved. IMPORTANT: Before calling this tool, always confirm with the user — e.g. "Should I update [Sheet title/URL] range X with the new data?" — and wait for explicit approval. If multiple Sheets are in the conversation context and the user says "update the sheet" without specifying which one, ask them to clarify before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        url_or_id: {
          type: 'string',
          description: 'Google Sheet URL or file ID',
        },
        range: {
          type: 'string',
          description: 'A1 notation range to write into, e.g. "Sheet1!A1" or "Sheet1!B2:D10"',
        },
        data: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Rows of data to write into the range',
        },
      },
      required: ['url_or_id', 'range', 'data'],
    },
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) return { success: false, message: 'Authentication required' };
    return agentModeService.updateGoogleSheet(args.url_or_id, args.range, args.data, context.userId);
  },
});

/**
 * ENG-239 AC3 — "Existing campaigns are not silently modified; a report/tool lists
 * campaigns lacking UTMs so the team can opt in per client."
 *
 * This is the report. It is STRICTLY READ-ONLY: it audits through an AdReadPort that
 * exposes no write method, so Emma cannot modify a campaign through this tool. Fixing
 * an untagged campaign stays a deliberate, per-campaign act by a human, which is what
 * the AC's "not silently" is protecting — on Meta, re-tagging means swapping the
 * creative, and that resets the ad's learning phase.
 */
const AD_UTM_AUDIT_PORTS = Object.assign(Object.create(null), {
  meta: metaAdReadPort,
  google: googleAdReadPort,
  linkedin: linkedInAdReadPort,
}) as Record<string, typeof metaAdReadPort>;

emmaToolRegistry.register({
  name: 'audit_ad_utm_coverage',
  definition: {
    name: 'audit_ad_utm_coverage',
    description:
      "READ-ONLY. Lists which of an ad account's campaigns are missing UTM tracking on their " +
      'destination URLs, so leads from them can be attributed back to the ad that produced them. ' +
      'This tool NEVER modifies a campaign, ad, or URL — it only reports. Use it to decide which ' +
      'clients to opt in to UTM tagging.\n\n' +
      'A campaign counts as tagged only if EVERY ad under it carries utm_source, utm_medium and ' +
      'utm_campaign (utm_content is not required — LinkedIn cannot supply it).\n\n' +
      'Two kinds of problem are reported SEPARATELY and must not be conflated:\n' +
      '  • untaggedAdIds  — ads definitely missing a UTM key. Safe to act on.\n' +
      '  • unreadableAdIds — ads whose destination URL could not be read. These need a HUMAN to ' +
      'look; do NOT assume they are untagged and do not "fix" them blindly.\n\n' +
      "Get account_id from list_connected_accounts for the platform.",
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['meta', 'google', 'linkedin'],
          description: 'Which ad platform to audit.',
        },
        account_id: {
          type: 'string',
          description:
            'The ad account id on that platform (Meta ad account id, Google customer id, or LinkedIn ad account id).',
        },
      },
      required: ['platform', 'account_id'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Missing user context');
    }
    const platform = String(args?.platform || '').trim();
    const port = AD_UTM_AUDIT_PORTS[platform];
    if (!port) {
      throw new Error(
        `Unsupported platform "${args?.platform}". Use one of: meta, google, linkedin.`,
      );
    }
    const accountId = String(args?.account_id || '').trim();
    if (!accountId) {
      throw new Error('account_id is required — get it from list_connected_accounts.');
    }

    const campaigns = await auditCampaigns(
      platform as AdPlatform,
      context.userId,
      accountId,
      port,
    );

    const needingAction = campaigns.filter((c) => !c.tagged);
    const unreadableCount = campaigns.reduce((n, c) => n + c.unreadableAdIds.length, 0);

    // Say the unreadable count out loud. Silently folding it into "untagged" would send
    // someone to swap a creative we never actually managed to read.
    const message = needingAction.length === 0
      ? `✅ All ${campaigns.length} campaign(s) on ${platform} carry UTM tracking. Nothing to opt in.`
      : `${needingAction.length} of ${campaigns.length} campaign(s) on ${platform} need attention.` +
        (unreadableCount > 0
          ? ` ${unreadableCount} ad(s) were unreadable — their destination URL could not be parsed, so they need review by a human rather than an automatic fix.`
          : '');

    return {
      success: true,
      message,
      platform,
      accountId,
      totalCampaigns: campaigns.length,
      campaignsNeedingAction: needingAction.length,
      unreadableAdCount: unreadableCount,
      campaigns,
    };
  },
});
